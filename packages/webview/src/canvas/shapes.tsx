import { memo, type ReactNode } from 'react';
import getStroke from 'perfect-freehand';
import {
  DEFAULT_FONT_SIZE,
  type ChangeType,
  type ColorName,
  type FillStyle,
  type Step,
  type TextAlign,
  type VerificationStatus,
} from '@agentic-whiteboard/shared';
import { arrowheadPath, hashSeed, roundedRectPath } from './geometry';
import { roughOptions, roughPaths } from './rough';
import { textStyleOf } from './textStyle';
import { FONT_FAMILY, MONO_FAMILY, ellipsize, measureText, wrapText } from './text';
import type { Pt, SceneElement } from './types';

export const color = (c: ColorName | undefined) => `var(--pc-${c && c !== 'default' ? c : 'ink'})`;
export const tint = (c: ColorName | undefined) =>
  `var(--pc-${c && c !== 'default' ? c : 'ink'}-fill)`;

const CHANGE_COLOR: Record<ChangeType, ColorName> = {
  new: 'green',
  modify: 'blue',
  delete: 'red',
  unchanged: 'grey',
};
const RISK_COLOR = { low: 'green', medium: 'orange', high: 'red' } as const;

type OutlineKind = 'rrect' | 'rect' | 'ellipse' | 'diamond';

interface OutlineProps {
  kind: OutlineKind;
  w: number;
  h: number;
  r?: number;
  stroke: string;
  fill?: string;
  fillStyle?: FillStyle;
  strokeWidth?: number;
  dash?: string;
  sketch: boolean;
  seed: number;
}

/** A closed outline, either hand-drawn (rough.js) or crisp SVG. */
function Outline({
  kind,
  w,
  h,
  r = 10,
  stroke,
  fill,
  fillStyle = 'none',
  strokeWidth = 1.5,
  dash,
  sketch,
  seed,
}: OutlineProps) {
  if (!sketch || w < 2 || h < 2) {
    const style = {
      stroke,
      strokeWidth,
      fill: fillStyle === 'none' ? 'none' : fill,
      strokeDasharray: dash,
    };
    if (kind === 'ellipse')
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} style={style} />;
    if (kind === 'diamond')
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} style={style} />;
    return <path d={roundedRectPath(0, 0, w, h, kind === 'rrect' ? r : 2)} style={style} />;
  }
  const key = `${kind}|${Math.round(w)}|${Math.round(h)}|${r}|${stroke}|${fill}|${fillStyle}|${strokeWidth}|${dash}|${seed}`;
  const paths = roughPaths(key, (g) => {
    const o = roughOptions(seed, {
      stroke,
      strokeWidth,
      fill: fillStyle === 'none' ? undefined : fill,
      fillStyle: fillStyle === 'solid' ? 'solid' : 'hachure',
      strokeLineDash: dash ? dash.split(/\s+/).map(Number) : undefined,
      roughness: kind === 'rrect' ? 0.7 : 1,
    });
    if (kind === 'ellipse') return g.ellipse(w / 2, h / 2, w, h, o);
    if (kind === 'diamond')
      return g.polygon(
        [
          [w / 2, 0],
          [w, h / 2],
          [w / 2, h],
          [0, h / 2],
        ],
        o,
      );
    if (kind === 'rect') return g.rectangle(0, 0, w, h, o);
    return g.path(roundedRectPath(0, 0, w, h, r), o);
  });
  return (
    <>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          style={{
            stroke: p.stroke,
            strokeWidth: p.strokeWidth,
            fill: p.fill ?? 'none',
            strokeDasharray: dash,
          }}
        />
      ))}
    </>
  );
}

interface LinesProps {
  lines: string[];
  x: number;
  y: number;
  size: number;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  fill?: string;
  lineHeight?: number;
  family?: string;
  className?: string;
  decoration?: string;
  action?: string;
}

function Lines({
  lines,
  x,
  y,
  size,
  weight = 400,
  anchor = 'start',
  fill = 'var(--pc-text)',
  lineHeight = 1.3,
  family = FONT_FAMILY,
  className,
  decoration,
  action,
}: LinesProps) {
  return (
    <text
      x={x}
      y={y}
      className={className}
      data-action={action}
      textAnchor={anchor}
      style={{
        fontSize: size,
        fontWeight: weight,
        fill,
        fontFamily: family,
        textDecoration: decoration,
      }}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : size * lineHeight}>
          {l || ' '}
        </tspan>
      ))}
    </text>
  );
}

