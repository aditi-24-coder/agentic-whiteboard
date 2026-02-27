import {
  CodeIndex,
  applyArchitecture,
  architectureFromScan,
  basename,
  dirname,
  isBoardPath,
  isUnder,
  nodePackages,
  normalizeCodePath,
  uniqueSorted,
  type ArchitectureOptions,
  type CodeScan,
} from './codemap.js';
import type { Edge, Plan, PlanNode } from './schema.js';

export type DriftKind =
  /** A linked file or folder is gone. */
  | 'missing'
  /** A linked file is gone but a file with the same name exists elsewhere. */
  | 'renamed'
  /** A planned box (changeType "new") still has no code, though the plan is underway. */
  | 'not-implemented'
  /** A planned deletion has not happened, though the plan is done. */
  | 'not-deleted'
  /** The box's code imports different external packages than at the baseline. */
  | 'deps-changed'
  /** An external system's package is no longer imported anywhere. */
  | 'package-unused'
  /** An arrow between linked boxes has no import behind it. */
  | 'edge-unbacked'
  /** Code imports between two boxes that have no arrow. */
  | 'edge-missing'
  /** Source folders that no box covers (boards generated from code only). */
  | 'unmapped'
  /** Files changed outside what the approved plan touches. */
  | 'unplanned-change';

export type DriftSeverity = 'error' | 'warning' | 'info';

export interface DriftItem {
  kind: DriftKind;
  severity: DriftSeverity;
  /** Box or arrow id the drift is about; none for board-wide drift. */
  targetId?: string;
  message: string;
  files?: string[];
  /** Repo path that likely replaces a missing one. */
  suggestion?: string;
}

export interface DriftOptions {
  /** Files changed in the working tree (from git). Enables unplanned-change detection. */
  changedFiles?: readonly string[];
}

const UNDERWAY = new Set<Plan['status']>(['approved', 'in_progress', 'done']);
const MAX_PER_KIND = 20;

const nodeName = (n: PlanNode) => `"${n.label.split('\n')[0]}"`;
const quotePkgs = (pkgs: readonly string[]) => pkgs.map((p) => `"${p}"`).join(' or ');

// Shared checks, used both to detect drift and to record the baseline it is measured against

/** Boxes whose path exists in the repo, with their normalised path. */
function linkedPaths(plan: Plan, index: CodeIndex): Map<string, string> {
  const linked = new Map<string, string>();
  for (const n of plan.nodes) {
    if (!n.path) continue;
    const p = index.resolve(n.path);
    if (p !== undefined) linked.set(n.id, p);
  }
  return linked;
}

/**
 * Whether the code behind an arrow imports its target: the target's files, or its package for
 * an external system. Undefined when the arrow cannot be checked (an end is not linked).
 */
function edgeBacked(
  e: Edge,
  byId: ReadonlyMap<string, PlanNode>,
  index: CodeIndex,
  linked: ReadonlyMap<string, string>,
): boolean | undefined {
  const pa = linked.get(e.from);
  const b = byId.get(e.to);
  if (!pa || !b) return undefined;
  const pkgs = nodePackages(b);
  if (pkgs.length)
    return index.filesUnder(pa).some((f) => f.packages.some((p) => pkgs.includes(p)));
  const pb = linked.get(b.id);
  if (!pb) return undefined;
  const targets = new Set(index.filesUnder(pb).map((f) => f.path));
  return index.filesUnder(pa).some((f) => f.imports.some((i) => targets.has(i)));
}

/** Box-to-box imports in the code ("from->to" to the importing files), nesting excluded. */
function importPairs(
  plan: Plan,
  index: CodeIndex,
  linked: ReadonlyMap<string, string>,
): Map<string, string[]> {
  // Each source file belongs to the box with the most specific path covering it.
  const owners = [...linked].sort(([, a], [, b]) => b.length - a.length);
  const ownerOf = (file: string) => owners.find(([, p]) => isUnder(file, p))?.[0];
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const contains = (outer: string, inner: string) => {
    for (let p = byId.get(inner)?.parentId; p; p = byId.get(p)?.parentId)
      if (p === outer) return true;
    return isUnder(linked.get(inner)!, linked.get(outer)!);
  };
  const pairs = new Map<string, string[]>();
  for (const f of index.scan.files) {
    if (f.test) continue;
    const from = ownerOf(f.path);
    if (!from) continue;
    for (const imp of f.imports) {
      const to = ownerOf(imp);
      if (!to || to === from || contains(from, to) || contains(to, from)) continue;
      const k = `${from}->${to}`;
      pairs.set(k, uniqueSorted([...(pairs.get(k) ?? []), f.path]));
    }
  }
  return pairs;
}

