import {
  parseFreeform,
  pruneDanglingRefs,
  serializeFreeform,
  type FreeformShape,
  type Plan,
} from '@agentic-whiteboard/shared';
import { exportPng, exportSvg } from './export';
import { unionBoxes } from './geometry';
import type { Box, CanvasAdapter, Scene, SceneElement } from './types';

export const DEFAULT_SIZE = {
  component: { w: 200, h: 72 },
  file: { w: 240, h: 56 },
  external: { w: 180, h: 64 },
  step: { w: 300, h: 76 },
  constraint: { w: 220, h: 110 },
  comment: { w: 200, h: 110 },
} as const;

function sizeFor(el: Pick<SceneElement, 'kind'> & { data: unknown }): { w: number; h: number } {
  switch (el.kind) {
    case 'node':
      return (
        DEFAULT_SIZE[(el.data as { kind: keyof typeof DEFAULT_SIZE }).kind] ??
        DEFAULT_SIZE.component
      );
    case 'step':
      return DEFAULT_SIZE.step;
    case 'constraint':
      return DEFAULT_SIZE.constraint;
    default:
      return DEFAULT_SIZE.comment;
  }
}

export function toScene(plan: Plan): Scene {
  const { nodes, edges, steps, constraints, comments, layout, freeform, ...meta } = plan;
  const { freeform: ff, unknown } = parseFreeform(freeform);
  const elements: SceneElement[] = [];
  const unplaced: SceneElement[] = [];

  const place = (el: SceneElement) => {
    elements.push(el);
    if (!layout[el.id]) unplaced.push(el);
  };
  const box = (id: string, kind: SceneElement['kind'], data: unknown): Box => {
    const r = layout[id];
    if (r)
      return {
        x: r.x,
        y: r.y,
        w: r.w || sizeFor({ kind, data }).w,
        h: r.h || sizeFor({ kind, data }).h,
      };
    return { x: 0, y: 0, ...sizeFor({ kind, data }) };
  };

  for (const n of nodes) place({ id: n.id, kind: 'node', data: n, ...box(n.id, 'node', n) });
  for (const s of steps) place({ id: s.id, kind: 'step', data: s, ...box(s.id, 'step', s) });
  for (const c of constraints)
    place({ id: c.id, kind: 'constraint', data: c, ...box(c.id, 'constraint', c) });
  for (const c of comments)
    place({ id: c.id, kind: 'comment', data: c, ...box(c.id, 'comment', c) });
  for (const s of ff.shapes)
    elements.push({ id: s.id, kind: 'shape', data: s, x: s.x, y: s.y, w: s.w, h: s.h });

  // Elements without a layout entry (e.g. hand-edited JSON) get a temporary grid position
  // below everything else; the host is then asked to auto-layout them properly.
  if (unplaced.length) {
    const placed = elements.filter((e) => !unplaced.includes(e));
    const bounds = unionBoxes(placed) ?? { x: 0, y: 0, w: 0, h: 0 };
    let x = bounds.x;
    let y = bounds.y + bounds.h + (placed.length ? 80 : 0);
    let rowH = 0;
    for (const el of unplaced) {
      if (x > bounds.x + 1200) {
        x = bounds.x;
        y += rowH + 40;
        rowH = 0;
      }
      el.x = x;
      el.y = y;
      x += el.w + 40;
      rowH = Math.max(rowH, el.h);
    }
  }

  return { meta, elements, edges, unknownShapes: unknown, unplaced: unplaced.map((e) => e.id) };
}

const round = (n: number) => Math.round(n * 10) / 10;

export function fromScene(scene: Scene): Plan {
  const plan: Plan = {
    ...scene.meta,
    nodes: [],
    edges: scene.edges,
    steps: [],
    constraints: [],
    comments: [],
    layout: {},
    freeform: {},
  };
  const shapes: FreeformShape[] = [];
  for (const el of scene.elements) {
    const rect = { x: round(el.x), y: round(el.y), w: round(el.w), h: round(el.h) };
    switch (el.kind) {
      case 'node':
        plan.nodes.push(el.data);
        plan.layout[el.id] = rect;
        break;
      case 'step':
        plan.steps.push(el.data);
        plan.layout[el.id] = rect;
        break;
      case 'constraint':
        plan.constraints.push(el.data);
        plan.layout[el.id] = rect;
        break;
      case 'comment':
        plan.comments.push(el.data);
        plan.layout[el.id] = rect;
        break;
      case 'shape':
        shapes.push({ ...el.data, ...rect } as FreeformShape);
        break;
    }
  }
  plan.freeform = serializeFreeform({ shapes }, scene.unknownShapes);
  return pruneDanglingRefs(plan);
}

export const svgCanvasAdapter: CanvasAdapter = {
  name: 'agentic-whiteboard-svg',
  toScene,
  fromScene,
  exportSvg,
  exportPng,
};
