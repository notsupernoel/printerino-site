// The theme change's drop, its rim lens: t-lens.png, the map of glass.js's #vt-lens (Chromium on a desktop, fitted to
// the drop every frame). The unit disc, neutral (128,128) inside, bending toward the centre in a band at the rim (R
// and G hold the inward direction times the profile, 128 = no displacement; B marks the band).
// Usage: node tools/glass/t/gen-lens.mjs [size, default 512] [band, default 0.16] [out file, default
// src/web/public/glass/t-lens.png]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from '../e/png.mjs';
const N = Number(process.argv[2] || 512), B = Number(process.argv[3] || 0.16);
// The pixels, RGBA with every alpha 255: the encoder every map shares (../e/png.mjs) then writes an opaque map as RGB
// with the best filter on each row, and glass.js reads R, G and B only.
const rgba = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const u = ((x + 0.5) / N) * 2 - 1, v = ((y + 0.5) / N) * 2 - 1, rho = Math.hypot(u, v);
    const t = Math.min(1, Math.max(0, (rho - (1 - B)) / B));
    const P = t * t * (3 - 2 * t); // 0 inside, 1 at the rim, flat at both ends
    const dx = rho > 0 ? -u / rho : 0, dy = rho > 0 ? -v / rho : 0;
    const o = (y * N + x) * 4;
    rgba[o] = Math.round(127.5 + 127.5 * P * dx);
    rgba[o + 1] = Math.round(127.5 + 127.5 * P * dy);
    rgba[o + 2] = Math.round(255 * (rho >= 1 ? 1 : Math.min(1, P / 0.1))); rgba[o + 3] = 255; // B: the band (where the lens bends), for the soft pass
  }
}
const png = encodeSmall(N, N, rgba);
const out = process.argv[4] || fileURLToPath(new URL('../../../src/web/public/glass/t-lens.png', import.meta.url));
writeFileSync(out, png);
console.log(out, png.length, 'bytes', N, B);