/** A box planned as new counts as built once a sync or a verified step recorded its code. */
const isBuilt = (n: PlanNode, plan: Plan) =>
  n.deps !== undefined || plan.edges.some((e) => e.to === n.id && e.imported);

/** Checks a board against the code and lists every place where they disagree. */
export function detectDrift(plan: Plan, scan: CodeScan, opts: DriftOptions = {}): DriftItem[] {
  const index = CodeIndex.for(scan);
  const items: DriftItem[] = [];
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const underway = UNDERWAY.has(plan.status);
  const doneSteps = plan.steps.filter((s) => s.status === 'done');
  const claimedPaths = new Set(plan.nodes.map((n) => n.path && normalizeCodePath(n.path)));
  const linked = linkedPaths(plan, index);

  for (const n of plan.nodes) {
    const planned = n.changeType === 'new' && !isBuilt(n, plan);
    const stepDone = doneSteps.some((s) => s.nodeIds.includes(n.id));
    if (!n.path) {
      // A planned external system is "built" once some code imports its package.
      const pkgs = nodePackages(n);
      if (
        planned &&
        pkgs.length &&
        (underway || stepDone) &&
        !pkgs.some((p) => index.importersOf(p).length)
      )
        items.push({
          kind: 'not-implemented',
          severity: plan.status === 'done' || stepDone ? 'error' : 'warning',
          targetId: n.id,
          message: `${nodeName(n)} is planned but no code imports ${quotePkgs(pkgs)} yet.`,
        });
      continue;
    }
    const p = normalizeCodePath(n.path);
    const exists = linked.has(n.id);
    if (planned) {
      if (!exists && (underway || stepDone))
        items.push({
          kind: 'not-implemented',
          severity: plan.status === 'done' || stepDone ? 'error' : 'warning',
          targetId: n.id,
          message: `${nodeName(n)} is planned as new but ${p} does not exist yet.`,
          files: [p],
        });
      continue;
    }
    if (n.changeType === 'delete') {
      if (exists && plan.status === 'done')
        items.push({
          kind: 'not-deleted',
          severity: 'warning',
          targetId: n.id,
          message: `${nodeName(n)} was planned for deletion but ${p} still exists.`,
          files: [p],
        });
      continue;
    }
    if (exists) continue;
    const name = basename(p);
    const candidate = scan.paths.find(
      (x) => basename(x) === name && x !== p && !claimedPaths.has(x),
    );
    items.push(
      candidate
        ? {
            kind: 'renamed',
            severity: 'warning',
            targetId: n.id,
            message: `${nodeName(n)} points to ${p}, which is gone. It may have moved to ${candidate}.`,
            files: [p],
            suggestion: candidate,
          }
        : isBuilt(n, plan) || n.origin === 'code'
          ? {
              kind: 'missing',
              severity: 'error',
              targetId: n.id,
              message: `${nodeName(n)} points to ${p}, which no longer exists.`,
              files: [p],
            }
          : // Never seen with code: it may have been deleted, or it may not be built yet.
            {
              kind: 'missing',
              severity: 'warning',
              targetId: n.id,
              message: `${nodeName(n)} points to ${p}, which does not exist. If it is still to be built, mark the box as new.`,
              files: [p],
            },
    );
  }

  // Dependencies: what the code imports now versus at the baseline.
  for (const n of plan.nodes) {
    const p = linked.get(n.id);
    if (!p || !n.deps) continue;
    const now = new Set(index.packagesUnder(p));
    const before = new Set(n.deps);
    const added = [...now].filter((d) => !before.has(d));
    const removed = [...before].filter((d) => !now.has(d));
    if (!added.length && !removed.length) continue;
    const parts = [
      added.length ? `now imports ${added.join(', ')}` : '',
      removed.length ? `no longer imports ${removed.join(', ')}` : '',
    ].filter(Boolean);
    items.push({
      kind: 'deps-changed',
      severity: 'warning',
      targetId: n.id,
      message: `${nodeName(n)} ${parts.join(' and ')}.`,
    });
  }

  const hasCode = scan.files.length > 0;
  for (const n of plan.nodes) {
    const pkgs = nodePackages(n);
    if (!pkgs.length || !hasCode) continue;
    if (n.changeType === 'new' && !isBuilt(n, plan)) continue; // Handled as not-implemented.
    if (pkgs.some((p) => index.importersOf(p).some((f) => !f.test))) continue;
    items.push({
      kind: 'package-unused',
      severity: 'warning',
      targetId: n.id,
      message: `${nodeName(n)}: no code imports ${quotePkgs(pkgs)} any more.`,
    });
  }

  // Arrows: each one between linked boxes should have an import behind it. Arrows that had
  // one at the baseline and lost it are a real change; hand-drawn arrows that never had one
  // are probably runtime calls (HTTP, events) and only get a note.
  for (const e of plan.edges) {
    if (edgeBacked(e, byId, index, linked) !== false) continue;
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const bPkgs = nodePackages(b);
    const strict = e.origin === 'code' || bPkgs.length > 0 || e.imported === true;
    const from = linked.get(e.from);
    items.push({
      kind: 'edge-unbacked',
      severity: strict ? 'warning' : 'info',
      targetId: e.id,
      message: e.imported
        ? `Arrow ${nodeName(a)} -> ${nodeName(b)}: the import behind it is gone.`
        : bPkgs.length
          ? `Arrow ${nodeName(a)} -> ${nodeName(b)}: no code in ${from} imports ${quotePkgs(bPkgs)}.`
          : `Arrow ${nodeName(a)} -> ${nodeName(b)}: no import from ${from} to ${linked.get(b.id)}` +
            (strict ? '.' : ' (fine if it is a runtime call, like HTTP).'),
    });
  }

  if (plan.codebase) items.push(...structuralDrift(plan, index, linked));

  if (opts.changedFiles && (plan.status === 'approved' || plan.status === 'in_progress')) {
    const planned = new Set<string>();
    for (const n of plan.nodes)
      if (n.path && n.changeType !== 'unchanged') planned.add(normalizeCodePath(n.path));
    for (const s of plan.steps)
      for (const id of s.nodeIds) {
        const p = byId.get(id)?.path;
        if (p) planned.add(normalizeCodePath(p));
      }
    // A plan that names no code says nothing about which files it may touch.
    const outside = !planned.size
      ? []
      : opts.changedFiles
          .map(normalizeCodePath)
          .filter((f) => !isBoardPath(f) && ![...planned].some((p) => isUnder(f, p)));
    if (outside.length)
      items.push({
        kind: 'unplanned-change',
        severity: 'warning',
        message: `${outside.length} changed file${outside.length === 1 ? ' is' : 's are'} outside the approved plan: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}.`,
        files: outside,
      });
  }

  return items;
}

