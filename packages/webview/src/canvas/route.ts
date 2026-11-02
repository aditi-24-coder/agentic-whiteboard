import type { ArrowAnchor, Edge } from '@agentic-whiteboard/shared';
import {
  arrowPoints,
  boxContains,
  boxesIntersect,
  center,
  edgePoints,
  elementIndex,
} from './geometry';
import type { Box, Pt, Scene, SceneElement } from './types';

/** Clearance a routed line keeps from the boxes it passes. */
const MARGIN = 16;
/** How far an arrow end stands off its box, as in `outlinePoint`. */
const GAP = 6;
/** Cost of a turn, in px of extra length: fewer, longer segments read better. */
const BEND = 30;
/** Extra cost per px of running along a line another arrow already uses. */
const SHARED = 4;
/** How far around the two ends the first search looks for a way through. */
const REACH = 160;

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** A connector end: a box it is bound to (only on side `dir`, when given), or a free point. */
type End = { box: Box; dir?: number } | { pt: Pt };

/** Port direction (see `DX`/`DY`) of each anchor side. */
const ANCHOR_DIR: Record<ArrowAnchor, number> = { e: 0, s: 1, w: 2, n: 3 };

/** Where a route may leave or enter an end. `dir` points away from the box; -1 for a point. */
interface Port {
  stub: Pt;
  tip: Pt;
  dir: number;
}

function ports(end: End): Port[] {
  if ('pt' in end) return [{ stub: end.pt, tip: end.pt, dir: -1 }];
  const b = end.box;
  const c = center(b);
  return (end.dir === undefined ? [0, 1, 2, 3] : [end.dir]).map((d) => {
    const mid = {
      x: d === 0 ? b.x + b.w : d === 2 ? b.x : c.x,
      y: d === 1 ? b.y + b.h : d === 3 ? b.y : c.y,
    };
    return {
      dir: d,
      tip: { x: mid.x + DX[d]! * GAP, y: mid.y + DY[d]! * GAP },
      stub: { x: mid.x + DX[d]! * MARGIN, y: mid.y + DY[d]! * MARGIN },
    };
  });
}

/** Axis-aligned segments already drawn, bucketed by the coordinate they run along. */
class Lanes {
  private h = new Map<number, [number, number][]>();
  private v = new Map<number, [number, number][]>();

  addPath(pts: readonly Pt[]) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (Math.abs(a.y - b.y) < 0.5) push(this.h, a.y, a.x, b.x);
      else if (Math.abs(a.x - b.x) < 0.5) push(this.v, a.x, a.y, b.y);
    }
  }

  /** Length of the axis-aligned step a→b that runs along an existing line. */
  overlap(a: Pt, b: Pt): number {
    const [lanes, at, lo, hi] =
      a.y === b.y
        ? [this.h, a.y, Math.min(a.x, b.x), Math.max(a.x, b.x)]
        : [this.v, a.x, Math.min(a.y, b.y), Math.max(a.y, b.y)];
    let n = 0;
    for (const [s, e] of lanes.get(Math.round(at)) ?? [])
      n += Math.max(0, Math.min(hi, e) - Math.max(lo, s));
    return n;
  }
}

function push(m: Map<number, [number, number][]>, at: number, a: number, b: number) {
  const k = Math.round(at);
  const list = m.get(k) ?? [];
  list.push([Math.min(a, b), Math.max(a, b)]);
  m.set(k, list);
}

