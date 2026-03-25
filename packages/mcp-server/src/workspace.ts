import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  WHITEBOARD_EXT,
  blankBoard,
  boardBaseName,
  isBoardFileName,
  slugify,
  uniqueId,
  type Plan,
} from '@agentic-whiteboard/shared';
import {
  activeBoardIn,
  createPlanFile,
  findBoardFiles,
  readPlan,
  withPlanLock,
  writePlanAtomic,
  type PlanFileInfo,
} from '@agentic-whiteboard/shared/node';

export class ToolError extends Error {}

export interface Workspace {
  /** Absolute workspace root. */
  root(): Promise<string>;
  /** Legacy plans folder; its `.plan.json` files are listed like any other board. */
  plansFolder: string;
}

export interface FoundBoard {
  file: string;
  plan: Plan;
}

export async function listBoards(ws: Workspace): Promise<PlanFileInfo[]> {
  const root = await ws.root();
  const found = await findBoardFiles(root);
  // The plans folder may be configured outside the root.
  const plans = path.resolve(root, ws.plansFolder);
  if (path.relative(root, plans).startsWith('..')) {
    const extra = await findBoardFiles(plans, 0);
    found.push(...extra.filter((e) => !found.some((f) => f.file === e.file)));
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  return found;
}

/** `target` is `dir` or inside it. Case-insensitive on Windows. */
function isWithin(dir: string, target: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const rel = path.relative(norm(dir), norm(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Agents only reach boards inside the workspace, or in the plans folder when it is configured
 * elsewhere, so a tool call cannot read or overwrite files in other places.
 */
function assertInWorkspace(ws: Workspace, root: string, target: string, what: string) {
  if (isWithin(root, target) || isWithin(path.resolve(root, ws.plansFolder), target)) return;
  throw new ToolError(
    `${what} ${target} is outside the workspace (${root}). Whiteboards must be inside it.`,
  );
}

export function relPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Reads a board, turning an empty file (e.g. one the user just created) into a blank board. */
async function loadBoard(file: string): Promise<Plan> {
  const text = await fs.readFile(file, 'utf8');
  if (!text.trim()) {
    return withPlanLock(file, async () => {
      if ((await fs.readFile(file, 'utf8')).trim()) return readPlan(file);
      const name = boardBaseName(file);
      const plan = blankBoard(slugify(name), name);
      await writePlanAtomic(file, plan);
      return plan;
    });
  }
  try {
    return await readPlan(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolError(
      `Could not read ${file}: ${msg}\nAsk the user to fix the file (it may have been edited by hand).`,
    );
  }
}

export async function createBoard(
  ws: Workspace,
  name: string,
  folder?: string,
): Promise<FoundBoard> {
  const root = await ws.root();
  const dir = path.resolve(root, folder ?? '.');
  assertInWorkspace(ws, root, dir, 'Folder');
  const existing = new Set(
    (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith(WHITEBOARD_EXT))
      .map((n) => boardBaseName(n)),
  );
  const id = uniqueId(slugify(name), existing);
  const file = path.join(dir, `${id}${WHITEBOARD_EXT}`);
  const plan = blankBoard(id, name.trim() || id);
  await createPlanFile(file, plan);
  return { file, plan };
}

/**
 * Resolves the board an agent means. `ref` may be a path, a file name, a board id or a title.
 * Without `ref`: the board the user last focused in VS Code, else the most recently changed one,
 * else (when `create` is set) a new `whiteboard.whiteboard` at the root.
 */
export async function findBoard(
  ws: Workspace,
  ref: string | undefined,
  opts: { create?: boolean } = {},
): Promise<FoundBoard> {
  const root = await ws.root();
  if (ref?.trim()) {
    const r = ref.trim();
    for (const candidate of [path.resolve(root, r), path.resolve(root, r + WHITEBOARD_EXT)]) {
      if (!isBoardFileName(candidate)) continue;
      assertInWorkspace(ws, root, candidate, 'Board');
      const isFile = await fs
        .stat(candidate)
        .then((s) => s.isFile())
        .catch(() => false);
      if (isFile) return { file: candidate, plan: await loadBoard(candidate) };
    }
    const boards = await listBoards(ws);
    const lower = r.toLowerCase();
    const match =
      boards.find((b) => boardBaseName(b.file).toLowerCase() === lower) ??
      boards.find((b) => b.plan?.id === r) ??
      boards.find((b) => b.plan?.title.toLowerCase() === lower);
    if (match) return { file: match.file, plan: await loadBoard(match.file) };
    throw new ToolError(
      `No whiteboard "${r}" in ${root}. ` +
        (boards.length
          ? `Known boards: ${boards.map((b) => relPath(root, b.file)).join(', ')}.`
          : 'There are no boards yet; call create_whiteboard, or omit "board" to use a new default board.'),
    );
  }

  const active = await activeBoardIn(root);
  if (active) return { file: active, plan: await loadBoard(active) };
  const [latest] = await listBoards(ws);
  if (latest) return { file: latest.file, plan: await loadBoard(latest.file) };
  if (opts.create) {
    const file = path.join(root, `whiteboard${WHITEBOARD_EXT}`);
    const plan = blankBoard('whiteboard', 'Whiteboard');
    try {
      await createPlanFile(file, plan);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { file, plan: await loadBoard(file) };
  }
  throw new ToolError(
    'There are no whiteboards in this workspace yet. Call create_whiteboard first.',
  );
}
