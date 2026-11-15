// The smallest exact PNG, Node and zlib only, no dependency: every colour type that holds the pixels exactly (a
// palette at 1, 2, 4 or 8 bits with its transparency, grey, grey with alpha, RGB, RGBA), every filter strategy (each
// of the five fixed filters, and the per-row least residual choice) and three deflate strategies at level 9; the smallest is kept and decoded back, so a file is only
// ever replaced by one with the very same pixels. (sharp's PNG re-encode, tried first, moved visible pixels of the
// glass maps by up to 32 levels: it premultiplies.) The same pixels always give the same bytes on the same Node.
// The icons and every glass map go through it: the maps through tools/glass/e/png.mjs, the icons here.
// Usage: node tools/png/squeeze.mjs <png>...     squeezes each file in place (never larger, never different)
//        node tools/png/squeeze.mjs --check       names any served PNG that could still be smaller (exit 1 if one can)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
export function decode(buf) {
  let o = 8, W, H, bd, ct, idat = [], plte = null, trns = null;
  while (o < buf.length) { const n = buf.readUInt32BE(o), t = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + n); if (t === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); bd = d[8]; ct = d[9]; if (d[12]) throw new Error('interlaced'); } else if (t === 'IDAT') idat.push(d); else if (t === 'PLTE') plte = d; else if (t === 'tRNS') trns = d; o += 12 + n; }
  if (bd === 16) throw new Error('16-bit');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const bpp = Math.max(1, (ch * bd) >> 3), stride = Math.ceil((W * ch * bd) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) { const f = raw[y * (stride + 1)]; for (let x = 0; x < stride; x++) { const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? px[y * stride + x - bpp] : 0, u = y ? px[(y - 1) * stride + x] : 0, c = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0; px[y * stride + x] = (v + (f === 1 ? a : f === 2 ? u : f === 3 ? (a + u) >> 1 : f === 4 ? paeth(a, u, c) : 0)) & 255; } }
  const rgba = Buffer.alloc(W * H * 4);
  const sample = (y, i) => { if (bd === 8) return px[y * stride + i]; const per = 8 / bd, byte = px[y * stride + Math.floor(i / per)], sh = 8 - bd * ((i % per) + 1); return (byte >> sh) & ((1 << bd) - 1); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = (y * W + x) * 4;
    if (ct === 3) { const k = sample(y, x); rgba[d] = plte[k * 3]; rgba[d + 1] = plte[k * 3 + 1]; rgba[d + 2] = plte[k * 3 + 2]; rgba[d + 3] = trns && k < trns.length ? trns[k] : 255; }
    else if (ct === 0) { const g = sample(y, x) * (255 / ((1 << bd) - 1)); rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = 255; }
    else if (ct === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[y * stride + x * 2]; rgba[d + 3] = px[y * stride + x * 2 + 1]; }
    else if (ct === 2) { const s = y * stride + x * 3; rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else px.copy(rgba, d, y * stride + x * 4, y * stride + x * 4 + 4); }
  return { W, H, rgba };
}
function layouts(W, H, rgba) {
  const n = W * H; const out = [];
  let opaque = true, grey = true; const colours = new Map();
  for (let i = 0; i < n; i++) { const o = i * 4; if (rgba[o + 3] !== 255) opaque = false; if (rgba[o] !== rgba[o + 1] || rgba[o] !== rgba[o + 2]) grey = false; const k = rgba.readUInt32BE(o); if (colours.size <= 256 && !colours.has(k)) colours.set(k, colours.size); }
  const pack = (ch, get) => { const b = Buffer.alloc(n * ch); for (let i = 0; i < n; i++) get(i, b, i * ch); return b; };
  out.push({ ct: 6, bd: 8, ch: 4, px: Buffer.from(rgba) });
  if (opaque) out.push({ ct: 2, bd: 8, ch: 3, px: pack(3, (i, b, d) => { b[d] = rgba[i * 4]; b[d + 1] = rgba[i * 4 + 1]; b[d + 2] = rgba[i * 4 + 2]; }) });
  if (grey) out.push({ ct: 4, bd: 8, ch: 2, px: pack(2, (i, b, d) => { b[d] = rgba[i * 4]; b[d + 1] = rgba[i * 4 + 3]; }) });
  if (grey && opaque) out.push({ ct: 0, bd: 8, ch: 1, px: pack(1, (i, b, d) => { b[d] = rgba[i * 4]; }) });
  if (colours.size <= 256) {
    // palette ordered with the transparent entries first, so tRNS is as short as it can be
    const keys = [...colours.keys()].sort((a, b) => ((a & 255) === 255) - ((b & 255) === 255) || a - b);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const plte = Buffer.alloc(keys.length * 3), trnsN = keys.filter((k) => (k & 255) !== 255).length, trns = Buffer.alloc(trnsN);
    keys.forEach((k, i) => { plte[i * 3] = k >>> 24; plte[i * 3 + 1] = (k >>> 16) & 255; plte[i * 3 + 2] = (k >>> 8) & 255; if (i < trnsN) trns[i] = k & 255; });
    for (const bd of [1, 2, 4, 8]) { if (keys.length > 1 << bd) continue;
      const per = 8 / bd, stride = Math.ceil(W / per), px = Buffer.alloc(stride * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = idx.get(rgba.readUInt32BE((y * W + x) * 4)); px[y * stride + Math.floor(x / per)] |= k << (8 - bd * ((x % per) + 1)); }
      out.push({ ct: 3, bd, ch: 1, px, stride, plte, trns: trnsN ? trns : null }); }
  }
  return out;
}
function filtered(L, W, H, mode) {
  const ch = L.ch, bpp = Math.max(1, (ch * L.bd) >> 3), stride = L.stride ?? W * ch, raw = Buffer.alloc((stride + 1) * H), zero = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < H; y++) { const cur = L.px.subarray(y * stride, (y + 1) * stride), up = y ? L.px.subarray((y - 1) * stride, y * stride) : zero;
    let best = mode, bestSum = Infinity;
    for (let f = 0; f < 5; f++) { if (mode !== 'adaptive' && f !== mode) continue; const c = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) { const a = i >= bpp ? cur[i - bpp] : 0, b = up[i], cc = i >= bpp ? up[i - bpp] : 0; const v = (cur[i] - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, cc) : 0)) & 255; c[i] = v; sum += v < 128 ? v : 256 - v; }
      if (sum < bestSum) { bestSum = sum; best = f; } }
    raw[y * (stride + 1)] = best; cand[best].copy(raw, y * (stride + 1) + 1); }
  return raw;
}
/** The smallest exact PNG of these pixels (W by H, RGBA bytes). */
export function encodeBest(W, H, rgba) {
  let best = null;
  for (const L of layouts(W, H, rgba)) for (const mode of ['adaptive', 0, 1, 2, 3, 4]) {
    const raw = filtered(L, W, H, mode);
    for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_RLE]) {
      const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9, windowBits: 15, strategy });
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = L.bd; ihdr[9] = L.ct;
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(L.plte ? [chunk('PLTE', L.plte)] : []), ...(L.trns ? [chunk('tRNS', L.trns)] : []), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
      if (!best || png.length < best.length) best = png;
    }
  }
  const back = decode(best);
  if (back.W !== W || back.H !== H || !back.rgba.equals(rgba)) throw new Error('squeeze: the smallest encoding did not decode to the same pixels');
  return best;
}

