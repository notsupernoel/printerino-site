// The coins sealed in glass: the maps for one clear resin dome over a round coin, in the coin's own box. index.html's
// svg.fx-defs reads them: #coin-lens (e-ref.png) and the #coin-spec filters (e-nrm.png; e-env.png and e-bar.png come
// from light.mjs). The scales printed at the end are the ones written in those filters.
//
// Unit space: the coin's box is [-1, 1] on both axes (the 192px art's 96px half-size = 1; one art cell = 1/48).
// What the art is (measured on all 30 icons in assets/coin-icons/192; they share one disc template):
//   - the disc's pixel silhouette runs from r 0.959 to 0.982 (a staircase), the disc 93/96 = 0.969;
//   - a one-cell dark outline, one flat colour per icon (99% of its cells), its inner staircase from r 0.925 to 0.953;
//   - at r 0.953..0.957 a ray lands on the outline at 99.1% of angles; the rest is the top-left baked sparkle, whose
//     two arm tips cut right through the outline to the silhouette (219.75-220.5 and 227.75-228.5 degrees).
//
// The dome: a domed sticker's resin, not a magnifier. A crystal of even thickness over the face (it bends nothing:
// the art inside Rm is drawn pixel for pixel, exactly), meeting the coin's edge in a steep meniscus. A meniscus squeezes
// the coin's edge into the glass edge: from Rm out to Rd the view converges on a sliver of the outline, so the rim of
// the dome shows each coin's own outline colour, as a smooth circle (the art's outer pixel staircase goes under it):
//   r_in(r) = Rm + (t - Rm) (1 - (1 - u)^p),  u = (r - Rm) / (Rd - Rm)
// Why not a wider lens (or a bend from r 0.90): the outline is one cell thick and both its edges are staircases,
// so any real magnification across it stretches its inner staircase into a comb of teeth, and a smooth ramp that ends
// by r 0.94 folds over (min(1 - D') = -1.25).
// The sparkle tips: in the meniscus the lens also samples the art 1.5 cells along the tangent at the sparkle and keeps
// the darker of the two (feBlend darken): the outline is darker than everything near it on every icon, so this changes
// nothing anywhere else (0 of 259,200 samples) and the tips do not streak across the glass edge.
//
// Maps (each covers the filter region: the box plus a margin M on every side, in bounding-box units):
//   e-ref.png  R,G = where to look for the coin (feDisplacementMap, 128 = straight through: the whole face)
//              B   = the light the coin keeps under the glass: 1 under the crystal; under the meniscus 0.99 down to
//                    1 - shade at the edge (the thick glass), so B < 1 also marks the meniscus for the darken pass
//              A   = the dome's coverage: a smooth, antialiased circle of radius Rd (the glass edge)
//   e-nrm.png  R,G = where the reflection looks the light up: a sphere map, centre + Rs * n(p), stored as the offset
//                    from p (feDisplacementMap on the light's picture). n is the crystal's outer surface (x, y): a
//                    gentle curve over the face (a watch crystal), steeper toward the edge.
//              B   = how much the surface reflects there (Schlick's Fresnel times a gain, 0 off the dome), antialiased
// Usage: node tools/glass/e/gen.mjs  [CFG='{"Rd":1.0}'] [OUT=<folder>, default src/web/public/glass]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from './png.mjs';