const ANCHOR = { left: 'start', center: 'middle', right: 'end' } as const;

/** Vertically centred block of wrapped text inside a box. */
function CenteredText({
  text,
  w,
  h,
  size,
  weight = 400,
  fill,
  pad = 10,
  maxLines,
  decoration,
  align = 'center',
}: {
  text: string;
  w: number;
  h: number;
  size: number;
  weight?: number;
  fill?: string;
  pad?: number;
  maxLines?: number;
  decoration?: string;
  align?: TextAlign;
}) {
  if (!text) return null;
  const lh = size * 1.3;
  const fitLines = Math.max(1, Math.floor((h - pad) / lh));
  const lines = wrapText(
    text,
    Math.max(10, w - pad * 2),
    size,
    Math.min(maxLines ?? Infinity, fitLines),
    weight,
  );
  const blockH = lines.length * lh;
  return (
    <Lines
      lines={lines}
      x={align === 'left' ? pad : align === 'right' ? w - pad : w / 2}
      y={h / 2 - blockH / 2 + size * 0.95}
      size={size}
      weight={weight}
      anchor={ANCHOR[align]}
      fill={fill}
      decoration={decoration}
    />
  );
}

export function Pill({
  x,
  y,
  text,
  c,
  filled = false,
  className,
  action,
  anchor = 'start',
}: {
  x: number;
  y: number;
  text: string;
  c: ColorName;
  filled?: boolean;
  className?: string;
  action?: string;
  anchor?: 'start' | 'end';
}) {
  const size = 10.5;
  const w = measureText(text, size, 600) + 14;
  const left = anchor === 'end' ? x - w : x;
  return (
    <g className={className} data-action={action} transform={`translate(${left},${y})`}>
      <rect
        width={w}
        height={18}
        rx={9}
        style={{ fill: filled ? color(c) : tint(c), stroke: color(c), strokeWidth: 1 }}
      />
      <text
        x={w / 2}
        y={12.5}
        textAnchor="middle"
        style={{
          fontSize: size,
          fontWeight: 600,
          fill: filled ? 'var(--pc-on-accent)' : color(c),
          fontFamily: FONT_FAMILY,
        }}
      >
        {text}
      </text>
    </g>
  );
}

function FileIcon({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g transform={`translate(${x},${y})`} data-action="open-file" className="pc-link">
      <path
        d="M2 0 H11 L16 5 V20 H2 Z"
        style={{ fill: 'var(--pc-card)', stroke: c, strokeWidth: 1.4 }}
      />
      <path d="M11 0 V5 H16" style={{ fill: 'none', stroke: c, strokeWidth: 1.4 }} />
      <path d="M5 10 H13 M5 13.5 H13 M5 17 H10" style={{ stroke: c, strokeWidth: 1 }} />
    </g>
  );
}

// Plan shapes

function ComponentNode({
  el,
  sketch,
  isParent,
}: {
  el: Extract<SceneElement, { kind: 'node' }>;
  sketch: boolean;
  isParent: boolean;
}) {
  const n = el.data;
  const c = CHANGE_COLOR[n.changeType];
  const external = n.kind === 'external';
  const { w, h } = el;
  const tag = external
    ? 'EXTERNAL'
    : n.changeType === 'unchanged'
      ? (n.role?.toUpperCase() ?? '')
      : n.changeType.toUpperCase();
  const deco = n.changeType === 'delete' ? 'line-through' : undefined;
  const ts = textStyleOf(el)!;
  const weight = ts.bold ? 700 : 400;
  return (
    <>
      <Outline
        kind="rrect"
        r={14}
        w={w}
        h={h}
        stroke={color(c)}
        fill={isParent ? 'var(--pc-parent-fill)' : tint(c)}
        fillStyle="solid"
        strokeWidth={2}
        dash={external ? '7 5' : undefined}
        sketch={sketch}
        seed={hashSeed(el.id)}
      />
      {tag && <Lines lines={[tag]} x={12} y={16} size={9.5} weight={700} fill={color(c)} />}
      {n.risk && (
        <Pill
          x={w - 8}
          y={6}
          anchor="end"
          text={`${n.risk} risk`}
          c={RISK_COLOR[n.risk]}
          filled={n.risk === 'high'}
        />
      )}
      {isParent ? (
        <Lines
          lines={[ellipsize(n.label, w - 24, ts.fontSize, weight)]}
          x={12}
          y={21 + ts.fontSize}
          size={ts.fontSize}
          weight={weight}
          decoration={deco}
        />
      ) : (
        <CenteredText
          text={n.label}
          w={w}
          h={n.path ? h - 14 : h}
          size={ts.fontSize}
          weight={weight}
          pad={14}
          align={ts.align}
          decoration={deco}
        />
      )}
      {n.path && !isParent && (
        <Lines
          lines={[ellipsize(n.path, w - 24, 10.5, 400, MONO_FAMILY)]}
          x={w / 2}
          y={h - 10}
          anchor="middle"
          size={10.5}
          family={MONO_FAMILY}
          fill="var(--pc-muted)"
          className="pc-link"
          action="open-file"
        />
      )}
    </>
  );
}

