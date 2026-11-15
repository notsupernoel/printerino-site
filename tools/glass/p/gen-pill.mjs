// The dock pill's lens: p-lens.png, the map glass.js fits to the dock's pill while it is held or in flight (Chromium on
// a desktop). Read off the Photos bar on an iPhone (iOS 27), frame by frame: the word inside the lifted pill stays
// crisp and steady, and only what the pill's rim crosses is bent (and, bent a touch differently per colour, split into
// a fringe). So this map is flat in the middle (128, 128: no
// bending) and bends inward only in a band at the rim, falling off as a square so the band joins the flat middle
// without a seam. Same channels as the droplets' dome (k-lens.png): R the push across, G the push up and down, B
// neutral, so glass.js drives it with the same two passes.
// Usage: node tools/glass/p/gen-pill.mjs [out file, default src/web/public/glass/p-lens.png]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSmall } from '../e/png.mjs';
// The lifted pill is about 108 by 64; the map is drawn at twice that and stretched to the pill's box as it changes.
const W = 216, H = 128, BAND = 0.44;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const rgba = Buffer.alloc(W * H * 4, 255);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const px = x + 0.5, py = y + 0.5, r = H / 2, cx = clamp(px, r, W - r);
  let nx = px - cx, ny = py - r;
  const l = Math.hypot(nx, ny) || 1, dist = r - l, t = clamp(dist / (BAND * r)), m = dist <= 0 ? 1 : (1 - t) * (1 - t), o = (y * W + x) * 4;
  nx /= l; ny /= l;
  rgba[o] = Math.round(128 - nx * m * 127); rgba[o + 1] = Math.round(128 - ny * m * 127); rgba[o + 2] = 128;
}
const out = process.argv[2] || fileURLToPath(new URL('../../../src/web/public/glass/p-lens.png', import.meta.url));
const png = encodeSmall(W, H, rgba);
writeFileSync(out, png);
console.log(out, png.length, 'bytes');

