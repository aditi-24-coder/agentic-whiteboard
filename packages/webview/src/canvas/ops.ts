import {
  randomId,
  type ArrowShape,
  type FreeformShape,
  type PenShape,
  type ShapeStyle,
  type TextStyle,
} from '@agentic-whiteboard/shared';
import { arrowPoints, boxContains, elementIndex, normalizeBox } from './geometry';
import { measureText, textBoxSize, wrapText } from './text';
import { textStyleOf } from './textStyle';
import type { Box, Scene, SceneElement } from './types';

/** Pure scene operations. Every function returns a new scene and never mutates its input. */

export function mapElements(
  scene: Scene,
  ids: ReadonlySet<string>,
  fn: (el: SceneElement) => SceneElement,
): Scene {
  return { ...scene, elements: scene.elements.map((el) => (ids.has(el.id) ? fn(el) : el)) };
}

function withBox<T extends SceneElement>(el: T, box: Box): T {
  if (el.kind === 'shape') return { ...el, ...box, data: { ...el.data, ...box } } as T;
  return { ...el, ...box };
}

/** Recomputes the cached bounding box of arrows from their (possibly bound) endpoints. */
export function syncArrows(scene: Scene): Scene {
  const byId = elementIndex(scene);
  let changed = false;
  const elements = scene.elements.map((el) => {
    if (el.kind !== 'shape' || el.data.type !== 'arrow') return el;
    const [a, b] = arrowPoints(el.data, byId);
    const box = normalizeBox(a, b);
    if (box.x === el.x && box.y === el.y && box.w === el.w && box.h === el.h) return el;
    changed = true;
    return withBox(el, box);
  });
  return changed ? { ...scene, elements } : scene;
}

/** Ids of everything that should move along with `ids`: child nodes and frame contents. */
export function expandMoveSet(scene: Scene, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  const blockedGroups = new Set(
    scene.elements
      .filter((el) => ids.has(el.id))
      .map((el) => blockIdOf(el))
      .filter((id): id is string => !!id),
  );
  if (blockedGroups.size) {
    for (const el of scene.elements) {
      const blockId = blockIdOf(el);
      if (blockId && blockedGroups.has(blockId)) out.add(el.id);
    }
  }
  const childrenOf = new Map<string, string[]>();
  for (const el of scene.elements)
    if (el.kind === 'node' && el.data.parentId) {
      const list = childrenOf.get(el.data.parentId) ?? [];
      list.push(el.id);
      childrenOf.set(el.data.parentId, list);
    }
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf.get(id) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      stack.push(c);
    }
    const el = scene.elements.find((e) => e.id === id);
    if (el?.kind === 'shape' && el.data.type === 'frame')
      for (const other of scene.elements)
        if (other.id !== id && !out.has(other.id) && boxContains(el, other)) {
          out.add(other.id);
          stack.push(other.id);
        }
  }
  return out;
}

function blockIdOf(el: SceneElement): string | undefined {
  return el.data.blockId;
}

export function isBlocked(el: SceneElement): boolean {
  return !!blockIdOf(el);
}

export function setBlocked(scene: Scene, ids: ReadonlySet<string>, blocked: boolean): Scene {
  const blockId = blocked ? randomId('b') : undefined;
  return mapElements(scene, ids, (el) => updateBlockId(el, blockId));
}

function updateBlockId(el: SceneElement, blockId: string | undefined): SceneElement {
  switch (el.kind) {
    case 'node':
      return { ...el, data: blockId ? { ...el.data, blockId } : withoutBlockId(el.data) };
    case 'step':
      return { ...el, data: blockId ? { ...el.data, blockId } : withoutBlockId(el.data) };
    case 'constraint':
      return { ...el, data: blockId ? { ...el.data, blockId } : withoutBlockId(el.data) };
    case 'comment':
      return { ...el, data: blockId ? { ...el.data, blockId } : withoutBlockId(el.data) };
    case 'shape':
      return { ...el, data: blockId ? { ...el.data, blockId } : withoutBlockId(el.data) };
  }
}

