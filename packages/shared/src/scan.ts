import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { dirname, normalizeCodePath, type CodeScan, type ScannedFile } from './codemap.js';
import { git } from './git.js';

/** What one file declares, before its imports are resolved against the rest of the repo. */
interface RawFile {
  lang: ScannedFile['lang'];
  specifiers: string[];
  exports: string[];
  routes: string[];
  models: string[];
}

/** Parse results by file, reused while a file's mtime and size are unchanged. */
export type ScanCache = Map<string, { mtimeMs: number; size: number; raw: RawFile }>;

export interface ScanOptions {
  cache?: ScanCache;
  /** Most source files to parse. */
  maxFiles?: number;
  /**
   * Use git to list files and read the commit (default true). Off in untrusted folders: a
   * repository's config can make git run programs.
   */
  git?: boolean;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_PATHS = 100_000;
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.agentic-whiteboard',
]);

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function langOf(file: string): RawFile['lang'] | undefined {
  // Declarations, generated bundles and tool configs (vite.config.ts, .eslintrc.js) are not
  // architecture: they would turn build tools into "external systems".
  if (/\.d\.[cm]?ts$|[.-]min\.[cm]?js$|[.-]bundle\.[cm]?js$/.test(file)) return undefined;
  if (/(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)\.[\w-]+rc\.[cm]?js$/.test(file)) return undefined;
  const ext = path.extname(file);
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'ts';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.prisma') return 'prisma';
  return undefined;
}

export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec|e2e)\//.test(p) ||
    /[._](test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)test_[^/]+\.py$/.test(p) ||
    /_test\.(py|go)$/.test(p)
  );
}

// File listing

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    if (out.length >= MAX_PATHS) return;
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) await visit(rel);
      } else if (e.isFile()) out.push(rel);
    }
  };
  await visit('');
  return out;
}

/** Every file in the repo: git's view (tracked plus untracked, minus ignored), else a walk. */
export async function listRepoFiles(root: string, useGit = true): Promise<string[]> {
  const listed = useGit
    ? await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    : undefined;
  let files: string[];
  if (listed === undefined) files = await walk(root);
  else {
    // --cached keeps listing a file deleted from disk until the deletion is staged.
    const deleted = new Set(
      ((await git(root, ['ls-files', '-z', '--deleted'])) ?? '')
        .split('\0')
        .filter(Boolean)
        .map(normalizeCodePath),
    );
    files = [
      ...new Set(
        listed
          .split('\0')
          .filter(Boolean)
          .map(normalizeCodePath)
          .filter((f) => !deleted.has(f)),
      ),
    ];
  }
  return files
    .filter((f) => !f.split('/').some((seg) => IGNORED_DIRS.has(seg)))
    .slice(0, MAX_PATHS);
}

// Parsing

const each = (re: RegExp, text: string, group = 1) =>
  [...text.matchAll(re)].map((m) => m[group]!).filter(Boolean);