/** Sorted unique coordinates within [lo, hi], plus the middle of every gap between them. */
function axis(raw: number[], lo: number, hi: number): number[] {
  const base = [...new Set(raw.filter((v) => v >= lo && v <= hi))].sort((a, b) => a - b);
  const out = [...base];
  for (let i = 0; i < base.length - 1; i++) out.push((base[i]! + base[i + 1]!) / 2);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Min-heap of [priority, cost, state]. */
class Heap {
  private items: [number, number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(item: [number, number, number]) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Cheapest orthogonal path between two ends over a sparse grid made of the box edges
 * (pushed out by MARGIN) and the middles of the gaps between them, inside `area`.
 */
function search(
  from: Port[],
  to: Port[],
  obstacles: readonly Box[],
  area: Box,
  lanes: Lanes,
): Pt[] | undefined {
  const m = MARGIN - 0.5;
  const solid = obstacles.filter((o) =>
    boxesIntersect(area, {
      x: o.x - MARGIN,
      y: o.y - MARGIN,
      w: o.w + MARGIN * 2,
      h: o.h + MARGIN * 2,
    }),
  );
  const rx = [area.x, area.x + area.w];
  const ry = [area.y, area.y + area.h];
  for (const o of solid) {
    rx.push(o.x - MARGIN, o.x + o.w + MARGIN);
    ry.push(o.y - MARGIN, o.y + o.h + MARGIN);
  }
  for (const p of [...from, ...to]) {
    rx.push(p.stub.x);
    ry.push(p.stub.y);
  }
  const xs = axis(rx, area.x, area.x + area.w);
  const ys = axis(ry, area.y, area.y + area.h);
  const nx = xs.length;
  const n = nx * ys.length;
  const nodeAt = (p: Pt) => {
    const ix = xs.indexOf(p.x);
    const iy = ys.indexOf(p.y);
    return ix < 0 || iy < 0 ? -1 : iy * nx + ix;
  };

  // Grid nodes inside a box, and steps (node i one place in +x or +y) whose middle is inside one.
  const blocked = new Uint8Array(n);
  const cutX = new Uint8Array(n);
  const cutY = new Uint8Array(n);
  const midX = xs.slice(1).map((v, i) => (v + xs[i]!) / 2);
  const midY = ys.slice(1).map((v, i) => (v + ys[i]!) / 2);
  const within = (vals: number[], lo: number, hi: number) => {
    const out: number[] = [];
    for (let i = 0; i < vals.length; i++) if (vals[i]! > lo && vals[i]! < hi) out.push(i);
    return out;
  };
  for (const o of solid) {
    const [x0, x1, y0, y1] = [o.x - m, o.x + o.w + m, o.y - m, o.y + o.h + m];
    const cols = within(xs, x0, x1);
    const rows = within(ys, y0, y1);
    for (const iy of rows) for (const ix of cols) blocked[iy * nx + ix] = 1;
    for (const iy of rows) for (const ix of within(midX, x0, x1)) cutX[iy * nx + ix] = 1;
    for (const iy of within(midY, y0, y1)) for (const ix of cols) cutY[iy * nx + ix] = 1;
  }
  const okX = new Uint8Array(n);
  const okY = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (blocked[i]) continue;
    const ix = i % nx;
    if (ix + 1 < nx && !blocked[i + 1] && !cutX[i]) okX[i] = 1;
    if (i + nx < n && !blocked[i + nx] && !cutY[i]) okY[i] = 1;
  }
  const step = (i: number, d: number): number => {
    const ix = i % nx;
    const iy = (i / nx) | 0;
    if (d === 0) return okX[i] ? i + 1 : -1;
    if (d === 2) return ix > 0 && okX[i - 1] ? i - 1 : -1;
    if (d === 1) return okY[i] ? i + nx : -1;
    return iy > 0 && okY[i - nx] ? i - nx : -1;
  };
  const pt = (i: number): Pt => ({ x: xs[i % nx]!, y: ys[(i / nx) | 0]! });

  const targets = new Map<number, Port[]>();
  for (const p of to) {
    const i = nodeAt(p.stub);
    if (i >= 0 && !blocked[i]) targets.set(i, [...(targets.get(i) ?? []), p]);
  }
  if (!targets.size) return undefined;
  const goals = [...targets.keys()].map(pt);
  const h = (i: number) => {
    const x = xs[i % nx]!;
    const y = ys[(i / nx) | 0]!;
    let min = Infinity;
    for (const g of goals) min = Math.min(min, Math.abs(g.x - x) + Math.abs(g.y - y));
    return min;
  };

  const dist = new Float64Array(n * 4).fill(Infinity);
  const prev = new Int32Array(n * 4).fill(-1);
  const heap = new Heap();
  const starts = new Map<number, Port>();
  for (const p of from) {
    const i = nodeAt(p.stub);
    if (i < 0 || blocked[i]) continue;
    starts.set(i, p);
    for (const d of p.dir < 0 ? [0, 1, 2, 3] : [p.dir]) {
      dist[i * 4 + d] = 0;
      heap.push([h(i), 0, i * 4 + d]);
    }
  }

  let best = Infinity;
  let bestState = -1;
  let bestPort: Port | undefined;
  while (heap.size) {
    const [f, g, s] = heap.pop();
    if (f >= best) break;
    if (g > dist[s]!) continue;
    const i = s >> 2;
    const d = s & 3;
    for (const t of targets.get(i) ?? []) {
      const inward = (t.dir + 2) % 4;
      const pen = t.dir < 0 || d === inward ? 0 : d === t.dir ? BEND * 2 : BEND;
      if (g + pen < best) [best, bestState, bestPort] = [g + pen, s, t];
    }
    const a = pt(i);
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const j = step(i, nd);
      if (j < 0) continue;
      const b = pt(j);
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const cost = g + len + lanes.overlap(a, b) * SHARED + (nd === d ? 0 : BEND);
      const ns = j * 4 + nd;
      if (cost < dist[ns]!) {
        dist[ns] = cost;
        prev[ns] = s;
        heap.push([cost + h(j), cost, ns]);
      }
    }
  }
  if (bestState < 0) return undefined;

  const nodes: number[] = [];
  for (let s = bestState; s >= 0; s = prev[s]!) nodes.push(s >> 2);
  nodes.reverse();
  const start = starts.get(nodes[0]!)!;
  return simplify([start.tip, ...nodes.map(pt), bestPort!.tip]);
}

/** Drops repeated points and the middle of any three in a row along one axis. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = out[out.length - 2];
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))
    )
      out.pop();
    out.push(p);
  }
  return out;
}

/** Whether segment a→b passes through box `o` grown by `pad` (Liang–Barsky). */
function segmentHitsBox(a: Pt, b: Pt, o: Box, pad: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - (o.x - pad), o.x + o.w + pad - a.x, a.y - (o.y - pad), o.y + o.h + pad - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false;
      continue;
    }
    const t = q[i]! / p[i]!;
    if (p[i]! < 0) {
      if (t > t1) return false;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return false;
      t1 = Math.min(t1, t);
    }
  }
  return true;
}

