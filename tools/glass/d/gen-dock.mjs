// The dock's rim lens: d-lens.png, the map of glass.js's #dock-lens (Chromium on a desktop). The dock at its full size
// is a capsule 436 by 62 (four 107px cells), so one map at 1x fits it exactly: R and G hold the way in times the
// bezel's throw (128 = no bending; a convex squircle bezel 16px deep, Snell's law at n = 1.5), and B says
// where the middle is softened (0 at the rim, where the glass stays clear and bends what is behind it, as the Photos
// bar on an iPhone does).
// d-round-lens.png is the same lens for the dock's round button (62 by 62), written beside it.
// Usage: node tools/glass/d/gen-dock.mjs [out file, default src/web/public/glass/d-lens.png]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from '../e/png.mjs';
const H = 62, BEZEL = 16;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const PROF = Array.from({ length: 257 }, (_, i) => {
  const u = 1 - Math.max(i / 256, 1e-4), slope = (u * u * u) / (1 - u * u * u * u) ** 0.75, th = Math.atan(slope);
  return Math.tan(th - Math.asin(Math.sin(th) / 1.5)) / 1.118;
});
// One capsule of the dock's height, W wide: the bar (436) or, as wide as it is tall, the round button beside it (62).
function lens(W) {
  const rgba = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x + 0.5, py = y + 0.5, r = H / 2, cx = clamp(px, r, W - r);
    let nx = px - cx, ny = py - r;
    const l = Math.hypot(nx, ny) || 1, dist = r - l, m = dist <= 0 ? 1 : dist >= BEZEL ? 0 : PROF[Math.floor((dist / BEZEL) * 256)], o = (y * W + x) * 4;
    nx /= l; ny /= l;
    rgba[o] = Math.round(128 - nx * m * 127); rgba[o + 1] = Math.round(128 - ny * m * 127);
    rgba[o + 2] = Math.round(255 * sstep(BEZEL * 0.3, BEZEL * 1.05, dist));
  }
  return encodeSmall(W, H, rgba);
}
const out = process.argv[2] || fileURLToPath(new URL('../../../src/web/public/glass/d-lens.png', import.meta.url));
// The round button's map lies beside the bar's, under its own name, so the button bends at its rim and frosts only its
// middle as the bar does, rather than frosting its whole face evenly: they are one piece of glass.
const round = path.join(path.dirname(out), 'd-round-lens.png');
for (const [file, W] of [[out, 436], [round, H]]) {
  const png = lens(W);
  writeFileSync(file, png);
  console.log(file, png.length, 'bytes');
}