function FileNode({
  el,
  sketch,
}: {
  el: Extract<SceneElement, { kind: 'node' }>;
  sketch: boolean;
}) {
  const n = el.data;
  const c = color(CHANGE_COLOR[n.changeType]);
  const { w, h } = el;
  const deco = n.changeType === 'delete' ? 'line-through' : undefined;
  const ts = textStyleOf(el)!;
  const weight = ts.bold ? 600 : 400;
  const labelW = w - 52;
  return (
    <>
      <Outline
        kind="rrect"
        r={8}
        w={w}
        h={h}
        stroke={c}
        fill="var(--pc-card)"
        fillStyle="solid"
        strokeWidth={1.5}
        sketch={sketch}
        seed={hashSeed(el.id)}
      />
      <rect x={0} y={6} width={4} height={h - 12} rx={2} style={{ fill: c }} />
      <FileIcon x={12} y={h / 2 - 10} c={c} />
      <Lines
        lines={[ellipsize(n.label, labelW, ts.fontSize, weight)]}
        x={ts.align === 'left' ? 38 : ts.align === 'right' ? w - 14 : 38 + labelW / 2}
        anchor={ts.align === 'left' ? 'start' : ts.align === 'right' ? 'end' : 'middle'}
        y={n.path ? h / 2 - 3 : h / 2 + ts.fontSize * 0.35}
        size={ts.fontSize}
        weight={weight}
        decoration={deco}
      />
      {n.path && (
        <Lines
          lines={[ellipsize(n.path, w - 52, 10.5, 400, MONO_FAMILY)]}
          x={38}
          y={h / 2 + 13}
          size={10.5}
          family={MONO_FAMILY}
          fill="var(--pc-muted)"
          className="pc-link"
          action="open-file"
        />
      )}
      {n.risk && (
        <Pill
          x={w - 6}
          y={-9}
          anchor="end"
          text={`${n.risk} risk`}
          c={RISK_COLOR[n.risk]}
          filled={n.risk === 'high'}
        />
      )}
    </>
  );
}

export const VERIFICATION: Record<VerificationStatus, { label: string; c: ColorName }> = {
  verified: { label: '✓ verified', c: 'green' },
  failed: { label: '✕ tests failed', c: 'red' },
  drifted: { label: '⚠ drifted', c: 'orange' },
};

const STEP_STATUS: Record<Step['status'], { label: string; c: ColorName }> = {
  pending: { label: 'pending', c: 'grey' },
  in_progress: { label: 'in progress', c: 'blue' },
  done: { label: '✓ done', c: 'green' },
  failed: { label: '✕ failed', c: 'red' },
  skipped: { label: 'skipped', c: 'grey' },
};

