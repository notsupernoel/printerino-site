// Lossless WebP copies of every served PNG: the icons and the glass maps, about a third smaller again than the
// squeezed PNGs. sharp (tools/package.json, never installed on the server) writes each one lossless with its exact colours kept under full transparency (exact), at its slowest,
// smallest setting; every copy is decoded back and compared with its PNG, pixel for pixel, every channel, before it is
// kept. The PNG stays the source (the glass generators write it, tools/png/squeeze.mjs keeps it small); server.js
// serves the WebP in its place wherever one sits beside it, and the PNG where none does.
// Usage: cd tools && npm install (once), then from the repo root:
//        node tools/png/webp.mjs            writes every copy
//        node tools/png/webp.mjs --check    exits 1 unless every copy exists, is current and has the very same pixels
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decode } from './squeeze.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIRS = ['assets/coin-icons/192', 'src/web/public/glass'];
const check = process.argv.includes('--check');
const bad = [];
let before = 0, after = 0, n = 0;
for (const dir of DIRS) for (const f of readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.png'))) {
  const png = path.join(ROOT, dir, f), webp = png.replace(/\.png$/, '.webp');
  const src = readFileSync(png);
  const want = decode(src);
  const same = async (buf) => { const r = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return r.info.width === want.W && r.info.height === want.H && r.data.equals(want.rgba); };
  if (check) { if (!existsSync(webp) || !(await same(readFileSync(webp)))) bad.push(path.relative(ROOT, webp)); n++; continue; }
  const out = await sharp(src).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
  if (!(await same(out))) throw new Error(`${f}: the WebP did not decode to the same pixels`);
  writeFileSync(webp, out);
  before += src.length; after += out.length; n++;
}
if (check) {
  if (bad.length) { console.log(`missing, out of date or not exact (node tools/png/webp.mjs):\n  ${bad.join('\n  ')}`); process.exit(1); }
  console.log(`all ${n} WebP copies are current and pixel-identical to their PNGs`);
} else console.log(`${n} files: ${before} -> ${after} bytes as WebP (${Math.round((1 - after / before) * 100)}% smaller), every pixel checked identical`);