/** Imports with no arrow, and (on boards generated from code) source folders with no box. */
function structuralDrift(
  plan: Plan,
  index: CodeIndex,
  linked: ReadonlyMap<string, string>,
): DriftItem[] {
  const items: DriftItem[] = [];
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const generated = plan.nodes.some((n) => n.origin === 'code');
  const baseline = plan.codebase?.links ? new Set(plan.codebase.links) : undefined;
  const arrows = new Set(plan.edges.map((e) => `${e.from}->${e.to}`));

  // With a baseline, only imports added since then count: that is an architecture change.
  // Without one, a board generated from code should show every import.
  if (baseline || generated) {
    const fresh = [...importPairs(plan, index, linked)].filter(
      ([k]) => !arrows.has(k) && !baseline?.has(k),
    );
    for (const [k, files] of fresh.slice(0, MAX_PER_KIND)) {
      const [from, to] = k.split('->') as [string, string];
      items.push({
        kind: 'edge-missing',
        severity: baseline ? 'warning' : 'info',
        targetId: from,
        message: `${nodeName(byId.get(from)!)} ${baseline ? 'now imports' : 'imports'} ${nodeName(byId.get(to)!)}, but there is no arrow.`,
        files,
      });
    }
  }

  if (generated) {
    const folder = plan.codebase?.folder ?? '';
    const owned = [...linked.values()];
    const unmapped = new Map<string, string[]>();
    for (const f of index.scan.files) {
      if (f.test || !isUnder(f.path, folder) || owned.some((p) => isUnder(f.path, p))) continue;
      const d = dirname(f.path);
      unmapped.set(d, [...(unmapped.get(d) ?? []), f.path]);
    }
    for (const [dir, files] of [...unmapped].slice(0, MAX_PER_KIND))
      items.push({
        kind: 'unmapped',
        severity: 'info',
        message: `${files.length} source file${files.length === 1 ? '' : 's'} in ${dir} ${files.length === 1 ? 'is' : 'are'} not on the diagram.`,
        files,
      });
  }
  return items;
}