function StepCard({
  el,
  sketch,
}: {
  el: Extract<SceneElement, { kind: 'step' }>;
  sketch: boolean;
}) {
  const s = el.data;
  const { w, h } = el;
  const st = STEP_STATUS[s.status];
  const border =
    s.status === 'pending' || s.status === 'skipped' ? 'var(--pc-border)' : color(st.c);
  const titleLines = wrapText(s.title, w - 64, 13, s.note ? 1 : 2, 600);
  const done = s.status === 'done';
  return (
    <g style={{ opacity: s.status === 'skipped' ? 0.6 : 1 }}>
      <Outline
        kind="rrect"
        r={10}
        w={w}
        h={h}
        stroke={border}
        fill="var(--pc-card)"
        fillStyle="solid"
        strokeWidth={s.status === 'in_progress' ? 2.5 : 1.5}
        sketch={sketch}
        seed={hashSeed(el.id)}
      />
      <circle
        cx={26}
        cy={h / 2}
        r={14}
        style={{ fill: done ? color('green') : tint(st.c), stroke: color(st.c), strokeWidth: 1.5 }}
      />
      <text
        x={26}
        y={h / 2 + 4.5}
        textAnchor="middle"
        style={{
          fontSize: 13,
          fontWeight: 700,
          fill: done ? 'var(--pc-on-accent)' : color(st.c),
          fontFamily: FONT_FAMILY,
        }}
      >
        {done ? '✓' : Number.isInteger(s.order) ? s.order : '•'}
      </text>
      <Lines
        lines={titleLines}
        x={50}
        y={titleLines.length > 1 ? 24 : 28}
        size={13}
        weight={600}
        decoration={s.status === 'skipped' ? 'line-through' : undefined}
      />
      {s.note && (
        <Lines
          lines={[ellipsize(s.note, w - 64, 11)]}
          x={50}
          y={46}
          size={11}
          fill="var(--pc-muted)"
        />
      )}
      <Pill
        x={w - 10}
        y={h - 26}
        anchor="end"
        text={st.label}
        c={st.c}
        filled={done}
        className={`${s.status === 'in_progress' ? 'pc-pulse' : ''} ${done ? 'pc-link' : ''}`}
        action={done ? 'step-diff' : undefined}
      />
      {s.verification && (
        <Pill
          x={w - 10}
          y={-9}
          anchor="end"
          text={VERIFICATION[s.verification.status].label}
          c={VERIFICATION[s.verification.status].c}
          filled={s.verification.status !== 'verified'}
          className="pc-link"
          action="open-verification"
        />
      )}
    </g>
  );
}

function ConstraintSticky({
  el,
  sketch,
}: {
  el: Extract<SceneElement, { kind: 'constraint' }>;
  sketch: boolean;
}) {
  const { w, h } = el;
  const lines = wrapText(
    el.data.text || 'Type a rule the agent must obey…',
    w - 24,
    13,
    Math.max(1, Math.floor((h - 44) / 17)),
    500,
  );
  return (
    <>
      <Outline
        kind="rect"
        w={w}
        h={h}
        stroke={color('red')}
        fill="var(--pc-constraint-fill)"
        fillStyle="solid"
        strokeWidth={2.5}
        sketch={sketch}
        seed={hashSeed(el.id)}
      />
      <text x={12} y={24} style={{ fontSize: 15, fontFamily: FONT_FAMILY }}>
        🚫
      </text>
      <Lines lines={['CONSTRAINT']} x={34} y={22} size={10} weight={800} fill={color('red')} />
      <Lines
        lines={lines}
        x={12}
        y={44}
        size={13}
        weight={500}
        fill={el.data.text ? 'var(--pc-sticky-text)' : 'var(--pc-muted)'}
      />
    </>
  );
}

function CommentSticky({
  el,
  sketch,
}: {
  el: Extract<SceneElement, { kind: 'comment' }>;
  sketch: boolean;
}) {
  const { w, h } = el;
  const ts = textStyleOf(el)!;
  const weight = ts.bold ? 700 : 400;
  const lh = ts.fontSize * 1.3;
  const lines = wrapText(
    el.data.text || 'Note…',
    w - 24,
    ts.fontSize,
    // First baseline at 11 + size; keep the last line 8px above the bottom edge.
    Math.max(1, Math.floor((h - 19 - ts.fontSize) / lh) + 1),
    weight,
  );
  return (
    <>
      <rect x={3} y={4} width={w} height={h} style={{ fill: 'var(--pc-shadow)' }} />
      <Outline
        kind="rect"
        w={w}
        h={h}
        stroke="var(--pc-sticky-edge)"
        fill="var(--pc-sticky)"
        fillStyle="solid"
        strokeWidth={1}
        sketch={sketch}
        seed={hashSeed(el.id)}
      />
      <Lines
        lines={lines}
        x={ts.align === 'left' ? 12 : ts.align === 'right' ? w - 12 : w / 2}
        anchor={ts.align === 'left' ? 'start' : ts.align === 'right' ? 'end' : 'middle'}
        y={11 + ts.fontSize}
        size={ts.fontSize}
        weight={weight}
        fill={el.data.text ? 'var(--pc-sticky-text)' : 'var(--pc-muted)'}
      />
    </>
  );
}

