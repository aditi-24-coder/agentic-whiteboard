import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  FONT_SIZES,
  randomId,
  type ArrowEnd,
  type ColorName,
  type DriftItem,
  type Edge,
  type FontSizeName,
  type TextAlign,
  type FillStyle,
  type FreeformShape,
  type ShapeStyle,
} from '@agentic-whiteboard/shared';
import { DEFAULT_SIZE } from './adapter';
import { sceneBounds } from './export';
import {
  arrowPoints,
  boxesIntersect,
  boxContains,
  center,
  edgePoints,
  elementIndex,
  normalizeBox,
  pointInBox,
  unionBoxes,
} from './geometry';
import {
  addElement,
  deleteElements,
  duplicateElements,
  expandMoveSet,
  getText,
  hasText,
  isStylableText,
  moveElements,
  penShapeFromPoints,
  reparentOnDrop,
  setArrowEnd,
  setBox,
  setText,
  setTextStyle,
} from './ops';
import { ArrowView, ElementView, Pill, color } from './shapes';
import { TextStyleControls } from '../Toolbar';
import { FONT_FAMILY, measureText, textBoxSize } from './text';
import { textStyleOf } from './textStyle';
import type { Box, Pt, Scene, SceneElement } from './types';

export type Tool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'text'
  | 'comment'
  | 'constraint'
  | 'component'
  | 'file'
  | 'frame';

export const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  p: 'pen',
  r: 'rect',
  o: 'ellipse',
  d: 'diamond',
  a: 'arrow',
  l: 'line',
  t: 'text',
  s: 'comment',
  b: 'component',
  i: 'file',
  f: 'frame',
};

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface ShapeStyleState {
  color: ColorName;
  fill: FillStyle;
  strokeWidth: number;
  /** Text size for new text and shapes; unset uses each kind's default. */
  fontSize?: FontSizeName;
}

export interface CanvasHandle {
  fit(): void;
  /** Smoothly brings a world box into view, unless it is already fully visible. */
  reveal(box: Box): void;
  zoomBy(factor: number): void;
  resetZoom(): void;
  /** World point at the centre of the viewport. */
  viewportCenter(): Pt;
  edit(id: string, isNew?: boolean): void;
  svg(): SVGSVGElement | null;
}