// Baseline and sync

/**
 * Records what the code looks like now as the baseline later drift is measured against: each
 * linked box's packages, which arrows have an import behind them, and which boxes import each
 * other. `nodeIds` limits it to some boxes (a verified step); the default is every box.
 */
export function recordBaseline(plan: Plan, scan: CodeScan, nodeIds?: readonly string[]): Plan {
  const index = CodeIndex.for(scan);
  const next: Plan = structuredClone(plan);
  const only = nodeIds ? new Set(nodeIds) : undefined;
  const linked = linkedPaths(next, index);
  const byId = new Map(next.nodes.map((n) => [n.id, n]));
  const inScope = (id: string) => !only || only.has(id);

  for (const n of next.nodes) {
    const p = linked.get(n.id);
    if (p && inScope(n.id)) n.deps = index.packagesUnder(p);
  }
  for (const e of next.edges) {
    if (!inScope(e.from) && !inScope(e.to)) continue;
    if (edgeBacked(e, byId, index, linked)) e.imported = true;
    else delete e.imported;
  }
  const pairs = [...importPairs(next, index, linked).keys()];
  const kept = (next.codebase?.links ?? []).filter((k) => {
    const [from, to] = k.split('->') as [string, string];
    return only ? !(only.has(from) || only.has(to)) : false;
  });
  const fresh = pairs.filter((k) => {
    const [from, to] = k.split('->') as [string, string];
    return inScope(from) || inScope(to);
  });
  next.codebase = {
    ...next.codebase,
    scannedAt: scan.scannedAt,
    ...(scan.commit ? { commit: scan.commit } : {}),
    links: uniqueSorted([...kept, ...fresh]),
  };
  return next;
}

/** Generates or re-syncs a board's architecture from the code, then records the baseline. */
export function syncBoardWithCode(
  plan: Plan,
  scan: CodeScan,
  opts: ArchitectureOptions & { rootName?: string; prune?: boolean } = {},
) {
  const arch = architectureFromScan(scan, opts);
  const res = applyArchitecture(plan, arch, {
    scannedAt: scan.scannedAt,
    ...(scan.commit ? { commit: scan.commit } : {}),
    ...(opts.folder ? { folder: opts.folder } : {}),
    ...(opts.prune === false ? { prune: false } : {}),
    scan,
  });
  const synced = recordBaseline(res.plan, scan);
  // Synced from code: the board is about code from now on (unless someone chose otherwise).
  if (!synced.codeSync) synced.codeSync = 'on';
  return { ...res, plan: synced, empty: !arch.nodes.length };
}

const SEVERITY_RANK: Record<DriftSeverity, number> = { error: 0, warning: 1, info: 2 };

export function worstSeverity(items: readonly DriftItem[]): DriftSeverity | undefined {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]
    ?.severity;
}

/** Drift grouped by the box or arrow it concerns. */
export function driftByTarget(items: readonly DriftItem[]): Map<string, DriftItem[]> {
  const map = new Map<string, DriftItem[]>();
  for (const it of items)
    if (it.targetId) map.set(it.targetId, [...(map.get(it.targetId) ?? []), it]);
  return map;
}

/** Plain-text report for agents and logs. */
export function formatDrift(items: readonly DriftItem[]): string {
  if (!items.length) return 'No drift: the diagram matches the code.';
  const sorted = [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const counts = (['error', 'warning', 'info'] as const)
    .map((s) => [sorted.filter((i) => i.severity === s).length, s] as const)
    .filter(([n]) => n)
    .map(([n, s]) => `${n} ${s}${n === 1 ? '' : 's'}`);
  return [
    `Drift: ${counts.join(', ')}.`,
    ...sorted.map(
      (i) =>
        `- [${i.severity}] ${i.kind}${i.targetId ? ` (${i.targetId})` : ''}: ${i.message}` +
        (i.suggestion ? ` Suggested path: ${i.suggestion}.` : ''),
    ),
  ].join('\n');
}