const OUT = process.env.OUT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/web/public/glass');
const cfg = {
  Rd: 1.0,      // the dome's radius: the box's own edge, 3% wider than the art's disc (0.969)
  Rm: 0.953,    // the crystal is flat (bends nothing) inside this radius: past the outline's inner staircase
  t: 0.957,     // the meniscus converges on the outline at this radius ...
  p: 2,         // ... this fast (the edge of the glass is all outline)
  shade: 0.12,  // the coin keeps this much less light under the thickest glass at the edge ...
  shade0: 0.01, // ... and this much less as soon as the meniscus starts (a step that marks it for the darken pass)
  ter: 68,      // the crystal's outer surface tilt at the edge, for the reflection (degrees) ...
  kr: 1.5,      // ... and how it grows: a gentle curve, so the light can sit on the face
  Rs: 0.5,      // the light's sphere map: radius in bounding-box units, centred on the box
  F0: 0.04,     // Fresnel reflectance face-on (acrylic: 4%)
  Fk: 3.5,      // the light is far brighter than its surroundings: reflectance times this, clamped to 1
  Nref: 192,    // map sizes in px (each covers the whole filter region)
  Nnrm: 192,
  edge: 0.09,   // the reflection fades out from this far inside the dome's edge (unit) ...
  edgeIn: 0.03, // ... to this far inside it: a coin tilted under a fixed dome (WebKit) never shows light past its edge
  M: 0.02,      // filter region margin, bounding-box units (each side)
  ...JSON.parse(process.env.CFG || '{}'),
};
const { Rd, Rm, t, p, M } = cfg;
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const rin = (r) => (r <= Rm ? r : r >= Rd ? t : Rm + (t - Rm) * (1 - Math.pow(1 - (r - Rm) / (Rd - Rm), p)));
// D(r) = r - r_in(r): how far toward the centre the view is pulled. Past Rd (the antialiased edge pixel) it keeps
// converging on t, so the edge pixel shows the outline too.
const D = (r) => r - rin(r);
const RMAX = Rd + 0.03;
const Dmax = D(RMAX);
// pixel (i, j) of an N-px map -> unit-space point; the image spans bounding-box [-M, 1+M]
const toUnit = (N, i) => (((i + 0.5) / N) * (1 + 2 * M) - M - 0.5) * 2;
// feDisplacementMap: P'(x) = P(x + S (C - 0.5)) with S in bounding-box units. Encoding C = 0.5 + 0.5 v gives an
// offset of S v / 2 bbox = S v unit. We need -D u (toward the centre): v = -D u / S.
// The darken pass reads the same map shifted a constant one cell left, right, up and down: the scale leaves room for it.
const SH = 1 / 48;
const Sref = Math.ceil((Dmax + SH) * 100) / 100 + 0.01;
const enc = (v) => Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * v)));
const enc01 = (v) => Math.max(0, Math.min(255, Math.round(255 * v)));
const SS = 4;
const cover = (N, i, j, R) => { let c = 0; for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) c += Math.hypot(toUnit(N, i - 0.5 + (a + 0.5) / SS), toUnit(N, j - 0.5 + (b + 0.5) / SS)) <= R ? 1 : 0; return c / (SS * SS); };

// ---- e-ref.png: the lens ----
{
  const N = cfg.Nref, ref = Buffer.alloc(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = toUnit(N, i), y = toUnit(N, j), r = Math.hypot(x, y);
    const cov = cover(N, i, j, Rd);
    const o = (j * N + i) * 4;
    // Outside the glass nothing is drawn (alpha 0): a constant there compresses (the browser interpolates the map
    // premultiplied, so the edge pixel never mixes it in).
    if (cov === 0 && r > Rd) { ref.set([128, 128, 255, 0], o); continue; }
    const ux = r > 1e-9 ? x / r : 0, uy = r > 1e-9 ? y / r : 0;
    const d = Math.min(D(r), Dmax);
    const sh = r <= Rm ? 1 : 1 - cfg.shade0 - (cfg.shade - cfg.shade0) * smooth(Rm, Rd, r);
    ref.set([enc(-(d * ux) / Sref), enc(-(d * uy) / Sref), enc01(sh), enc01(cov)], o);
  }
  writeFileSync(path.join(OUT, 'e-ref.png'), encodeSmall(N, N, ref));
}