export interface CanvasProps {
  scene: Scene;
  sketch: boolean;
  readOnly: boolean;
  tool: Tool;
  onToolChange(tool: Tool): void;
  selection: ReadonlySet<string>;
  onSelectionChange(ids: Set<string>): void;
  /** `commit` marks the end of a gesture: one undoable edit. */
  onChange(scene: Scene, commit: boolean): void;
  onGestureChange(active: boolean): void;
  /** Open what a box stands for in the code (its file, folder, symbol or package users). */
  onOpenCode(nodeId: string): void;
  onStepDiff(stepId: string): void;
  onOpenVerification(stepId: string): void;
  /** Drift between the board and the code, by box or arrow id. */
  drift?: ReadonlyMap<string, readonly DriftItem[]>;
  shapeStyle: ShapeStyleState;
  initialCamera?: Camera;
  onCameraChange?(camera: Camera): void;
  /** Show the floating text bar for selected text (off while the Properties panel is open). */
  textBar?: boolean;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 3;

type Gesture =
  | { type: 'pan'; start: Pt; cam: Camera }
  | {
      type: 'move';
      start: Pt;
      ids: Set<string>;
      base: Scene;
      moved: boolean;
      action?: { name: string; id: string };
      primary?: string;
    }
  | { type: 'resize'; id: string; handle: Handle; start: Pt; box: Box; base: Scene }
  | { type: 'marquee'; start: Pt; current: Pt; additive: boolean; before: Set<string> }
  | { type: 'create'; tool: Tool; start: Pt; id: string; base: Scene }
  | { type: 'pen'; id: string; points: [number, number, number][]; base: Scene }
  | {
      type: 'arrow';
      start: Pt;
      startBind?: string;
      id: string;
      base: Scene;
      head: 'arrow' | 'none';
    }
  | { type: 'arrowEnd'; id: string; which: 'start' | 'end'; base: Scene };

/** Draw order: frames, nodes (parents under children), shapes, steps, stickies. Arrows go on top. */
function renderOrder(scene: Scene): SceneElement[] {
  const byId = elementIndex(scene);
  const depth = (el: SceneElement) => {
    let d = 0;
    let cur = el;
    const seen = new Set<string>();
    while (cur.kind === 'node' && cur.data.parentId && !seen.has(cur.id) && d < 20) {
      seen.add(cur.id);
      const p = byId.get(cur.data.parentId);
      if (!p) break;
      d++;
      cur = p;
    }
    return d;
  };
  const rank = (el: SceneElement) => {
    if (el.kind === 'shape') return el.data.type === 'frame' ? 0 : el.data.type === 'arrow' ? 9 : 3;
    if (el.kind === 'node') return 1 + depth(el) / 100;
    return { step: 4, constraint: 5, comment: 6 }[el.kind];
  };
  return scene.elements
    .map((el, i) => ({ el, i, r: rank(el) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.el);
}

function isEditableTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  );
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  const {
    scene,
    sketch,
    readOnly,
    tool,
    selection,
    onChange,
    onSelectionChange,
    onGestureChange,
    shapeStyle,
  } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Camera>(props.initialCamera ?? { x: 0, y: 0, z: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<string | undefined>();
  const [marquee, setMarquee] = useState<Box | undefined>();
  const [editing, setEditing] = useState<{ id: string; isNew: boolean } | undefined>();
  const [spaceHeld, setSpaceHeld] = useState(false);
  const gesture = useRef<Gesture | undefined>(undefined);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const camRef = useRef(cam);
  camRef.current = cam;

  const byId = useMemo(() => elementIndex(scene), [scene]);
  const ordered = useMemo(() => renderOrder(scene), [scene]);
  const parents = useMemo(() => {
    const s = new Set<string>();
    for (const el of scene.elements)
      if (el.kind === 'node' && el.data.parentId) s.add(el.data.parentId);
    return s;
  }, [scene]);

  const onCameraChange = props.onCameraChange;
  useEffect(() => onCameraChange?.(cam), [cam, onCameraChange]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }),
    );
    ro.observe(el);
    setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    return () => ro.disconnect();
  }, []);

  const toWorld = useCallback((sx: number, sy: number): Pt => {
    const r = svgRef.current?.getBoundingClientRect();
    const c = camRef.current;
    return { x: (sx - (r?.left ?? 0) - c.x) / c.z, y: (sy - (r?.top ?? 0) - c.y) / c.z };
  }, []);

  const zoomAt = useCallback((factor: number, sx?: number, sy?: number) => {
    setCam((c) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.z * factor));
      const r = svgRef.current?.getBoundingClientRect();
      const px = sx !== undefined ? sx - (r?.left ?? 0) : (r?.width ?? 800) / 2;
      const py = sy !== undefined ? sy - (r?.top ?? 0) : (r?.height ?? 600) / 2;
      return { z, x: px - ((px - c.x) / c.z) * z, y: py - ((py - c.y) / c.z) * z };
    });
  }, []);

  const fit = useCallback(() => {
    const s = sceneRef.current;
    const r = svgRef.current?.getBoundingClientRect();
    const vw = r?.width || 800;
    const vh = r?.height || 600;
    if (!s.elements.length) {
      setCam({ x: vw / 2, y: vh / 2, z: 1 });
      return;
    }
    const b = sceneBounds(s);
    const z = Math.min(
      1.2,
      Math.max(MIN_ZOOM, Math.min((vw - 80) / (b.w || 1), (vh - 80) / (b.h || 1))),
    );
    setCam({ z, x: vw / 2 - (b.x + b.w / 2) * z, y: vh / 2 - (b.y + b.h / 2) * z });
  }, []);

  const animation = useRef(0);
  const reveal = useCallback((b: Box) => {
    const r = svgRef.current?.getBoundingClientRect();
    const vw = r?.width || 800;
    const vh = r?.height || 600;
    const c = camRef.current;
    const margin = 40;
    const inView =
      b.x * c.z + c.x >= margin &&
      b.y * c.z + c.y >= margin &&
      (b.x + b.w) * c.z + c.x <= vw - margin &&
      (b.y + b.h) * c.z + c.y <= vh - margin;
    if (inView) return;
    // Keep the current zoom when the box fits at it; zoom out only as far as needed.
    const fitZ = Math.min((vw - 2 * margin) / (b.w || 1), (vh - 2 * margin) / (b.h || 1));
    const z = Math.max(MIN_ZOOM, Math.min(c.z, fitZ, 1.2));
    const target = { z, x: vw / 2 - (b.x + b.w / 2) * z, y: vh / 2 - (b.y + b.h / 2) * z };
    const start = { ...c };
    const t0 = performance.now();
    cancelAnimationFrame(animation.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 450);
      const k = 1 - (1 - t) ** 3; // ease out
      setCam({
        x: start.x + (target.x - start.x) * k,
        y: start.y + (target.y - start.y) * k,
        z: start.z + (target.z - start.z) * k,
      });
      if (t < 1) animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      reveal,
      zoomBy: (f) => zoomAt(f),
      resetZoom: () => zoomAt(1 / camRef.current.z),
      viewportCenter: () => {
        const c = camRef.current;
        return { x: (size.w / 2 - c.x) / c.z, y: (size.h / 2 - c.y) / c.z };
      },
      edit: (id, isNew = false) => {
        setEditing({ id, isNew });
        onGestureChange(true);
      },
      svg: () => svgRef.current,
    }),
    [fit, reveal, zoomAt, size, onGestureChange],
  );

  // Wheel: pan, or zoom with Ctrl/Cmd (trackpad pinch also arrives as ctrl+wheel).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        setCam((c) => ({ ...c, x: c.x - e.deltaX * k, y: c.y - e.deltaY * k }));
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /** Topmost non-arrow element under a world point. */
  const elementAt = useCallback(
    (p: Pt, exclude?: ReadonlySet<string>): SceneElement | undefined => {
      for (let i = ordered.length - 1; i >= 0; i--) {
        const el = ordered[i]!;
        if (exclude?.has(el.id)) continue;
        if (el.kind === 'shape' && el.data.type === 'arrow') continue;
        if (pointInBox(p, el)) return el;
      }
      return undefined;
    },
    [ordered],
  );

  const style = (): ShapeStyle => ({
    color: shapeStyle.color,
    fill: shapeStyle.fill,
    strokeWidth: shapeStyle.strokeWidth,
  });

  /** Text size for a new rectangle/ellipse/diamond, when the user picked one. */
  const boxFont = () => (shapeStyle.fontSize ? { fontSize: FONT_SIZES[shapeStyle.fontSize] } : {});

  const createAt = (t: Tool, p: Pt): { scene: Scene; id: string; edit: boolean } | undefined => {
    const s = sceneRef.current;
    const at = (w: number, h: number) => ({ x: p.x - w / 2, y: p.y - h / 2, w, h });
    switch (t) {
      case 'component':
      case 'file': {
        const id = randomId('n');
        const sz = DEFAULT_SIZE[t];
        const data = {
          id,
          kind: t,
          label: t === 'file' ? 'new-file.ts' : 'New component',
          changeType: 'new' as const,
        };
        return {
          scene: addElement(s, { id, kind: 'node', data, ...at(sz.w, sz.h) }),
          id,
          edit: true,
        };
      }
      case 'comment': {
        const id = randomId('c');
        return {
          scene: addElement(s, {
            id,
            kind: 'comment',
            data: { id, text: '' },
            ...at(DEFAULT_SIZE.comment.w, DEFAULT_SIZE.comment.h),
          }),
          id,
          edit: true,
        };
      }
      case 'constraint': {
        const id = randomId('k');
        return {
          scene: addElement(s, {
            id,
            kind: 'constraint',
            data: { id, text: '', author: 'user' },
            ...at(DEFAULT_SIZE.constraint.w, DEFAULT_SIZE.constraint.h),
          }),
          id,
          edit: true,
        };
      }
      case 'text': {
        const id = randomId('f');
        const fontSize = FONT_SIZES[shapeStyle.fontSize ?? 'M'];
        const box = { x: p.x, y: p.y - fontSize * 0.8, ...textBoxSize('', fontSize) };
        const data: FreeformShape = {
          ...style(),
          id,
          type: 'text',
          text: '',
          fontSize,
          ...box,
        };
        return { scene: addElement(s, { id, kind: 'shape', data, ...box }), id, edit: true };
      }
      default:
        return undefined;
    }
  };

  const finishEditing = useCallback(
    (text: string | undefined) => {
      const ed = editing;
      setEditing(undefined);
      onGestureChange(false);
      if (!ed) return;
      const s = sceneRef.current;
      const el = byId.get(ed.id);
      const edge = s.edges.find((e) => e.id === ed.id);
      if (!el && !edge) return;
      if (text === undefined) {
        // Cancelled: drop a brand-new empty element, otherwise keep whatever is there.
        if (ed.isNew && el && !getText(el).trim() && el.kind !== 'node')
          onChange(deleteElements(s, new Set([ed.id])), false);
        else if (ed.isNew) onChange(s, true);
        return;
      }
      const disposable =
        el &&
        (el.kind === 'comment' ||
          el.kind === 'constraint' ||
          (el.kind === 'shape' && el.data.type === 'text'));
      if (disposable && !text.trim()) {
        onChange(deleteElements(s, new Set([ed.id])), !ed.isNew);
        onSelectionChange(new Set());
        return;
      }
      let next = setText(s, ed.id, text);
      if (el?.kind === 'shape' && el.data.type === 'text') {
        // Fit the text box to what was typed, keeping the edge its alignment anchors.
        next = setTextStyle(next, new Set([el.id]), {});
      }
      onChange(next, true);
    },
    [editing, byId, onChange, onGestureChange, onSelectionChange],
  );

  // Pointer handling

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (editing) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const svg = svgRef.current!;
    svg.setPointerCapture?.(e.pointerId);
    const p = toWorld(e.clientX, e.clientY);
    const target = e.target as Element;
    const s = sceneRef.current;

    if (e.button === 1 || tool === 'hand' || spaceHeld || (readOnly && e.button === 0)) {
      gesture.current = { type: 'pan', start: { x: e.clientX, y: e.clientY }, cam: camRef.current };
      return;
    }
    if (e.button !== 0) return;

    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    if (handle && selection.size === 1) {
      const id = [...selection][0]!;
      const el = byId.get(id);
      if (
        el?.kind === 'shape' &&
        el.data.type === 'arrow' &&
        (handle === 'start' || handle === 'end')
      ) {
        gesture.current = { type: 'arrowEnd', id, which: handle, base: s };
        onGestureChange(true);
        return;
      }
      if (el) {
        gesture.current = {
          type: 'resize',
          id,
          handle: handle as Handle,
          start: p,
          box: { x: el.x, y: el.y, w: el.w, h: el.h },
          base: s,
        };
        onGestureChange(true);
        return;
      }
    }

    if (tool === 'pen') {
      const id = randomId('f');
      gesture.current = { type: 'pen', id, points: [[p.x, p.y, e.pressure || 0.5]], base: s };
      onGestureChange(true);
      return;
    }
    if (tool === 'arrow' || tool === 'line') {
      const bind = tool === 'arrow' ? elementAt(p)?.id : undefined;
      gesture.current = {
        type: 'arrow',
        start: p,
        startBind: bind,
        id: randomId('f'),
        base: s,
        head: tool === 'arrow' ? 'arrow' : 'none',
      };
      onGestureChange(true);
      return;
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'frame') {
      gesture.current = { type: 'create', tool, start: p, id: randomId('f'), base: s };
      onGestureChange(true);
      return;
    }
    if (tool !== 'select') {
      const created = createAt(tool, p);
      if (created) {
        onChange(created.scene, false);
        onSelectionChange(new Set([created.id]));
        props.onToolChange('select');
        if (created.edit) {
          setEditing({ id: created.id, isNew: true });
          onGestureChange(true);
        } else onChange(created.scene, true);
      }
      return;
    }

    // Select tool
    const hitId = target.closest('[data-id]')?.getAttribute('data-id') ?? undefined;
    const action = target.closest('[data-action]')?.getAttribute('data-action') ?? undefined;
    if (!hitId) {
      gesture.current = {
        type: 'marquee',
        start: p,
        current: p,
        additive: e.shiftKey,
        before: e.shiftKey ? new Set(selection) : new Set(),
      };
      if (!e.shiftKey) onSelectionChange(new Set());
      return;
    }
    let sel = new Set(selection);
    if (e.shiftKey) {
      if (sel.has(hitId)) sel.delete(hitId);
      else sel.add(hitId);
    } else if (!sel.has(hitId)) {
      sel = new Set([hitId]);
    }
    onSelectionChange(sel);
    const movable = new Set([...sel].filter((id) => byId.has(id)));
    gesture.current = {
      type: 'move',
      start: p,
      ids: readOnly ? new Set() : expandMoveSet(s, movable),
      base: s,
      moved: false,
      action: action ? { name: action, id: hitId } : undefined,
      primary: hitId,
    };
    onGestureChange(true);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    const p = toWorld(e.clientX, e.clientY);
    if (!g) {
      const id = (e.target as Element).closest('[data-id]')?.getAttribute('data-id') ?? undefined;
      if (id !== hover) setHover(id);
      return;
    }
    switch (g.type) {
      case 'pan':
        setCam({
          ...g.cam,
          x: g.cam.x + e.clientX - g.start.x,
          y: g.cam.y + e.clientY - g.start.y,
        });
        break;
      case 'move': {
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * camRef.current.z < DRAG_THRESHOLD) return;
        g.moved = true;
        onChange(moveElements(g.base, g.ids, dx, dy), false);
        break;
      }
      case 'resize': {
        const b = g.box;
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        let { x, y, w, h } = b;
        if (g.handle.includes('e')) w = b.w + dx;
        if (g.handle.includes('s')) h = b.h + dy;
        if (g.handle.includes('w')) {
          x = b.x + dx;
          w = b.w - dx;
        }
        if (g.handle.includes('n')) {
          y = b.y + dy;
          h = b.h - dy;
        }
        if (e.shiftKey && b.w && b.h) {
          const ratio = b.w / b.h;
          if (Math.abs(w / b.w) > Math.abs(h / b.h)) h = w / ratio;
          else w = h * ratio;
          if (g.handle.includes('n')) y = b.y + b.h - h;
          if (g.handle.includes('w')) x = b.x + b.w - w;
        }
        const min = 16;
        if (w < min) {
          if (g.handle.includes('w')) x -= min - w;
          w = min;
        }
        if (h < min) {
          if (g.handle.includes('n')) y -= min - h;
          h = min;
        }
        onChange(setBox(g.base, g.id, { x, y, w, h }), false);
        break;
      }
      case 'marquee': {
        g.current = p;
        const box = normalizeBox(g.start, p);
        setMarquee(box);
        const hit = new Set(g.before);
        for (const el of sceneRef.current.elements)
          if (
            boxContains(box, el) ||
            (el.kind !== 'shape' &&
              boxesIntersect(box, el) &&
              boxContains(box, { ...el, w: 1, h: 1 }))
          )
            hit.add(el.id);
        onSelectionChange(hit);
        break;
      }
      case 'create': {
        const box = normalizeBox(g.start, p);
        if (box.w < 2 && box.h < 2) return;
        const type = g.tool as 'rect' | 'ellipse' | 'diamond' | 'frame';
        const data: FreeformShape =
          type === 'frame'
            ? { id: g.id, type, label: 'Frame', ...box }
            : { ...style(), ...boxFont(), id: g.id, type, ...box };
        onChange(addElement(g.base, { id: g.id, kind: 'shape', data, ...box }), false);
        break;
      }
      case 'pen': {
        g.points.push([p.x, p.y, e.pressure || 0.5]);
        const pen = penShapeFromPoints(g.id, g.points, style());
        onChange(
          addElement(g.base, {
            id: g.id,
            kind: 'shape',
            data: pen,
            x: pen.x,
            y: pen.y,
            w: pen.w,
            h: pen.h,
          }),
          false,
        );
        break;
      }
      case 'arrow': {
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) * camRef.current.z < 4) return;
        const endBind =
          g.head === 'arrow'
            ? elementAt(p, g.startBind ? new Set([g.startBind]) : undefined)?.id
            : undefined;
        const start: ArrowEnd = g.startBind ? { ...g.start, bindTo: g.startBind } : g.start;
        const end: ArrowEnd = endBind ? { ...p, bindTo: endBind } : p;
        const data: FreeformShape = {
          ...style(),
          fill: undefined,
          id: g.id,
          type: 'arrow',
          start,
          end,
          head: g.head,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
        };
        onChange(
          addElement(g.base, { id: g.id, kind: 'shape', data, x: 0, y: 0, w: 0, h: 0 }),
          false,
        );
        setHover(endBind);
        break;
      }
      case 'arrowEnd': {
        const bind = elementAt(p, new Set([g.id]))?.id;
        onChange(setArrowEnd(g.base, g.id, g.which, bind ? { ...p, bindTo: bind } : p), false);
        setHover(bind);
        break;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = undefined;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    if (!g) return;
    const s = sceneRef.current;
    switch (g.type) {
      case 'pan':
        return;
      case 'marquee':
        setMarquee(undefined);
        return;
      case 'move': {
        onGestureChange(false);
        if (g.moved) {
          onChange(reparentOnDrop(s, g.ids), true);
        } else if (g.action && !e.shiftKey) {
          const el = byId.get(g.action.id);
          if (g.action.name === 'open-file' && el?.kind === 'node') props.onOpenCode(el.id);
          if (g.action.name === 'step-diff' && el?.kind === 'step') props.onStepDiff(el.id);
          if (g.action.name === 'open-verification' && el?.kind === 'step')
            props.onOpenVerification(el.id);
        } else if (!e.shiftKey && g.primary && selection.size > 1) {
          onSelectionChange(new Set([g.primary]));
        }
        return;
      }
      case 'resize':
      case 'pen':
      case 'arrowEnd':
        onGestureChange(false);
        if (s !== g.base) onChange(s, true);
        setHover(undefined);
        return;
      case 'create': {
        onGestureChange(false);
        if (s === g.base) {
          // A click without dragging creates a default-sized shape.
          const p = g.start;
          const w = g.tool === 'frame' ? 320 : 120;
          const h = g.tool === 'frame' ? 220 : 80;
          const box = { x: p.x - w / 2, y: p.y - h / 2, w, h };
          const type = g.tool as 'rect' | 'ellipse' | 'diamond' | 'frame';
          const data: FreeformShape =
            type === 'frame'
              ? { id: g.id, type, label: 'Frame', ...box }
              : { ...style(), ...boxFont(), id: g.id, type, ...box };
          onChange(addElement(g.base, { id: g.id, kind: 'shape', data, ...box }), true);
        } else onChange(s, true);
        onSelectionChange(new Set([g.id]));
        props.onToolChange('select');
        return;
      }
      case 'arrow': {
        onGestureChange(false);
        setHover(undefined);
        const el = s.elements.find((x) => x.id === g.id);
        if (!el || el.kind !== 'shape' || el.data.type !== 'arrow') return;
        const { start, end } = el.data;
        const from = start.bindTo ? byId.get(start.bindTo) : undefined;
        const to = end.bindTo ? byId.get(end.bindTo) : undefined;
        // An arrow between two plan nodes is a plan edge (data flow), not a doodle.
        if (from?.kind === 'node' && to?.kind === 'node' && from.id !== to.id) {
          const base = g.base;
          if (!base.edges.some((x) => x.from === from.id && x.to === to.id)) {
            const id = randomId('e');
            onChange({ ...base, edges: [...base.edges, { id, from: from.id, to: to.id }] }, true);
            onSelectionChange(new Set([id]));
          } else onChange(base, false);
        } else {
          onChange(s, true);
          onSelectionChange(new Set([g.id]));
        }
        props.onToolChange('select');
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    // The svg captures the pointer on pointerdown, so in browsers the dblclick target is the svg
    // itself, not the element under the cursor. Use the target when it is precise (an arrow or
    // edge label), otherwise hit-test the point.
    const id =
      (e.target as Element).closest('[data-id]')?.getAttribute('data-id') ??
      elementAt(toWorld(e.clientX, e.clientY))?.id;
    if (id) {
      const el = byId.get(id);
      if ((el && hasText(el)) || scene.edges.some((x) => x.id === id)) {
        onSelectionChange(new Set([id]));
        setEditing({ id, isNew: false });
        onGestureChange(true);
      }
      return;
    }
    if (tool === 'select') {
      const created = createAt('text', toWorld(e.clientX, e.clientY));
      if (created) {
        onChange(created.scene, false);
        onSelectionChange(new Set([created.id]));
        setEditing({ id: created.id, isNew: true });
        onGestureChange(true);
      }
    }
  };

  // Keyboard

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editing || isEditableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const s = sceneRef.current;
      if (e.key === ' ' && !spaceHeld) {
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        onSelectionChange(new Set());
        props.onToolChange('select');
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        onSelectionChange(new Set(s.elements.map((x) => x.id)));
        return;
      }
      if ((e.key === '=' || e.key === '+') && !mod) return zoomAt(1.2);
      if (e.key === '-' && !mod) return zoomAt(1 / 1.2);
      if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) return fit();
      if (e.shiftKey && (e.key === ')' || e.code === 'Digit0')) return zoomAt(1 / camRef.current.z);
      if (readOnly) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        e.preventDefault();
        onChange(deleteElements(s, new Set(selection)), true);
        onSelectionChange(new Set());
        return;
      }
      if (mod && e.key.toLowerCase() === 'b' && selection.size) {
        const texts = s.elements.filter((x) => selection.has(x.id) && isStylableText(x));
        if (texts.length) {
          e.preventDefault();
          const bold = !texts.every((x) => textStyleOf(x)?.bold);
          onChange(setTextStyle(s, new Set(texts.map((x) => x.id)), { bold }), true);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && selection.size) {
        e.preventDefault();
        const dup = duplicateElements(s, new Set(selection));
        onChange(dup.scene, true);
        onSelectionChange(dup.ids);
        return;
      }
      if (e.key === 'Enter' && selection.size === 1) {
        const id = [...selection][0]!;
        const el = byId.get(id);
        if ((el && hasText(el)) || s.edges.some((x) => x.id === id)) {
          e.preventDefault();
          setEditing({ id, isNew: false });
          onGestureChange(true);
        }
        return;
      }
      const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        e.key
      ];
      if (nudge && selection.size) {
        e.preventDefault();
        const k = e.shiftKey ? 10 : 1;
        onChange(
          moveElements(s, expandMoveSet(s, new Set(selection)), nudge[0]! * k, nudge[1]! * k),
          true,
        );
        return;
      }
      if (!mod && !e.altKey) {
        const t = TOOL_KEYS[e.key.toLowerCase()];
        if (t) props.onToolChange(t);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  // Render

  const z = cam.z;
  const hoverEl = hover ? byId.get(hover) : undefined;
  const focusStep =
    (hoverEl?.kind === 'step' ? hoverEl : undefined) ??
    (selection.size === 1 ? byId.get([...selection][0]!) : undefined);
  const stepNodes =
    focusStep?.kind === 'step'
      ? focusStep.data.nodeIds.map((id) => byId.get(id)).filter((x): x is SceneElement => !!x)
      : [];

  const single = selection.size === 1 ? byId.get([...selection][0]!) : undefined;
  const singleArrow =
    single?.kind === 'shape' && single.data.type === 'arrow' ? single.data : undefined;
  const editingEl = editing ? byId.get(editing.id) : undefined;
  const editingEdge = editing ? scene.edges.find((x) => x.id === editing.id) : undefined;
  const editFree = editingEl?.kind === 'shape' && editingEl.data.type === 'text';
  const editStyle = editingEl ? textStyleOf(editingEl) : undefined;
  const editFontSize = editStyle?.fontSize ?? 14;

  // Floating text bar above a selection made only of text shapes.
  const textBar = (() => {
    if (props.textBar === false || readOnly || editing || gesture.current || !selection.size)
      return undefined;
    const els = scene.elements.filter((e) => selection.has(e.id));
    if (els.length !== selection.size || !els.every(isStylableText)) return undefined;
    const b = unionBoxes(els);
    const value = textStyleOf(els[0]!);
    if (!b || !value) return undefined;
    const BAR_W = Math.min(360, size.w - 16);
    // The bar wraps to two rows on narrow boards; anchor its bottom edge above the selection so
    // it grows upwards, or put it below when there is no room above.
    const selTop = b.y * z + cam.y;
    const barH = BAR_W < 340 ? 92 : 46;
    const above = selTop - 8 >= barH + 8;
    return {
      ids: new Set(els.map((e) => e.id)),
      left: Math.min(
        Math.max(8, (b.x + b.w / 2) * z + cam.x - BAR_W / 2),
        Math.max(8, size.w - BAR_W - 8),
      ),
      top: above ? selTop - 8 : (b.y + b.h) * z + cam.y + 12,
      above,
      value,
    };
  })();

  const cursor =
    spaceHeld || tool === 'hand'
      ? 'grab'
      : tool === 'select'
        ? 'default'
        : tool === 'text'
          ? 'text'
          : 'crosshair';
  const gridSize = 24 * z;

  return (
    <div ref={wrapRef} className="pc-canvas-wrap">
      <svg
        ref={svgRef}
        className="pc-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => !gesture.current && setHover(undefined)}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <pattern
            id="pc-dots"
            width={gridSize}
            height={gridSize}
            patternUnits="userSpaceOnUse"
            x={cam.x % gridSize}
            y={cam.y % gridSize}
          >
            <circle
              cx={1}
              cy={1}
              r={Math.max(0.6, Math.min(1.2, z))}
              style={{ fill: 'var(--pc-grid)' }}
            />
          </pattern>
        </defs>
        {z > 0.25 && (
          <rect className="pc-grid" width="100%" height="100%" style={{ fill: 'url(#pc-dots)' }} />
        )}
        <g className="pc-world" transform={`translate(${cam.x},${cam.y}) scale(${z})`}>
          {ordered.map((el) =>
            el.kind === 'shape' && el.data.type === 'arrow' ? null : (
              <ElementView key={el.id} el={el} sketch={sketch} isParent={parents.has(el.id)} />
            ),
          )}
          {scene.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const route = routeFor(edge, from, to);
            const [a, b] = route ? [route[0]!, route[route.length - 1]!] : edgePoints(from, to);
            const sel = selection.has(edge.id);
            const drifted = props.drift?.get(edge.id)?.some((d) => d.severity !== 'info');
            return (
              <ArrowView
                key={edge.id}
                id={edge.id}
                from={a}
                to={b}
                via={route?.slice(1, -1)}
                label={edge.label}
                stroke={sel ? 'var(--pc-accent)' : drifted ? 'var(--pc-orange)' : 'var(--pc-edge)'}
                strokeWidth={sel ? 2.5 : 1.8}
                sketch={sketch}
                dashed={drifted}
              />
            );
          })}
          {ordered.map((el) => {
            if (el.kind !== 'shape' || el.data.type !== 'arrow') return null;
            const [a, b] = arrowPoints(el.data, byId);
            return (
              <ArrowView
                key={el.id}
                id={el.id}
                from={a}
                to={b}
                label={el.data.label}
                head={el.data.head}
                stroke={color(el.data.color)}
                strokeWidth={el.data.strokeWidth ?? 2}
                sketch={sketch}
              />
            );
          })}

          {/* UI chrome below: excluded from exports via the pc-ui class. */}
          {props.drift && props.drift.size > 0 && (
            <g className="pc-ui pc-drift" aria-hidden>
              {scene.elements.map((el) => {
                const items = props.drift!.get(el.id)?.filter((d) => d.severity !== 'info');
                if (!items?.length) return null;
                const error = items.some((d) => d.severity === 'error');
                return (
                  <g key={el.id}>
                    <rect
                      x={el.x - 6}
                      y={el.y - 6}
                      width={el.w + 12}
                      height={el.h + 12}
                      rx={16}
                      className={`pc-drift-outline ${error ? 'pc-drift-error' : ''}`}
                    />
                    <Pill
                      x={el.x + 6}
                      y={el.y - 15}
                      text={`⚠ ${driftLabel(items)}`}
                      c={error ? 'red' : 'orange'}
                      filled
                    />
                  </g>
                );
              })}
            </g>
          )}
          {stepNodes.length > 0 && focusStep && (
            <g className="pc-ui pc-step-links">
              {stepNodes.map((n) => {
                const [a, b] = edgePoints(focusStep, n);
                return (
                  <g key={n.id}>
                    <rect
                      x={n.x - 5}
                      y={n.y - 5}
                      width={n.w + 10}
                      height={n.h + 10}
                      rx={16}
                      className="pc-highlight"
                    />
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="pc-step-link" />
                  </g>
                );
              })}
            </g>
          )}
          {hoverEl && !selection.has(hoverEl.id) && gesture.current && (
            <rect
              className="pc-ui pc-drop-target"
              x={hoverEl.x - 4}
              y={hoverEl.y - 4}
              width={hoverEl.w + 8}
              height={hoverEl.h + 8}
              rx={10}
            />
          )}
          <g className="pc-ui">
            {[...selection].map((id) => {
              const el = byId.get(id);
              if (!el || (el.kind === 'shape' && el.data.type === 'arrow')) return null;
              return (
                <rect
                  key={id}
                  className="pc-selection"
                  x={el.x - 4}
                  y={el.y - 4}
                  width={el.w + 8}
                  height={el.h + 8}
                  style={{ strokeWidth: 1.5 / z }}
                />
              );
            })}
            {single &&
              !singleArrow &&
              !readOnly &&
              HANDLES.map((hd) => {
                const hx =
                  single.x +
                  (hd.includes('w') ? 0 : hd.includes('e') ? single.w : single.w / 2) -
                  4 / z;
                const hy =
                  single.y +
                  (hd.includes('n') ? 0 : hd.includes('s') ? single.h : single.h / 2) -
                  4 / z;
                return (
                  <rect
                    key={hd}
                    data-handle={hd}
                    className={`pc-handle pc-handle-${hd}`}
                    x={hx}
                    y={hy}
                    width={8 / z}
                    height={8 / z}
                    style={{ strokeWidth: 1 / z }}
                  />
                );
              })}
            {singleArrow &&
              !readOnly &&
              (() => {
                const [a, b] = arrowPoints(singleArrow, byId);
                return (
                  <>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className="pc-selection"
                      style={{ strokeWidth: 1 / z }}
                    />
                    <circle
                      data-handle="start"
                      className="pc-handle"
                      cx={a.x}
                      cy={a.y}
                      r={5 / z}
                      style={{ strokeWidth: 1 / z }}
                    />
                    <circle
                      data-handle="end"
                      className="pc-handle"
                      cx={b.x}
                      cy={b.y}
                      r={5 / z}
                      style={{ strokeWidth: 1 / z }}
                    />
                  </>
                );
              })()}
            {marquee && (
              <rect
                className="pc-marquee"
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                style={{ strokeWidth: 1 / z }}
              />
            )}
          </g>
        </g>
      </svg>
      {editing && (editingEl || editingEdge) && (
        <TextEditor
          key={editing.id}
          initial={editingEl ? getText(editingEl) : (editingEdge?.label ?? '')}
          box={
            editingEl
              ? {
                  x: editingEl.x * z + cam.x,
                  y: editingEl.y * z + cam.y,
                  w: editingEl.w * z,
                  h: editingEl.h * z,
                }
              : (() => {
                  const from = byId.get(editingEdge!.from)!;
                  const to = byId.get(editingEdge!.to)!;
                  const c = center({ ...normalizeBox(...edgePoints(from, to)) });
                  return { x: c.x * z + cam.x - 80, y: c.y * z + cam.y - 16, w: 160, h: 32 };
                })()
          }
          fontSize={editFontSize * z}
          bold={!!editStyle?.bold}
          align={editStyle?.align ?? 'left'}
          mode={
            editFree
              ? 'free'
              : editingEdge || editingEl?.kind === 'node'
                ? 'line'
                : editingEl?.kind === 'shape'
                  ? 'shape'
                  : 'note'
          }
          onDone={finishEditing}
        />
      )}
      {textBar && (
        <div
          className="pc-text-bar"
          style={{
            left: textBar.left,
            top: textBar.top,
            transform: textBar.above ? 'translateY(-100%)' : undefined,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          role="toolbar"
          aria-label="Text"
        >
          <TextStyleControls
            value={textBar.value}
            onChange={(patch) => onChange(setTextStyle(scene, textBar.ids, patch), true)}
          />
        </div>
      )}
    </div>
  );
});

