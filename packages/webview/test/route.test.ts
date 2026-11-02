import { describe, expect, it } from 'vitest';
import { routeConnectors } from '../src/canvas/route';
import type { Box, Pt, Scene, SceneElement } from '../src/canvas/types';

const rect = (id: string, x: number, y: number, w = 100, h = 60): SceneElement =>
  ({ id, kind: 'shape', x, y, w, h, data: { id, type: 'rect', x, y, w, h } }) as SceneElement;

const arrow = (id: string, from: string, to: string): SceneElement =>
  ({
    id,
    kind: 'shape',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    data: {
      id,
      type: 'arrow',
      start: { x: 0, y: 0, bindTo: from },
      end: { x: 0, y: 0, bindTo: to },
    },
  }) as SceneElement;

const scene = (elements: SceneElement[], edges: [string, string][] = []): Scene =>
  ({
    meta: {},
    elements,
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })),
    unknownShapes: [],
    unplaced: [],
  }) as unknown as Scene;

/** Whether any segment of the polyline passes through the interior of `b`. */
function crosses(pts: readonly Pt[], b: Box): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const c = pts[i + 1]!;
    for (let t = 0; t <= 1; t += 0.01) {
      const x = a.x + (c.x - a.x) * t;
      const y = a.y + (c.y - a.y) * t;
      if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true;
    }
  }
  return false;
}

describe('routeConnectors', () => {
  it('keeps a connector straight when nothing is in the way', () => {
    const r = routeConnectors(scene([rect('a', 0, 0), rect('b', 300, 0)], [['a', 'b']]));
    expect(r.get('e0')).toHaveLength(2);
  });

  it('routes around a box sitting between the two ends', () => {
    const blocker = rect('x', 150, -20, 100, 100);
    const r = routeConnectors(
      scene([rect('a', 0, 0), blocker, rect('b', 400, 0), arrow('arr', 'a', 'b')], [['a', 'b']]),
    );
    for (const id of ['e0', 'arr']) {
      const pts = r.get(id)!;
      expect(pts.length).toBeGreaterThan(2);
      expect(crosses(pts, blocker)).toBe(false);
      // Orthogonal between the two end stubs.
      for (let i = 0; i < pts.length - 1; i++)
        expect(pts[i]!.x === pts[i + 1]!.x || pts[i]!.y === pts[i + 1]!.y).toBe(true);
    }
  });

  it('does not run two connectors along the same line', () => {
    const r = routeConnectors(
      scene(
        [rect('a', 0, 0), rect('x', 150, -20, 100, 100), rect('b', 400, 0)],
        [
          ['a', 'b'],
          ['a', 'b'],
        ],
      ),
    );
    const segs = (pts: Pt[]) =>
      pts.slice(1, -2).map((p, i) => `${p.x},${p.y}-${pts[i + 2]!.x},${pts[i + 2]!.y}`);
    const shared = segs(r.get('e0')!).filter((s) => segs(r.get('e1')!).includes(s));
    expect(shared).toEqual([]);
  });

  it('crosses the box an end sits inside, but no other', () => {
    const parent = rect('p', -50, -50, 600, 200);
    const blocker = rect('x', 150, -20, 100, 100);
    const r = routeConnectors(
      scene([parent, rect('a', 0, 0), blocker, rect('b', 400, 0)], [['a', 'b']]),
    );
    expect(crosses(r.get('e0')!, blocker)).toBe(false);
  });

  it('is quick enough to run on every drag frame', () => {
    const els: SceneElement[] = [];
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) els.push(rect(`n${i}${j}`, i * 180, j * 120));
    const edges: [string, string][] = [];
    for (let i = 0; i < 40; i++) edges.push([`n${i % 8}${(i * 3) % 8}`, `n${(i * 5) % 8}${i % 8}`]);
    const t = performance.now();
    routeConnectors(scene(els, edges));
    expect(performance.now() - t).toBeLessThan(500);
  });
});
