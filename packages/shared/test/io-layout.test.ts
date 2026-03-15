import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoLayout } from '../src/layout.js';
import {
  createPlanFile,
  listPlanFiles,
  readPlan,
  updatePlanFile,
  writePlanAtomic,
} from '../src/io.js';
import type { Plan, Rect } from '../src/schema.js';
import { makePlan } from './fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-whiteboard-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomic IO', () => {
  it('writes and reads back, leaving no temp files', async () => {
    const file = path.join(dir, 'a.plan.json');
    await writePlanAtomic(file, makePlan());
    expect((await readPlan(file)).title).toBe('Demo plan');
    expect(await fs.readdir(dir)).toEqual(['a.plan.json']);
  });

  it('never leaves a half-written file under concurrent writes', async () => {
    const file = path.join(dir, 'a.plan.json');
    const big = makePlan();
    for (let i = 0; i < 300; i++)
      big.nodes.push({ id: `n${i}`, kind: 'component', label: `Node ${i}`, changeType: 'new' });
    await writePlanAtomic(file, big);
    const writes = Array.from({ length: 20 }, (_, i) =>
      writePlanAtomic(file, { ...big, revision: i }),
    );
    const reads = Array.from({ length: 20 }, () => readPlan(file));
    await Promise.all([...writes, ...reads]);
    expect((await readPlan(file)).nodes).toHaveLength(304);
  });

  it('updatePlanFile serialises concurrent updates without losing any', async () => {
    const file = path.join(dir, 'a.plan.json');
    await createPlanFile(file, makePlan({ revision: 0 }));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updatePlanFile(file, (p) => {
          p.comments.push({ id: `c${i}`, text: `comment ${i}` });
        }),
      ),
    );
    const plan = await readPlan(file);
    expect(plan.comments).toHaveLength(10);
    expect(plan.revision).toBe(10);
  });

  it('createPlanFile refuses to overwrite', async () => {
    const file = path.join(dir, 'a.plan.json');
    await createPlanFile(file, makePlan());
    await expect(createPlanFile(file, makePlan())).rejects.toThrow();
  });

  it('listPlanFiles reports broken files instead of throwing', async () => {
    await writePlanAtomic(path.join(dir, 'good.plan.json'), makePlan());
    await fs.writeFile(path.join(dir, 'bad.plan.json'), '{nope');
    await fs.writeFile(path.join(dir, 'other.json'), '{}');
    const list = await listPlanFiles(dir);
    expect(list).toHaveLength(2);
    expect(list.find((f) => f.file.endsWith('bad.plan.json'))!.errors![0]).toMatch(/Malformed/);
    expect(await listPlanFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function topLevelRects(plan: Plan) {
  return plan.nodes.filter((n) => !n.parentId).map((n) => plan.layout[n.id]!);
}

describe('autoLayout', () => {
  it('lays out every element without overlapping top-level nodes', async () => {
    const plan = await autoLayout(
      makePlan({
        constraints: [{ id: 'k', text: 'x', author: 'user' }],
        comments: [{ id: 'c', text: 'y', attachedTo: 'api' }],
      }),
    );
    for (const id of ['api', 'svc', 'f1', 'stripe', 's1', 's2', 's3', 'k', 'c'])
      expect(plan.layout[id]).toBeDefined();
    const rects = topLevelRects(plan);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    // Flow is left to right.
    expect(plan.layout.api!.x).toBeLessThan(plan.layout.svc!.x);
    // A child sits inside its parent.
    const parent = plan.layout.svc!;
    const child = plan.layout.f1!;
    expect(
      child.x >= parent.x && child.y >= parent.y && child.x + child.w <= parent.x + parent.w,
    ).toBe(true);
    // Steps stack in order to the right of the graph.
    expect(plan.layout.s1!.y).toBeLessThan(plan.layout.s2!.y);
    expect(plan.layout.s1!.x).toBeGreaterThan(plan.layout.stripe!.x);
  });

  it('routes edges from border to border and spaces labelled layers apart', async () => {
    const plan = await autoLayout(
      makePlan({
        layout: {},
        edges: [
          { id: 'e1', from: 'api', to: 'svc', label: 'access + refresh token' },
          { id: 'e2', from: 'svc', to: 'api', label: 'callback' },
        ],
      }),
    );
    for (const e of plan.edges) {
      const r = e.route!;
      expect(r.from).toEqual(plan.layout[e.from]);
      expect(r.to).toEqual(plan.layout[e.to]);
      const onBorder = (p: { x: number; y: number }, b: typeof r.from) =>
        Math.abs(p.x - b.x) <= 1 ||
        Math.abs(p.x - b.x - b.w) <= 1 ||
        Math.abs(p.y - b.y) <= 1 ||
        Math.abs(p.y - b.y - b.h) <= 1;
      expect(onBorder(r.points[0]!, r.from)).toBe(true);
      expect(onBorder(r.points.at(-1)!, r.to)).toBe(true);
      // Orthogonal routing: every segment is horizontal or vertical.
      for (let i = 1; i < r.points.length; i++)
        expect(r.points[i]!.x === r.points[i - 1]!.x || r.points[i]!.y === r.points[i - 1]!.y).toBe(
          true,
        );
    }
    const api = plan.layout.api!;
    const svc = plan.layout.svc!;
    const gap = Math.max(svc.x - (api.x + api.w), api.x - (svc.x + svc.w));
    expect(gap).toBeGreaterThan('access + refresh token'.length * 7);
  });

  it('drops stale routes on a forced re-layout and recomputes them', async () => {
    const first = await autoLayout(makePlan({ layout: {} }));
    const moved = { ...first, layout: { ...first.layout, api: { ...first.layout.api!, x: 9999 } } };
    const again = await autoLayout(moved, { force: true });
    expect(again.edges.find((e) => e.id === 'e1')!.route!.from).toEqual(again.layout.api);
  });

  it('keeps existing positions unless forced', async () => {
    const plan = makePlan({ layout: { api: { x: -500, y: -500, w: 200, h: 72 } } });
    expect((await autoLayout(plan)).layout.api!.x).toBe(-500);
    expect((await autoLayout(plan, { force: true })).layout.api!.x).not.toBe(-500);
  });

  it('handles 250 nodes', async () => {
    const plan = makePlan();
    for (let i = 0; i < 250; i++) {
      plan.nodes.push({
        id: `n${i}`,
        kind: i % 2 ? 'file' : 'component',
        label: `N${i}`,
        changeType: 'new',
      });
      if (i > 0) plan.edges.push({ id: `x${i}`, from: `n${Math.floor(i / 3)}`, to: `n${i}` });
    }
    const t = Date.now();
    const out = await autoLayout(plan);
    expect(Object.keys(out.layout).length).toBeGreaterThanOrEqual(254);
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  it('survives parent cycles', async () => {
    const plan = makePlan({
      nodes: [
        { id: 'a', kind: 'component', label: 'A', parentId: 'b' },
        { id: 'b', kind: 'component', label: 'B', parentId: 'a' },
      ],
      edges: [],
      steps: [],
    });
    const out = await autoLayout(plan);
    expect(out.layout.a && out.layout.b).toBeTruthy();
  });
});
