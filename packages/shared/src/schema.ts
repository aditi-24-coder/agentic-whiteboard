import { z } from 'zod';

export const PLAN_VERSION = 1 as const;

export const PlanStatusSchema = z.enum([
  'drafting',
  'awaiting_approval',
  'approved',
  'in_progress',
  'done',
  'rejected',
]);
export const NodeKindSchema = z.enum(['component', 'file', 'external']);
export const ChangeTypeSchema = z.enum(['new', 'modify', 'delete', 'unchanged']);
export const RiskSchema = z.enum(['low', 'medium', 'high']);
export const StepStatusSchema = z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']);
export const AuthorSchema = z.enum(['user', 'agent']);
/** Where a diagram element came from: drawn by a person or agent, or generated from the code. */
export const OriginSchema = z.enum(['user', 'code']);
export const VerificationStatusSchema = z.enum(['verified', 'failed', 'drifted']);
/**
 * Whether a board is checked against the code. "auto": when its boxes link to code. "on": a
 * plan or architecture board. "off": a plain whiteboard (sketches, explaining to people).
 */
export const CodeSyncModeSchema = z.enum(['auto', 'on', 'off']);

const id = z.string().min(1, 'id must not be empty');

/** Optional text styling, shared by diagram boxes, sticky notes and free-form text. */
const textStyle = {
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
};

// Loose objects keep unknown keys so that a round trip through any writer never drops data.
export const NodeSchema = z.looseObject({
  id,
  blockId: z.string().optional(),
  kind: NodeKindSchema,
  label: z.string(),
  path: z.string().optional(),
  changeType: ChangeTypeSchema.default('unchanged'),
  risk: RiskSchema.optional(),
  parentId: z.string().optional(),
  /** Exported symbol inside `path` that this box stands for, e.g. "PaymentService". */
  symbol: z.string().optional(),
  /** External systems: the package that talks to it, e.g. "stripe". Checked against imports. */
  package: z.string().optional(),
  /** External systems reached through several packages (pg, prisma -> PostgreSQL): any counts. */
  packages: z.array(z.string()).optional(),
  /** External packages this box's code used when it was last synced with the code. */
  deps: z.array(z.string()).optional(),
  origin: OriginSchema.optional(),
  /** Short role shown as a tag, e.g. "api", "data", "service", "ui", "tests". */
  role: z.string().optional(),
  /** One-line summary of the linked code, e.g. "12 files · 3 routes". */
  summary: z.string().optional(),
  ...textStyle,
});

export const PointSchema = z.object({ x: z.number(), y: z.number() });

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});

/**
 * The path auto-layout chose for an edge. It is only drawn while both nodes are still at the
 * rects recorded here; once either moves, the edge falls back to a straight line.
 */
export const EdgeRouteSchema = z.object({
  points: z.array(PointSchema).min(2),
  from: RectSchema,
  to: RectSchema,
});

export const EdgeSchema = z.looseObject({
  id,
  from: id,
  to: id,
  label: z.string().optional(),
  route: EdgeRouteSchema.optional(),
  /** "code": the arrow mirrors an import and is re-checked against the code. */
  origin: OriginSchema.optional(),
  /** The code imported along this arrow when the board was last synced or a step verified. */
  imported: z.boolean().optional(),
});

