import { arrowPoints, elementIndex, normalizeBox, unionBoxes } from './geometry';
import { FONT_FAMILY } from './text';
import { expandMoveSet } from './ops';
import type { Box, Scene } from './types';

const PAD = 32;

/** Bounds of everything drawn, including frame labels and arrows. */
export function sceneBounds(scene: Scene): Box {
  const byId = elementIndex(scene);
  const boxes: Box[] = scene.elements.map((el) => {
    if (el.kind === 'shape' && el.data.type === 'arrow')
      return normalizeBox(...arrowPoints(el.data, byId));
    if (el.kind === 'shape' && el.data.type === 'frame')
      return { ...el, y: el.y - 20, h: el.h + 20 };
    return el;
  });
  return unionBoxes(boxes) ?? { x: 0, y: 0, w: 400, h: 300 };
}

/**
 * Bounds of what the live canvas actually drew for `scene`, in world coordinates. Unlike
 * `sceneBounds` this covers routed edges that detour around boxes and their labels.
 */
function renderedBounds(svg: SVGSVGElement, scene: Scene): Box | undefined {
  const world = svg.querySelector<SVGGraphicsElement>('.pc-world');
  const toWorld = world?.getCTM?.()?.inverse();
  if (!world || !toWorld) return undefined;
  const kept = new Set([...scene.elements.map((e) => e.id), ...scene.edges.map((e) => e.id)]);
  const boxes: Box[] = [];
  world.querySelectorAll<SVGGraphicsElement>('[data-id]').forEach((n) => {
    if (!kept.has(n.getAttribute('data-id') ?? '')) return;
    try {
      const bb = n.getBBox();
      const m = toWorld.multiply(n.getCTM()!);
      const corners = [
        [bb.x, bb.y],
        [bb.x + bb.width, bb.y],
        [bb.x, bb.y + bb.height],
        [bb.x + bb.width, bb.y + bb.height],
      ].map(([px, py]) => new DOMPoint(px, py).matrixTransform(m));
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      boxes.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
    } catch {
      // Not rendered (e.g. hidden): sceneBounds still covers it.
    }
  });
  return unionBoxes(boxes);
}

/** The exported area: everything drawn plus a margin on all four sides. */
function exportFrame(svg: SVGSVGElement, scene: Scene): Box {
  const b = unionBoxes(
    [sceneBounds(scene), renderedBounds(svg, scene)].filter((x) => x !== undefined),
  )!;
  return { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
}

/**
 * What an export of `selection` contains: the selected elements plus what belongs to them
 * (children of a box, shapes inside a frame) and arrows/edges whose both ends are included.
 */
export function exportScope(scene: Scene, selection: ReadonlySet<string>): Scene {
  const ids = expandMoveSet(scene, selection);
  for (const e of scene.edges) if (selection.has(e.id)) [e.from, e.to].forEach((id) => ids.add(id));
  const ends = (id: string | undefined) => !!id && ids.has(id);
  const elements = scene.elements.filter(
    (el) =>
      ids.has(el.id) ||
      (el.kind === 'shape' &&
        el.data.type === 'arrow' &&
        ends(el.data.start.bindTo) &&
        ends(el.data.end.bindTo)),
  );
  const kept = new Set(elements.map((el) => el.id));
  const edges = scene.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  return { ...scene, elements, edges };
}

function themeVariables(): string {
  const style = getComputedStyle(document.documentElement);
  const decls: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style[i]!;
    if (name.startsWith('--pc-')) decls.push(`${name}: ${style.getPropertyValue(name).trim()};`);
  }
  return decls.join(' ');
}

/**
 * Serialises the live canvas without UI chrome (selection, handles, hover hints), framed to the
 * content. Theme variables are inlined so the file looks the same outside VS Code.
 */
export function exportSvg(svg: SVGSVGElement, scene: Scene): string {
  const { x, y, w, h } = exportFrame(svg, scene);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('.pc-ui, .pc-hit, .pc-grid').forEach((n) => n.remove());
  // A partial scene (an export of the selection): drop everything else.
  const kept = new Set([...scene.elements.map((e) => e.id), ...scene.edges.map((e) => e.id)]);
  clone.querySelectorAll<SVGElement>('.pc-world [data-id]').forEach((n) => {
    if (!kept.has(n.dataset.id ?? n.getAttribute('data-id') ?? '')) n.remove();
  });
  clone.querySelectorAll('.pc-pulse').forEach((n) => n.classList.remove('pc-pulse'));
  const world = clone.querySelector('.pc-world');
  world?.removeAttribute('transform');
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.setAttribute('width', String(Math.ceil(w)));
  clone.setAttribute('height', String(Math.ceil(h)));
  const ns = 'http://www.w3.org/2000/svg';
  const style = document.createElementNS(ns, 'style');
  style.textContent = `svg { ${themeVariables()} font-family: ${FONT_FAMILY}; } text { white-space: pre; }`;
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('x', String(x));
  bg.setAttribute('y', String(y));
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('style', 'fill: var(--pc-bg)');
  clone.insertBefore(bg, clone.firstChild);
  clone.insertBefore(style, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Rasterises the exported SVG. Returns base64 PNG data (no data: prefix). */
export async function exportPng(svg: SVGSVGElement, scene: Scene, scale = 2): Promise<string> {
  const text = exportSvg(svg, scene);
  const frame = exportFrame(svg, scene);
  const w = Math.ceil(frame.w);
  const h = Math.ceil(frame.h);
  // Keep huge boards under common canvas limits.
  const s = Math.min(scale, 16000 / Math.max(w, h));
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the board image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * s);
    canvas.height = Math.ceil(h * s);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1]!;
  } finally {
    URL.revokeObjectURL(url);
  }
}
