// Lossless WebP copies of the served PNGs: the icons, their light twins (tools/png/light.mjs) and the glass maps,
// about a fifth smaller again than the squeezed PNGs. sharp (tools/package.json, never installed on the server) writes each one lossless with its exact colours kept under full transparency (exact), at its slowest,
// smallest setting; every copy is decoded back and compared with its PNG, pixel for pixel, every channel, before it is
// kept. A copy is kept only where it is smaller than its PNG (a map of a few hundred bytes can come out larger as
// WebP: that PNG is served as it is, and a copy left beside it from before is removed). The PNG stays the source (the
// glass generators write it, tools/png/squeeze.mjs keeps it small); server.js serves the WebP in its place wherever
// one sits beside it, and the PNG where none does.
// Usage: cd tools && npm install (once), then from the repo root:
//        node tools/png/webp.mjs            writes every copy that is smaller than its PNG
//        node tools/png/webp.mjs --check    exits 1 unless every copy has the very same pixels as its PNG and is
//                                           smaller, and every PNG without one has none that would be
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SERVED_DIRS, decode } from './squeeze.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const check = process.argv.includes('--check');
const bad = [];
let before = 0, after = 0, copies = 0, plain = 0;
for (const dir of SERVED_DIRS) for (const f of readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.png'))) {
  const png = path.join(ROOT, dir, f), webp = png.replace(/\.png$/, '.webp');
  const src = readFileSync(png);
  const want = decode(src);
  const same = async (buf) => { const r = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return r.info.width === want.W && r.info.height === want.H && r.data.equals(want.rgba); };
  const encoded = () => sharp(src).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
  if (check) {
    const rel = path.relative(ROOT, webp);
    if (existsSync(webp)) {
      const have = readFileSync(webp);
      if (!(await same(have))) bad.push(`${rel}: out of date or not exact`);
      else if (have.length >= src.length) bad.push(`${rel}: not smaller than its PNG (${have.length} against ${src.length} bytes)`);
      copies++;
    } else {
      if ((await encoded()).length < src.length) bad.push(`${rel}: missing`);
      plain++;
    }
    continue;
  }
  const out = await encoded();
  if (!(await same(out))) throw new Error(`${f}: the WebP did not decode to the same pixels`);
  if (out.length < src.length) {
    writeFileSync(webp, out);
    before += src.length; after += out.length; copies++;
  } else {
    rmSync(webp, { force: true });
    plain++;
  }
}
const served = `${plain} PNG${plain === 1 ? ' is' : 's are'} served as ${plain === 1 ? 'it is' : 'they are'} (no smaller as WebP)`;
if (check) {
  if (bad.length) { console.log(`to rewrite (node tools/png/webp.mjs):\n  ${bad.join('\n  ')}`); process.exit(1); }
  console.log(`all ${copies} WebP copies are current, pixel-identical to their PNGs and smaller; ${served}`);
} else console.log(`${copies} copies: ${before} -> ${after} bytes as WebP (${Math.round((1 - after / before) * 100)}% smaller), every pixel checked identical; ${served}`);