// ---- the dock pill's lens, as UIKit's own liquid lens is built ----
// p-apple-lens.png and p-apple-split.png, written beside p-lens.png. The numbers are Apple's, as the open-source
// Liquidum project read them off the iOS 26.5 tab bar's live layers and fitted them frame by frame (its
// shaders/lens_material.glsl and doc/comparison/uikit-reference-notes.md, MIT): the lens is two bends in a row and a
// dispersion.
//   inner refraction: where the lens looks is pulled INWARD by 17.5pt at the very edge, gone 7pt in (the sag of a
//     circular arc). So the outer ring shows a squeezed, mirrored picture of what lies 7 to 17pt inside: the bright
//     line at the rim.
//   warp: then pushed OUTWARD by 9pt at the edge, fading over 36pt (the whole half height). So everything is drawn a
//     little smaller, and the bar's top and bottom edges come out a few pt further in, the page above and below
//     showing in a band: the "shorter base".
//   direction: the capsule's own outward normal, turned half way toward the point's direction in the capsule's
//     normalized coordinates (UIKit's ovalization, 0.5).
//   dispersion: red and blue are read a little to either side along a vector that grows with the position
//     (x / half width, y / half height) through the matrix below, fully at the edge and not at all 14pt in.
// All in the lens's own points for a lens 72pt tall; here scaled to the lifted pill, 68px tall (AK).
// The first map holds where to look (R across, G up and down; 127.5 = nowhere, a full step = AS px) and, in B, where
// the outer ring is (glass.js softens the bent picture there and nowhere else, so words inside stay sharp), the second
// the dispersion's whole reach (glass.js reads the picture at seven steps along it, from the far end for blue to the
// near end for red, as UIKit does; a full step = SS px). glass.js fits both to the pill's box.
const AW = 108, AH = 68, AZ = 2, AK = AH / 72;
const A_IN = 17.5 * AK, H_IN = 7 * AK, A_WARP = 9 * AK, H_WARP = 36 * AK, H_SPLIT = 14 * AK, OVAL = 0.5;
const M = [-1.499, 2.235, 5.925, 0.706];
const END = 5;
export const AS = 40, SS = 26;
const sag = (depth, height) => { const u = clamp(1 - depth / height); return 1 - Math.sqrt(1 - u * u); };
const hw = AW / 2, hh = AH / 2, ar = Math.min(hw, hh);
const sdf = (x, y) => { const qx = Math.abs(x - hw) - hw + ar, qy = Math.abs(y - hh) - hh + ar; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - ar; };
const outward = (x, y) => {
  const dx = x - hw, dy = y - hh, qx = Math.abs(dx) - hw + ar, qy = Math.abs(dy) - hh + ar;
  let gx, gy;
  if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); gx = qx / l; gy = qy / l; } else if (qx > qy) { gx = 1; gy = 0; } else { gx = 0; gy = 1; }
  gx *= dx < 0 ? -1 : 1; gy *= dy < 0 ? -1 : 1;
  let ox = dx / hw, oy = dy / hh; const ol = Math.hypot(ox, oy);
  if (ol > 0) { ox /= ol; oy /= ol; } else { ox = gx; oy = gy; }
  const nx = gx + (ox - gx) * OVAL, ny = gy + (oy - gy) * OVAL, nl = Math.hypot(nx, ny);
  return nl > 0 ? [nx / nl, ny / nl] : [gx, gy];
};
const lensMap = Buffer.alloc(AW * AZ * AH * AZ * 4, 255), splitMap = Buffer.alloc(AW * AZ * AH * AZ * 4, 255);
const enc = (v, full) => Math.round(clamp(0.5 + v / full) * 255);
for (let y = 0; y < AH * AZ; y++) for (let x = 0; x < AW * AZ; x++) {
  const px = (x + 0.5) / AZ, py = (y + 0.5) / AZ, o = (y * AW * AZ + x) * 4;
  let dx = 0, dy = 0, vx = 0, vy = 0, ring = 0;
  const d = sdf(px, py);
  if (d < 0) {
    // The outer ring, where about 10px of picture is squeezed into 2: whole to 7pt in, gone by 10pt. Along the
    // straight top and bottom only (gy: how far the capsule's own normal points up or down): there glass.js softens
    // the bent picture, which is what lets the two bands read as bands. The round ends are left sharp, for the colour.
    const qx0 = Math.abs(px - hw) - hw + ar, qy0 = Math.abs(py - hh) - hh + ar;
    const gyy = qx0 > 0 && qy0 > 0 ? (qy0 / Math.hypot(qx0, qy0)) ** 2 : qx0 > qy0 ? 0 : 1;
    ring = clamp(1 - (-d - H_IN) / (3 * AK)) * gyy;
    const [nx, ny] = outward(px, py), k1 = A_IN * sag(-d, H_IN);
    let qx = px - nx * k1, qy = py - ny * k1;
    const d2 = Math.max(-sdf(qx, qy), 0), [mx, my] = outward(qx, qy), k2 = A_WARP * sag(d2, H_WARP);
    qx = clamp(qx + mx * k2, 0, AW); qy = clamp(qy + my * k2, 0, AH);
    dx = qx - px; dy = qy - py;
    const spread = clamp(1 + d / H_SPLIT), ux = (px - hw) / hw, uy = (py - hh) / hh;
    vx = spread * AK * (M[0] * ux + M[2] * uy); vy = spread * AK * (M[1] * ux + M[3] * uy);
    // Not Apple's (Apple's own split is faint here, and this turns the icons beside the pill to rainbow at its
    // left and right ends): at the two round ends red and blue are parted a further END px along the way out,
    // nothing extra along the top and bottom.
    const gxx = 1 - gyy;
    vx += END * spread * gxx * nx; vy += END * spread * gxx * ny;
  }
  lensMap[o] = enc(dx, AS); lensMap[o + 1] = enc(dy, AS); lensMap[o + 2] = Math.round(255 * ring);
  splitMap[o] = enc(vx, SS); splitMap[o + 1] = enc(vy, SS); splitMap[o + 2] = 128;
}
for (const [name, buf] of [['p-apple-lens.png', lensMap], ['p-apple-split.png', splitMap]]) {
  const file = path.join(path.dirname(out), name), data = encodeSmall(AW * AZ, AH * AZ, buf);
  writeFileSync(file, data);
  console.log(file, data.length, 'bytes');
}
