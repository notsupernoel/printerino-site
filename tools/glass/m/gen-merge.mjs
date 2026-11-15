// The top bar's merge: as the page scrolls, the glass switch, the theme switch and the X link flow into one body of
// glass. A free shape cannot be cut by the stylesheet alone and the page's policy allows no picture made at run time,
// so the shape is drawn here, ahead of time, as 24 frames stacked in two sprites the stylesheet steps through with the
// scroll (white, the alpha holds the picture):
//   m-mask.png   the body's shape: the mask of the frosted layer, and of the shadow the stylesheet casts from it
//   m-rim.png    the light on its top edge (the dock's rim)
//   m-lens.png   how the body bends what is behind it at its rim (Chromium on a desktop; glass.js fits it)
// Frame 0 is the three controls as they stand (60, 60 and 116 by 28, 10px apart, 6px in from the box's edges); by the
// last frame they are one capsule, 268 by 40, one clean body.
// The shape is a smooth union of the capsules (a distance field), so each bridge forms the way two drops touch.
// Usage: node tools/glass/m/gen-merge.mjs [out folder, default src/web/public/glass or $OUT]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from '../e/png.mjs';

const OUT = process.argv[2] || process.env.OUT || fileURLToPath(new URL('../../../src/web/public/glass/', import.meta.url));
// The box (CSS px), the frames, and the scale the sprites are drawn at.
const W = 268, H = 40, N = 24, S = 2;
// The controls at rest, left to right (glass.js's outline() holds the same numbers).
const P0 = [{ x: 6, w: 60 }, { x: 76, w: 60 }, { x: 146, w: 116 }], A0 = { y: 6, h: 28 };
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const capsule = (x, y, x0, y0, w, h) => { const r = h / 2, cx = clamp(x, x0 + r, x0 + w - r); return Math.hypot(x - cx, y - (y0 + r)) - r; };
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = clamp(0.5 + (0.5 * (b - a)) / k); return b + (a - b) * h - k * h * (1 - h); };
// The shape at frame i: distance to its edge, negative inside. Each capsule grows to the box's full height and reaches
// across its neighbours, so the last frame is one whole capsule; the smooth union is widest half way, where the bridges run.
function shape(i) {
  const q = i / (N - 1), e = q * q * (3 - 2 * q), ex = e ** 2.1, L = (a, b, k) => a + (b - a) * k;
  const y = L(A0.y, 0, e), h = L(A0.h, H, e), k = 16 * Math.sin(Math.PI * q);
  const caps = P0.map((p, j) => {
    const l = j ? L(p.x, P0[j - 1].x + P0[j - 1].w * 0.45, ex) : L(p.x, 0, e);
    const r = j < P0.length - 1 ? L(p.x + p.w, P0[j + 1].x + P0[j + 1].w * 0.55, ex) : L(p.x + p.w, W, e);
    return [l, r - l];
  });
  return (px, py) => caps.map(([l, w]) => capsule(px, py, l, y, w, h)).reduce((d, c) => smin(d, c, k));
}
// How far the glass throws a ray sideways at depth t into its bezel (0 at the edge, 1 where it turns flat): a convex
// squircle surface, Snell's law at n = 1.5, 1 at the very edge.
const PROF = Array.from({ length: 257 }, (_, i) => {
  const u = 1 - Math.max(i / 256, 1e-4), slope = (u * u * u) / (1 - u * u * u * u) ** 0.75, th = Math.atan(slope);
  return Math.tan(th - Math.asin(Math.sin(th) / 1.5)) / 1.118;
});
const BEZEL = 13;
// The light: the dock's own rim (the merged body matches the dock): a fine line on the top edge only, whole on the
// edge and gone 3.5px below the body's top, as the stylesheet's top-edge rim is; along it the dock's 135 degree run of
// light (its --dock-rim-a, b, c: 0.5, 0.1, 0.32, here as shares of the brightest), in white; the stylesheet sets its
// strength (0.5, the dock's). No colour. The shadow is not drawn here: the stylesheet casts it from the mask itself.
// Not a whole ring, brightest top left and bottom right: the dock has none.
const RUN = (t) => (t < 0.34 ? 1 - 0.8 * (t / 0.34) : t < 0.62 ? 0.2 : 0.2 + 0.44 * ((t - 0.62) / 0.38));

const mw = W * S, mh = H * S, mask = Buffer.alloc(mw * mh * N * 4, 255), rim = Buffer.alloc(mw * mh * N * 4, 255);
// The lens (Chromium on a desktop): one map a frame at 1x, R and G the way in times the bezel's throw (128 = none), B
// where the middle is frosted (0 at the rim, where the glass stays clear and bends).
const lens = Buffer.alloc(W * H * N * 4, 255);
for (let i = 0; i < N; i++) {
  const sd = shape(i);
  // The body's top at this frame (shape() eases it from the controls' own top to the box's).
  const q = i / (N - 1), top = A0.y * (1 - q * q * (3 - 2 * q));
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const px = (x + 0.5) / S, py = (y + 0.5) / S, d = sd(px, py), o = ((i * mh + y) * mw + x) * 4, ci = clamp(0.5 - d * S);
    mask[o + 3] = Math.round(255 * ci);
    let a = 0;
    if (ci > 0) {
      const dist = -d, fade = clamp(1 - (py - top - 1) / 2.5), run = RUN(clamp((px - W / 2 + py - H / 2) / (W + H) + 0.5));
      a = clamp((1 - sstep(0.4, 1.3, dist)) * run * fade) * ci;
    }
    rim[o + 3] = Math.round(255 * a);
  }
}
for (let i = 0; i < N; i++) {
  const sd = shape(i);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x + 0.5, py = y + 0.5, d = sd(px, py), o = ((i * H + y) * W + x) * 4, dist = -d;
    let nx = sd(px + 1, py) - sd(px - 1, py), ny = sd(px, py + 1) - sd(px, py - 1);
    const l = Math.hypot(nx, ny) || 1, m = dist <= 0 ? 1 : dist >= BEZEL ? 0 : PROF[Math.floor((dist / BEZEL) * 256)];
    lens[o] = Math.round(128 - (nx / l) * m * 127); lens[o + 1] = Math.round(128 - (ny / l) * m * 127);
    lens[o + 2] = Math.round(255 * sstep(BEZEL * 0.3, BEZEL * 1.05, dist));
  }
}
const put = (name, w, h, rgba) => { const png = encodeSmall(w, h, rgba); writeFileSync(path.join(OUT, name), png); console.log(name, png.length, 'bytes', `${w}x${h}`); };
put('m-mask.png', mw, mh * N, mask);
put('m-rim.png', mw, mh * N, rim);
put('m-lens.png', W, H * N, lens);
