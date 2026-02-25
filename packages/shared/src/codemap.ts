import { slugify, uniqueId } from './ids.js';
import {
  pruneDanglingRefs,
  type CodeSyncMode,
  type Edge,
  type Plan,
  type PlanNode,
} from './schema.js';
import { systemNamedIn, systemOf, type SystemDef } from './systems.js';

/**
 * What the repository scanner found. Plain data, so it can cross into the webview and be
 * checked against a board anywhere. The scanner itself is Node-only (`@agentic-whiteboard/shared/node`).
 */
export interface ScannedFile {
  /** Repo-relative, forward slashes. */
  path: string;
  lang: 'ts' | 'js' | 'py' | 'go' | 'prisma';
  test: boolean;
  /** Repo files this one imports (resolved). */
  imports: string[];
  /** External packages this one imports, e.g. "stripe", "@adyen/api-library". */
  packages: string[];
  exports: string[];
  /** HTTP routes it declares, e.g. "POST /orders". */
  routes: string[];
  /** Database models it declares. */
  models: string[];
}

export interface CodeScan {
  scannedAt: string;
  commit?: string;
  /** Every file in the repo (tracked or not ignored), for existence checks. */
  paths: string[];
  /** Source files that were parsed. */
  files: ScannedFile[];
  /** True when the repo had more files than the scanner reads. */
  truncated?: boolean;
  /** Packages of a monorepo (workspaces), by folder: the natural top-level parts. */
  workspaces?: { dir: string; name: string }[];
}

/** Every package a box stands for: any of them in use means the system is in use. */
export function nodePackages(n: Pick<PlanNode, 'package' | 'packages'>): string[] {
  return [...new Set([...(n.packages ?? []), ...(n.package ? [n.package] : [])])];
}