// Free-form shapes

function strokeToPath(points: number[][]): string {
  if (!points.length) return '';
  const d = points.reduce<(string | number)[]>(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(x0!, y0!, (x0! + x1!) / 2, (y0! + y1!) / 2);
      return acc;
    },
    ['M', ...points[0]!, 'Q'],
  );
  return `${d.join(' ')} Z`;
}

function Freeform({
  el,
  sketch,
}: {
  el: Extract<SceneElement, { kind: 'shape' }>;
  sketch: boolean;
}) {
  const s = el.data;
  const { w, h } = el;
  const sw = s.strokeWidth ?? 2;
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
      return (
        <>
          {/* Unfilled outlines only catch clicks on the stroke; this makes the inside grabbable. */}
          {s.type === 'ellipse' ? (
            <ellipse
              className="pc-hit"
              cx={w / 2}
              cy={h / 2}
              rx={w / 2}
              ry={h / 2}
              style={{ fill: 'transparent', stroke: 'none' }}
            />
          ) : s.type === 'diamond' ? (
            <polygon
              className="pc-hit"
              points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}
              style={{ fill: 'transparent', stroke: 'none' }}
            />
          ) : (
            <rect
              className="pc-hit"
              width={w}
              height={h}
              style={{ fill: 'transparent', stroke: 'none' }}
            />
          )}
          <Outline
            kind={s.type === 'rect' ? 'rrect' : s.type}
            r={6}
            w={w}
            h={h}
            stroke={color(s.color)}
            fill={s.fill === 'solid' ? tint(s.color) : color(s.color)}
            fillStyle={s.fill ?? 'none'}
            strokeWidth={sw}
            sketch={sketch}
            seed={hashSeed(s.id)}
          />
          {s.text && (
            <g transform={s.type === 'rect' ? undefined : `translate(${w * 0.125},${h * 0.125})`}>
              <CenteredText
                text={s.text}
                w={s.type === 'rect' ? w : w * 0.75}
                h={s.type === 'rect' ? h : h * 0.75}
                size={s.fontSize ?? DEFAULT_FONT_SIZE.box}
                weight={s.bold ? 700 : 400}
                align={s.align}
                fill={color(s.color)}
              />
            </g>
          )}
        </>
      );
    case 'text': {
      const size = s.fontSize ?? DEFAULT_FONT_SIZE.text;
      const weight = s.bold ? 700 : 400;
      const align = s.align ?? 'left';
      return (
        <Lines
          lines={wrapText(s.text, Math.max(w, size), size, Infinity, weight)}
          x={align === 'left' ? 0 : align === 'right' ? w : w / 2}
          y={size}
          size={size}
          weight={weight}
          anchor={ANCHOR[align]}
          fill={color(s.color)}
        />
      );
    }
    case 'frame':
      return (
        <>
          <rect
            width={w}
            height={h}
            rx={6}
            style={{ fill: 'var(--pc-frame-fill)', stroke: 'var(--pc-border)', strokeWidth: 1.5 }}
          />
          <Lines
            lines={[ellipsize(s.label || 'Frame', w, 12, 600)]}
            x={2}
            y={-8}
            size={12}
            weight={600}
            fill="var(--pc-muted)"
          />
        </>
      );
    case 'pen': {
      const sx = s.baseW ? w / s.baseW : 1;
      const sy = s.baseH ? h / s.baseH : 1;
      const simulate = s.points.every((p) => p[2] === 0.5);
      const outline = getStroke(
        s.points.map(([x, y, p]) => [x * sx, y * sy, p]),
        {
          size: sw * 3,
          thinning: 0.6,
          smoothing: 0.5,
          streamline: 0.5,
          simulatePressure: simulate,
        },
      );
      return <path d={strokeToPath(outline)} style={{ fill: color(s.color) }} />;
    }
    case 'arrow':
      return null; // Arrows are drawn in world space by ArrowView.
  }
}

export interface ElementViewProps {
  el: SceneElement;
  sketch: boolean;
  isParent: boolean;
}

