// The coins' glass, its light pictures (gen.mjs draws the dome): the studio the dome reflects, drawn in the
// reflection's normal space. Each image spans n in [-R, R] (R = 1.6) around the key light's direction H, and app.js
// places its centre at H (x = 0.5 + Rs hx - R Rs, width 2 R Rs, Rs = 0.5). The whole studio moves with the key: the pointer turns the room, not one lamp.
//   e-env.png  the key: a small window (a rounded rectangle with a crisp edge): on the dome, a catchlight;
//              the sky behind it: a band past the key, which only the rim (grazing, so reflective) catches, faintly;
//              the fill: a dim card on the far side, a whisper on the opposite rim.
//   e-bar.png  the glint: a long soft bar at the pixel glint's own angle (its stripes lean like "/", 118deg gradient)
// The key is a catchlight, not a blob (edge 0.15, 0.16 x 0.07); it rests on the art's own baked crescent (-0.469,
// -0.469; the crescent is at r 0.72, while a key at -0.50, -0.58 would land at r 0.81, on the top-left sparkle) and lies
// along the crescent; the rim glow and the fill are faint (sky 0.30, fill 0.15, at a gain of 2.4).
// Usage: node tools/glass/e/light.mjs  [LCFG='{"keyW":0.16}'] [OUT=<folder>, default src/web/public/glass]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from './png.mjs';
const OUT = process.env.OUT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/web/public/glass');
const R = 1.6;
const cfg = {
  H: [-0.469, -0.469], // the key's rest direction (app.js's resting light): on the art's baked crescent (r 0.72, 225 degrees)
  keyW: 0.16, keyH: 0.07, keyE: 0.15, keyA: 1.0, keyP: 4,
  // The gain in the filter (index.html, the #coin-spec filters' k1) is 4.4: the key peaks at 0.63 white on the face;
  // the rest is scaled from levels set at a gain of 2.4 (sky 0.30, fill 0.15, halo 0.06, glint bar 0.75, times
  // 2.4 / 4.4).
  haloA: 0.033, haloS: 0.3,
  skyA: 0.164, skyD: 0.40, skyR: 0.16, skyT: 0.55, // past the key by skyD, radial and tangential spread
  fillA: 0.082, fillR: 0.12, fillT: 0.42,          // on the far rim
  rimN: 0.93,                                     // where the rim sits in normal space
  bar: 0.11, barA: 0.41,
  Wenv: 384, Wbar: 128,
  ...JSON.parse(process.env.LCFG || '{}'),
};
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const enc01 = (v) => Math.max(0, Math.min(255, Math.round(255 * v)));
const SS = 3;
function img(W, f) {
  const b = Buffer.alloc(W * W * 4);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    let s = 0; // supersampled, so the catchlight's edge is antialiased in the picture itself
    for (let a = 0; a < SS; a++) for (let c = 0; c < SS; c++) s += Math.min(1, f((((i + (a + 0.5) / SS) / W) * 2 - 1) * R, (((j + (c + 0.5) / SS) / W) * 2 - 1) * R));
    b.set([255, 255, 255, enc01(s / (SS * SS))], (j * W + i) * 4);
  }
  return encodeSmall(W, W, b);
}
const [hx, hy] = cfg.H;
const hl = Math.hypot(hx, hy), lx = hx / hl, ly = hy / hl; // the light's side
// an elongated gaussian round (cx, cy), radial along the light's side, tangential across it
const band = (cx, cy, sr, st) => (x, y) => { const dx = x - cx, dy = y - cy; const r = dx * lx + dy * ly, t = -dx * ly + dy * lx; return Math.exp(-(r * r) / (2 * sr * sr) - (t * t) / (2 * st * st)); };
const sky = band(cfg.skyD * lx, cfg.skyD * ly, cfg.skyR, cfg.skyT);
// the far rim in local coordinates: absolute -rimN L, minus H
const fill = band(-cfg.rimN * lx - hx, -cfg.rimN * ly - hy, cfg.fillR, cfg.fillT);
// the key is a strip window whose long side runs across the light's direction: on the dome it lies along the crescent
const key = (x, y) => { const along = -x * ly + y * lx, across = x * lx + y * ly; return 1 - smooth(1 - cfg.keyE, 1, Math.pow(Math.pow(Math.abs(along / cfg.keyW), cfg.keyP) + Math.pow(Math.abs(across / cfg.keyH), cfg.keyP), 1 / cfg.keyP)); };
const env = (x, y) => cfg.keyA * key(x, y) + cfg.haloA * Math.exp(-(x * x + y * y) / (2 * cfg.haloS ** 2)) + cfg.skyA * sky(x, y) + cfg.fillA * fill(x, y);
writeFileSync(path.join(OUT, 'e-env.png'), img(cfg.Wenv, env));
{
  const nx = Math.sin((118 * Math.PI) / 180), ny = -Math.cos((118 * Math.PI) / 180); // the gradient's direction (screen, y down)
  writeFileSync(path.join(OUT, 'e-bar.png'), img(cfg.Wbar, (x, y) => {
    const d = x * nx + y * ny, along = -x * ny + y * nx;
    return cfg.barA * Math.pow(Math.max(0, 1 - (d / cfg.bar) ** 2), 2) * (1 - smooth(1.0, 1.5, Math.abs(along)));
  }));
}
console.log(`light written: ${path.join(OUT, 'e-env.png')} and e-bar.png`);
