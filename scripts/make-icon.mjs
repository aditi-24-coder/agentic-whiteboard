// Draws the extension icon (an original design: a whiteboard card with two nodes joined by a
// curved arrow, plus an AI sparkle, on a violet-to-blue tile) and writes
// packages/extension/media/icon.png at 256×256. No dependencies: shapes are defined in a
// 128-unit space, rasterised at 4× and box-filtered down for antialiasing, then the PNG is
// encoded with zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SS = 4;
const N = SIZE * SS;
const UNIT = SIZE / 128; // design coordinates are 0..128
const px = new Float32Array(N * N * 4); // premultiplied RGBA, 0..1

const hex = (h, a = 1) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
  a,
];
const mix = (c1, c2, t) => c1.map((c, i) => c + (c2[i] - c) * t);

function blend(i, [r, g, b, a]) {
  const k = 1 - a;
  px[i] = r * a + px[i] * k;
  px[i + 1] = g * a + px[i + 1] * k;
  px[i + 2] = b * a + px[i + 2] * k;
  px[i + 3] = a + px[i + 3] * k;
}

/**
 * Fills every supersampled pixel whose centre satisfies `inside(u, v)` (coords in 0..128).
 * `color` is an RGBA array or a function of (u, v) returning one, for gradients.
 */
function fill(inside, color) {
  const at = typeof color === 'function' ? color : () => color;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / SS / UNIT;
      const v = (y + 0.5) / SS / UNIT;
      if (inside(u, v)) blend((y * N + x) * 4, at(u, v));
    }
}

const roundRect = (x0, y0, w, h, r) => (u, v) => {
  if (u < x0 || v < y0 || u > x0 + w || v > y0 + h) return false;
  const cx = Math.min(Math.max(u, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(v, y0 + r), y0 + h - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};
const segment = (x1, y1, x2, y2, width) => (u, v) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(u - (x1 + t * dx), v - (y1 + t * dy)) <= width / 2;
};
const circle = (cx, cy, r) => (u, v) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
const triangle = (a, b, c) => (u, v) => {
  const s = (p, q) => (q[0] - p[0]) * (v - p[1]) - (q[1] - p[1]) * (u - p[0]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
/** Four-pointed sparkle: a concave astroid-like star of radius r. */
const sparkle = (cx, cy, r) => (u, v) =>
  Math.sqrt(Math.abs(u - cx) / r) + Math.sqrt(Math.abs(v - cy) / r) <= 1;
/** Cubic Bézier stroke, as the union of short round-capped segments. */
const curve = (p0, p1, p2, p3, width, steps = 32) => {
  const pt = (t) =>
    [0, 1].map(
      (k) =>
        (1 - t) ** 3 * p0[k] +
        3 * (1 - t) ** 2 * t * p1[k] +
        3 * (1 - t) * t ** 2 * p2[k] +
        t ** 3 * p3[k],
    );
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const [x1, y1] = pt(i / steps);
    const [x2, y2] = pt((i + 1) / steps);
    parts.push(segment(x1, y1, x2, y2, width));
  }
  return (u, v) => parts.some((f) => f(u, v));
};

// Background: rounded tile with a diagonal violet-to-blue gradient.
const tileTop = hex('#8b5cf6');
const tileBottom = hex('#2563eb');
fill(roundRect(4, 4, 120, 120, 28), (u, v) => mix(tileTop, tileBottom, (u + v - 8) / 240));

// Whiteboard card with a soft drop shadow.
for (let i = 4; i >= 1; i--) fill(roundRect(18, 30 + i, 92, 74, 12), hex('#1e1b4b', 0.07));
fill(roundRect(18, 30, 92, 74, 12), hex('#ffffff'));

// Curved connector with arrowhead, drawn before the nodes so they sit on top.
const ink = hex('#1e293b');
fill(curve([42, 80], [50, 56], [61, 76], [71, 67], 4.5), ink);
fill(triangle([78.5, 60.5], [75, 71.5], [67.5, 63]), ink);

// Nodes: a violet circle and a green rounded square.
fill(circle(38, 82, 9), hex('#8b5cf6'));
fill(roundRect(80, 42, 18, 18, 5), hex('#10b981'));

// AI sparkles, overlapping the card's top-right corner.
fill(sparkle(105, 25, 18), hex('#fde047'));
fill(sparkle(84, 14, 7), hex('#ffffff'));

// Downsample and encode.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        a += px[i + 3];
      }
    const n = SS * SS;
    a /= n;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round((r / n / a) * 255) : 0;
    raw[o + 1] = a ? Math.round((g / n / a) * 255) : 0;
    raw[o + 2] = a ? Math.round((b / n / a) * 255) : 0;
    raw[o + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync('packages/extension/media/icon.png', png);
console.log(`Wrote packages/extension/media/icon.png (${png.length} bytes)`);