/** Renders one element in its own coordinate space. Memoised so drags re-render only what moves. */
export const ElementView = memo(function ElementView({ el, sketch, isParent }: ElementViewProps) {
  let body: ReactNode;
  switch (el.kind) {
    case 'node':
      body =
        el.data.kind === 'file' ? (
          <FileNode el={el} sketch={sketch} />
        ) : (
          <ComponentNode el={el} sketch={sketch} isParent={isParent} />
        );
      break;
    case 'step':
      body = <StepCard el={el} sketch={sketch} />;
      break;
    case 'constraint':
      body = <ConstraintSticky el={el} sketch={sketch} />;
      break;
    case 'comment':
      body = <CommentSticky el={el} sketch={sketch} />;
      break;
    case 'shape':
      body = <Freeform el={el} sketch={sketch} />;
      break;
  }
  return (
    <g transform={`translate(${el.x},${el.y})`} data-id={el.id} className={`pc-el pc-${el.kind}`}>
      {body}
    </g>
  );
});

/** Middle of the longest segment: where a label is least likely to sit on a bend. */
export function labelPoint(pts: readonly Pt[]): Pt {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    if (len > bestLen) [best, bestLen] = [i, len];
  }
  const a = pts[best]!;
  const b = pts[best + 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface ArrowViewProps {
  id: string;
  from: Pt;
  to: Pt;
  /** Bend points between `from` and `to` (an auto-layout route). */
  via?: readonly Pt[];
  label?: string;
  head?: 'arrow' | 'none';
  stroke: string;
  strokeWidth?: number;
  sketch: boolean;
  dashed?: boolean;
}

export const ArrowView = memo(function ArrowView({
  id,
  from,
  to,
  via,
  label,
  head = 'arrow',
  stroke,
  strokeWidth = 2,
  sketch,
  dashed,
}: ArrowViewProps) {
  const pts = via?.length ? [from, ...via, to] : [from, to];
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const style = {
    stroke,
    strokeWidth,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeDasharray: dashed ? '6 5' : undefined,
  };
  let line: ReactNode;
  let headEl: ReactNode = null;
  const headD = head === 'arrow' ? arrowheadPath(pts[pts.length - 2]!, to, 11 + strokeWidth) : '';
  if (sketch) {
    const seed = hashSeed(id);
    const key = `line|${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}|${stroke}|${strokeWidth}|${seed}`;
    const paths = roughPaths(key, (g) =>
      g.linearPath(
        pts.map((p) => [p.x, p.y] as [number, number]),
        roughOptions(seed, { stroke, strokeWidth, roughness: 0.8 }),
      ),
    );
    line = paths.map((p, i) => <path key={i} d={p.d} style={style} />);
    if (headD) {
      const hp = roughPaths(`head|${headD}|${stroke}|${seed}`, (g) =>
        g.path(headD, roughOptions(seed, { stroke, strokeWidth, roughness: 0.6 })),
      );
      headEl = hp.map((p, i) => (
        <path key={`h${i}`} d={p.d} style={{ ...style, strokeDasharray: undefined }} />
      ));
    }
  } else {
    line = <polyline points={polyline} style={style} />;
    if (headD) headEl = <path d={headD} style={{ ...style, strokeDasharray: undefined }} />;
  }
  const mid = labelPoint(pts);
  const lw = label ? measureText(label, 12, 500) + 12 : 0;
  return (
    <g data-id={id} className="pc-arrow">
      {/* Wide invisible stroke makes thin arrows easy to click. */}
      <polyline
        points={polyline}
        className="pc-hit"
        style={{ stroke: 'transparent', strokeWidth: 14, fill: 'none' }}
      />
      {line}
      {headEl}
      {label && (
        <g transform={`translate(${mid.x - lw / 2},${mid.y - 10})`}>
          <rect
            width={lw}
            height={20}
            rx={4}
            style={{ fill: 'var(--pc-bg)', stroke: 'var(--pc-border)', strokeWidth: 1 }}
          />
          <text
            x={lw / 2}
            y={14}
            textAnchor="middle"
            style={{
              fontSize: 12,
              fontWeight: 500,
              fill: 'var(--pc-text)',
              fontFamily: FONT_FAMILY,
            }}
          >
            {label}
          </text>
        </g>
      )}
    </g>
  );
});