/** Evidence attached to a step by `verify_step`: what ran, what changed, and the verdict. */
export const VerificationSchema = z.looseObject({
  status: VerificationStatusSchema,
  at: z.string(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  /** Tail of the command output. */
  output: z.string().optional(),
  /** `git diff --stat` of the files the step changed. */
  diffStat: z.string().optional(),
  /** The diff itself, truncated. */
  diff: z.string().optional(),
  files: z.array(z.string()).default([]),
  commit: z.string().optional(),
  /** Why the step is failed or drifted. */
  reasons: z.array(z.string()).default([]),
});

/** When the board was last synced with the code. */
export const CodebaseSchema = z.looseObject({
  scannedAt: z.string(),
  commit: z.string().optional(),
  /** Workspace-relative folder the architecture was generated from; "" for the whole repo. */
  folder: z.string().optional(),
  /**
   * Box-to-box imports ("from->to") that existed at the last sync or verified step. Imports
   * outside this list that have no arrow are new, and flagged.
   */
  links: z.array(z.string()).optional(),
});

export const StepSchema = z.looseObject({
  id,
  blockId: z.string().optional(),
  order: z.number(),
  title: z.string(),
  detail: z.string().optional(),
  nodeIds: z.array(z.string()).default([]),
  status: StepStatusSchema.default('pending'),
  note: z.string().optional(),
  verification: VerificationSchema.optional(),
});

export const ConstraintSchema = z.looseObject({
  id,
  blockId: z.string().optional(),
  text: z.string(),
  scope: z.array(z.string()).optional(),
  author: AuthorSchema.default('user'),
});

export const CommentSchema = z.looseObject({
  id,
  blockId: z.string().optional(),
  text: z.string(),
  attachedTo: z.string().optional(),
  ...textStyle,
});

export const PlanSchema = z.looseObject({
  version: z.literal(PLAN_VERSION).default(PLAN_VERSION),
  revision: z.number().int().nonnegative().default(0),
  id,
  title: z.string(),
  prompt: z.string().default(''),
  status: PlanStatusSchema.default('drafting'),
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  steps: z.array(StepSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
  comments: z.array(CommentSchema).default([]),
  layout: z.record(z.string(), RectSchema).default({}),
  freeform: z.unknown().default({ shapes: [] }),
  codebase: CodebaseSchema.optional(),
  /** Absent means "auto". */
  codeSync: CodeSyncModeSchema.optional(),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type ChangeType = z.infer<typeof ChangeTypeSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type PlanNode = z.infer<typeof NodeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type EdgeRoute = z.infer<typeof EdgeRouteSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
export type Codebase = z.infer<typeof CodebaseSchema>;
export type CodeSyncMode = z.infer<typeof CodeSyncModeSchema>;
/** Plan as accepted from writers: defaults may be omitted. */
export type PlanInput = z.input<typeof PlanSchema>;

export type ValidationResult =
  { ok: true; plan: Plan; warnings: string[] } | { ok: false; errors: string[] };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(root)';
}

/**
 * Validates unknown input against the plan schema and checks referential integrity.
 * Schema problems and duplicate ids are errors; dangling references are warnings.
 */
export function validatePlan(input: unknown): ValidationResult {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`),
    };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, string>();
  const collections = ['nodes', 'edges', 'steps', 'constraints', 'comments'] as const;
  for (const key of collections) {
    plan[key].forEach((item, i) => {
      const prev = seen.get(item.id);
      if (prev) errors.push(`${key}[${i}].id: duplicate id "${item.id}" (already used in ${prev})`);
      else seen.set(item.id, `${key}[${i}]`);
    });
  }

  const nodeIds = new Set(plan.nodes.map((n) => n.id));
  plan.edges.forEach((e, i) => {
    if (!nodeIds.has(e.from)) warnings.push(`edges[${i}].from: unknown node "${e.from}"`);
    if (!nodeIds.has(e.to)) warnings.push(`edges[${i}].to: unknown node "${e.to}"`);
  });
  plan.steps.forEach((s, i) => {
    s.nodeIds.forEach((n, j) => {
      if (!nodeIds.has(n)) warnings.push(`steps[${i}].nodeIds[${j}]: unknown node "${n}"`);
    });
  });
  plan.nodes.forEach((n, i) => {
    if (n.parentId && !nodeIds.has(n.parentId))
      warnings.push(`nodes[${i}].parentId: unknown node "${n.parentId}"`);
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan, warnings };
}

/** Drops edges, step references and layout entries that point at elements that no longer exist. */
export function pruneDanglingRefs(plan: Plan): Plan {
  const nodeIds = new Set(plan.nodes.map((n) => n.id));
  const allIds = new Set<string>([
    ...nodeIds,
    ...plan.steps.map((s) => s.id),
    ...plan.constraints.map((c) => c.id),
    ...plan.comments.map((c) => c.id),
  ]);
  const layout: Plan['layout'] = {};
  for (const [k, v] of Object.entries(plan.layout)) if (allIds.has(k)) layout[k] = v;
  return {
    ...plan,
    nodes: plan.nodes.map((n) => {
      if (!n.parentId || nodeIds.has(n.parentId)) return n;
      const { parentId: _drop, ...rest } = n;
      return rest;
    }),
    edges: plan.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
    steps: plan.steps.map((s) => ({ ...s, nodeIds: s.nodeIds.filter((n) => nodeIds.has(n)) })),
    comments: plan.comments.map((c) => {
      if (!c.attachedTo || allIds.has(c.attachedTo)) return c;
      const { attachedTo: _drop, ...rest } = c;
      return rest;
    }),
    layout,
  };
}

export function planProgress(plan: Pick<Plan, 'steps'>): { done: number; total: number } {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done, total };
}

export function sortedSteps<T extends Pick<Step, 'order'>>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => a.order - b.order);
}

/** Extension of whiteboard files. Older `.plan.json` files open on the same board. */
export const WHITEBOARD_EXT = '.whiteboard';

export function isBoardFileName(name: string): boolean {
  return name.endsWith(WHITEBOARD_EXT) || name.endsWith('.plan.json');
}

/** File name without the board extension: `docs/flow.whiteboard` -> `flow`. */
export function boardBaseName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (base.endsWith(WHITEBOARD_EXT)) return base.slice(0, -WHITEBOARD_EXT.length);
  if (base.endsWith('.plan.json')) return base.slice(0, -'.plan.json'.length);
  return base;
}

export function blankBoard(id: string, title: string): Plan {
  return PlanSchema.parse({ version: PLAN_VERSION, revision: 1, id, title, status: 'drafting' });
}

/**
 * Board backgrounds, stored as `background` on the board. Each sets the light or dark palette
 * so ink stays readable. No `background` means: follow the VS Code theme.
 */
export const BOARD_BACKGROUNDS = {
  white: { label: 'White', color: '#ffffff', tone: 'light' },
  paper: { label: 'Paper', color: '#fbfaf7', tone: 'light' },
  grey: { label: 'Light grey', color: '#eceef1', tone: 'light' },
  blue: { label: 'Blueprint light', color: '#eef4fb', tone: 'light' },
  slate: { label: 'Slate', color: '#1b1b1f', tone: 'dark' },
  navy: { label: 'Navy', color: '#121a2b', tone: 'dark' },
  black: { label: 'Black', color: '#09090b', tone: 'dark' },
} as const;

export type BoardBackground = keyof typeof BOARD_BACKGROUNDS;

export function boardBackground(plan: object) {
  const id = (plan as { background?: unknown }).background;
  return typeof id === 'string' && id in BOARD_BACKGROUNDS
    ? { id: id as BoardBackground, ...BOARD_BACKGROUNDS[id as BoardBackground] }
    : undefined;
}