function withoutBlockId<T extends { blockId?: string }>(data: T): T {
  const { blockId: _blockId, ...rest } = data;
  return rest as T;
}

export function moveElements(
  scene: Scene,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): Scene {
  if (!dx && !dy) return scene;
  const next = mapElements(scene, ids, (el) => {
    if (el.kind === 'shape' && el.data.type === 'arrow') {
      const a = el.data;
      const start =
        a.start.bindTo && !ids.has(a.start.bindTo)
          ? a.start
          : { ...a.start, x: a.start.x + dx, y: a.start.y + dy };
      const end =
        a.end.bindTo && !ids.has(a.end.bindTo)
          ? a.end
          : { ...a.end, x: a.end.x + dx, y: a.end.y + dy };
      return { ...el, data: { ...a, start, end } };
    }
    return withBox(el, { x: el.x + dx, y: el.y + dy, w: el.w, h: el.h });
  });
  return syncArrows(next);
}

export function setBox(scene: Scene, id: string, box: Box): Scene {
  return syncArrows(mapElements(scene, new Set([id]), (el) => withBox(el, box)));
}

export function setArrowEnd(
  scene: Scene,
  id: string,
  which: 'start' | 'end',
  end: ArrowShape['start'],
): Scene {
  return syncArrows(
    mapElements(scene, new Set([id]), (el) =>
      el.kind === 'shape' && el.data.type === 'arrow'
        ? { ...el, data: { ...el.data, [which]: end } }
        : el,
    ),
  );
}

export function deleteElements(scene: Scene, ids: ReadonlySet<string>): Scene {
  const byId = elementIndex(scene);
  const removedNodes = new Set([...ids].filter((id) => byId.get(id)?.kind === 'node'));
  const elements: SceneElement[] = [];
  for (const el of scene.elements) {
    if (ids.has(el.id)) continue;
    if (el.kind === 'node' && el.data.parentId && removedNodes.has(el.data.parentId)) {
      const { parentId: _p, ...data } = el.data;
      elements.push({ ...el, data });
    } else if (el.kind === 'step' && el.data.nodeIds.some((n) => removedNodes.has(n))) {
      elements.push({
        ...el,
        data: { ...el.data, nodeIds: el.data.nodeIds.filter((n) => !removedNodes.has(n)) },
      });
    } else if (el.kind === 'comment' && el.data.attachedTo && ids.has(el.data.attachedTo)) {
      const { attachedTo: _a, ...data } = el.data;
      elements.push({ ...el, data });
    } else if (
      el.kind === 'shape' &&
      el.data.type === 'arrow' &&
      (ids.has(el.data.start.bindTo ?? '') || ids.has(el.data.end.bindTo ?? ''))
    ) {
      // Unbind from deleted elements, leaving the end where it was drawn.
      const [s, e] = arrowPoints(el.data, byId);
      const start = ids.has(el.data.start.bindTo ?? '') ? { x: s.x, y: s.y } : el.data.start;
      const end = ids.has(el.data.end.bindTo ?? '') ? { x: e.x, y: e.y } : el.data.end;
      elements.push({ ...el, data: { ...el.data, start, end } });
    } else {
      elements.push(el);
    }
  }
  const edges = scene.edges.filter(
    (e) => !ids.has(e.id) && !removedNodes.has(e.from) && !removedNodes.has(e.to),
  );
  return syncArrows({ ...scene, elements, edges });
}

export function getText(el: SceneElement): string {
  switch (el.kind) {
    case 'node':
      return el.data.label;
    case 'step':
      return el.data.title;
    case 'constraint':
    case 'comment':
      return el.data.text;
    case 'shape':
      switch (el.data.type) {
        case 'frame':
          return el.data.label;
        case 'arrow':
          return el.data.label ?? '';
        case 'pen':
          return '';
        default:
          return el.data.text ?? '';
      }
  }
}

