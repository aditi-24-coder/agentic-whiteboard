import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  BOARD_BACKGROUNDS,
  ChangeTypeSchema,
  DEFAULT_FONT_SIZE,
  NodeKindSchema,
  PlanStatusSchema,
  detectDrift,
  formatDrift,
  CodeSyncModeSchema,
  codeSyncMode,
  isCodeSynced,
  isUnder,
  nodePackages,
  normalizeCodePath,
  parseFreeform,
  pruneDanglingRefs,
  serializeFreeform,
  slugify,
  sortedSteps,
  syncBoardWithCode,
  uniqueId,
  type ArrowShape,
  type BoardBackground,
  type ColorName,
  type Edge,
  type FillStyle,
  type FreeformShape,
  type Plan,
  type PlanNode,
  type Rect,
  type TextStyle,
} from '@agentic-whiteboard/shared';
import { DEFAULT_SIZES, autoLayout, layoutSynced } from '@agentic-whiteboard/shared/layout';
import {
  attachVerification,
  detectVerifyCommand,
  gitChangedFiles,
  recordAgentActivity,
  scanRepo,
  updatePlanFile,
  VerificationCancelled,
  verifyStep as runStepVerification,
} from '@agentic-whiteboard/shared/node';
import {
  ToolError,
  createBoard,
  findBoard,
  listBoards,
  relPath,
  type Workspace,
} from './workspace.js';

// Input schemas (zod raw shapes, as the MCP SDK expects)

const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey'] as const;
const colorArg = z.enum(COLORS).optional();
const textStyleArgs = {
  fontSize: z
    .number()
    .min(8)
    .max(200)
    .optional()
    .describe('Text size in px. Presets: 14 small, 18 medium, 24 large, 36 extra large (titles).'),
  bold: z.boolean().optional(),
  align: z
    .enum(['left', 'center', 'right'])
    .optional()
    .describe('Text alignment. Defaults: left for text, center inside shapes.'),
};
const fillArg = z
  .enum(['none', 'hachure', 'solid'])
  .optional()
  .describe('"hachure" is a sketchy fill.');

export const boardArg = z
  .string()
  .optional()
  .describe(
    'Which whiteboard: a path like "docs/arch.whiteboard", its file name, or its title. ' +
      'Omit to use the board the user has open in VS Code (or the most recently changed one).',
  );

const changeTypeArg = ChangeTypeSchema.optional().describe(
  'For a plan: "new" for code you are going to write, "modify" for code you will change, "delete" for code you will remove. ' +
    'Defaults to "new" when `path` does not exist yet, else "unchanged".',
);

const codeLinkArgs = {
  symbol: z
    .string()
    .optional()
    .describe('Exported symbol in `path` this box stands for, e.g. "PaymentService".'),
  package: z
    .string()
    .optional()
    .describe(
      'External systems: the package the code uses to talk to it, e.g. "stripe". Agentic Whiteboard flags the box when no code imports it.',
    ),
};

const nodeInput = z.object({
  id: z
    .string()
    .optional()
    .describe('Stable id, e.g. "auth-service". Generated from the label if omitted.'),
  label: z.string().describe('Text shown in the box.'),
  kind: NodeKindSchema.optional().describe(
    '"component" (default) for a box, "file" for a file card, "external" for a third-party system.',
  ),
  parentId: z.string().optional().describe('Id of a component box that contains this one.'),
  path: z
    .string()
    .optional()
    .describe(
      'Repo-relative file or folder this box stands for (or will live in). The user can click the box to open it, and Agentic Whiteboard checks it against the code. ' +
        'Give every component and file box a path when the diagram describes code: boxes without one are never checked.',
    ),
  ...codeLinkArgs,
  changeType: changeTypeArg,
});

const edgeInput = z.object({
  from: z
    .string()
    .describe('Id (or exact label) of the source box. May be a box already on the board.'),
  to: z.string().describe('Id (or exact label) of the target box.'),
  label: z.string().optional().describe('Text on the arrow, e.g. "HTTP".'),
});

export const drawDiagramShape = {
  board: boardArg,
  nodes: z
    .array(nodeInput)
    .describe('Boxes to add. They are laid out automatically, left to right.'),
  edges: z.array(edgeInput).default([]).describe('Arrows between boxes.'),
  steps: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().describe('What this step does, e.g. "Add the refund endpoint".'),
        detail: z.string().optional(),
        nodes: z
          .array(z.string())
          .default([])
          .describe('Ids (or labels) of the boxes this step changes. verify_step checks these.'),
      }),
    )
    .default([])
    .describe('Implementation steps (list cards), in order. Use them for a plan you will verify.'),
  title: z.string().optional().describe('Rename the board.'),
};

const point = z.object({ x: z.number(), y: z.number() });

const shapeInput = z.object({
  type: z
    .enum(['rect', 'ellipse', 'diamond', 'text', 'frame', 'sticky', 'arrow', 'line'])
    .describe(
      '"sticky" is a sticky note; "frame" is a labelled area that groups things; "line" has no arrowhead.',
    ),
  id: z
    .string()
    .optional()
    .describe('Optional id, so later shapes in this call can connect to it.'),
  text: z
    .string()
    .optional()
    .describe('Text inside the shape, the frame label, or the arrow label.'),
  x: z
    .number()
    .optional()
    .describe('Left edge in board units. Omit x/y to place it in free space.'),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  color: colorArg,
  fill: fillArg,
  ...textStyleArgs,
  from: z.string().optional().describe('Arrows: id of the element the arrow starts at.'),
  to: z.string().optional().describe('Arrows: id of the element the arrow points to.'),
  start: point.optional().describe('Arrows: start point, when not attached to an element.'),
  end: point.optional().describe('Arrows: end point, when not attached to an element.'),
});