function stripComments(text: string, lang: RawFile['lang']): string {
  if (lang === 'py') return text.replace(/^\s*#.*$/gm, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const HTTP = '(get|post|put|patch|delete|options|head|all)';

function parseJs(text: string, file: string): Omit<RawFile, 'lang'> {
  const specifiers = [
    ...each(/\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g, text),
    ...each(
      /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/g,
      text,
    ),
    ...each(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, text),
    ...each(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, text),
  ];
  const exports = [
    ...each(
      /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
      text,
    ),
    ...[...text.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)].flatMap((m) =>
      m[1]!
        .split(',')
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
        .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)),
    ),
  ];
  const routes = [
    ...[
      ...text.matchAll(
        new RegExp(
          `\\b(?:app|router|server|api|routes?|fastify|hono)\\.${HTTP}\\(\\s*['"\`]([^'"\`]+)`,
          'gi',
        ),
      ),
    ].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`),
  ];
  // NestJS controllers.
  const controller = /@Controller\(\s*['"]([^'"]*)['"]/.exec(text)?.[1];
  for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g))
    routes.push(
      `${m[1]!.toUpperCase()} /${[controller, m[2]].filter(Boolean).join('/')}`.replace(
        /\/+/g,
        '/',
      ),
    );
  // Next.js route handlers and API pages.
  const appRoute = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/.exec(file);
  if (appRoute)
    for (const verb of each(
      /\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
      text,
    ))
      routes.push(`${verb} /${appRoute[1]}`);
  const apiPage = /(?:^|\/)pages\/(api\/.*?)(?:\/index)?\.[cm]?[jt]sx?$/.exec(file);
  if (apiPage) routes.push(`ANY /${apiPage[1]}`);
  const models = [
    ...each(/\bmongoose\.model\s*(?:<[^>]*>)?\(\s*['"](\w+)/g, text),
    ...each(/\bsequelize\.define\(\s*['"](\w+)/g, text),
    ...each(/@Entity\([^)]*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g, text),
    ...each(/\bclass\s+(\w+)\s+extends\s+Model\b/g, text),
    ...each(/\b(?:pgTable|mysqlTable|sqliteTable)\(\s*['"](\w+)/g, text),
  ];
  return { specifiers, exports, routes, models };
}

function parsePy(text: string): Omit<RawFile, 'lang'> {
  const specifiers = [
    // "from pkg import mod" may name a module ("pkg.mod") or a symbol in "pkg": keep both and
    // let the resolver take the longest one that exists.
    ...[...text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)].flatMap(
      (m) => {
        const base = m[1]!;
        const names = m[2]!
          .replace(/[()\\]/g, ' ')
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0]!)
          .filter((s) => /^\w+$/.test(s));
        const sep = base.endsWith('.') ? '' : '.';
        return [base, ...names.map((n) => `${base}${sep}${n}`)];
      },
    ),
    ...[...text.matchAll(/^\s*import\s+([\w., ]+)/gm)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim().split(/\s+/)[0]!),
    ),
  ];
  const exports = each(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm, text);
  const routes = [...text.matchAll(new RegExp(`@\\w+\\.${HTTP}\\(\\s*['"]([^'"]+)`, 'gi'))].map(
    (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
  );
  routes.push(...each(/@\w+\.route\(\s*['"]([^'"]+)/g, text).map((r) => `ANY ${r}`));
  const models = each(
    /^class\s+(\w+)\s*\([^)]*\b(?:Base|db\.Model|models\.Model|SQLModel|Document)\b[^)]*\)/gm,
    text,
  );
  return { specifiers, exports, routes, models };
}

function parseGo(text: string): Omit<RawFile, 'lang'> {
  const specifiers = [
    ...each(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, text),
    ...[...text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)].flatMap((m) =>
      each(/"([^"]+)"/g, m[1]!),
    ),
  ];
  const exports = each(/^(?:func(?:\s+\([^)]*\))?|type)\s+([A-Z]\w*)/gm, text);
  const routes = [
    ...each(/\bHandleFunc\(\s*"([^"]+)"/g, text).map((r) => `ANY ${r}`),
    ...[...text.matchAll(/\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    ),
  ];
  return { specifiers, exports, routes, models: [] };
}

function parse(text: string, file: string, lang: RawFile['lang']): RawFile {
  const code = stripComments(text, lang);
  const uniq = (r: Omit<RawFile, 'lang'>): RawFile => ({
    lang,
    specifiers: [...new Set(r.specifiers)],
    exports: [...new Set(r.exports)],
    routes: [...new Set(r.routes)],
    models: [...new Set(r.models)],
  });
  switch (lang) {
    case 'ts':
    case 'js':
      return uniq(parseJs(code, file));
    case 'py':
      return uniq(parsePy(code));
    case 'go':
      return uniq(parseGo(code));
    case 'prisma':
      return uniq({
        specifiers: [],
        exports: [],
        routes: [],
        models: each(/^\s*model\s+(\w+)\s*\{/gm, code),
      });
  }
}

// Resolution

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]!));
const PY_STDLIB = new Set(
  (
    'abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent contextlib ' +
    'copy csv ctypes dataclasses datetime decimal difflib enum errno functools gc getpass glob gzip ' +
    'hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math ' +
    'mimetypes multiprocessing operator os pathlib pickle platform pprint queue random re secrets ' +
    'select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys ' +
    'tempfile textwrap threading time timeit traceback types typing unittest urllib uuid warnings ' +
    'weakref xml zipfile zoneinfo __future__ _thread binascii bz2 cmath codecs colorsys ' +
    'configparser contextvars copyreg cProfile curses dbm doctest email encodings filecmp ' +
    'fileinput fnmatch fractions ftplib getopt gettext graphlib imaplib locale lzma mailbox ' +
    'marshal mmap numbers optparse pdb pkgutil poplib posixpath profile pstats pty pwd quopri ' +
    'readline reprlib resource runpy sched selectors shelve site smtplib socketserver stringprep ' +
    'symtable sysconfig tarfile termios tkinter token tokenize tomllib trace tty turtle ' +
    'unicodedata venv wave webbrowser wsgiref xmlrpc zipimport zlib'
  ).split(' '),
);