// ---- e-nrm.png: the reflection ----
const schlick = (cosT) => cfg.F0 + (1 - cfg.F0) * Math.pow(1 - cosT, 5);
const ter = (cfg.ter * Math.PI) / 180;
const thetaR = (r) => ter * Math.pow(Math.min(r, Rd) / Rd, cfg.kr);
// the reflection's lookup offset (bbox units) at unit radius r: centre + Rs sin(thetaR) u - p, along u
const offR = (r) => cfg.Rs * Math.sin(thetaR(r)) - r / 2;
let Omax = 0;
for (let r = 0; r <= Rd; r += 1e-3) Omax = Math.max(Omax, Math.abs(offR(r)));
const Sn = Math.ceil(Omax * 2 * 1000) / 1000 + 0.002;
{
  const N = cfg.Nnrm, nrm = Buffer.alloc(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = toUnit(N, i), y = toUnit(N, j), r = Math.hypot(x, y);
    const ux = r > 1e-9 ? x / r : 0, uy = r > 1e-9 ? y / r : 0;
    // the reflection keeps inside the glass's own edge: it fades out over the last px of the dome
    let cov = 0;
    for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) cov += 1 - smooth(Rd - cfg.edge, Rd - cfg.edgeIn, Math.hypot(toUnit(N, i - 0.5 + (a + 0.5) / SS), toUnit(N, j - 0.5 + (b + 0.5) / SS)));
    cov /= SS * SS;
    const refl = Math.min(1, cfg.Fk * schlick(Math.cos(thetaR(r)))) * cov;
    const o2 = r < Rd ? offR(r) : 0; // offset = Sn (C - 0.5), C = 0.5 + 0.5 v  ->  v = 2 o / Sn
    nrm.set(refl > 0 ? [enc((2 * o2 * ux) / Sn), enc((2 * o2 * uy) / Sn), enc01(refl), 255] : [128, 128, 0, 255], (j * N + i) * 4);
  }
  writeFileSync(path.join(OUT, 'e-nrm.png'), encodeSmall(N, N, nrm));
}

// The light's pictures (e-env.png, e-bar.png) are drawn by light.mjs.

console.log(`lens: flat inside Rm=${Rm}, meniscus to Rd=${Rd} converging on r=${t}; Dmax=${Dmax.toFixed(4)} unit -> feDisplacementMap scale=${Sref}`);
console.log('  r_out -> r_in:', [0.9, Rm, 0.96, 0.97, 0.98, 0.99, Rd].map((r) => `${r.toFixed(3)}>${rin(r).toFixed(4)}`).join('  '));
console.log(`reflection: sphere map scale=${Sn}`, [0, 0.5, 0.7, 0.85, 0.95, Rd - 0.01].map((r) => `${r.toFixed(2)}: n=${Math.sin(thetaR(r)).toFixed(2)} F=${Math.min(1, cfg.Fk * schlick(Math.cos(thetaR(r)))).toFixed(2)} off=${offR(r).toFixed(3)}`).join('  '));
console.log(`feImage x=${-M} y=${-M} width=${1 + 2 * M} height=${1 + 2 * M}; filter region the same`);
// The darken pass: the art also read one cell left, right, up and down, and the darkest read kept, in the meniscus only.
// The outline is the darkest colour round every icon's rim, so this finds it wherever a read lands a little off it (the
// sparkle's arm tips cut through it; WebKit registers the map up to half a cell off: with the reads alone, 5.4% of band
// reads would miss under a half-cell error, with the cross 0%, and no colour changes anywhere). Not an
// feOffset of the art (WebKit draws an feOffset in bounding-box units as ragged streaks round the edge): the same map
// with a constant added to R or G, which moves every read by the same step: C' = C - shift / (2 S).
const dC = SH / (2 * Sref);
console.log(`darken pass (scale ${Sref}): +-x  values="1 0 0 0 ${(-dC).toFixed(4)}  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" / ${dC.toFixed(4)};  +-y  "1 0 0 0 0  0 1 0 0 ${(-dC).toFixed(4)}  ..." / ${dC.toFixed(4)}`);
