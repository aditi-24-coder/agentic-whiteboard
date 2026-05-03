// Text is laid out by hand into <tspan> lines instead of using <foreignObject>, so that exported
// SVG and PNG files render identically everywhere and a PNG export never taints the canvas.

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';
export const MONO_FAMILY = 'ui-monospace, "SF Mono", Consolas, "Liberation Mono", monospace';

let ctx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

export function measureText(
  text: string,
  size: number,
  weight = 400,
  family = FONT_FAMILY,
): number {
  const key = `${weight}|${size}|${family}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
  }
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${family}`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * size * 0.56; // No canvas (tests): a decent average glyph width.
  }
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/** Greedy word wrap. Long words are broken; overflow beyond maxLines ends in an ellipsis. */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  maxLines = Infinity,
  weight = 400,
  family = FONT_FAMILY,
): string[] {
  const lines: string[] = [];
  const fits = (s: string) => measureText(s, size, weight, family) <= maxWidth;
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (!fits(line) && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && !fits(line.slice(0, cut))) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1]!;
    while (last && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

export function ellipsize(
  text: string,
  maxWidth: number,
  size: number,
  weight = 400,
  family = FONT_FAMILY,
): string {
  if (measureText(text, size, weight, family) <= maxWidth) return text;
  let t = text;
  while (t && measureText(`${t}…`, size, weight, family) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Box that exactly fits free text as the board draws it: first baseline at `size`, 1.3 line height. */
export function textBoxSize(text: string, size: number, weight = 400): { w: number; h: number } {
  const lines = (text || ' ').split('\n');
  const w = Math.max(size, ...lines.map((l) => measureText(l, size, weight)));
  return { w: Math.ceil(w + 4), h: Math.ceil((lines.length - 1) * size * 1.3 + size * 1.35) };
}