/** "@scope/pkg/sub" -> "@scope/pkg"; "lodash/fp" -> "lodash". */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

interface Workspace {
  dir: string;
  exports: Record<string, string>;
}

function exportTarget(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return exportTarget(o.source ?? o.import ?? o.default ?? o.require ?? o.types);
  }
  return undefined;
}

/** Packages that live in this repo (monorepo workspaces), by name. */
async function workspacePackages(root: string, paths: readonly string[]) {
  const map = new Map<string, Workspace>();
  for (const p of paths) {
    if (!p.endsWith('package.json') || (p !== 'package.json' && !p.endsWith('/package.json')))
      continue;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, p), 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof pkg.name !== 'string') continue;
      const dir = dirname(p) === '.' ? '' : dirname(p);
      const exports: Record<string, string> = {};
      const raw = pkg.exports;
      if (
        typeof raw === 'string' ||
        (raw && typeof raw === 'object' && !Object.keys(raw).some((k) => k.startsWith('.')))
      ) {
        const t = exportTarget(raw);
        if (t) exports['.'] = t;
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          const t = exportTarget(v);
          if (t) exports[k] = t;
        }
      }
      const main = [pkg.source, pkg.module, pkg.main].find((m) => typeof m === 'string') as
        string | undefined;
      if (!exports['.'] && main) exports['.'] = main;
      map.set(pkg.name, { dir, exports });
    } catch {
      // Not valid JSON; skip it.
    }
  }
  return map;
}

async function goModule(root: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(root, 'go.mod'), 'utf8').catch(() => '');
  return /^module\s+(\S+)/m.exec(text)?.[1];
}

/** Module resolution settings from one tsconfig.json or jsconfig.json. */
interface TsConfig {
  /** Folder the config applies to (its own folder), repo-relative; "" for the root. */
  dir: string;
  baseUrl?: string;
  paths: { pattern: string; targets: string[]; base: string }[];
}

const isUnderDir = (file: string, dir: string) => !dir || file.startsWith(dir + '/');