export function setText(scene: Scene, id: string, text: string): Scene {
  const edge = scene.edges.find((e) => e.id === id);
  if (edge) {
    return {
      ...scene,
      edges: scene.edges.map((e) => (e.id === id ? { ...e, label: text || undefined } : e)),
    };
  }
  return mapElements(scene, new Set([id]), (el) => {
    switch (el.kind) {
      case 'node':
        return { ...el, data: { ...el.data, label: text } };
      case 'step':
        return { ...el, data: { ...el.data, title: text } };
      case 'constraint':
        return { ...el, data: { ...el.data, text } };
      case 'comment':
        return { ...el, data: { ...el.data, text } };
      case 'shape': {
        const d = el.data;
        if (d.type === 'frame') return { ...el, data: { ...d, label: text } };
        if (d.type === 'arrow') return { ...el, data: { ...d, label: text || undefined } };
        if (d.type === 'pen') return el;
        return { ...el, data: { ...d, text } };
      }
    }
  });
}

export function hasText(el: SceneElement): boolean {
  return !(el.kind === 'shape' && el.data.type === 'pen');
}

/** Removes elements whose text was left empty right after creation (e.g. an empty text box). */
export function isEmptyDisposable(el: SceneElement): boolean {
  return el.kind === 'shape' && el.data.type === 'text' && !el.data.text.trim();
}

export function addElement(scene: Scene, el: SceneElement): Scene {
  return syncArrows({ ...scene, elements: [...scene.elements, el] });
}

export function duplicateElements(
  scene: Scene,
  ids: ReadonlySet<string>,
  offset = 24,
): { scene: Scene; ids: Set<string> } {
  const idMap = new Map<string, string>();
  const prefix: Record<SceneElement['kind'], string> = {
    node: 'n',
    step: 's',
    constraint: 'k',
    comment: 'c',
    shape: 'f',
  };
  const copies: SceneElement[] = [];
  for (const el of scene.elements) {
    if (!ids.has(el.id)) continue;
    const id = randomId(prefix[el.kind]);
    idMap.set(el.id, id);
    copies.push(el);
  }
  const remap = (id?: string) => (id && idMap.has(id) ? idMap.get(id) : id);
  const out: SceneElement[] = copies.map((el) => {
    const id = idMap.get(el.id)!;
    const box = { x: el.x + offset, y: el.y + offset, w: el.w, h: el.h };
    switch (el.kind) {
      case 'node':
        return { ...el, ...box, id, data: { ...el.data, id, parentId: remap(el.data.parentId) } };
      case 'step':
        return {
          ...el,
          ...box,
          id,
          data: { ...el.data, id, status: 'pending' as const, order: el.data.order + 0.5 },
        };
      case 'constraint':
        return { ...el, ...box, id, data: { ...el.data, id, author: 'user' as const } };
      case 'comment':
        return {
          ...el,
          ...box,
          id,
          data: { ...el.data, id, attachedTo: remap(el.data.attachedTo) },
        };
      case 'shape': {
        let data: FreeformShape = { ...el.data, id, ...box };
        if (data.type === 'arrow') {
          const a = data;
          const shift = (e: ArrowShape['start']) =>
            e.bindTo && idMap.has(e.bindTo)
              ? { ...e, bindTo: idMap.get(e.bindTo) }
              : e.bindTo
                ? e
                : { x: e.x + offset, y: e.y + offset };
          data = { ...a, start: shift(a.start), end: shift(a.end) };
        }
        return { ...el, ...box, id, data };
      }
    }
  });
  const edges = scene.edges
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((e) => ({ ...e, id: randomId('e'), from: idMap.get(e.from)!, to: idMap.get(e.to)! }));
  return {
    scene: syncArrows({
      ...scene,
      elements: [...scene.elements, ...out],
      edges: [...scene.edges, ...edges],
    }),
    ids: new Set(idMap.values()),
  };
}

/**
 * After nodes are dragged: a node dropped fully inside a component becomes its child; a child
 * dragged out of its parent is detached.
 */
