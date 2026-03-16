import { describe, expect, it } from 'vitest';
import { diffPlans, mergePlans, summarizeChanges } from '../src/index.js';
import { makePlan } from './fixtures.js';

describe('mergePlans', () => {
  it('keeps both sides additions', () => {
    const base = makePlan();
    const ours = structuredClone(base);
    ours.nodes.push({ id: 'db', kind: 'component', label: 'DB', changeType: 'new' });
    const theirs = structuredClone(base);
    theirs.comments.push({ id: 'c1', text: 'use idempotency keys' });
    theirs.constraints.push({ id: 'k1', text: "don't touch auth", author: 'user' });
    const merged = mergePlans(base, ours, theirs);
    expect(merged.nodes.map((n) => n.id)).toContain('db');
    expect(merged.comments).toHaveLength(1);
    expect(merged.constraints).toHaveLength(1);
  });

  it('merges free-form shapes by id, so concurrent drawings both survive', () => {
    const rect = (id: string, x = 0) => ({ id, type: 'rect', x, y: 0, w: 10, h: 10 });
    const base = makePlan({ freeform: { shapes: [rect('a'), rect('b')] } });
    const ours = structuredClone(base);
    (ours.freeform as { shapes: unknown[] }).shapes.push(rect('agent'));
    const theirs = structuredClone(base);
    const theirShapes = (theirs.freeform as { shapes: ReturnType<typeof rect>[] }).shapes;
    theirShapes.push(rect('user'));
    theirShapes[0]!.x = 50;
    theirShapes.splice(1, 1);
    const merged = mergePlans(base, ours, theirs);
    const shapes = (merged.freeform as { shapes: ReturnType<typeof rect>[] }).shapes;
    expect(shapes.map((s) => s.id)).toEqual(['a', 'user', 'agent']);
    expect(shapes[0]!.x).toBe(50);
  });

  it('is last-writer-wins per field, ours being the latest writer', () => {
    const base = makePlan();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours.steps[0]!.status = 'done';
    theirs.steps[0]!.title = 'Create PaymentService';
    theirs.steps[1]!.status = 'failed';
    ours.steps[1]!.status = 'in_progress';
    const merged = mergePlans(base, ours, theirs);
    expect(merged.steps[0]).toMatchObject({ status: 'done', title: 'Create PaymentService' });
    expect(merged.steps[1]!.status).toBe('in_progress');
  });

  it('honours a deletion on one side when the other side did not touch the item', () => {
    const base = makePlan();
    const ours = structuredClone(base);
    ours.steps[2]!.status = 'done';
    const theirs = structuredClone(base);
    theirs.steps = theirs.steps.filter((s) => s.id !== 's2');
    const merged = mergePlans(base, ours, theirs);
    expect(merged.steps.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('keeps an item edited on one side and deleted on the other', () => {
    const base = makePlan();
    const ours = structuredClone(base);
    ours.steps[1]!.status = 'done';
    const theirs = structuredClone(base);
    theirs.steps = theirs.steps.filter((s) => s.id !== 's2');
    expect(mergePlans(base, ours, theirs).steps.map((s) => s.id)).toContain('s2');
  });

  it('never lets ours (an agent) drop user comments or constraints', () => {
    const base = makePlan({
      comments: [{ id: 'c1', text: 'keep me' }],
      constraints: [
        { id: 'k1', text: 'no auth changes', author: 'user' },
        { id: 'k2', text: 'agent note', author: 'agent' },
      ],
    });
    const ours = structuredClone(base);
    ours.comments = [];
    ours.constraints = [];
    const theirs = structuredClone(base);
    theirs.revision = 5;
    const merged = mergePlans(base, ours, theirs, { protectUserContent: true });
    expect(merged.comments.map((c) => c.id)).toEqual(['c1']);
    expect(merged.constraints.map((c) => c.id)).toEqual(['k1']);
    expect(merged.revision).toBe(5);
  });

  it('prunes edges to nodes deleted by the other side', () => {
    const base = makePlan();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    theirs.nodes = theirs.nodes.filter((n) => n.id !== 'stripe');
    const merged = mergePlans(base, ours, theirs);
    expect(merged.edges.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('diffPlans', () => {
  it('describes user edits for the agent', () => {
    const before = makePlan();
    const after = structuredClone(before);
    after.status = 'approved';
    after.steps = after.steps.filter((s) => s.id !== 's3');
    after.nodes = after.nodes.filter((n) => n.id !== 'stripe');
    after.edges = after.edges.filter((e) => e.to !== 'stripe');
    after.constraints.push({ id: 'k', text: "don't touch auth", author: 'user' });
    after.comments.push({ id: 'c', text: 'use a queue', attachedTo: 'svc' });
    after.nodes[0]!.label = 'HTTP API';
    after.layout = { api: { x: 1, y: 2, w: 3, h: 4 } };

    const changes = diffPlans(before, after);
    const text = summarizeChanges(changes);
    expect(text).toContain('approved');
    expect(text).toContain('DELETED step 3 "Add webhook"');
    expect(text).toContain('DELETED external "Stripe"');
    expect(text).toContain('CONSTRAINT: "don\'t touch auth"');
    expect(text).toContain('use a queue');
    expect(text).toContain('renamed to "HTTP API"');
    // Edge removal caused by a node deletion is not reported twice.
    expect(changes.filter((c) => c.target === 'edge')).toHaveLength(0);
  });

  it('reports reordering', () => {
    const before = makePlan();
    const after = structuredClone(before);
    after.steps[0]!.order = 5;
    expect(summarizeChanges(diffPlans(before, after))).toContain('reordered');
  });

  it('says nothing changed for layout-only edits', () => {
    const before = makePlan();
    const after = { ...structuredClone(before), layout: { api: { x: 9, y: 9, w: 9, h: 9 } } };
    expect(diffPlans(before, after)).toEqual([]);
  });
});
