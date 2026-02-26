import { deepEqual } from './equal.js';
import { sortedSteps, type Plan } from './schema.js';

export type ChangeKind = 'added' | 'removed' | 'changed';
export type ChangeTarget = 'plan' | 'node' | 'edge' | 'step' | 'constraint' | 'comment';

export interface Change {
  kind: ChangeKind;
  target: ChangeTarget;
  id?: string;
  description: string;
}

function quote(s: string | undefined) {
  return `"${s ?? ''}"`;
}

/**
 * Describes what changed from `before` (the plan as the agent last wrote it) to `after`
 * (the plan on disk now), in terms an agent can act on. Layout-only changes are ignored.
 */
export function diffPlans(before: Plan, after: Plan): Change[] {
  const changes: Change[] = [];
  const nodeLabel = (id: string) =>
    after.nodes.find((n) => n.id === id)?.label ??
    before.nodes.find((n) => n.id === id)?.label ??
    id;

  if (before.status !== after.status)
    changes.push({
      kind: 'changed',
      target: 'plan',
      description: `Plan status changed from ${before.status} to ${after.status}.`,
    });
  if (before.title !== after.title)
    changes.push({
      kind: 'changed',
      target: 'plan',
      description: `Plan renamed from ${quote(before.title)} to ${quote(after.title)}.`,
    });

  // Nodes
  const bNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const aNodes = new Map(after.nodes.map((n) => [n.id, n]));
  for (const [id, n] of bNodes)
    if (!aNodes.has(id))
      changes.push({
        kind: 'removed',
        target: 'node',
        id,
        description: `User DELETED ${n.kind} ${quote(n.label)} (${id})${n.path ? ` at ${n.path}` : ''}. Do not create or modify it.`,
      });
  for (const [id, n] of aNodes) {
    const b = bNodes.get(id);
    if (!b) {
      changes.push({
        kind: 'added',
        target: 'node',
        id,
        description: `User added ${n.kind} ${quote(n.label)} (${id})${n.path ? ` at ${n.path}` : ''}, change type ${n.changeType}.`,
      });
      continue;
    }
    const parts: string[] = [];
    if (b.label !== n.label) parts.push(`renamed to ${quote(n.label)}`);
    if (b.path !== n.path) parts.push(`path set to ${n.path ?? '(none)'}`);
    if (b.changeType !== n.changeType) parts.push(`change type ${b.changeType} -> ${n.changeType}`);
    if (b.risk !== n.risk) parts.push(`risk ${b.risk ?? 'none'} -> ${n.risk ?? 'none'}`);
    if (b.kind !== n.kind) parts.push(`kind ${b.kind} -> ${n.kind}`);
    if (b.parentId !== n.parentId)
      parts.push(`moved under ${n.parentId ? nodeLabel(n.parentId) : 'top level'}`);
    if (parts.length)
      changes.push({
        kind: 'changed',
        target: 'node',
        id,
        description: `User edited node ${quote(b.label)} (${id}): ${parts.join(', ')}.`,
      });
  }

  // Edges
  const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
  const bEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const aEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  for (const [k, e] of bEdges)
    if (!aEdges.has(k) && aNodes.has(e.from) && aNodes.has(e.to))
      changes.push({
        kind: 'removed',
        target: 'edge',
        id: e.id,
        description: `User removed the connection ${quote(nodeLabel(e.from))} -> ${quote(nodeLabel(e.to))}.`,
      });
  for (const [k, e] of aEdges)
    if (!bEdges.has(k))
      changes.push({
        kind: 'added',
        target: 'edge',
        id: e.id,
        description: `User added a connection ${quote(nodeLabel(e.from))} -> ${quote(nodeLabel(e.to))}${e.label ? ` (${e.label})` : ''}.`,
      });

  // Steps
  const bSteps = new Map(before.steps.map((s) => [s.id, s]));
  const aSteps = new Map(after.steps.map((s) => [s.id, s]));
  for (const [id, s] of bSteps)
    if (!aSteps.has(id))
      changes.push({
        kind: 'removed',
        target: 'step',
        id,
        description: `User DELETED step ${s.order} ${quote(s.title)} (${id}). Do not perform it.`,
      });
  for (const [id, s] of aSteps) {
    const b = bSteps.get(id);
    if (!b) {
      changes.push({
        kind: 'added',
        target: 'step',
        id,
        description: `User added step ${quote(s.title)} (${id})${s.detail ? `: ${s.detail}` : ''}.`,
      });
      continue;
    }
    const parts: string[] = [];
    if (b.title !== s.title) parts.push(`title changed to ${quote(s.title)}`);
    if ((b.detail ?? '') !== (s.detail ?? '')) parts.push(`detail changed to ${quote(s.detail)}`);
    if (!deepEqual(b.nodeIds, s.nodeIds))
      parts.push(`now touches ${s.nodeIds.map(nodeLabel).join(', ') || 'no nodes'}`);
    if (b.status !== s.status) parts.push(`status ${b.status} -> ${s.status}`);
    if ((b.note ?? '') !== (s.note ?? '')) parts.push(`note: ${quote(s.note)}`);
    if (parts.length)
      changes.push({
        kind: 'changed',
        target: 'step',
        id,
        description: `User edited step ${quote(b.title)} (${id}): ${parts.join(', ')}.`,
      });
  }
  const common = (p: Plan) =>
    sortedSteps(p.steps)
      .map((s) => s.id)
      .filter((id) => bSteps.has(id) && aSteps.has(id));
  const beforeOrder = common(before);
  const afterOrder = common(after);
  if (!deepEqual(beforeOrder, afterOrder))
    changes.push({
      kind: 'changed',
      target: 'step',
      description: `User reordered steps. New order: ${sortedSteps(after.steps)
        .map((s) => quote(s.title))
        .join(' -> ')}.`,
    });

  // Constraints and comments
  const bCons = new Map(before.constraints.map((c) => [c.id, c]));
  const aCons = new Map(after.constraints.map((c) => [c.id, c]));
  for (const [id, c] of aCons) {
    const b = bCons.get(id);
    if (!b)
      changes.push({
        kind: 'added',
        target: 'constraint',
        id,
        description: `User added CONSTRAINT: ${quote(c.text)}${c.scope?.length ? ` (applies to ${c.scope.join(', ')})` : ''}. You must obey it.`,
      });
    else if (b.text !== c.text || !deepEqual(b.scope, c.scope))
      changes.push({
        kind: 'changed',
        target: 'constraint',
        id,
        description: `User changed constraint to ${quote(c.text)}. You must obey it.`,
      });
  }
  for (const [id, c] of bCons)
    if (!aCons.has(id))
      changes.push({
        kind: 'removed',
        target: 'constraint',
        id,
        description: `User removed constraint ${quote(c.text)}.`,
      });

  const bCom = new Map(before.comments.map((c) => [c.id, c]));
  const aCom = new Map(after.comments.map((c) => [c.id, c]));
  const attached = (t?: string) => (t ? ` (on ${nodeLabel(t)})` : '');
  for (const [id, c] of aCom) {
    const b = bCom.get(id);
    if (!b)
      changes.push({
        kind: 'added',
        target: 'comment',
        id,
        description: `User commented${attached(c.attachedTo)}: ${quote(c.text)}`,
      });
    else if (b.text !== c.text)
      changes.push({
        kind: 'changed',
        target: 'comment',
        id,
        description: `User edited a comment${attached(c.attachedTo)}: ${quote(c.text)}`,
      });
  }
  for (const [id, c] of bCom)
    if (!aCom.has(id))
      changes.push({
        kind: 'removed',
        target: 'comment',
        id,
        description: `User removed comment ${quote(c.text)}.`,
      });

  return changes;
}

export function summarizeChanges(changes: readonly Change[]): string {
  if (!changes.length) return 'No changes by the user since your last write.';
  return [
    `The user made ${changes.length} change(s) since your last write:`,
    ...changes.map((c) => `- ${c.description}`),
  ].join('\n');
}