/** A PNG file as small as it exactly can be: the file itself when nothing is smaller. */
export function squeeze(buf) {
  const { W, H, rgba } = decode(buf);
  const png = encodeBest(W, H, rgba);
  return png.length < buf.length ? png : buf;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const check = process.argv.includes('--check');
  // What the page serves as PNG: the icons and the glass maps (the maps are written by their generators, which
  // already squeeze; this checks them too).
  const served = () => [
    ...readdirSync(path.join(ROOT, 'assets/coin-icons/192')).filter((f) => f.endsWith('.png')).map((f) => path.join(ROOT, 'assets/coin-icons/192', f)),
    ...readdirSync(path.join(ROOT, 'src/web/public/glass')).filter((f) => f.endsWith('.png')).map((f) => path.join(ROOT, 'src/web/public/glass', f)),
  ];
  const files = check ? served() : process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let before = 0, after = 0;
  const loose = [];
  for (const f of files) {
    const b = readFileSync(f);
    const png = squeeze(b);
    before += b.length;
    after += png.length;
    if (png.length < b.length) { if (check) loose.push(`${path.relative(ROOT, f)} ${b.length} -> ${png.length}`); else writeFileSync(f, png); }
  }
  if (check) {
    if (loose.length) { console.log(`could still be smaller (node tools/png/squeeze.mjs <file>):\n  ${loose.join('\n  ')}`); process.exit(1); }
    console.log(`all ${files.length} served PNGs are as small as they exactly can be`);
  } else console.log(`${files.length} files: ${before} -> ${after} bytes (${Math.round((1 - after / Math.max(1, before)) * 100)}% smaller), every pixel checked identical`);
}
