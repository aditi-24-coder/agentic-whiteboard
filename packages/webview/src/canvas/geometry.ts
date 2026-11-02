import type { ArrowAnchor, ArrowShape } from '@agentic-whiteboard/shared';
import type { Box, Pt, Scene, SceneElement } from './types';

export function normalizeBox(a: Pt, b: Pt): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function pointInBox(p: Pt, b: Box, pad = 0): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

export function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function unionBoxes(boxes: readonly Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type Outline = 'rect' | 'ellipse' | 'diamond';

/** Where the ray from the box centre towards `toward` leaves the outline, pushed out by `gap`. */
export function outlinePoint(b: Box, toward: Pt, outline: Outline = 'rect', gap = 6): Pt {
  const c = center(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const hw = b.w / 2;
  const hh = b.h / 2;
  let t: number;
  if (outline === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
  } else if (outline === 'diamond') {
    t = 1 / (Math.abs(dx) / (hw || 1) + Math.abs(dy) / (hh || 1));
  } else {
    t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  }
  const len = Math.hypot(dx, dy);
  const k = t + gap / len;
  return { x: c.x + dx * Math.min(k, 1), y: c.y + dy * Math.min(k, 1) };
}

export function outlineOf(el: SceneElement): Outline {
  if (el.kind === 'shape' && (el.data.type === 'ellipse' || el.data.type === 'diamond'))
    return el.data.type;
  return 'rect';
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h - rr}`,
    `Q${x + w},${y + h} ${x + w - rr},${y + h}`,
    `H${x + rr}`,
    `Q${x},${y + h} ${x},${y + h - rr}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    'Z',
  ].join(' ');
}

export function elementIndex(scene: Scene): Map<string, SceneElement> {
  return new Map(scene.elements.map((e) => [e.id, e]));
}

/** Resolved endpoints of a free-form arrow, following its bindings. */
export function arrowPoints(a: ArrowShape, byId: Map<string, SceneElement>): [Pt, Pt] {
  const sEl = a.start.bindTo ? byId.get(a.start.bindTo) : undefined;
  const eEl = a.end.bindTo ? byId.get(a.end.bindTo) : undefined;
  const sRef: Pt = sEl
    ? a.start.anchor
      ? anchorPoint(sEl, a.start.anchor)
      : center(sEl)
    : a.start;
  const eRef: Pt = eEl ? (a.end.anchor ? anchorPoint(eEl, a.end.anchor) : center(eEl)) : a.end;
  const tip = (el: SceneElement, anchor: ArrowAnchor | undefined, toward: Pt) =>
    anchor ? anchorPoint(el, anchor, 6) : outlinePoint(el, toward, outlineOf(el));
  const start = sEl ? tip(sEl, a.start.anchor, eRef) : { x: a.start.x, y: a.start.y };
  const end = eEl ? tip(eEl, a.end.anchor, sRef) : { x: a.end.x, y: a.end.y };
  return [start, end];
}

export const ANCHORS: readonly ArrowAnchor[] = ['n', 'e', 's', 'w'];

/**
 * The connection point on a side of `b`: the middle of that side, which lies on the outline of
 * rectangles, ellipses and diamonds alike, pushed out by `gap`.
 */
export function anchorPoint(b: Box, side: ArrowAnchor, gap = 0): Pt {
  const c = center(b);
  if (side === 'n') return { x: c.x, y: b.y - gap };
  if (side === 's') return { x: c.x, y: b.y + b.h + gap };
  if (side === 'w') return { x: b.x - gap, y: c.y };
  return { x: b.x + b.w + gap, y: c.y };
}

/** Endpoints of a plan edge between two node elements. */
export function edgePoints(from: SceneElement, to: SceneElement): [Pt, Pt] {
  return [outlinePoint(from, center(to)), outlinePoint(to, center(from))];
}

export function arrowheadPath(from: Pt, to: Pt, size = 12): string {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  return `M${to.x + size * Math.cos(a1)},${to.y + size * Math.sin(a1)} L${to.x},${to.y} L${to.x + size * Math.cos(a2)},${to.y + size * Math.sin(a2)}`;
}

export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647 || 1;
}
