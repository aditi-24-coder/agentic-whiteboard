import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergePlans, type MergeOptions } from './merge.js';
import { isBoardFileName, type Plan } from './schema.js';
import { parsePlanText, serializePlan } from './text.js';

export { parsePlanText, serializePlan, type ParseResult } from './text.js';

export class PlanParseError extends Error {
  constructor(
    readonly file: string,
    readonly errors: string[],
  ) {
    super(`Invalid plan file ${file}:\n  - ${errors.join('\n  - ')}`);
    this.name = 'PlanParseError';
  }
}

export async function readPlan(file: string): Promise<Plan> {
  const text = await fs.readFile(file, 'utf8');
  const res = parsePlanText(text);
  if (!res.ok) throw new PlanParseError(file, res.errors);
  return res.plan;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function renameWithRetry(from: string, to: string) {
  // On Windows a rename onto a file that another process (an editor or a watcher) has open
  // fails briefly with EPERM or EBUSY.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 20) throw err;
      await sleep(10 + attempt * 10);
    }
  }
}

/** Writes the plan to a temp file in the same directory, then renames it into place. */
export async function writePlanAtomic(file: string, plan: Plan): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tmp, serializePlan(plan), 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

const LOCK_STALE_MS = 10_000;

/** Cooperative lock shared by every plan writer: MCP servers (via updatePlanFile) and the extension. */
export async function withPlanLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.close();
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      // EPERM: on Windows the previous holder's lock file can still be pending deletion.
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for lock on ${file}`, { cause: err });
      await sleep(15 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Read, modify, write. If the file changed between the read and the write (for example the
 * user saved the board in VS Code), the change is three-way merged instead of overwritten.
 */
export async function updatePlanFile(
  file: string,
  mutate: (plan: Plan) => Plan | void | Promise<Plan | void>,
  opts: MergeOptions = {},
): Promise<Plan> {
  return withPlanLock(file, async () => {
    const base = await readPlan(file);
    const draft = structuredClone(base);
    const ours = (await mutate(draft)) ?? draft;
    const disk = await readPlan(file);
    const merged = disk.revision === base.revision ? ours : mergePlans(base, ours, disk, opts);
    const next: Plan = {
      ...merged,
      revision: Math.max(disk.revision, base.revision) + 1,
      updatedAt: new Date().toISOString(),
    };
    await writePlanAtomic(file, next);
    return next;
  });
}

/**
 * Creates a plan file, failing if it already exists. The content appears in one step (a hard
 * link from a fully written temp file), so file watchers never see an empty file.
 */
export async function createPlanFile(file: string, plan: Plan): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(tmp, serializePlan(plan), 'utf8');
  try {
    await fs.link(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    // File systems without hard links: reserve the name, then replace it atomically.
    const handle = await fs.open(file, 'wx');
    await handle.close();
    await renameWithRetry(tmp, file);
    return;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export const PLAN_FILE_SUFFIX = '.plan.json';

export interface PlanFileInfo {
  file: string;
  plan?: Plan;
  errors?: string[];
  mtimeMs: number;
}

export async function listPlanFiles(dir: string): Promise<PlanFileInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PlanFileInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(PLAN_FILE_SUFFIX)) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) continue;
    try {
      out.push({ file, plan: await readPlan(file), mtimeMs: stat.mtimeMs });
    } catch (err) {
      const errors =
        err instanceof PlanParseError ? err.errors : [`Unreadable: ${(err as Error).message}`];
      out.push({ file, errors, mtimeMs: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readBoardInfo(file: string): Promise<PlanFileInfo | undefined> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  try {
    return { file, plan: await readPlan(file), mtimeMs: stat.mtimeMs };
  } catch (err) {
    const errors =
      err instanceof PlanParseError ? err.errors : [`Unreadable: ${(err as Error).message}`];
    return { file, errors, mtimeMs: stat.mtimeMs };
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.agent',
]);

/**
 * Every whiteboard (`*.whiteboard`, and legacy `*.plan.json`) under `root`, newest first.
 * Skips dependency and build folders.
 */
export async function findBoardFiles(root: string, maxDepth = 8): Promise<PlanFileInfo[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name))
          await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && isBoardFileName(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  await walk(root, 0);
  const infos = await Promise.all(files.map(readBoardInfo));
  return infos.filter((i): i is PlanFileInfo => !!i).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The board the user last focused in VS Code. The extension records it in a small file in the
// temp folder, so that an MCP server started by any agent can draw on the board the user is
// looking at.
const ACTIVE_FILE = path.join(os.tmpdir(), 'agentic-whiteboard-active-boards.json');

interface ActiveEntry {
  file: string;
  at: number;
}

async function readActiveEntries(): Promise<ActiveEntry[]> {
  try {
    const data = JSON.parse(await fs.readFile(ACTIVE_FILE, 'utf8')) as { boards?: ActiveEntry[] };
    return Array.isArray(data.boards)
      ? data.boards.filter((b) => typeof b?.file === 'string' && typeof b.at === 'number')
      : [];
  } catch {
    return [];
  }
}

export async function recordActiveBoard(file: string): Promise<void> {
  const boards = [
    { file, at: Date.now() },
    ...(await readActiveEntries()).filter((b) => b.file !== file),
  ].slice(0, 20);
  const tmp = `${ACTIVE_FILE}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ boards }), 'utf8');
    await renameWithRetry(tmp, ACTIVE_FILE);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function isInside(root: string, file: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const rel = path.relative(norm(root), norm(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The most recently focused board inside `root` that still exists. */
export async function activeBoardIn(root: string): Promise<string | undefined> {
  for (const b of (await readActiveEntries()).sort((x, y) => y.at - x.at)) {
    if (!isInside(root, b.file)) continue;
    if (
      await fs
        .stat(b.file)
        .then((s) => s.isFile())
        .catch(() => false)
    )
      return b.file;
  }
  return undefined;
}

// An AI changing a board. MCP servers record each change in a small file per board in the temp
// folder, so the extension can lock the board while an agent is working on it.
const ACTIVITY_DIR = path.join(os.tmpdir(), 'agentic-whiteboard-agent');
/** How long after an agent's last change its board stays locked, unless it said it is done. */
export const AGENT_IDLE_MS = 20_000;
/** A change still in progress after this long is assumed to have died with its server. */
const AGENT_STUCK_MS = 120_000;

export interface AgentActivity {
  /** When the agent last started or finished a change. */
  at: number;
  /** A change is being written right now. */
  writing: boolean;
  /** The agent said it finished (tidy_layout). */
  done: boolean;
}

function activityFile(board: string): string {
  const resolved = path.resolve(board);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return path.join(ACTIVITY_DIR, `${createHash('sha1').update(key).digest('hex')}.json`);
}

export async function recordAgentActivity(
  board: string,
  state: { writing?: boolean; done?: boolean },
): Promise<void> {
  const file = activityFile(board);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const activity: AgentActivity = {
    at: Date.now(),
    writing: !!state.writing,
    done: !!state.done,
  };
  try {
    await fs.mkdir(ACTIVITY_DIR, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(activity), 'utf8');
    await renameWithRetry(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function readAgentActivity(board: string): Promise<AgentActivity | undefined> {
  try {
    const a = JSON.parse(await fs.readFile(activityFile(board), 'utf8')) as Partial<AgentActivity>;
    return typeof a.at === 'number'
      ? { at: a.at, writing: a.writing === true, done: a.done === true }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an agent is still working on the board, judged from its last recorded activity. */
export function isAgentWorking(a: AgentActivity | undefined, now = Date.now()): boolean {
  if (!a) return false;
  if (a.writing) return now - a.at < AGENT_STUCK_MS;
  return !a.done && now - a.at < AGENT_IDLE_MS;
}