export const addShapesShape = {
  board: boardArg,
  shapes: z
    .array(shapeInput)
    .min(1)
    .describe('Shapes to draw, in order. Arrows may connect to shapes earlier in the list.'),
};

export const updateElementsShape = {
  board: boardArg,
  updates: z
    .array(
      z.object({
        id: z.string().describe('Element id from read_whiteboard.'),
        text: z.string().optional().describe('New text or label.'),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().positive().optional(),
        h: z.number().positive().optional(),
        color: colorArg,
        fill: fillArg,
        ...textStyleArgs,
        path: z.string().optional().describe('Boxes: repo-relative file or folder; "" unlinks.'),
        ...codeLinkArgs,
        changeType: changeTypeArg,
      }),
    )
    .default([]),
  title: z.string().optional().describe('Rename the board.'),
  codeSync: CodeSyncModeSchema.optional().describe(
    'Whether the board is checked against the code: "on" for a plan or architecture board, "off" for a plain whiteboard (sketches, explaining to people), "auto" (default) when boxes link to code. Only change it when the user asks.',
  ),
  status: PlanStatusSchema.optional().describe(
    'Plan status. Set "approved" when the user approves the plan and "in_progress" when you start implementing; verify_step moves it on from there. ' +
      'While approved or in progress, Agentic Whiteboard flags code changes outside the plan.',
  ),
  background: z
    .enum(['auto', ...(Object.keys(BOARD_BACKGROUNDS) as BoardBackground[])])
    .optional()
    .describe('Board background color. "auto" follows the VS Code theme.'),
};

export const removeElementsShape = {
  board: boardArg,
  ids: z
    .array(z.string())
    .min(1)
    .describe('Ids from read_whiteboard. Arrows attached to removed boxes go too.'),
};

export const boardOnlyShape = { board: boardArg };

export const generateArchitectureShape = {
  board: boardArg,
  folder: z
    .string()
    .optional()
    .describe('Only map this repo-relative folder, e.g. "server". Defaults to the whole repo.'),
  maxBoxes: z
    .number()
    .int()
    .min(3)
    .max(120)
    .optional()
    .describe(
      'At most this many boxes for the code (external systems come on top). Default 12: an overview, not a file map.',
    ),
  prune: z
    .boolean()
    .optional()
    .describe(
      'Remove generated boxes that no longer match the code. Default true; boxes you or the user drew are never removed.',
    ),
};

export const verifyStepShape = {
  board: boardArg,
  step: z.string().describe('Step (list card) id from read_whiteboard, or its exact title.'),
  command: z
    .string()
    .optional()
    .describe(
      'Command that proves the step works, e.g. "npm test -- payments". Defaults to the project test command; pass "" to only check the code against the plan.',
    ),
};

export const createWhiteboardShape = {
  name: z.string().describe('Board title, e.g. "Checkout flow". The file name is derived from it.'),
  folder: z
    .string()
    .optional()
    .describe('Workspace-relative folder for the file. Defaults to the workspace root.'),
};

// Helpers

export interface ToolOutput {
  text: string;
}

const round = (n: number) => Math.round(n);

function allIds(plan: Plan, shapes: readonly FreeformShape[]): Set<string> {
  return new Set([
    ...plan.nodes.map((n) => n.id),
    ...plan.edges.map((e) => e.id),
    ...plan.steps.map((s) => s.id),
    ...plan.constraints.map((c) => c.id),
    ...plan.comments.map((c) => c.id),
    ...shapes.map((s) => s.id),
  ]);
}

function shapeBox(s: FreeformShape): Rect {
  if (s.type !== 'arrow') return { x: s.x, y: s.y, w: s.w, h: s.h };
  const x = Math.min(s.start.x, s.end.x);
  const y = Math.min(s.start.y, s.end.y);
  return { x, y, w: Math.abs(s.end.x - s.start.x), h: Math.abs(s.end.y - s.start.y) };
}