/** JSON with comments and trailing commas, as tsconfig files allow. Strings stay intact. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface RawCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

async function readTsConfig(
  root: string,
  file: string,
  depth = 0,
): Promise<{ baseUrl?: string; paths?: { map: Record<string, string[]>; base: string } }> {
  let json: { extends?: unknown; compilerOptions?: RawCompilerOptions };
  try {
    json = parseJsonc(await fs.readFile(path.join(root, file), 'utf8')) as typeof json;
  } catch {
    return {};
  }
  const dir = dirname(file) === '.' ? '' : dirname(file);
  // Relative `extends` only: package presets (@tsconfig/…) do not set paths for this repo.
  const parentRef = typeof json.extends === 'string' ? json.extends : undefined;
  let inherited: Awaited<ReturnType<typeof readTsConfig>> = {};
  if (parentRef?.startsWith('.') && depth < 5) {
    let parent = path.posix.normalize(path.posix.join(dir, parentRef));
    if (!parent.endsWith('.json')) parent += '.json';
    if (!parent.startsWith('..')) inherited = await readTsConfig(root, parent, depth + 1);
  }
  const opts = json.compilerOptions ?? {};
  const baseUrl =
    typeof opts.baseUrl === 'string'
      ? path.posix.normalize(path.posix.join(dir, opts.baseUrl))
      : inherited.baseUrl;
  const paths =
    opts.paths && typeof opts.paths === 'object'
      ? { map: opts.paths, base: baseUrl ?? dir }
      : inherited.paths;
  return { ...(baseUrl !== undefined ? { baseUrl } : {}), ...(paths ? { paths } : {}) };
}

/** Every tsconfig.json / jsconfig.json with paths or baseUrl, nearest-first for lookups. */
async function tsConfigs(root: string, paths: readonly string[]): Promise<TsConfig[]> {
  const out: TsConfig[] = [];
  for (const file of paths) {
    if (!/(^|\/)(tsconfig|jsconfig)\.json$/.test(file)) continue;
    const cfg = await readTsConfig(root, file);
    if (cfg.baseUrl === undefined && !cfg.paths) continue;
    const dir = dirname(file) === '.' ? '' : dirname(file);
    const toNorm = (b: string) => (b === '.' ? '' : b);
    const entry: TsConfig = {
      dir,
      ...(cfg.baseUrl !== undefined ? { baseUrl: toNorm(cfg.baseUrl) } : {}),
      paths: Object.entries(cfg.paths?.map ?? {})
        .filter(([, t]) => Array.isArray(t))
        .map(([pattern, targets]) => ({
          pattern,
          targets: targets.filter((t) => typeof t === 'string'),
          base: toNorm(cfg.paths!.base),
        })),
    };
    const same = out.findIndex((c) => c.dir === dir);
    if (same < 0) out.push(entry);
    // A tsconfig.json beats a jsconfig.json in the same folder.
    else if (file.endsWith('tsconfig.json')) out[same] = entry;
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

class Resolver {
  /** Go package directory -> one non-test file in it. */
  private readonly goDirs = new Map<string, string>();

  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly workspaces: ReadonlyMap<string, Workspace>,
    private readonly goMod: string | undefined,
    private readonly pyRoots: readonly string[],
    /** Nearest first: sorted by directory depth, deepest first. */
    private readonly tsConfigs: readonly TsConfig[] = [],
  ) {
    for (const f of files)
      if (f.endsWith('.go') && !f.endsWith('_test.go') && !this.goDirs.has(dirname(f)))
        this.goDirs.set(dirname(f), f);
  }

  private readonly firstSource = new Map<string, string | undefined>();

  private firstSourceIn(dir: string): string | undefined {
    if (!this.firstSource.has(dir)) {
      const found = [...this.files]
        .filter(
          (f) => isUnderDir(f, dir) && (langOf(f) === 'ts' || langOf(f) === 'js') && !isTestPath(f),
        )
        .sort()[0];
      this.firstSource.set(dir, found);
    }
    return this.firstSource.get(dir);
  }

  /** Finds the repo file a JS/TS path points to, trying extensions and index files. */
  private jsFile(base: string): string | undefined {
    const p = path.posix.normalize(base);
    if (this.files.has(p) && langOf(p)) return p;
    const stem = p.replace(/\.([cm]?js|jsx)$/, '');
    for (const ext of JS_EXT) if (this.files.has(stem + ext)) return stem + ext;
    for (const ext of JS_EXT) if (this.files.has(`${p}/index${ext}`)) return `${p}/index${ext}`;
    return undefined;
  }

  resolve(spec: string, from: string, lang: RawFile['lang']): { file?: string; pkg?: string } {
    if (lang === 'ts' || lang === 'js') return this.resolveJs(spec, from);
    if (lang === 'py') return this.resolvePy(spec, from);
    if (lang === 'go') return this.resolveGo(spec);
    return {};
  }

  /** tsconfig/jsconfig `paths` and `baseUrl` of the config nearest to `from`. */
  private viaTsConfig(spec: string, from: string): string | undefined {
    const cfg = this.tsConfigs.find((c) => isUnderDir(from, c.dir));
    if (!cfg) return undefined;
    for (const { pattern, targets, base } of cfg.paths) {
      const star = pattern.indexOf('*');
      let rest: string | undefined;
      if (star < 0) rest = pattern === spec ? '' : undefined;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
          rest = spec.slice(pre.length, spec.length - post.length);
      }
      if (rest === undefined) continue;
      for (const t of targets) {
        const file = this.jsFile(path.posix.join(base, t.replace('*', rest)));
        if (file) return file;
      }
    }
    return cfg.baseUrl !== undefined ? this.jsFile(path.posix.join(cfg.baseUrl, spec)) : undefined;
  }

  private resolveJs(spec: string, from: string) {
    if (spec.startsWith('.')) {
      const file = this.jsFile(path.posix.join(dirname(from), spec));
      return file ? { file } : {};
    }
    // node:, bun:, virtual: modules and URL imports are not packages in this repo.
    if (spec.includes(':')) return {};
    const aliased = this.viaTsConfig(spec, from);
    if (aliased) return { file: aliased };
    const name = packageName(spec);
    if (NODE_BUILTINS.has(name)) return {};
    const ws = this.workspaces.get(name);
    if (ws) {
      const sub = spec.slice(name.length);
      const target = ws.exports[sub ? `.${sub}` : '.'];
      const base = (rel: string) => path.posix.join(ws.dir, rel);
      const file =
        (target && this.jsFile(base(target))) ??
        (sub ? (this.jsFile(base(sub.slice(1))) ?? this.jsFile(base(`src${sub}`))) : undefined) ??
        (!sub ? (this.jsFile(base('src/index')) ?? this.jsFile(base('index'))) : undefined) ??
        // No entry point declared: any source file shows the package is used.
        this.firstSourceIn(ws.dir);
      return file ? { file } : {};
    }
    // "~/x" and "@/x" path aliases usually point at src/.
    const alias = /^[~@]\/(.*)$/.exec(spec);
    if (alias) {
      const file = this.jsFile(`src/${alias[1]}`) ?? this.jsFile(alias[1]!);
      return file ? { file } : {};
    }
    return { pkg: name };
  }

  private pyFile(mod: string, base: string) {
    const rel = mod.replace(/\./g, '/');
    for (const c of [`${rel}.py`, `${rel}/__init__.py`]) {
      const p = path.posix.normalize(base ? `${base}/${c}` : c);
      if (this.files.has(p)) return p;
    }
    return undefined;
  }

  /** "a.b.c" may name a module or a symbol in "a.b": the longest module that exists. */
  private pyLongest(mod: string, base: string) {
    const parts = mod.split('.');
    for (let n = parts.length; n > 0; n--) {
      const file = this.pyFile(parts.slice(0, n).join('.'), base);
      if (file) return file;
    }
    return undefined;
  }

  private resolvePy(spec: string, from: string) {
    const dots = /^\.*/.exec(spec)![0].length;
    if (dots) {
      let dir = dirname(from);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      const rest = spec.slice(dots);
      const base = dir === '.' ? '' : dir;
      const file = rest ? this.pyLongest(rest, base) : this.pyFile('__init__', base);
      return file ? { file } : {};
    }
    for (const r of this.pyRoots) {
      const file = this.pyLongest(spec, r);
      if (file) return { file };
    }
    const top = spec.split('.')[0]!;
    return PY_STDLIB.has(top) ? {} : { pkg: top };
  }

  private resolveGo(spec: string) {
    if (this.goMod && (spec === this.goMod || spec.startsWith(this.goMod + '/'))) {
      const file = this.goDirs.get(spec.slice(this.goMod.length + 1) || '.');
      return file ? { file } : {};
    }
    // Standard library paths have no dot in their first segment.
    return spec.split('/')[0]!.includes('.') ? { pkg: spec.split('/').slice(0, 3).join('/') } : {};
  }
}

