import { describe, expect, it } from 'vitest';
import { parsePlanText, planProgress, pruneDanglingRefs, validatePlan } from '../src/index.js';
import { parseFreeform } from '../src/freeform.js';
import { parsePlanText as parseNode } from '../src/io.js';
import { makePlan } from './fixtures.js';

describe('validatePlan', () => {
  it('fills defaults for a minimal plan', () => {
    const res = validatePlan({ id: 'x', title: 'X' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan).toMatchObject({
      version: 1,
      revision: 0,
      status: 'drafting',
      nodes: [],
      steps: [],
      layout: {},
    });
  });

  it('returns readable errors with paths', () => {
    const res = validatePlan({
      id: 'x',
      title: 'X',
      steps: [{ id: 's', order: 1, title: 't', status: 'finished' }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatch(/^steps\[0\]\.status: /);
  });

  it('rejects duplicate ids across collections', () => {
    const res = validatePlan({
      id: 'x',
      title: 'X',
      nodes: [{ id: 'a', kind: 'component', label: 'A' }],
      steps: [{ id: 'a', order: 1, title: 'A' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('duplicate id "a"');
  });

  it('warns about dangling references', () => {
    const res = validatePlan({ id: 'x', title: 'X', edges: [{ id: 'e', from: 'a', to: 'b' }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings).toHaveLength(2);
  });

  it('keeps unknown keys', () => {
    const res = validatePlan({
      id: 'x',
      title: 'X',
      custom: { a: 1 },
      nodes: [{ id: 'n', kind: 'file', label: 'n', extra: true }],
    });
    expect(res.ok && (res.plan as Record<string, unknown>).custom).toEqual({ a: 1 });
    expect(res.ok && (res.plan.nodes[0] as Record<string, unknown>).extra).toBe(true);
  });
});

describe('parsePlanText', () => {
  it('reports malformed JSON', () => {
    const res = parsePlanText('{ "id": ');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatch(/Malformed JSON/);
    expect(parseNode).toBe(parsePlanText);
  });
});

describe('helpers', () => {
  it('pruneDanglingRefs removes references to deleted nodes', () => {
    const plan = makePlan();
    plan.nodes = plan.nodes.filter((n) => n.id !== 'svc');
    const pruned = pruneDanglingRefs(plan);
    expect(pruned.edges).toEqual([]);
    expect(pruned.steps[0]!.nodeIds).toEqual(['f1']);
    expect(pruned.nodes.find((n) => n.id === 'f1')!.parentId).toBeUndefined();
  });

  it('planProgress counts done and skipped', () => {
    const plan = makePlan();
    plan.steps[0]!.status = 'done';
    plan.steps[1]!.status = 'skipped';
    expect(planProgress(plan)).toEqual({ done: 2, total: 3 });
  });

  it('parseFreeform keeps malformed shapes aside', () => {
    const { freeform, unknown } = parseFreeform({
      shapes: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', type: 'blob' },
      ],
    });
    expect(freeform.shapes).toHaveLength(1);
    expect(unknown).toHaveLength(1);
  });
});