/** Boxes a connector must keep out of: everything solid except frames, arrows and pen strokes. */
function isSolid(el: SceneElement): boolean {
  return el.kind !== 'shape' || ['rect', 'ellipse', 'diamond', 'text'].includes(el.data.type);
}

/**
 * Polylines for every plan edge and bound arrow, keyed by id. A connector whose straight line
 * is clear stays straight; otherwise it is routed orthogonally around the boxes in its way,
 * preferring gaps no other connector already runs through. `fixed` supplies routes to keep
 * as they are (e.g. a still-valid auto-layout route).
 */
export function routeConnectors(
  scene: Scene,
  fixed?: (edge: Edge, from: Box, to: Box) => readonly Pt[] | undefined,
): Map<string, Pt[]> {
  const byId = elementIndex(scene);
  const solids = scene.elements.filter(isSolid);
  const lanes = new Lanes();
  const out = new Map<string, Pt[]>();

  const connect = (
    s: SceneElement | Pt,
    e: SceneElement | Pt,
    straight: [Pt, Pt],
    anchors: [ArrowAnchor | undefined, ArrowAnchor | undefined] = [undefined, undefined],
  ): Pt[] => {
    const ends = [s, e].filter((x): x is SceneElement => 'id' in x);
    if (ends.length === 2 && boxesIntersect(ends[0]!, ends[1]!)) return straight;
    // Containers of an end (parent boxes) are crossed by necessity, not avoided.
    const others = solids.filter(
      (o) => !ends.includes(o) && !ends.some((el) => boxContains(o, el)),
    );
    // An anchored end must leave its side outwards, or the straight line cuts through its box.
    const outwards = (a: ArrowAnchor | undefined, from: Pt, to: Pt) =>
      !a || (to.x - from.x) * DX[ANCHOR_DIR[a]]! + (to.y - from.y) * DY[ANCHOR_DIR[a]]! > 0;
    if (
      outwards(anchors[0], straight[0], straight[1]) &&
      outwards(anchors[1], straight[1], straight[0]) &&
      !others.some((o) => segmentHitsBox(straight[0], straight[1], o, 4))
    ) {
      lanes.addPath(straight);
      return straight;
    }
    const end = (x: SceneElement | Pt, a: ArrowAnchor | undefined): End =>
      'id' in x ? { box: x, dir: a && ANCHOR_DIR[a] } : { pt: x };
    const from = ports(end(s, anchors[0]));
    const to = ports(end(e, anchors[1]));
    const obstacles = [...others, ...ends];
    const near = unionAll([s, e]);
    const grow = (b: Box, k: number) => ({
      x: b.x - k,
      y: b.y - k,
      w: b.w + k * 2,
      h: b.h + k * 2,
    });
    const path =
      search(from, to, obstacles, grow(near, REACH), lanes) ??
      search(from, to, obstacles, grow(unionAll([...obstacles, s, e]), MARGIN * 3), lanes);
    if (!path) return straight;
    lanes.addPath(path);
    return path;
  };

  for (const edge of scene.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const kept = fixed?.(edge, from, to);
    if (kept) {
      lanes.addPath(kept);
      out.set(edge.id, [...kept]);
    } else out.set(edge.id, connect(from, to, edgePoints(from, to)));
  }
  for (const el of scene.elements) {
    if (el.kind !== 'shape' || el.data.type !== 'arrow') continue;
    const sEl = el.data.start.bindTo ? byId.get(el.data.start.bindTo) : undefined;
    const eEl = el.data.end.bindTo ? byId.get(el.data.end.bindTo) : undefined;
    if (!sEl && !eEl) continue;
    const straight = arrowPoints(el.data, byId);
    out.set(
      el.id,
      connect(sEl ?? straight[0], eEl ?? straight[1], straight, [
        sEl && el.data.start.anchor,
        eEl && el.data.end.anchor,
      ]),
    );
  }
  return out;
}

function unionAll(items: readonly (Box | Pt)[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of items) {
    const w = 'w' in b ? b.w : 0;
    const h = 'h' in b ? b.h : 0;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + w);
    maxY = Math.max(maxY, b.y + h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