/** The auto-layout route of an edge, if both nodes are still where the layout put them. */
const DRIFT_LABEL: Record<DriftItem['kind'], string> = {
  missing: 'missing',
  renamed: 'moved?',
  'not-implemented': 'not built',
  'not-deleted': 'not deleted',
  'deps-changed': 'deps changed',
  'package-unused': 'unused',
  'edge-unbacked': 'no import',
  'edge-missing': 'missing arrow',
  unmapped: 'unmapped',
  'unplanned-change': 'unplanned',
};

/** Short badge text: the most serious drift on an element. */
export function driftLabel(items: readonly DriftItem[]): string {
  const first = items.find((d) => d.severity === 'error') ?? items[0]!;
  return DRIFT_LABEL[first.kind] + (items.length > 1 ? ` +${items.length - 1}` : '');
}

function routeFor(edge: Edge, from: Box, to: Box): readonly Pt[] | undefined {
  const r = edge.route;
  if (!r) return undefined;
  const same = (a: Box, b: Box) =>
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.w - b.w) < 1 &&
    Math.abs(a.h - b.h) < 1;
  return same(r.from, from) && same(r.to, to) ? r.points : undefined;
}

/**
 * In-place text editor. `free` text edits transparently over the text and grows with it;
 * `shape` and `note` cover the element; `line` is a single-line label (box names, arrows).
 */
