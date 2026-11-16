// The icons for the light theme: a twin of every coin icon with its two dark outlines softened, since near-black
// lines that sit well on a dark card cut hard into a white one. Node and zlib only, no dependency: squeeze.mjs decodes
// each icon and writes its twin as the smallest exact PNG.
// Every icon shares one template, 192 by 192, read along its middle row (y = 96) from the left edge: 2px clear, the
// outer ring (4px, one dark colour), the rim (8px, dithered from two colours), the inner line where the rim meets the
// face (4px, a second dark colour), a bevel (2px), then the face. Only the two lines change, each inside its own band
// of radius around the centre (95.5, 95.5), so art of the same colour inside the face is never touched:
//   outer ring: every opaque pixel at radius 86 or more of exactly the ring's colour becomes that colour mixed
//               T_OUT of the way to the rim's first colour;
//   inner line: every opaque pixel at radius 74 up to 86 of exactly the line's colour becomes that colour mixed T_IN
//               of the way to the mean of its two neighbours (the rim's second colour and the bevel).
// Alpha and every other pixel stay as they are. An icon that does not fit the template (the colours along the middle
// row, or too few pixels found in either band) stops the run before anything is written.
// Usage, from the repo root:
//        node tools/png/light.mjs            writes assets/coin-icons/192/light/<sym>.png for every icon
//        node tools/png/light.mjs --check    exits 1 unless every twin exists and is byte for byte what would be written
// The lossless WebP copies of the twins are tools/png/webp.mjs's, as for every other served PNG.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encodeBest } from './squeeze.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(ROOT, 'assets/coin-icons/192');
const OUT = path.join(SRC, 'light');
const SIZE = 192;
// The middle row, and where along it each part of the template is read.
const ROW = 96;
const X = { clear: 1, ring: 2, ringEnd: 5, rim: 6, rim2: 12, rimEnd: 13, line: 14, lineEnd: 17, bevel: 18 };
const CENTRE = 95.5;
const R_RING = 86;
const R_LINE = 74;
const T_OUT = 0.45;
const T_IN = 0.55;
// The fewest pixels of each line an icon must have to fit (the template's ring is 1760 pixels, its inner line 1228).
const MIN_RING = 1500;
const MIN_LINE = 1200;

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The light twin of one icon's pixels: { rgba } on a fit, { odd } (why not) otherwise. */
export function lighten({ W, H, rgba }) {
  if (W !== SIZE || H !== SIZE) return { odd: `${W}x${H}, not ${SIZE}x${SIZE}` };
  const at = (x, y) => (y * W + x) * 4;
  const rgb = (x) => [...rgba.subarray(at(x, ROW), at(x, ROW) + 3)];
  const ring = rgb(X.ring), rim = rgb(X.rim), rim2 = rgb(X.rim2), line = rgb(X.line), bevel = rgb(X.bevel);
  const fits = rgba[at(X.clear, ROW) + 3] < 128 && eq(rgb(X.ringEnd), ring) && !eq(rim, ring) && eq(rgb(X.lineEnd), line) && !eq(rgb(X.rimEnd), line) && !eq(bevel, line);
  const ringTo = mix(ring, rim, T_OUT);
  const lineTo = mix(line, rim2.map((v, i) => (v + bevel[i]) / 2), T_IN);
  const out = Buffer.from(rgba);
  let nRing = 0, nLine = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = at(x, y);
    if (rgba[i + 3] < 128) continue;
    const here = [rgba[i], rgba[i + 1], rgba[i + 2]];
    const r = Math.hypot(x - CENTRE, y - CENTRE);
    if (r >= R_RING && eq(here, ring)) { out.set(ringTo, i); nRing++; }
    else if (r >= R_LINE && r < R_RING && eq(here, line)) { out.set(lineTo, i); nLine++; }
  }
  if (!fits || nRing < MIN_RING || nLine < MIN_LINE) return { odd: `template ${fits ? 'fits' : 'does not fit'}, outer ring ${nRing}px, inner line ${nLine}px` };
  return { rgba: out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const names = readdirSync(SRC).filter((f) => f.endsWith('.png')).sort();
  const twins = [];
  const odd = [];
  for (const f of names) {
    const src = readFileSync(path.join(SRC, f));
    const t = lighten(decode(src));
    if (t.odd) odd.push(`${f}: ${t.odd}`);
    else twins.push({ f, src, png: encodeBest(SIZE, SIZE, t.rgba) });
  }
  if (odd.length) {
    console.error(`not the icon template, nothing written:\n  ${odd.join('\n  ')}`);
    process.exit(1);
  }
  if (check) {
    const bad = [];
    for (const { f, png } of twins) {
      const p = path.join(OUT, f);
      if (!existsSync(p)) { bad.push(`${f}: missing`); continue; }
      const have = readFileSync(p);
      if (have.equals(png)) continue;
      // The same pixels in other bytes: written by a Node whose zlib packs differently.
      bad.push(`${f}: ${decode(have).rgba.equals(decode(png).rgba) ? 'the right pixels, but not the bytes this Node writes' : 'out of date'}`);
    }
    // A twin whose icon is gone would still get a WebP copy from webp.mjs.
    const want = new Set(names);
    for (const f of existsSync(OUT) ? readdirSync(OUT).filter((x) => x.endsWith('.png')) : []) if (!want.has(f)) bad.push(`${f}: no icon of that name`);
    if (bad.length) { console.log(`light icons to rewrite (node tools/png/light.mjs):\n  ${bad.join('\n  ')}`); process.exit(1); }
    console.log(`all ${twins.length} light icons are byte for byte what this tool writes`);
  } else {
    mkdirSync(OUT, { recursive: true });
    let before = 0, after = 0;
    for (const { f, src, png } of twins) {
      writeFileSync(path.join(OUT, f), png);
      before += src.length;
      after += png.length;
    }
    console.log(`${twins.length} light icons in ${path.relative(ROOT, OUT)}: ${after} bytes (their icons: ${before}), every one fits the template`);
  }
}