/** `./src\\a/` -> `src/a`. */
export function normalizeCodePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/** True when `file` is `target` or lies inside the folder `target`. */
export function isUnder(file: string, target: string): boolean {
  if (!target || target === '.') return true;
  return file === target || file.startsWith(target + '/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Whiteboard files themselves: never code, never drift. */
export const isBoardPath = (p: string) =>
  p.endsWith('.whiteboard') || p.endsWith('.plan.json') || p.startsWith('.agentic-whiteboard/');

/** Fast lookups over a scan. */
export class CodeIndex {
  readonly paths: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
  readonly byPath: ReadonlyMap<string, ScannedFile>;
  /** Lower-cased path -> the real path, or null when two paths differ only in case. */
  private readonly folded = new Map<string, string | null>();

  /** Indexes are cached per scan; drift is checked after every board edit. */
  static for(scan: CodeScan): CodeIndex {
    let index = indexes.get(scan);
    if (!index) indexes.set(scan, (index = new CodeIndex(scan)));
    return index;
  }

  constructor(readonly scan: CodeScan) {
    this.paths = new Set(scan.paths);
    const dirs = new Set<string>();
    for (const p of scan.paths) for (let d = dirname(p); d !== '.'; d = dirname(d)) dirs.add(d);
    this.dirs = dirs;
    this.byPath = new Map(scan.files.map((f) => [f.path, f]));
    for (const p of [...this.paths, ...dirs]) {
      const k = p.toLowerCase();
      this.folded.set(k, this.folded.has(k) && this.folded.get(k) !== p ? null : p);
    }
  }

  /**
   * The repo path `p` names, normalised. A box typed as "Src/Auth" finds "src/auth" (Windows
   * and macOS treat them as the same) unless the case is ambiguous.
   */
  resolve(p: string): string | undefined {
    const n = normalizeCodePath(p);
    if (n === '' || n === '.') return n;
    if (this.paths.has(n) || this.dirs.has(n)) return n;
    return this.folded.get(n.toLowerCase()) ?? undefined;
  }

  exists(p: string): boolean {
    return this.resolve(p) !== undefined;
  }

  /** Parsed source files at or under `p`. */
  filesUnder(p: string): ScannedFile[] {
    const n = this.resolve(p) ?? normalizeCodePath(p);
    const exact = this.byPath.get(n);
    if (exact) return [exact];
    return this.scan.files.filter((f) => isUnder(f.path, n));
  }

  /** Any repo files (parsed or not) at or under `p`. */
  pathsUnder(p: string): string[] {
    const n = this.resolve(p) ?? normalizeCodePath(p);
    return this.scan.paths.filter((f) => isUnder(f, n));
  }

  /** Test files that live under `p` or import a file under it. */
  testsFor(p: string): string[] {
    const n = this.resolve(p) ?? normalizeCodePath(p);
    return this.scan.files
      .filter((f) => f.test && (isUnder(f.path, n) || f.imports.some((i) => isUnder(i, n))))
      .map((f) => f.path);
  }

  packagesUnder(p: string): string[] {
    return uniqueSorted(this.filesUnder(p).flatMap((f) => (f.test ? [] : f.packages)));
  }

  /** Files that import `pkg` or one of its subpaths. */
  importersOf(pkg: string): ScannedFile[] {
    return this.scan.files.filter((f) => f.packages.some((p) => p === pkg));
  }
}

const indexes = new WeakMap<CodeScan, CodeIndex>();

export function uniqueSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

// Architecture from code

export interface ArchitectureOptions {
  /** Only map this folder (repo-relative). */
  folder?: string;
  /** At most this many boxes for the code itself; external systems come on top. Default 12. */
  maxNodes?: number;
}

export interface Architecture {
  nodes: PlanNode[];
  edges: Edge[];
}

const depth = (d: string) => (d === '.' ? 0 : d.split('/').length);

/** Groups source files into modules: their folders, collapsed upwards until few enough remain. */
export function moduleKeys(files: readonly string[], maxModules: number): Map<string, string> {
  const keys = new Map(files.map((f) => [f, dirname(f)]));
  for (;;) {
    const distinct = new Set(keys.values());
    if (distinct.size <= maxModules) break;
    const deepest = [...distinct].reduce((m, d) => Math.max(m, depth(d)), 0);
    if (deepest === 0) break;
    for (const [f, k] of keys) if (depth(k) === deepest) keys.set(f, dirname(k));
  }
  return keys;
}

/** Folders that only hold the code below them; the folder above names the part. */
const TRUNKS = new Set(['src', 'lib', 'app', 'source', 'pkg', 'internal']);
/** Folders of helpers everything uses: a box, but no arrows into it. */
const SHARED =
  /^(utils?|helpers?|common|shared|config|configs|constants?|types?|typings|logger|logging|errors?)$/i;
const ACRONYMS: Record<string, string> = {
  api: 'API',
  ui: 'UI',
  db: 'DB',
  cli: 'CLI',
  mcp: 'MCP',
  sdk: 'SDK',
  http: 'HTTP',
  graphql: 'GraphQL',
};

/** "user-service" -> "User service", "apiGateway" -> "API gateway". */
export function titleize(name: string): string {
  const words = name
    .replace(/^@[^/]+\//, '')
    .replace(/\.[cm]?[jt]sx?$|\.py$|\.go$|\.prisma$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(
      (w, i) =>
        ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase()),
    );
  return words.join(' ') || name;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function roleOf(label: string, files: readonly ScannedFile[]): string | undefined {
  if (files.some((f) => f.routes.length)) return 'api';
  if (files.some((f) => f.models.length)) return 'data';
  if (/service/i.test(label)) return 'service';
  const ui = files.filter((f) => /\.(tsx|jsx)$/.test(f.path)).length;
  if (ui && ui * 2 >= files.length) return 'ui';
  return undefined;
}

/** Stable id for a module path, so re-syncing updates the same box. */
export function moduleNodeId(key: string): string {
  return key === '.' ? 'code-root' : `code-${slugify(key.replace(/\//g, '-'), 64)}`;
}

export function systemNodeId(name: string): string {
  return `sys-${slugify(name, 48)}`;
}

/**
 * The parts of the code, as file -> part key. A monorepo's parts are its packages; otherwise
 * folders, merged upwards until at most `max` remain.
 */
function partKeys(
  scan: CodeScan,
  files: readonly ScannedFile[],
  max: number,
): { keys: Map<string, string>; names: Map<string, string> } {
  const names = new Map<string, string>();
  const workspaces = (scan.workspaces ?? []).filter((w) =>
    files.some((f) => isUnder(f.path, w.dir)),
  );
  if (workspaces.length < 2)
    return {
      keys: moduleKeys(
        files.map((f) => f.path),
        max,
      ),
      names,
    };
  const deepestFirst = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  const keys = new Map<string, string>();
  const rest: string[] = [];
  for (const f of files) {
    const w = deepestFirst.find((x) => isUnder(f.path, x.dir));
    if (w) keys.set(f.path, w.dir);
    else rest.push(f.path);
  }
  for (const w of workspaces) names.set(w.dir, w.name);
  for (const [f, k] of moduleKeys(rest, Math.max(2, max - workspaces.length))) keys.set(f, k);
  return { keys, names };
}

function partLabel(key: string, files: readonly ScannedFile[], rootName: string, pkg?: string) {
  if (pkg) return titleize(pkg);
  const parts = key === '.' ? [] : key.split('/');
  // A folder names its part ("orders/routes.ts" is Orders). Files at the top of the code
  // (src/app.js, server.py) name theirs.
  if (key === '.' || TRUNKS.has(parts[parts.length - 1]!))
    if (files.length === 1) return titleize(basename(files[0]!.path));
  while (parts.length && TRUNKS.has(parts[parts.length - 1]!)) parts.pop();
  return titleize(parts.length ? parts[parts.length - 1]! : rootName);
}

/**
 * A high-level architecture of the code: about a dozen boxes for its parts (packages or
 * top-level folders), one box per external system it talks to (databases, caches, payment
 * and other APIs; never ordinary libraries), and one arrow per relationship. Shared helpers
 * (utils, config, types) keep their box but get no arrows, which would only add noise.
 */
export function architectureFromScan(
  scan: CodeScan,
  opts: ArchitectureOptions & { rootName?: string } = {},
): Architecture {
  const folder = opts.folder ? normalizeCodePath(opts.folder) : '';
  const source = scan.files.filter((f) => !f.test && isUnder(f.path, folder));
  const { keys, names } = partKeys(scan, source, opts.maxNodes ?? 12);
  const index = CodeIndex.for(scan);
  const parts = new Map<string, ScannedFile[]>();
  for (const f of source) {
    const k = keys.get(f.path)!;
    parts.set(k, [...(parts.get(k) ?? []), f]);
  }

  // Which part imports which, counted once per pair.
  const imports = new Map<string, Set<string>>();
  for (const f of source) {
    const from = keys.get(f.path)!;
    for (const imp of f.imports) {
      const to = keys.get(imp);
      if (to !== undefined && to !== from)
        imports.set(from, (imports.get(from) ?? new Set()).add(to));
    }
  }
  const fanIn = new Map<string, number>();
  for (const targets of imports.values())
    for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);

  const taken = new Set<string>();
  const idOf = new Map<string, string>();
  const shared = new Set<string>();
  const nodes: PlanNode[] = [];
  for (const [key, files] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
    const id = uniqueId(moduleNodeId(key), taken);
    taken.add(id);
    idOf.set(key, id);
    const single = files.length === 1 ? files[0]!.path : undefined;
    const path = single ?? key;
    const label = partLabel(key, files, opts.rootName ?? 'App', names.get(key));
    const usedBy = fanIn.get(key) ?? 0;
    // Helpers: named like one, or a leaf most of the other parts import.
    const isShared =
      SHARED.test(basename(key)) ||
      (parts.size >= 5 && !imports.get(key)?.size && usedBy >= Math.ceil(parts.size / 2));
    if (isShared) shared.add(key);
    const routes = files.reduce((n, f) => n + f.routes.length, 0);
    const models = files.reduce((n, f) => n + f.models.length, 0);
    const summary = [
      isShared ? `shared, used by ${usedBy}` : '',
      single ? '' : plural(files.length, 'file'),
      routes ? plural(routes, 'route') : '',
      models ? plural(models, 'model') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const node: PlanNode = {
      id,
      kind: 'component',
      label,
      path,
      changeType: 'unchanged',
      origin: 'code',
      // Everything under the folder, as drift detection compares against the same set.
      deps: index.packagesUnder(path),
    };
    const role = isShared ? 'shared' : roleOf(label, files);
    if (role) node.role = role;
    if (summary) node.summary = summary;
    nodes.push(node);
  }

  const edges: Edge[] = [];
  const addEdge = (from: string, to: string) => {
    const id = `e-${from}-${to}`;
    if (from !== to && !edges.some((e) => e.id === id))
      edges.push({ id, from, to, origin: 'code' });
  };
  // Arrows into shared helpers say nothing, unless they are the only arrows there are (a
  // monorepo whose core package is called "shared"): then the diagram would fall apart.
  const pairs = [...imports]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([from, targets]) => [...targets].sort().map((to) => [from, to] as const));
  const meaningful = pairs.filter(([, to]) => !shared.has(to));
  for (const [from, to] of meaningful.length ? meaningful : pairs)
    addEdge(idOf.get(from)!, idOf.get(to)!);

  // External systems, from the packages each part uses.
  const systems = new Map<string, { def: SystemDef; packages: Set<string>; parts: Set<string> }>();
  for (const f of source)
    for (const pkg of f.packages) {
      const def = systemOf(pkg);
      if (!def) continue;
      const s = systems.get(def.name) ?? { def, packages: new Set(), parts: new Set() };
      s.packages.add(pkg);
      s.parts.add(keys.get(f.path)!);
      systems.set(def.name, s);
    }
  // An ORM is how the code reaches a concrete database: the one the same part of the code
  // also uses (prisma next to pg is PostgreSQL). Elsewhere it stays a database of its own.
  for (const [name, s] of systems) {
    if (!s.def.generic) continue;
    const concrete = [...systems.values()].find(
      (x) =>
        !x.def.generic && x.def.kind === s.def.kind && [...x.parts].some((p) => s.parts.has(p)),
    );
    if (!concrete) continue;
    for (const p of s.packages) concrete.packages.add(p);
    for (const p of s.parts) concrete.parts.add(p);
    systems.delete(name);
  }
  for (const s of [...systems.values()].sort((a, b) => a.def.name.localeCompare(b.def.name))) {
    const id = uniqueId(systemNodeId(s.def.name), taken);
    taken.add(id);
    const packages = [...s.packages].sort();
    nodes.push({
      id,
      kind: 'external',
      label: s.def.name,
      package: packages[0]!,
      packages,
      role: s.def.kind,
      changeType: 'unchanged',
      origin: 'code',
    });
    for (const k of [...s.parts].sort()) addEdge(idOf.get(k)!, id);
  }
  return { nodes, edges };
}

export interface ApplyArchitectureResult {
  plan: Plan;
  /** "link": the board already showed the architecture; its boxes were linked, not redrawn. */
  mode: 'generate' | 'link';
  added: string[];
  updated: string[];
  /** Generated boxes whose code is gone, kept because `prune` was false. */
  stale: string[];
  removed: string[];
}

/**
 * Merges a generated architecture into a board.
 *
 * On a board that already shows the architecture (boxes someone drew that point at code), the
 * drawing stays as it is: its boxes are linked to the code, external systems they use but do
 * not show are added, and code that no box covers is left to drift detection. Otherwise the
 * generated boxes are added. Boxes from an earlier sync keep their label and position and get
 * fresh facts; generated boxes that no longer match the code are removed (unless `prune` is
 * false). Boxes people drew are never removed or renamed.
 */
export function applyArchitecture(
  plan: Plan,
  arch: Architecture,
  meta: {
    scannedAt: string;
    commit?: string;
    folder?: string;
    prune?: boolean;
    /** Lets boxes people drew get arrows to the systems their own code uses. */
    scan?: CodeScan;
  },
): ApplyArchitectureResult {
  const next: Plan = structuredClone(plan);
  const added: string[] = [];
  const updated: string[] = [];
  const drawnBoxes = next.nodes.filter((n) => n.origin !== 'code');
  const drawnParts = drawnBoxes.filter((n) => n.kind !== 'external' && n.path);
  // The repo path a drawn box names: "SRC/Payments" is src/payments where case does not matter.
  const index = meta.scan ? CodeIndex.for(meta.scan) : undefined;
  const repoPathOf = (x: PlanNode) => index?.resolve(x.path!) ?? normalizeCodePath(x.path!);
  const mode = drawnParts.length ? 'link' : 'generate';
  /** Generated id -> the id of the box it ended up as. */
  const idMap = new Map<string, string>();
  const claimed = new Set<string>();
  const kept = new Set<string>();

  for (const n of arch.nodes) {
    const isSystem = n.kind === 'external';
    const existing = next.nodes.find((x) => x.id === n.id);
    if (existing) {
      kept.add(existing.id);
      idMap.set(n.id, existing.id);
      updated.push(existing.id);
      const { label: _label, kind: _kind, ...facts } = n;
      for (const key of ['role', 'summary'] as const) if (!(key in facts)) delete existing[key];
      Object.assign(existing, facts);
      continue;
    }
    if (isSystem) {
      const sysPackages = nodePackages(n);
      const def = systemOf(sysPackages[0]!);
      const drawn = drawnBoxes.find((x) => {
        if (claimed.has(x.id) || x.kind !== 'external') return false;
        if (nodePackages(x).some((p) => sysPackages.includes(p))) return true;
        const named = systemNamedIn(x.label);
        return !!named && (named.name === n.label || (named.generic && named.kind === def?.kind));
      });
      if (drawn) {
        claimed.add(drawn.id);
        idMap.set(n.id, drawn.id);
        updated.push(drawn.id);
        // Link it: someone's "PostgreSQL" box now stands for the packages that reach it.
        if (!nodePackages(drawn).length) {
          drawn.packages = sysPackages;
          drawn.package = sysPackages[0]!;
        }
        continue;
      }
      // On a drawing, a system earns a box only if something on the board talks to it.
      if (mode === 'link' && !arch.edges.some((e) => e.to === n.id && idMap.has(e.from))) continue;
    } else {
      // A box someone drew for this folder, a file in it, or the folder around it covers it.
      const covering = drawnParts.filter((x) => {
        const p = repoPathOf(x);
        return isUnder(p, n.path!) || isUnder(n.path!, p);
      });
      if (covering.length) {
        const exact = covering.find((x) => repoPathOf(x) === n.path);
        const target = exact ?? (covering.length === 1 ? covering[0] : undefined);
        if (target) {
          idMap.set(n.id, target.id);
          if (!updated.includes(target.id)) updated.push(target.id);
          if (exact && n.summary) exact.summary = n.summary;
        }
        continue;
      }
      if (mode === 'link') continue;
    }
    next.nodes.push(n);
    added.push(n.id);
    kept.add(n.id);
    idMap.set(n.id, n.id);
  }

  const folder = meta.folder ? normalizeCodePath(meta.folder) : '';
  const stale = next.nodes
    .filter((n) => n.origin === 'code' && !kept.has(n.id) && (!n.path || isUnder(n.path, folder)))
    .map((n) => n.id);
  const prune = meta.prune ?? true;
  const removed = prune ? stale : [];
  if (removed.length) {
    const gone = new Set(removed);
    next.nodes = next.nodes.filter((n) => !gone.has(n.id));
    for (const id of removed) delete next.layout[id];
    next.steps = next.steps.map((s) => ({ ...s, nodeIds: s.nodeIds.filter((x) => !gone.has(x)) }));
  }

  // Arrows: the ones people drew stay; generated ones are recomputed.
  const nodeIds = new Set(next.nodes.map((n) => n.id));
  const keptEdges = next.edges.filter((e) => e.origin !== 'code');
  const drawnPairs = new Set(
    keptEdges.flatMap((e) => [`${e.from}->${e.to}`, `${e.to}->${e.from}`]),
  );
  const old = new Map(next.edges.filter((e) => e.origin === 'code').map((e) => [e.id, e]));
  const taken = new Set(keptEdges.map((e) => e.id));
  const systemIds = new Set(next.nodes.filter((n) => n.kind === 'external').map((n) => n.id));
  const fresh: Edge[] = [];
  const add = (from: string, to: string) => {
    if (from === to || drawnPairs.has(`${from}->${to}`)) return;
    if (fresh.some((e) => e.from === from && e.to === to)) return;
    const id = uniqueId(`e-${from}-${to}`, taken);
    taken.add(id);
    // Keep the old edge object (its route) when the same relationship still exists.
    fresh.push(old.get(id) ?? { id, from, to, origin: 'code' });
  };
  for (const e of arch.edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to) continue;
    // On a drawing, only arrows to external systems are added; how the drawn parts talk to
    // each other is what the person drew.
    if (mode === 'link' && !systemIds.has(to)) continue;
    add(from, to);
  }
  if (index) {
    // Boxes people drew: arrows to the systems their own code uses.
    const systems = next.nodes.filter((n) => systemIds.has(n.id) && nodePackages(n).length);
    for (const box of drawnParts) {
      const used = new Set(index.packagesUnder(box.path!));
      for (const s of systems) if (nodePackages(s).some((p) => used.has(p))) add(box.id, s.id);
    }
  }
  next.edges = [...keptEdges, ...fresh].filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  next.codebase = {
    ...next.codebase,
    scannedAt: meta.scannedAt,
    ...(meta.commit ? { commit: meta.commit } : {}),
    ...(folder ? { folder } : {}),
  };
  if (!folder) delete next.codebase.folder;
  if (!meta.commit) delete next.codebase.commit;
  return {
    plan: pruneDanglingRefs(next),
    mode,
    added,
    updated: [...new Set(updated)],
    stale: prune ? [] : stale,
    removed,
  };
}

/** True when the board has anything tied to the code worth checking for drift. */
export function hasCodeLinks(plan: Plan): boolean {
  return !!plan.codebase || plan.nodes.some((n) => n.path || nodePackages(n).length);
}

export function codeSyncMode(plan: Pick<Plan, 'codeSync'>): CodeSyncMode {
  return plan.codeSync ?? 'auto';
}

/**
 * Whether the board is checked against the code: always when code sync is on, never when it
 * is off (links stay, they are just not checked), and when something links to code on auto.
 */
export function isCodeSynced(plan: Plan): boolean {
  const mode = codeSyncMode(plan);
  return mode === 'on' || (mode === 'auto' && hasCodeLinks(plan));
}