/** Scans the repository: every file, plus imports, exports, routes and models of source files. */
export async function scanRepo(root: string, opts: ScanOptions = {}): Promise<CodeScan> {
  const useGit = opts.git ?? true;
  const paths = await listRepoFiles(root, useGit);
  const sources = paths.filter((p) => langOf(p));
  const maxFiles = opts.maxFiles ?? 5000;
  const cache = opts.cache;
  const raws = new Map<string, RawFile>();
  const seen = new Set<string>();

  const parseOne = async (p: string) => {
    const abs = path.join(root, p);
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return;
    seen.add(p);
    const hit = cache?.get(p);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      raws.set(p, hit.raw);
      return;
    }
    const text = await fs.readFile(abs, 'utf8').catch(() => undefined);
    if (text === undefined) return;
    const raw = parse(text, p, langOf(p)!);
    cache?.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
    raws.set(p, raw);
  };
  const queue = sources.slice(0, maxFiles);
  // A few files at a time keeps the number of open handles low.
  for (let i = 0; i < queue.length; i += 32)
    await Promise.all(queue.slice(i, i + 32).map(parseOne));
  if (cache) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);

  const fileSet = new Set(paths);
  const pyRoots = ['', 'src', ...paths.filter((p) => p.endsWith('/pyproject.toml')).map(dirname)];
  const workspaces = await workspacePackages(root, paths);
  const resolver = new Resolver(
    fileSet,
    workspaces,
    await goModule(root),
    [...new Set(pyRoots)],
    await tsConfigs(root, paths),
  );

  const files: ScannedFile[] = [];
  for (const [p, raw] of [...raws].sort(([a], [b]) => a.localeCompare(b))) {
    const imports = new Set<string>();
    const packages = new Set<string>();
    for (const spec of raw.specifiers) {
      const r = resolver.resolve(spec, p, raw.lang);
      if (r.file && r.file !== p) imports.add(r.file);
      if (r.pkg) packages.add(r.pkg);
    }
    files.push({
      path: p,
      lang: raw.lang,
      test: isTestPath(p),
      imports: [...imports].sort(),
      packages: [...packages].sort(),
      exports: raw.exports,
      routes: raw.routes,
      models: raw.models,
    });
  }
  const commit = useGit ? await git(root, ['rev-parse', '--short', 'HEAD']) : undefined;
  return {
    scannedAt: new Date().toISOString(),
    ...(commit ? { commit: commit.trim() } : {}),
    paths,
    files,
    workspaces: [...workspaces]
      .filter(([, w]) => w.dir)
      .map(([name, w]) => ({ dir: w.dir, name }))
      .sort((a, b) => a.dir.localeCompare(b.dir)),
    ...(sources.length > maxFiles ? { truncated: true } : {}),
  };
}