export function reparentOnDrop(scene: Scene, moved: ReadonlySet<string>): Scene {
  const byId = elementIndex(scene);
  const isDescendant = (candidate: string, ancestor: string): boolean => {
    let cur = byId.get(candidate);
    const seen = new Set<string>();
    while (cur?.kind === 'node' && cur.data.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.data.parentId === ancestor) return true;
      cur = byId.get(cur.data.parentId);
    }
    return false;
  };
  let next = scene;
  for (const id of moved) {
    const el = byId.get(id);
    if (el?.kind !== 'node') continue;
    // Moving with its parent: keep the relationship.
    if (el.data.parentId && moved.has(el.data.parentId)) continue;
    const containers = scene.elements.filter(
      (c): c is Extract<SceneElement, { kind: 'node' }> =>
        c.kind === 'node' &&
        c.id !== id &&
        c.data.kind === 'component' &&
        !isDescendant(c.id, id) &&
        boxContains(c, el),
    );
    containers.sort((a, b) => a.w * a.h - b.w * b.h);
    const parent = containers[0]?.id;
    if (parent === el.data.parentId) continue;
    next = mapElements(next, new Set([id]), (e) => {
      if (e.kind !== 'node') return e;
      const { parentId: _old, ...data } = e.data;
      return { ...e, data: parent ? { ...data, parentId: parent } : data };
    });
  }
  return next;
}

export function penShapeFromPoints(
  id: string,
  pts: [number, number, number][],
  style: ShapeStyle,
): PenShape {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - minX);
  const h = Math.max(1, Math.max(...ys) - minY);
  return {
    ...style,
    id,
    type: 'pen',
    x: minX,
    y: minY,
    w,
    h,
    baseW: w,
    baseH: h,
    points: pts.map(([x, y, p]) => [
      Math.round((x - minX) * 10) / 10,
      Math.round((y - minY) * 10) / 10,
      Math.round(p * 100) / 100,
    ]),
  };
}

/** Elements whose text size, weight and alignment can be changed. */
export function isStylableText(el: SceneElement): boolean {
  return !!textStyleOf(el);
}

/**
 * Applies a text style to the selected elements. Free text is refitted to its text, keeping the
 * edge its alignment anchors; boxes and notes grow (never shrink) so larger text still fits.
 */
export function setTextStyle(scene: Scene, ids: ReadonlySet<string>, patch: TextStyle): Scene {
  const parents = new Set(
    scene.elements.flatMap((e) => (e.kind === 'node' && e.data.parentId ? [e.data.parentId] : [])),
  );
  return syncArrows(
    mapElements(scene, ids, (el) => {
      const current = textStyleOf(el);
      if (!current) return el;
      const st = { ...current, ...patch };
      const weight = st.bold ? 700 : 400;
      const lh = st.fontSize * 1.3;
      switch (el.kind) {
        case 'shape': {
          const data = { ...el.data, ...patch } as FreeformShape;
          if (data.type !== 'text') return { ...el, data };
          const size = textBoxSize(data.text, st.fontSize, weight);
          const x =
            st.align === 'left'
              ? el.x
              : st.align === 'right'
                ? el.x + el.w - size.w
                : el.x + (el.w - size.w) / 2;
          const box = { x, y: el.y, ...size };
          return { ...el, ...box, data: { ...data, ...box } };
        }
        case 'node': {
          const data = { ...el.data, ...patch };
          if (data.kind === 'file') {
            const w = measureText(data.label, st.fontSize, weight) + 52;
            const h = lh + (data.path ? 30 : 18);
            return { ...el, w: Math.max(el.w, w), h: Math.max(el.h, h), data };
          }
          if (parents.has(el.id)) return { ...el, data };
          const lines = wrapText(
            data.label,
            Math.max(10, el.w - 28),
            st.fontSize,
            Infinity,
            weight,
          );
          const h = lines.length * lh + 28 + (data.path ? 14 : 0);
          return { ...el, h: Math.max(el.h, h), data };
        }
        case 'comment': {
          const data = { ...el.data, ...patch };
          const lines = wrapText(
            data.text || ' ',
            Math.max(10, el.w - 24),
            st.fontSize,
            Infinity,
            weight,
          );
          return { ...el, h: Math.max(el.h, lines.length * lh + 24), data };
        }
        default:
          return el;
      }
    }),
  );
}
