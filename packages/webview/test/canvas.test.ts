import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlanSchema, type Plan } from '@agentic-whiteboard/shared';
import { fromScene, toScene } from '../src/canvas/adapter';
import { exportScope } from '../src/canvas/export';
import { arrowPoints, elementIndex, outlinePoint } from '../src/canvas/geometry';
import {
  deleteElements,
  duplicateElements,
  expandMoveSet,
  isBlocked,
  moveElements,
  reparentOnDrop,
  setBlocked,
  setText,
} from '../src/canvas/ops';
import { wrapText } from '../src/canvas/text';

const example = (): Plan =>
  PlanSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../shared/test/fixtures/stripe-payments.plan.json', import.meta.url),
        'utf8',
      ),
    ),
  );

describe('adapter', () => {
  it('round-trips a plan without loss', () => {
    const plan = example();
    plan.freeform = {
      shapes: [
        { id: 'f1', type: 'rect', x: 1, y: 2, w: 3, h: 4 },
        { id: 'weird', type: 'blob' },
      ],
    };
    (plan as Record<string, unknown>).customKey = 42;
    const back = fromScene(toScene(plan));
    expect(back.nodes).toEqual(plan.nodes);
    expect(back.steps).toEqual(plan.steps);
    expect(back.edges).toEqual(plan.edges);
    expect(back.constraints).toEqual(plan.constraints);
    expect(back.layout).toEqual(plan.layout);
    expect(back.freeform).toEqual(plan.freeform);
    expect((back as Record<string, unknown>).customKey).toBe(42);
  });

  it('places elements without layout and reports them', () => {
    const plan = example();
    delete plan.layout.s1;
    const scene = toScene(plan);
    expect(scene.unplaced).toEqual(['s1']);
    const el = scene.elements.find((e) => e.id === 's1')!;
    expect(el.w).toBeGreaterThan(0);
  });
});

describe('ops', () => {
  it('deleting a node removes its edges, step references and parent links', () => {
    const scene = toScene(example());
    const next = deleteElements(scene, new Set(['payments']));
    const plan = fromScene(next);
    expect(plan.nodes.some((n) => n.id === 'payments')).toBe(false);
    expect(plan.edges.some((e) => e.from === 'payments' || e.to === 'payments')).toBe(false);
    expect(plan.steps.find((s) => s.id === 's2')!.nodeIds).toEqual(['payments-file']);
    expect(plan.nodes.find((n) => n.id === 'payments-file')!.parentId).toBeUndefined();
  });

  it('deleting a step removes it from the model', () => {
    const plan = fromScene(deleteElements(toScene(example()), new Set(['s6'])));
    expect(plan.steps.map((s) => s.id)).not.toContain('s6');
    expect(plan.layout.s6).toBeUndefined();
  });

  it('moving a parent moves its children, and arrows bound to it follow', () => {
    let scene = toScene(example());
    scene = {
      ...scene,
      elements: [
        ...scene.elements,
        {
          id: 'a1',
          kind: 'shape',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          data: {
            id: 'a1',
            type: 'arrow',
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            start: { x: -100, y: -100 },
            end: { x: 0, y: 0, bindTo: 'payments' },
          },
        },
      ],
    };
    const ids = expandMoveSet(scene, new Set(['payments']));
    expect([...ids].sort()).toEqual(['payments', 'payments-file', 'webhook-file']);
    const before = elementIndex(scene);
    const moved = moveElements(scene, ids, 50, 20);
    const after = elementIndex(moved);
    expect(after.get('webhook-file')!.x).toBe(before.get('webhook-file')!.x + 50);
    const arrow = after.get('a1')!;
    if (arrow.kind !== 'shape' || arrow.data.type !== 'arrow') throw new Error('arrow');
    const [, end] = arrowPoints(arrow.data, after);
    const [, endBefore] = arrowPoints(before.get('a1')!.data as never, before);
    expect(end.x).not.toBe(endBefore.x);
  });

  it('blocks a selection and moves the blocked group together', () => {
    const scene = toScene(example());
    const blocked = setBlocked(scene, new Set(['api', 'web']), true);
    expect(isBlocked(blocked.elements.find((e) => e.id === 'api')!)).toBe(true);
    expect(isBlocked(blocked.elements.find((e) => e.id === 'web')!)).toBe(true);
    const ids = expandMoveSet(blocked, new Set(['api']));
    expect(ids).toEqual(new Set(['api', 'web']));
    const moved = moveElements(blocked, ids, 50, 20);
    expect(moved.elements.find((e) => e.id === 'web')!.x).toBe(
      scene.elements.find((e) => e.id === 'web')!.x + 50,
    );
    const unblocked = setBlocked(moved, new Set(['api', 'web']), false);
    expect(unblocked.elements.find((e) => e.id === 'api')!.data).not.toHaveProperty('blockId');
  });

  it('dropping a node into a component makes it a child; dragging out detaches it', () => {
    const scene = toScene(example());
    const box = elementIndex(scene).get('payments')!;
    let next = moveElements(scene, new Set(['routes']), 0, 0);
    next = {
      ...next,
      elements: next.elements.map((e) =>
        e.id === 'routes' ? { ...e, x: box.x + 10, y: box.y + 140, w: 100, h: 40 } : e,
      ),
    };
    next = reparentOnDrop(next, new Set(['routes']));
    expect(fromScene(next).nodes.find((n) => n.id === 'routes')!.parentId).toBe('payments');
    next = moveElements(next, new Set(['payments-file']), 2000, 0);
    next = reparentOnDrop(next, new Set(['payments-file']));
    expect(fromScene(next).nodes.find((n) => n.id === 'payments-file')!.parentId).toBeUndefined();
  });

  it('duplicates with fresh ids and remaps internal edges', () => {
    const scene = toScene(example());
    const { scene: next, ids } = duplicateElements(scene, new Set(['api', 'routes']));
    expect(ids.size).toBe(2);
    expect(next.edges.length).toBe(scene.edges.length + 1);
  });

  it('setText edits labels, titles, constraint text and edge labels', () => {
    let scene = toScene(example());
    scene = setText(scene, 's1', 'Install stripe');
    scene = setText(scene, scene.edges[0]!.id, 'HTTPS');
    const plan = fromScene(scene);
    expect(plan.steps[0]!.title).toBe('Install stripe');
    expect(plan.edges[0]!.label).toBe('HTTPS');
  });
});

describe('geometry and text', () => {
  it('outlinePoint lands on the box border', () => {
    const p = outlinePoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 500, y: 25 }, 'rect', 0);
    expect(p).toEqual({ x: 100, y: 25 });
    const e = outlinePoint({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: -500 }, 'ellipse', 0);
    expect(e.y).toBeCloseTo(0);
  });

  it('wraps and ellipsizes', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 60, 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });
});

describe('export scope', () => {
  it('keeps the selection, its children and edges between kept boxes only', () => {
    const scene = toScene(example());
    const scope = exportScope(scene, new Set(['api', 'payments']));
    expect(scope.elements.map((e) => e.id).sort()).toEqual(
      ['api', 'payments', 'payments-file', 'webhook-file'].sort(),
    );
    expect(scope.edges.map((e) => e.id)).toEqual(['e-api-payments']);
  });

  it('selecting an edge exports it with both ends', () => {
    const scope = exportScope(toScene(example()), new Set(['e-web-api']));
    expect(scope.elements.map((e) => e.id).sort()).toEqual(['api', 'web']);
    expect(scope.edges.map((e) => e.id)).toEqual(['e-web-api']);
  });
});
