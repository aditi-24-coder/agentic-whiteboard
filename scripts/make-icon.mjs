// Draws the 128×128 extension icon (an original design: three plan boxes, a data-flow arrow
// and a check mark) and writes packages/extension/media/icon.png. No dependencies: it
// rasterises at 4× and box-filters down for antialiasing, then encodes the PNG with zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4;
const N = SIZE * SS;
const px = new Float32Array(N * N * 4); // premultiplied RGBA, 0..1

const hex = (h, a = 1) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
  a,
];

function blend(i, [r, g, b, a]) {
  const k = 1 - a;
  px[i] = r * a + px[i] * k;
  px[i + 1] = g * a + px[i + 1] * k;
  px[i + 2] = b * a + px[i + 2] * k;
  px[i + 3] = a + px[i + 3] * k;
}

/** Fills every supersampled pixel whose centre satisfies `inside(x, y)` (coords in 0..128). */
function fill(inside, color) {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / SS;
      const v = (y + 0.5) / SS;
      if (inside(u, v)) blend((y * N + x) * 4, color);
    }
}

const roundRect = (x0, y0, w, h, r) => (u, v) => {
  if (u < x0 || v < y0 || u > x0 + w || v > y0 + h) return false;
  const cx = Math.min(Math.max(u, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(v, y0 + r), y0 + h - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};
const ring = (fn, inner) => (u, v) => fn(u, v) && !inner(u, v);
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

// Background: deep blue tile.
fill(roundRect(4, 4, 120, 120, 26), hex('#1f3f8f'));
// Faint dot grid, like the canvas.
for (let gx = 20; gx < 112; gx += 14)
  for (let gy = 20; gy < 112; gy += 14) fill(circle(gx, gy, 1.1), hex('#ffffff', 0.18));

const box = (x, y, w, h, stroke) => {
  fill(roundRect(x, y, w, h, 7), hex('#ffffff'));
  fill(ring(roundRect(x, y, w, h, 7), roundRect(x + 3, y + 3, w - 6, h - 6, 5)), hex(stroke));
};
// Connectors first so boxes sit on top.
fill(segment(40, 44, 60, 64, 4), hex('#dfe8ff'));
fill(segment(40, 86, 60, 72, 4), hex('#dfe8ff'));
fill(segment(84, 68, 96, 68, 4), hex('#dfe8ff'));
fill(triangle([102, 68], [93, 62], [93, 74]), hex('#dfe8ff'));

box(16, 28, 34, 24, '#4f86f7'); // modify (blue)
box(16, 76, 34, 24, '#4f86f7');
box(56, 54, 34, 28, '#34b35a'); // new (green)

// Check badge.
fill(circle(98, 98, 17), hex('#34b35a'));
fill(ring(circle(98, 98, 17), circle(98, 98, 14.5)), hex('#ffffff'));
fill(segment(90, 98, 96, 104, 4.5), hex('#ffffff'));
fill(segment(96, 104, 107, 91, 4.5), hex('#ffffff'));

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