function TextEditor({
  initial,
  box,
  fontSize,
  bold,
  align,
  mode,
  onDone,
}: {
  initial: string;
  box: Box;
  fontSize: number;
  bold: boolean;
  align: TextAlign;
  mode: 'free' | 'shape' | 'note' | 'line';
  onDone(text: string | undefined): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  const finish = (v: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const size = Math.max(10, fontSize);
  const weight = bold ? 700 : 400;
  const lh = size * 1.3;
  const lines = value.split('\n');
  let rect: Box;
  let padTop = 6;
  if (mode === 'free') {
    const w = Math.max(size, ...lines.map((l) => measureText(l, size, weight, FONT_FAMILY))) + size;
    const x =
      align === 'left' ? box.x : align === 'right' ? box.x + box.w - w : box.x + box.w / 2 - w / 2;
    // The board draws the first baseline at fontSize; a textarea line box puts it ~0.1em lower.
    rect = { x: x - 4, y: box.y - 4 - size * 0.08, w: w + 8, h: lines.length * lh + 8 };
    padTop = 4;
  } else if (mode === 'line') {
    const w = Math.max(160, box.w);
    rect = { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - (lh + 14) / 2, w, h: lh + 14 };
  } else {
    const h = Math.max(box.h, lines.length * lh + 16);
    rect = { x: box.x, y: box.y, w: Math.max(120, box.w), h };
    if (mode === 'shape') padTop = Math.max(6, (h - lines.length * lh) / 2);
  }
  const multiline = mode !== 'line';
  return (
    <>
      <textarea
        ref={ref}
        className={`pc-text-editor pc-text-editor-${mode}`}
        value={value}
        spellCheck
        wrap={mode === 'free' ? 'off' : 'soft'}
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          fontSize: size,
          fontWeight: weight,
          lineHeight: 1.3,
          textAlign: mode === 'line' ? 'center' : align,
          paddingTop: padTop,
          fontFamily: FONT_FAMILY,
        }}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={(e) => finish(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            finish(e.currentTarget.value);
          } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            finish(e.currentTarget.value);
          }
        }}
      />
      <div className="pc-edit-hint" style={{ left: rect.x, top: rect.y + rect.h + 6 }}>
        {multiline ? (
          <>
            <kbd>Enter</kbd> new line · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>Esc</kbd> done
          </>
        ) : (
          <>
            <kbd>Enter</kbd> or <kbd>Esc</kbd> done
          </>
        )}
      </div>
    </>
  );
}
