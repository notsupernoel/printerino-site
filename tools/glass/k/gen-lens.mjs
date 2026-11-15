// The droplet's magnifier: k-lens.png, the map of glass.js's #drop-lens, which Chromium lays over the words under a
// lifted droplet of the segmented controls and the theme switch (backdrop-filter: url(), two passes in bounding-box
// units: R moves across, G moves up, B = 128 no move). glass.js's lens strength is built on the full scale printed at
// the end.
// Usage: node tools/glass/k/gen-lens.mjs [P, default 2] [out file, default src/web/public/glass/k-lens.png]
// A droplet is a dome: it magnifies most in its middle (M) and less toward its rim, where what it holds is drawn in a
// little; nothing is read from outside it. g maps where you look (u, -1..1) to where the light comes from:
//   g(u) = u / M + (1 - 1 / M) * sign(u) * |u|^P,   g(+-1) = +-1
// P = 3 is flat in the middle, but at the rim it squeezes the content to 1 / (3 - 2 / M) = 78%, in a narrow band that
// reads as a cut through any letter crossing it. P = 2 spreads the same change over the outer half: the squeeze at
// the rim is 1 / (2 - 1 / M) = 88%, and it eases in.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from '../e/png.mjs';
const P = Number(process.argv[2]) || 2;
const OUT = process.argv[3] || fileURLToPath(new URL('../../../src/web/public/glass/k-lens.png', import.meta.url));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const enc = (d) => Math.round(clamp(127.5 + 127.5 * d, 0, 255));
const MX = 1.16, MY = 1.1, W = 256, H = 64;
const g = (u, M) => u / M + (1 - 1 / M) * Math.sign(u) * Math.abs(u) ** P;
let K = 0;
for (let i = 0; i < 2000; i++) { const u = (i / 1999) * 2 - 1; K = Math.max(K, Math.abs(g(u, MX) - u) / 2, Math.abs(g(u, MY) - u) / 2); }
K = Math.ceil(K * 1.01 * 10000) / 10000;
// The pixels, RGBA with every alpha 255: the encoder every map shares (../e/png.mjs) then writes an opaque map as RGB
// with the best filter on each row, and glass.js reads R, G and B only.
const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const u = ((x + 0.5) / W) * 2 - 1, v = ((y + 0.5) / H) * 2 - 1, o = (y * W + x) * 4;
  rgba[o] = enc((g(u, MX) - u) / 2 / K); rgba[o + 1] = enc((g(v, MY) - v) / 2 / K); rgba[o + 2] = 128; rgba[o + 3] = 255;
}
const buf = encodeSmall(W, H, rgba);
writeFileSync(OUT, buf);
const edge = (M) => 1 / (1 / M + P * (1 - 1 / M));
console.log(`P=${P}: ${OUT.split('/').pop()} ${buf.length} bytes; full scale (bbox units, ${MX}x across, ${MY}x up) = ${+(2 * K).toFixed(4)}; rim squeeze ${(edge(MX) * 100).toFixed(0)}%`);