function contentBounds(plan: Plan, shapes: readonly FreeformShape[]): Rect | undefined {
  const rects = [...Object.values(plan.layout), ...shapes.map(shapeBox)];
  if (!rects.length) return undefined;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Resolves a box reference given as an id or, failing that, an exact (case-insensitive) label. */
function resolveNodeRef(ref: string, nodes: readonly PlanNode[], where: string): string {
  if (nodes.some((n) => n.id === ref)) return ref;
  const byLabel = nodes.filter((n) => n.label.toLowerCase() === ref.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!.id;
  throw new ToolError(
    `${where}: unknown box "${ref}". Known box ids: ${nodes.map((n) => n.id).join(', ') || '(none)'}.`,
  );
}

/** Rect of any element on the board (box, sticky, list item or shape), for attaching arrows. */
function rectOf(id: string, plan: Plan, shapes: readonly FreeformShape[]): Rect | undefined {
  if (plan.layout[id]) return plan.layout[id];
  const s = shapes.find((x) => x.id === id);
  return s ? shapeBox(s) : undefined;
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function boardSummary(root: string, file: string, plan: Plan): string {
  const { freeform } = parseFreeform(plan.freeform);
  const counts = [
    [plan.nodes.length, 'boxes'],
    [plan.edges.length + freeform.shapes.filter((s) => s.type === 'arrow').length, 'arrows'],
    [plan.comments.length, 'sticky notes'],
    [freeform.shapes.filter((s) => s.type !== 'arrow').length, 'shapes'],
  ]
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}`);
  return `"${plan.title}" (${relPath(root, file)}): ${counts.join(', ') || 'empty'}`;
}

const at = (r: Rect | undefined) =>
  r ? ` at (${round(r.x)}, ${round(r.y)}) ${round(r.w)}×${round(r.h)}` : '';
const quoted = (t: string | undefined) => (t ? ` "${t.replace(/\n/g, ' / ')}"` : '');

function describeBoard(root: string, file: string, plan: Plan): string {
  const { freeform } = parseFreeform(plan.freeform);
  const lines = [`Whiteboard "${plan.title}" (${relPath(root, file)}), revision ${plan.revision}.`];
  const bounds = contentBounds(plan, freeform.shapes);
  lines.push(
    bounds
      ? `Content spans x ${round(bounds.x)}..${round(bounds.x + bounds.w)}, y ${round(bounds.y)}..${round(bounds.y + bounds.h)}. Free space starts at y ${round(bounds.y + bounds.h + 80)}.`
      : 'The board is empty.',
  );
  const label = (id: string) => {
    const node = plan.nodes.find((n) => n.id === id);
    if (node) return node.label;
    const shape = freeform.shapes.find((s) => s.id === id);
    return (shape && 'text' in shape && shape.text) || id;
  };

  if (plan.nodes.length) {
    lines.push('', 'Boxes (diagram):');
    for (const n of plan.nodes)
      lines.push(
        `- ${n.id} [${n.kind}]${quoted(n.label)}${at(plan.layout[n.id])}${n.parentId ? ` inside ${n.parentId}` : ''}${n.path ? ` -> ${n.path}${n.symbol ? `#${n.symbol}` : ''}` : ''}${nodePackages(n).length ? ` (package ${nodePackages(n).join(', ')})` : ''}${n.changeType !== 'unchanged' ? ` {${n.changeType}}` : ''}${n.summary ? ` - ${n.summary}` : ''}`,
      );
  }
  if (plan.edges.length) {
    lines.push('', 'Diagram arrows:');
    for (const e of plan.edges) lines.push(`- ${e.id}: ${e.from} -> ${e.to}${quoted(e.label)}`);
  }
  if (freeform.shapes.length) {
    lines.push('', 'Shapes:');
    for (const s of freeform.shapes) {
      const style = [
        s.color && s.color !== 'default' ? s.color : '',
        s.fill && s.fill !== 'none' ? `${s.fill} fill` : '',
        'fontSize' in s && s.fontSize ? `${s.fontSize}px` : '',
        'bold' in s && s.bold ? 'bold' : '',
        'align' in s && s.align ? `${s.align} aligned` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const styleText = style ? ` (${style})` : '';
      switch (s.type) {
        case 'arrow': {
          const from = s.start.bindTo
            ? `${s.start.bindTo} (${label(s.start.bindTo)})`
            : `(${round(s.start.x)}, ${round(s.start.y)})`;
          const to = s.end.bindTo
            ? `${s.end.bindTo} (${label(s.end.bindTo)})`
            : `(${round(s.end.x)}, ${round(s.end.y)})`;
          lines.push(
            `- ${s.id} [${s.head === 'none' ? 'line' : 'arrow'}] ${from} -> ${to}${quoted(s.label)}${styleText}`,
          );
          break;
        }
        case 'frame':
          lines.push(`- ${s.id} [frame]${quoted(s.label)}${at(s)}${styleText}`);
          break;
        case 'pen':
          lines.push(`- ${s.id} [freehand drawing]${at(s)}${styleText}`);
          break;
        default:
          lines.push(`- ${s.id} [${s.type}]${quoted(s.text)}${at(s)}${styleText}`);
      }
    }
  }
  if (plan.comments.length) {
    lines.push('', 'Sticky notes:');
    for (const c of plan.comments) lines.push(`- ${c.id}${quoted(c.text)}${at(plan.layout[c.id])}`);
  }
  if (plan.constraints.length) {
    lines.push('', 'Rule notes (🚫):');
    for (const c of plan.constraints)
      lines.push(`- ${c.id}${quoted(c.text)}${at(plan.layout[c.id])}`);
  }
  if (plan.steps.length) {
    lines.push('', `List cards (plan status: ${plan.status}):`);
    for (const s of sortedSteps(plan.steps))
      lines.push(
        `- ${s.id} #${s.order}${quoted(s.title)} [${s.status}]${s.nodeIds.length ? ` touches ${s.nodeIds.join(', ')}` : ''}${s.verification ? ` (${s.verification.status} ${s.verification.at})` : ''}${at(plan.layout[s.id])}`,
      );
  }
  const mode = codeSyncMode(plan);
  if (mode === 'off')
    lines.push(
      '',
      'Code sync: OFF. This is a plain whiteboard: draw freely and do not link boxes to files (path, symbol, package).',
    );
  else if (mode === 'on')
    lines.push(
      '',
      'Code sync: ON. This board describes code: give every component and file box a path.',
    );
  if (plan.codebase && mode !== 'off')
    lines.push(
      '',
      `Synced with the code at ${plan.codebase.scannedAt}${plan.codebase.commit ? ` (commit ${plan.codebase.commit})` : ''}. Call check_drift to compare with the code now.`,
    );
  return lines.join('\n');
}

/** Places boxes without a position in rows below the existing content. */
class Placer {
  private x: number;
  private y: number;
  private rowH = 0;
  private readonly left: number;

  constructor(bounds: Rect | undefined) {
    this.left = bounds?.x ?? 0;
    this.x = this.left;
    this.y = bounds ? bounds.y + bounds.h + 80 : 0;
  }

  next(w: number, h: number) {
    if (this.x > this.left && this.x + w > this.left + 1200) {
      this.x = this.left;
      this.y += this.rowH + 40;
      this.rowH = 0;
    }
    const pos = { x: this.x, y: this.y };
    this.x += w + 40;
    this.rowH = Math.max(this.rowH, h);
    return pos;
  }
}

function defaultSize(
  type: z.infer<typeof shapeInput>['type'],
  text = '',
  fontSize: number = DEFAULT_FONT_SIZE.text,
  bold = false,
) {
  switch (type) {
    case 'rect':
      return { w: 160, h: 80 };
    case 'ellipse':
      return { w: 160, h: 100 };
    case 'diamond':
      return { w: 170, h: 110 };
    case 'frame':
      return { w: 480, h: 320 };
    case 'sticky':
      return { ...DEFAULT_SIZES.comment };
    default: {
      const lines = text.split('\n');
      const longest = Math.max(1, ...lines.map((l) => l.length));
      return {
        w: Math.max(40, Math.round(longest * fontSize * (bold ? 0.65 : 0.6))),
        h: Math.round((lines.length - 1) * fontSize * 1.3 + fontSize * 1.35),
      };
    }
  }
}

/** Writes a board, telling VS Code an agent is working on it so the board locks meanwhile. */
async function writeBoard(
  file: string,
  mutate: (plan: Plan) => Plan | void | Promise<Plan | void>,
) {
  await recordAgentActivity(file, { writing: true });
  try {
    return await updatePlanFile(file, mutate);
  } finally {
    await recordAgentActivity(file, {});
  }
}

const TIDY_HINT =
  'When you have finished changing the diagram, call tidy_layout once: it arranges the boxes and routes every arrow around them, and unlocks the board for the user.';

// Handlers

export async function listWhiteboards(ws: Workspace): Promise<ToolOutput> {
  const root = await ws.root();
  const boards = await listBoards(ws);
  if (!boards.length)
    return {
      text: 'No whiteboards yet. Call create_whiteboard, or draw without "board" to start a default one.',
    };
  return {
    text: boards
      .map((b) =>
        b.plan
          ? `- ${boardSummary(root, b.file, b.plan)}, updated ${new Date(b.mtimeMs).toISOString()}`
          : `- ${relPath(root, b.file)}: ${b.errors?.[0]?.startsWith('Malformed JSON: Unexpected end') ? 'blank (new file)' : `INVALID (${b.errors?.[0] ?? 'unknown error'})`}`,
      )
      .join('\n'),
  };
}

export async function createWhiteboard(
  ws: Workspace,
  args: { name: string; folder?: string },
): Promise<ToolOutput> {
  const { file, plan } = await createBoard(ws, args.name, args.folder);
  const root = await ws.root();
  return {
    text: `Created whiteboard "${plan.title}" at ${relPath(root, file)}. It opens in VS Code for the user. Pass board: "${relPath(root, file)}" to draw on it.`,
  };
}

export async function readWhiteboard(ws: Workspace, args: { board?: string }): Promise<ToolOutput> {
  const { file, plan } = await findBoard(ws, args.board);
  return { text: describeBoard(await ws.root(), file, plan) };
}

type DrawDiagramArgs = z.infer<z.ZodObject<typeof drawDiagramShape>>;

/** Repo-relative, forward slashes: agents often pass absolute or Windows paths. */
function repoPath(root: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  // Outside the workspace: keep what the agent gave; drift will report it as missing.
  return normalizeCodePath(rel.startsWith('..') ? p : rel);
}

const pathExists = (root: string, p: string) =>
  fs.stat(path.resolve(root, p)).then(
    () => true,
    () => false,
  );

export async function drawDiagram(
  ws: Workspace,
  input: Omit<DrawDiagramArgs, 'steps'> & Partial<Pick<DrawDiagramArgs, 'steps'>>,
): Promise<ToolOutput> {
  const args = { ...input, steps: input.steps ?? [] };
  const { file, plan: before } = await findBoard(ws, args.board, { create: true });
  const root = await ws.root();
  // On a plain whiteboard boxes are not plans: nothing is "new", and nothing is checked.
  const off = codeSyncMode(before) === 'off';
  const exists = new Map<string, boolean>();
  for (const n of args.nodes)
    if (n.path && !n.changeType && !off) exists.set(n.path, await pathExists(root, n.path));
  const added: string[] = [];
  const next = await writeBoard(file, async (plan) => {
    const { freeform } = parseFreeform(plan.freeform);
    const taken = allIds(plan, freeform.shapes);
    if (args.title) plan.title = args.title;
    for (const n of args.nodes) {
      if (n.id && taken.has(n.id))
        throw new ToolError(
          `Id "${n.id}" is already on the board. Use update_elements to change it, or pick another id.`,
        );
      const id = n.id ?? uniqueId(slugify(n.label, 32), taken);
      taken.add(id);
      const node: PlanNode = {
        id,
        kind: n.kind ?? 'component',
        label: n.label,
        changeType: n.changeType ?? (n.path && !off && !exists.get(n.path) ? 'new' : 'unchanged'),
      };
      if (n.parentId) node.parentId = n.parentId;
      if (n.path) node.path = repoPath(root, n.path);
      if (n.symbol) node.symbol = n.symbol;
      if (n.package) node.package = n.package;
      plan.nodes.push(node);
      added.push(id);
    }
    const ids = new Set(plan.nodes.map((n) => n.id));
    for (const n of plan.nodes)
      if (n.parentId && !ids.has(n.parentId))
        throw new ToolError(
          `Box "${n.id}" has parentId "${n.parentId}", which is not a box on the board.`,
        );
    args.edges.forEach((e, i) => {
      const from = resolveNodeRef(e.from, plan.nodes, `edges[${i}].from`);
      const to = resolveNodeRef(e.to, plan.nodes, `edges[${i}].to`);
      const id = uniqueId(`e-${from}-${to}`, taken);
      taken.add(id);
      const edge: Edge = { id, from, to };
      if (e.label) edge.label = e.label;
      plan.edges.push(edge);
    });
    let order = Math.max(0, ...plan.steps.map((s) => s.order));
    for (const [i, st] of args.steps.entries()) {
      if (st.id && taken.has(st.id))
        throw new ToolError(`steps[${i}]: id "${st.id}" is already on the board.`);
      const id = st.id ?? uniqueId(`step-${slugify(st.title, 24)}`, taken);
      taken.add(id);
      plan.steps.push({
        id,
        order: ++order,
        title: st.title,
        ...(st.detail ? { detail: st.detail } : {}),
        nodeIds: (st.nodes ?? []).map((ref, j) =>
          resolveNodeRef(ref, plan.nodes, `steps[${i}].nodes[${j}]`),
        ),
        status: 'pending',
      });
      added.push(id);
    }
    const laid = await autoLayout(plan);
    // autoLayout puts new boxes below other boxes; keep them clear of free-form shapes too.
    const others = contentBounds(
      {
        ...laid,
        layout: Object.fromEntries(Object.entries(laid.layout).filter(([k]) => !added.includes(k))),
      },
      freeform.shapes,
    );
    const fresh = contentBounds(
      { ...laid, layout: Object.fromEntries(added.map((k) => [k, laid.layout[k]!])) },
      [],
    );
    if (others && fresh && fresh.y < others.y + others.h + 80 && fresh.x < others.x + others.w) {
      const dy = others.y + others.h + 80 - fresh.y;
      const down = <T extends { y: number }>(p: T): T => ({ ...p, y: p.y + dy });
      for (const k of added) laid.layout[k] = down(laid.layout[k]!);
      // Routes between moved boxes move with them, so they stay valid.
      const moved = new Set(added);
      laid.edges = laid.edges.map((e) =>
        e.route && moved.has(e.from) && moved.has(e.to)
          ? {
              ...e,
              route: {
                points: e.route.points.map(down),
                from: down(e.route.from),
                to: down(e.route.to),
              },
            }
          : e,
      );
    }
    return laid;
  });
  const lines = [
    `Drew ${args.nodes.length} boxes${args.steps.length ? `, ${args.steps.length} steps` : ''} and ${args.edges.length} arrows on ${boardSummary(root, file, next)}. New box ids: ${added.join(', ') || '(none)'}.`,
  ];
  if (off) {
    if (args.nodes.some((n) => n.path || n.package))
      lines.push(
        'Code sync is off on this board, so these links only open files on click; they are not checked against the code.',
      );
    lines.push(TIDY_HINT);
    return { text: lines.join('\n') };
  }
  // A diagram of code should be checkable: point out boxes the drift check cannot see.
  const describesCode = args.steps.length > 0 || args.nodes.some((n) => n.path || n.package);
  const unlinked = args.nodes.filter((n) => (n.kind ?? 'component') !== 'external' && !n.path);
  if (describesCode && unlinked.length)
    lines.push(
      `Note: ${unlinked.map((n) => `"${n.label}"`).join(', ')} ${unlinked.length === 1 ? 'has' : 'have'} no path, so Agentic Whiteboard cannot check ${unlinked.length === 1 ? 'it' : 'them'} against the code. Set path with update_elements.`,
    );
  const planned = next.nodes.filter((n) => added.includes(n.id) && n.changeType === 'new');
  if (planned.length)
    lines.push(
      `Planned as new (no code yet): ${planned.map((n) => n.id).join(', ')}. After implementing each step, call verify_step so its result and diff are attached and later code changes show as drift.`,
    );
  lines.push(TIDY_HINT);
  return { text: lines.join('\n') };
}

export async function addShapes(
  ws: Workspace,
  args: z.infer<z.ZodObject<typeof addShapesShape>>,
): Promise<ToolOutput> {
  const { file } = await findBoard(ws, args.board, { create: true });
  const created: string[] = [];
  const next = await writeBoard(file, (plan) => {
    const { freeform, unknown } = parseFreeform(plan.freeform);
    const shapes = freeform.shapes;
    const taken = allIds(plan, shapes);
    const placer = new Placer(contentBounds(plan, shapes));

    for (const [i, s] of args.shapes.entries()) {
      if (s.id && taken.has(s.id))
        throw new ToolError(`shapes[${i}]: id "${s.id}" is already on the board.`);
      const id = s.id ?? uniqueId(s.type === 'sticky' ? 'note' : s.type, taken);
      taken.add(id);
      const style: { color?: ColorName; fill?: FillStyle } = {};
      if (s.color) style.color = s.color;
      if (s.fill) style.fill = s.fill;

      if (s.type === 'arrow' || s.type === 'line') {
        const endpoint = (
          ref: string | undefined,
          p: { x: number; y: number } | undefined,
          which: string,
        ) => {
          if (ref) {
            const r = rectOf(ref, plan, shapes);
            if (!r) throw new ToolError(`shapes[${i}].${which}: no element "${ref}" on the board.`);
            return { ...center(r), bindTo: ref };
          }
          if (p) return { x: p.x, y: p.y };
          throw new ToolError(
            `shapes[${i}]: an ${s.type} needs "${which}" (an element id) or "${which === 'from' ? 'start' : 'end'}" (a point).`,
          );
        };
        const start = endpoint(s.from, s.start, 'from');
        const end = endpoint(s.to, s.end, 'to');
        const arrow: ArrowShape = {
          id,
          type: 'arrow',
          ...style,
          start,
          end,
          head: s.type === 'line' ? 'none' : 'arrow',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
        };
        if (s.text) arrow.label = s.text;
        shapes.push(arrow);
        created.push(id);
        continue;
      }

      const size = defaultSize(s.type, s.text, s.fontSize, s.bold);
      const textStyle: TextStyle = {};
      if (s.fontSize) textStyle.fontSize = s.fontSize;
      if (s.bold) textStyle.bold = true;
      if (s.align) textStyle.align = s.align;
      const w = s.w ?? size.w;
      const h = s.h ?? size.h;
      const pos = s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : placer.next(w, h);
      const box = { x: pos.x, y: pos.y, w, h };
      if (s.type === 'sticky') {
        plan.comments.push({ id, text: s.text ?? '' });
        plan.layout[id] = box;
      } else if (s.type === 'frame') {
        shapes.push({ id, type: 'frame', label: s.text ?? '', ...style, ...box });
      } else if (s.type === 'text') {
        shapes.push({
          id,
          type: 'text',
          text: s.text ?? '',
          ...textStyle,
          ...style,
          ...box,
        });
      } else {
        shapes.push({
          id,
          type: s.type,
          ...(s.text ? { text: s.text } : {}),
          ...textStyle,
          ...style,
          ...box,
        });
      }
      created.push(id);
    }
    plan.freeform = serializeFreeform({ shapes }, unknown);
  });
  const root = await ws.root();
  return {
    text: `Added ${created.length} shapes (${created.join(', ')}) to ${boardSummary(root, file, next)}.`,
  };
}

type UpdateElementsArgs = z.infer<z.ZodObject<typeof updateElementsShape>>;

export async function updateElements(
  ws: Workspace,
  input: Omit<UpdateElementsArgs, 'updates'> & Partial<Pick<UpdateElementsArgs, 'updates'>>,
): Promise<ToolOutput> {
  const args = { ...input, updates: input.updates ?? [] };
  if (!args.updates.length && !args.title && !args.background && !args.status && !args.codeSync)
    throw new ToolError('Nothing to update: pass updates, title, status, codeSync or background.');
  const root = await ws.root();
  const { file } = await findBoard(ws, args.board);
  const next = await writeBoard(file, (plan) => {
    const { freeform, unknown } = parseFreeform(plan.freeform);
    if (args.title) plan.title = args.title;
    if (args.status) plan.status = args.status;
    if (args.codeSync === 'auto') delete plan.codeSync;
    else if (args.codeSync) plan.codeSync = args.codeSync;
    if (args.background === 'auto') delete plan.background;
    else if (args.background) plan.background = args.background;
    for (const u of args.updates) {
      const moveRect = (r: Rect): Rect => ({
        x: u.x ?? r.x,
        y: u.y ?? r.y,
        w: u.w ?? r.w,
        h: u.h ?? r.h,
      });
      const node = plan.nodes.find((n) => n.id === u.id);
      const step = plan.steps.find((s) => s.id === u.id);
      const note =
        plan.comments.find((c) => c.id === u.id) ?? plan.constraints.find((c) => c.id === u.id);
      const edge = plan.edges.find((e) => e.id === u.id);
      const shape = freeform.shapes.find((s) => s.id === u.id);
      const styled = u.fontSize !== undefined || u.bold !== undefined || u.align !== undefined;
      const applyTextStyle = (target: TextStyle) => {
        if (u.fontSize !== undefined) target.fontSize = u.fontSize;
        if (u.bold !== undefined) target.bold = u.bold;
        if (u.align !== undefined) target.align = u.align;
      };
      const linking =
        u.path !== undefined ||
        u.symbol !== undefined ||
        u.package !== undefined ||
        u.changeType !== undefined;
      if (linking && !node)
        throw new ToolError(
          `"${u.id}" is not a diagram box; path, symbol, package and changeType apply to boxes.`,
        );
      if (node && u.changeType) node.changeType = u.changeType;
      if (node) {
        for (const key of ['path', 'symbol', 'package'] as const) {
          const v = u[key];
          if (v === undefined) continue;
          if (v) node[key] = key === 'path' ? repoPath(root, v) : v;
          else delete node[key];
          // A package set by hand replaces the packages a sync linked.
          if (key === 'package') delete node.packages;
        }
      }
      if (node || step || note) {
        if (u.text !== undefined) {
          if (node) node.label = u.text;
          else if (step) step.title = u.text;
          else note!.text = u.text;
        }
        if (styled) {
          const comment = plan.comments.find((c) => c.id === u.id);
          const target = node ?? comment;
          if (!target)
            throw new ToolError(
              `"${u.id}" is a ${step ? 'list card' : 'rule note'}; text size, bold and align apply to boxes, sticky notes and text shapes.`,
            );
          applyTextStyle(target);
          // Grow the box so larger text still fits (the board measures more precisely).
          const r = plan.layout[u.id];
          const size = target.fontSize;
          if (r && size) {
            const text = node ? node.label : comment!.text;
            const perLine = Math.max(1, Math.floor((r.w - 28) / (size * 0.6)));
            const lines = Math.max(1, Math.ceil(text.length / perLine));
            plan.layout[u.id] = { ...r, h: Math.max(r.h, Math.round(lines * size * 1.3 + 28)) };
          }
        }
        const r = plan.layout[u.id];
        if (r) plan.layout[u.id] = moveRect(r);
      } else if (edge) {
        if (u.text !== undefined) edge.label = u.text;
      } else if (shape) {
        if (u.color) shape.color = u.color;
        if (u.fill) shape.fill = u.fill;
        if (styled) {
          if (
            shape.type === 'text' ||
            shape.type === 'rect' ||
            shape.type === 'ellipse' ||
            shape.type === 'diamond'
          ) {
            applyTextStyle(shape);
          } else {
            throw new ToolError(
              `"${u.id}" is a ${shape.type}; text size, bold and align apply to boxes, sticky notes and text shapes.`,
            );
          }
        }
        if (u.text !== undefined) {
          if (shape.type === 'frame') shape.label = u.text;
          else if (shape.type === 'arrow') shape.label = u.text;
          else if (shape.type !== 'pen') shape.text = u.text;
        }
        if (shape.type === 'arrow') {
          if (u.x !== undefined || u.y !== undefined)
            throw new ToolError(
              `"${u.id}" is an arrow; move the elements it connects instead, or remove and redraw it.`,
            );
        } else {
          Object.assign(shape, moveRect(shape));
          // Free text boxes fit their text unless the agent sized them explicitly.
          if (
            shape.type === 'text' &&
            (styled || u.text !== undefined) &&
            u.w === undefined &&
            u.h === undefined
          )
            Object.assign(shape, defaultSize('text', shape.text, shape.fontSize, shape.bold));
        }
      } else {
        throw new ToolError(
          `No element "${u.id}" on the board. Call read_whiteboard for the current ids.`,
        );
      }
    }
    plan.freeform = serializeFreeform(freeform, unknown);
  });
  const what = [
    args.updates.length ? `${args.updates.length} elements` : '',
    args.title ? 'the title' : '',
    args.status ? `the status (${args.status})` : '',
    args.codeSync ? `code sync (${args.codeSync})` : '',
    args.background ? 'the background' : '',
  ].filter(Boolean);
  const movedBoxes = args.updates.some(
    (u) => (u.x !== undefined || u.y !== undefined) && next.nodes.some((n) => n.id === u.id),
  );
  return {
    text:
      `Updated ${what.join(', ')} on ${boardSummary(root, file, next)}.` +
      (movedBoxes
        ? `\nMoving diagram boxes by hand drops their arrow routes, so arrows may now cross boxes. ${TIDY_HINT}`
        : ''),
  };
}

function removeFrom(plan: Plan, ids: ReadonlySet<string>): Plan {
  const { freeform, unknown } = parseFreeform(plan.freeform);
  const shapes = freeform.shapes
    .filter((s) => !ids.has(s.id))
    // Arrows attached to something removed go with it.
    .filter(
      (s) => s.type !== 'arrow' || !(ids.has(s.start.bindTo ?? '') || ids.has(s.end.bindTo ?? '')),
    );
  const next: Plan = {
    ...plan,
    nodes: plan.nodes.filter((n) => !ids.has(n.id)),
    edges: plan.edges.filter((e) => !ids.has(e.id)),
    steps: plan.steps.filter((s) => !ids.has(s.id)),
    constraints: plan.constraints.filter((c) => !ids.has(c.id)),
    comments: plan.comments.filter((c) => !ids.has(c.id)),
    freeform: serializeFreeform({ shapes }, unknown),
  };
  return pruneDanglingRefs(next);
}

export async function removeElements(
  ws: Workspace,
  args: { board?: string; ids: string[] },
): Promise<ToolOutput> {
  const { file, plan: current } = await findBoard(ws, args.board);
  const known = allIds(current, parseFreeform(current.freeform).freeform.shapes);
  const missing = args.ids.filter((id) => !known.has(id));
  if (missing.length)
    throw new ToolError(
      `No element ${missing.map((m) => `"${m}"`).join(', ')} on the board. Call read_whiteboard for the current ids. Nothing was removed.`,
    );
  const next = await writeBoard(file, (plan) => removeFrom(plan, new Set(args.ids)));
  const root = await ws.root();
  return {
    text: `Removed ${args.ids.length} elements. Board is now ${boardSummary(root, file, next)}.`,
  };
}

/**
 * Re-arranges every diagram box and routes every arrow around the boxes, then tells VS Code the
 * agent is done so the user can edit the board again. Free-form shapes stay where they are.
 */
export async function tidyLayout(ws: Workspace, args: { board?: string }): Promise<ToolOutput> {
  const { file } = await findBoard(ws, args.board);
  try {
    const next = await writeBoard(file, (plan) => autoLayout(plan, { force: true }));
    return {
      text: `Tidied ${boardSummary(await ws.root(), file, next)}: boxes arranged left to right and every arrow routed around them. The board is unlocked for the user.`,
    };
  } finally {
    await recordAgentActivity(file, { done: true });
  }
}

export async function clearWhiteboard(
  ws: Workspace,
  args: { board?: string },
): Promise<ToolOutput> {
  const { file } = await findBoard(ws, args.board);
  const next = await writeBoard(file, (plan) => ({
    ...plan,
    nodes: [],
    edges: [],
    steps: [],
    constraints: [],
    comments: [],
    layout: {},
    freeform: { shapes: [] },
  }));
  return { text: `Cleared whiteboard "${next.title}" (${relPath(await ws.root(), file)}).` };
}

// Code sync: architecture from code, drift, verification

export async function generateArchitecture(
  ws: Workspace,
  args: z.infer<z.ZodObject<typeof generateArchitectureShape>>,
): Promise<ToolOutput> {
  const root = await ws.root();
  const scan = await scanRepo(root);
  if (!scan.files.length)
    throw new ToolError(
      `Found no source files (TypeScript, JavaScript, Python, Go, Prisma) in ${root}.`,
    );
  const folder = args.folder ? normalizeCodePath(args.folder) : '';
  if (folder && !scan.files.some((f) => isUnder(f.path, folder)))
    throw new ToolError(`No source files under "${args.folder}".`);
  const { file, plan: current } = await findBoard(ws, args.board, { create: true });
  if (codeSyncMode(current) === 'off')
    throw new ToolError(
      'Code sync is off on this board: the user keeps it as a plain whiteboard (for sketching or explaining), so it is not compared with the code. Do not turn it on unasked; to work with code, ask the user, or use another board (create_whiteboard).',
    );
  let result: ReturnType<typeof syncBoardWithCode> | undefined;
  const next = await writeBoard(file, async (plan) => {
    result = syncBoardWithCode(plan, scan, {
      ...(folder ? { folder } : {}),
      maxNodes: args.maxBoxes ?? 12,
      rootName: path.basename(root),
      ...(args.prune === false ? { prune: false } : {}),
    });
    if (!plan.nodes.length && plan.title === 'Whiteboard') result.plan.title = 'Architecture';
    return layoutSynced(result.plan, result.added);
  });
  const r = result!;
  const lines = [
    `Synced ${boardSummary(root, file, next)} with the code (${scan.files.length} source files${scan.commit ? `, commit ${scan.commit}` : ''}${scan.truncated ? ', repo truncated' : ''}).`,
    r.mode === 'link'
      ? `The board already shows the architecture, so it was kept as drawn: ${r.updated.length} boxes linked to the code${r.added.length ? `, ${r.added.length} external systems added (${r.added.join(', ')})` : ''}${r.removed.length ? `, ${r.removed.length} outdated generated boxes removed` : ''}. Code no box covers is reported by check_drift.`
      : `Added ${r.added.length} boxes${r.added.length ? ` (${r.added.join(', ')})` : ''}, refreshed ${r.updated.length}${r.removed.length ? `, removed ${r.removed.length} outdated (${r.removed.join(', ')})` : ''}.`,
  ];
  if (r.stale.length)
    lines.push(
      `${r.stale.length} generated boxes no longer match the code: ${r.stale.join(', ')}. Call again without prune: false to remove them.`,
    );
  if (r.mode === 'generate')
    lines.push(
      'Boxes are named after folders. Rename them with update_elements to what they do (e.g. "Orders API", "Payment service"); their links to the code stay. Keep the diagram high-level: add HTTP or event arrows the code cannot show, not more boxes.',
    );
  lines.push(TIDY_HINT);
  return { text: lines.join('\n') };
}

export async function checkDrift(ws: Workspace, args: { board?: string }): Promise<ToolOutput> {
  const root = await ws.root();
  const { file, plan } = await findBoard(ws, args.board);
  if (codeSyncMode(plan) === 'off')
    return {
      text: 'Code sync is off on this board: the user keeps it as a plain whiteboard (for sketching or explaining), so it is not compared with the code. Do not turn it on unasked; to work with code, ask the user, or use another board (create_whiteboard).',
    };
  if (!isCodeSynced(plan) || !plan.nodes.some((n) => n.path || nodePackages(n).length))
    return {
      text: `"${plan.title}" (${relPath(root, file)}) has no boxes linked to code (no path or package), so there is nothing to check. Use generate_architecture, or set path on boxes with update_elements.`,
    };
  const scan = await scanRepo(root);
  const changedFiles = await gitChangedFiles(root);
  const drift = detectDrift(plan, scan, changedFiles ? { changedFiles } : {});
  return {
    text: [
      `Checked "${plan.title}" (${relPath(root, file)}) against ${scan.files.length} source files${scan.commit ? ` at ${scan.commit}` : ''}.`,
      formatDrift(drift),
      drift.length
        ? 'To fix: update the diagram (generate_architecture re-syncs code boxes; update_elements fixes paths and packages) or change the code, as the user prefers. Explain any architectural change before making it.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export interface VerifyRun {
  /** Cancels the command (the client cancelled the call). */
  signal?: AbortSignal;
  /** Called every few seconds while the command runs, to keep the client from timing out. */
  heartbeat?(elapsedMs: number): void;
}

export async function verifyStep(
  ws: Workspace,
  args: z.infer<z.ZodObject<typeof verifyStepShape>>,
  run: VerifyRun = {},
): Promise<ToolOutput> {
  const root = await ws.root();
  const { file, plan } = await findBoard(ws, args.board);
  if (codeSyncMode(plan) === 'off')
    throw new ToolError(
      'Code sync is off on this board: the user keeps it as a plain whiteboard (for sketching or explaining), so it is not compared with the code. Do not turn it on unasked; to work with code, ask the user, or use another board (create_whiteboard).',
    );
  const step =
    plan.steps.find((s) => s.id === args.step) ??
    plan.steps.find((s) => s.title.toLowerCase() === args.step.toLowerCase());
  if (!step)
    throw new ToolError(
      `No step "${args.step}". Steps: ${plan.steps.map((s) => `${s.id} ("${s.title}")`).join(', ') || '(none; add them with draw_diagram steps)'}.`,
    );
  const command =
    args.command === undefined
      ? (process.env.AGENTIC_WHITEBOARD_VERIFY_COMMAND ?? (await detectVerifyCommand(root)))
      : args.command || undefined;
  const scan = await scanRepo(root);
  const started = Date.now();
  const beat = run.heartbeat && setInterval(() => run.heartbeat!(Date.now() - started), 5000);
  let v: Awaited<ReturnType<typeof runStepVerification>>;
  try {
    v = await runStepVerification(root, plan, step.id, scan, {
      ...(command ? { command } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
    });
  } catch (err) {
    if (err instanceof VerificationCancelled)
      throw new ToolError('Verification was cancelled; nothing was attached to the step.');
    throw err;
  } finally {
    if (beat) clearInterval(beat);
  }
  const next = await writeBoard(file, (p) =>
    p.steps.some((s) => s.id === step.id) ? attachVerification(p, step.id, v, scan) : p,
  );
  const lines = [
    `Step "${step.title}" is ${v.status.toUpperCase()}. The evidence is attached to the step on the board.`,
    command
      ? `Ran \`${command}\`: exit code ${v.exitCode}.`
      : 'No command ran (none given or detected); judged by the code alone.',
    v.files.length
      ? `Changed files: ${v.files.join(', ')}.`
      : 'No changed files under the step’s boxes.',
    ...v.reasons.map((r) => `- ${r}`),
    `Plan status: ${next.status}.`,
  ];
  if (v.status === 'verified')
    lines.push(
      'Its code is now the baseline: later changes to these boxes (dependencies, imports, files) show as drift on the board.',
    );
  if (v.status === 'failed' && v.output) lines.push('', 'Output (tail):', v.output.slice(-1500));
  return { text: lines.join('\n') };
}
