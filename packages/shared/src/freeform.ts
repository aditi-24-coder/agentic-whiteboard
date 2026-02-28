/**
 * Free-form drawing elements, stored verbatim in `plan.freeform.shapes`. The plan schema
 * types `freeform` as `unknown` so that agents never need to care about it. This module
 * gives the canvas typed access to it.
 */

export type ColorName =
  'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'grey';
export type FillStyle = 'none' | 'hachure' | 'solid';

export interface ShapeStyle {
  color?: ColorName;
  fill?: FillStyle;
  strokeWidth?: number;
}

interface Base extends ShapeStyle {
  id: string;
  blockId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TextAlign = 'left' | 'center' | 'right';

/** How text inside a shape is set. Box text defaults to centred, free text to left aligned. */
export interface TextStyle {
  fontSize?: number;
  bold?: boolean;
  align?: TextAlign;
}

/** Named text sizes offered in the UI and to agents. */
export const FONT_SIZES = { S: 14, M: 18, L: 24, XL: 36 } as const;
export type FontSizeName = keyof typeof FONT_SIZES;
/** Default text size of free text and of text inside boxes. */
export const DEFAULT_FONT_SIZE = { text: 18, box: 15 } as const;

export interface BoxShape extends Base, TextStyle {
  type: 'rect' | 'ellipse' | 'diamond';
  text?: string;
}
export interface TextShape extends Base, TextStyle {
  type: 'text';
  text: string;
}
export interface FrameShape extends Base {
  type: 'frame';
  label: string;
}
export interface PenShape extends Base {
  type: 'pen';
  /** Points relative to (x, y): [x, y, pressure]. */
  points: [number, number, number][];
  /** Size of the bounding box the points were recorded in, used to scale on resize. */
  baseW: number;
  baseH: number;
}

export interface ArrowEnd {
  x: number;
  y: number;
  /** Id of any canvas element (plan element or freeform shape) this end is bound to. */
  bindTo?: string;
}
export interface ArrowShape extends Base {
  type: 'arrow';
  start: ArrowEnd;
  end: ArrowEnd;
  label?: string;
  /** `line` has no arrowhead. */
  head?: 'arrow' | 'none';
}

export type FreeformShape = BoxShape | TextShape | FrameShape | PenShape | ArrowShape;
export type FreeformShapeType = FreeformShape['type'];

export interface Freeform {
  shapes: FreeformShape[];
}

const TYPES = new Set<FreeformShapeType>([
  'rect',
  'ellipse',
  'diamond',
  'text',
  'frame',
  'pen',
  'arrow',
]);

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Leniently reads `plan.freeform`. Unknown or broken entries are kept aside, never dropped. */
export function parseFreeform(raw: unknown): { freeform: Freeform; unknown: unknown[] } {
  const shapes: FreeformShape[] = [];
  const unknown: unknown[] = [];
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { shapes?: unknown }).shapes)
      ? (raw as { shapes: unknown[] }).shapes
      : [];
  for (const s of list) {
    const o = s as Partial<FreeformShape> | null;
    if (
      o &&
      typeof o === 'object' &&
      typeof o.id === 'string' &&
      TYPES.has(o.type as FreeformShapeType) &&
      isNum(o.x) &&
      isNum(o.y) &&
      isNum(o.w) &&
      isNum(o.h) &&
      (o.type !== 'arrow' || ((o as ArrowShape).start && (o as ArrowShape).end)) &&
      (o.type !== 'pen' || Array.isArray((o as PenShape).points))
    ) {
      shapes.push(o as FreeformShape);
    } else {
      unknown.push(s);
    }
  }
  return { freeform: { shapes }, unknown };
}

export function serializeFreeform(
  freeform: Freeform,
  unknown: unknown[] = [],
): { shapes: unknown[] } {
  return { shapes: [...freeform.shapes, ...unknown] };
}
