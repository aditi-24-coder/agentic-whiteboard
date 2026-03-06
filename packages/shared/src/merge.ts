import { deepEqual } from './equal.js';
import { pruneDanglingRefs, type Plan } from './schema.js';

export interface MergeOptions {
  /**
   * When true, user-authored constraints and comments that `ours` removed are restored.
   * Set this when `ours` is an agent: agents must never delete what the user wrote.
   */
  protectUserContent?: boolean;
}

type WithId = { id: string };

function pickField<T>(base: T | undefined, ours: T, theirs: T): T {
  // Last writer wins per field: `ours` is the write in progress, so it wins whenever it changed.
  return deepEqual(base, ours) ? theirs : ours;
}

function mergeRecord<T extends object>(base: T | undefined, ours: T, theirs: T): T {
  if (!base) return { ...theirs, ...ours };
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  const out: Record<string, unknown> = {};
  const b = base as Record<string, unknown>;
  const o = ours as Record<string, unknown>;
  const t = theirs as Record<string, unknown>;
  for (const k of keys) {
    const v = pickField(b[k], o[k], t[k]);
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function mergeById<T extends WithId>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
  isProtected: (item: T) => boolean = () => false,
): T[] {
  const b = new Map(base.map((x) => [x.id, x]));
  const o = new Map(ours.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const order: string[] = [];
  const seen = new Set<string>();
  for (const x of [...theirs, ...ours]) {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      order.push(x.id);
    }
  }
  // Items removed by ours but protected must be restored even if theirs still has them.
  for (const x of base) {
    if (!seen.has(x.id) && isProtected(x)) {
      seen.add(x.id);
      order.push(x.id);
    }
  }

  const out: T[] = [];
  for (const id of order) {
    const bi = b.get(id);
    const oi = o.get(id);
    const ti = t.get(id);
    if (oi && ti) {
      out.push(mergeRecord(bi, oi, ti));
    } else if (oi && !ti) {
      // Theirs deleted it (or ours added it). Keep it if ours added it or changed it.
      if (!bi || !deepEqual(bi, oi)) out.push(oi);
    } else if (!oi && ti) {
      // Ours deleted it (or theirs added it). Keep it if theirs added it, changed it, or it is protected.
      if (!bi || !deepEqual(bi, ti) || isProtected(ti)) out.push(ti);
    } else if (bi && isProtected(bi)) {
      out.push(bi);
    }
  }
  return out;
}

function mergeLayout(base: Plan['layout'], ours: Plan['layout'], theirs: Plan['layout']) {
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  const out: Plan['layout'] = {};
  for (const k of keys) {
    const v = pickField(base[k], ours[k], theirs[k]);
    if (v) out[k] = v;
  }
  return out;
}

function shapeList(freeform: unknown): WithId[] | undefined {
  const shapes = (freeform as { shapes?: unknown } | null)?.shapes;
  if (!Array.isArray(shapes)) return undefined;
  return shapes.every((s) => typeof (s as WithId | null)?.id === 'string')
    ? (shapes as WithId[])
    : undefined;
}

/** Free-form shapes merge by id like the other collections, so concurrent drawings both survive. */
function mergeFreeform(base: unknown, ours: unknown, theirs: unknown): unknown {
  const b = shapeList(base) ?? [];
  const o = shapeList(ours);
  const t = shapeList(theirs);
  if (!o || !t) return pickField(base, ours, theirs);
  return { ...(theirs as object), ...(ours as object), shapes: mergeById(b, o, t) };
}

/**
 * Three-way merge of plans. Collections merge by id; each field is last-writer-wins with
 * `ours` treated as the latest writer. An item edited on one side and deleted on the other is kept.
 */
export function mergePlans(base: Plan, ours: Plan, theirs: Plan, opts: MergeOptions = {}): Plan {
  const protect = opts.protectUserContent ?? false;
  const merged: Plan = {
    ...mergeRecord(base, ours, theirs),
    nodes: mergeById(base.nodes, ours.nodes, theirs.nodes),
    edges: mergeById(base.edges, ours.edges, theirs.edges),
    steps: mergeById(base.steps, ours.steps, theirs.steps).sort((a, b) => a.order - b.order),
    constraints: mergeById(
      base.constraints,
      ours.constraints,
      theirs.constraints,
      (c) => protect && c.author === 'user',
    ),
    comments: mergeById(base.comments, ours.comments, theirs.comments, () => protect),
    layout: mergeLayout(base.layout, ours.layout, theirs.layout),
    freeform: mergeFreeform(base.freeform, ours.freeform, theirs.freeform),
    revision: Math.max(ours.revision, theirs.revision),
    updatedAt: new Date().toISOString(),
  };
  return pruneDanglingRefs(merged);
}
