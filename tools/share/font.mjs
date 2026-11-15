// The page's Inter subset (src/web/public/fonts/InterVariable-page.woff2), made ready for the share card's canvas.
// The page sets its type with the character variants cv01, cv03, cv04 and cv09 (the flagged 1, the flat-topped 3, the
// open 6 and 9), tabular figures where figures line up, and font-optical-sizing: none (the text cut at every size). A
// canvas takes none of that: it has no font-feature-settings, and it picks the optical size from the font size (a 44px
// price would come out in the tighter display cut). So the font itself carries them, two small changes that change
// nothing the page draws:
//   1. The optical size axis is pinned at its default, 14 (Inter's range is 14 to 32): the page asks for 14 anyway, and a
//      canvas asking for more now gets 14 too.
//   2. Private-use code points name the glyphs the page's features pick, so the canvas can ask for them by character:
//        U+E000 + d   the digit d with the page's character variants (proportional, as in "24h" or a date)
//        U+E00A, B    + and the minus sign in their raised (case) form, which Inter's contextual alternates pick
//                     between a capital and a figure ("GMT+9"): Chrome's canvas shapes a private code point (the 9)
//                     in a run of its own, so the alternate never sees the figure after the sign, and the card asks
//                     for the raised sign itself
//        U+E010 + i   the i-th of 0-9 , . : + − - with tabular figures and the variants (as in a price)
//      The page's own text never holds these code points.
// The glyphs are found in the font's own GSUB (the cvNN and tnum features' single substitutions, applied in lookup
// order, as a shaper would), not written down by number.
// Usage: node tools/share/font.mjs            patches the served font in place (idempotent; then restart the server)
//        node tools/share/font.mjs --check    exits 1 unless the served font is already patched; changes nothing
// Zero dependencies (node:zlib has brotli). Only cmap and fvar change; every other table, glyf and loca in their
// WOFF2-transformed form included, is copied byte for byte.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../../src/web/public/fonts/InterVariable-page.woff2');
const CV = ['cv01', 'cv03', 'cv04', 'cv09'];
// Each block: its first code point, the characters it names in order, and the features that pick their glyphs.
const BLOCKS = [
  { at: 0xe000, chars: '0123456789', features: CV },
  { at: 0xe00a, chars: '+−', features: ['case'] },
  { at: 0xe010, chars: '0123456789,.:+−-', features: ['tnum', ...CV] },
];

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.log('Usage: node tools/share/font.mjs            patches the served font in place');
  console.log('       node tools/share/font.mjs --check    checks that the served font is patched, changes nothing');
  process.exit(1);
}
const check = args[0] === '--check';

// ---- WOFF2 in ----
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
function readWoff2(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  if (buf.readUInt32BE(28) || buf.readUInt32BE(40)) throw new Error('metadata or private blocks are not handled');
  const numTables = buf.readUInt16BE(12);
  let o = 48;
  const b128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[o++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v >>> 0;
    }
    throw new Error('bad UIntBase128');
  };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[o++];
    let tag;
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString('latin1', o, o + 4); o += 4; } else tag = KNOWN[flags & 0x3f];
    const xf = flags >> 6;
    const origLength = b128();
    const transformed = tag === 'glyf' || tag === 'loca' ? xf === 0 : xf !== 0;
    const length = transformed ? b128() : origLength;
    tables.push({ tag, flags, origLength, transformed, length });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(o, o + buf.readUInt32BE(20)));
  let at = 0;
  for (const t of tables) { t.data = data.subarray(at, at + t.length); at += t.length; }
  if (at !== data.length) throw new Error('table lengths do not add up');
  return { flavor: buf.readUInt32BE(4), major: buf.readUInt16BE(24), minor: buf.readUInt16BE(26), tables };
}

// ---- WOFF2 out: the same directory and flags, each table's new bytes, one brotli stream ----
function writeWoff2(font) {
  const b128 = (v) => {
    const out = [];
    do { out.unshift(v & 0x7f); v >>>= 7; } while (v);
    return out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b));
  };
  const dir = [];
  for (const t of font.tables) {
    dir.push(t.flags);
    if ((t.flags & 0x3f) === 0x3f) dir.push(...Buffer.from(t.tag, 'latin1'));
    dir.push(...b128(t.transformed ? t.origLength : t.data.length));
    if (t.transformed) dir.push(...b128(t.data.length));
  }
  const stream = Buffer.concat(font.tables.map((t) => t.data));
  const packed = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 22, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stream.length } });
  const sfnt = 12 + 16 * font.tables.length + font.tables.reduce((s, t) => s + ((t.transformed ? t.origLength : t.data.length) + 3 & ~3), 0);
  const head = Buffer.alloc(48);
  head.write('wOF2', 0, 'latin1');
  head.writeUInt32BE(font.flavor, 4);
  const length = (48 + dir.length + packed.length + 3) & ~3;
  head.writeUInt32BE(length, 8);
  head.writeUInt16BE(font.tables.length, 12);
  head.writeUInt32BE(sfnt, 16);
  head.writeUInt32BE(packed.length, 20);
  head.writeUInt16BE(font.major, 24);
  head.writeUInt16BE(font.minor, 26);
  const out = Buffer.alloc(length);
  head.copy(out, 0);
  Buffer.from(dir).copy(out, 48);
  packed.copy(out, 48 + dir.length);
  return out;
}

// ---- cmap: every code point and its glyph (formats 4 and 12) ----
function readCmap(t) {
  const map = new Map();
  for (let i = 0, n = t.readUInt16BE(2); i < n; i++) {
    const at = t.readUInt32BE(8 + i * 8);
    const format = t.readUInt16BE(at);
    if (format === 4) {
      const segs = t.readUInt16BE(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = t.readUInt16BE(ends + s * 2);
        const start = t.readUInt16BE(starts + s * 2);
        const delta = t.readUInt16BE(deltas + s * 2);
        const ro = t.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g = 0;
          if (!ro) g = (c + delta) & 0xffff;
          else {
            const raw = t.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2);
            g = raw ? (raw + delta) & 0xffff : 0;
          }
          if (g && !map.has(c)) map.set(c, g);
        }
      }
    } else if (format === 12) {
      for (let k = 0, n12 = t.readUInt32BE(at + 12); k < n12; k++) {
        const p = at + 16 + k * 12;
        const s = t.readUInt32BE(p);
        const e = t.readUInt32BE(p + 4);
        const g = t.readUInt32BE(p + 8);
        for (let c = s; c <= e; c++) if (!map.has(c)) map.set(c, g + c - s);
      }
    }
  }
  return map;
}
// A cmap with one format 4 subtable (the font is all in the Basic Multilingual Plane), shared by Unicode BMP (0, 3) and
// Windows Unicode BMP (3, 1), as the font had it. A run of code points whose glyphs run on too is one segment with a
// delta; any other run lists its glyphs.
function buildCmap(map) {
  const cps = [...map.keys()].sort((a, b) => a - b);
  if (cps.some((c) => c > 0xfffe)) throw new Error('a code point outside the BMP needs format 12');
  const runs = [];
  for (const c of cps) {
    const last = runs[runs.length - 1];
    if (last && c === last.end + 1) { last.end = c; last.glyphs.push(map.get(c)); } else runs.push({ start: c, end: c, glyphs: [map.get(c)] });
  }
  const segs = runs.map((r) => {
    const delta = (r.glyphs[0] - r.start) & 0xffff;
    const flat = r.glyphs.every((g, i) => ((g - (r.start + i)) & 0xffff) === delta);
    return { ...r, delta: flat ? delta : 0, list: flat ? null : r.glyphs };
  });
  segs.push({ start: 0xffff, end: 0xffff, delta: 1, list: null });
  const n = segs.length;
  const arrays = segs.filter((s) => s.list).reduce((k, s) => k + s.list.length, 0);
  const len = 16 + n * 8 + arrays * 2;
  const sub = Buffer.alloc(len);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(len, 2);
  sub.writeUInt16BE(0, 4);
  sub.writeUInt16BE(n * 2, 6);
  sub.writeUInt16BE(pow * 2, 8);
  sub.writeUInt16BE(log, 10);
  sub.writeUInt16BE(n * 2 - pow * 2, 12);
  const ends = 14;
  const starts = ends + n * 2 + 2;
  const deltas = starts + n * 2;
  const ranges = deltas + n * 2;
  let glyphAt = ranges + n * 2;
  segs.forEach((s, i) => {
    sub.writeUInt16BE(s.end, ends + i * 2);
    sub.writeUInt16BE(s.start, starts + i * 2);
    sub.writeUInt16BE(s.delta, deltas + i * 2);
    if (s.list) {
      sub.writeUInt16BE(glyphAt - (ranges + i * 2), ranges + i * 2);
      for (const g of s.list) { sub.writeUInt16BE(g, glyphAt); glyphAt += 2; }
    } else sub.writeUInt16BE(0, ranges + i * 2);
  });
  const head = Buffer.alloc(4 + 2 * 8);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(2, 2);
  for (const [i, [pid, eid]] of [[0, 3], [3, 1]].entries()) {
    head.writeUInt16BE(pid, 4 + i * 8);
    head.writeUInt16BE(eid, 6 + i * 8);
    head.writeUInt32BE(head.length, 8 + i * 8);
  }
  return Buffer.concat([head, sub]);
}

// ---- GSUB: the single substitutions of the features asked for, in lookup order ----
function substitutions(t, features) {
  const featureList = t.readUInt16BE(6);
  const lookupList = t.readUInt16BE(8);
  const want = new Set();
  for (let i = 0, n = t.readUInt16BE(featureList); i < n; i++) {
    const rec = featureList + 2 + i * 6;
    if (!features.includes(t.toString('latin1', rec, rec + 4))) continue;
    const f = featureList + t.readUInt16BE(rec + 4);
    for (let k = 0, m = t.readUInt16BE(f + 2); k < m; k++) want.add(t.readUInt16BE(f + 4 + k * 2));
  }
  const coverage = (p) => {
    const out = [];
    if (t.readUInt16BE(p) === 1) for (let i = 0, n = t.readUInt16BE(p + 2); i < n; i++) out.push(t.readUInt16BE(p + 4 + i * 2));
    else {
      for (let i = 0, n = t.readUInt16BE(p + 2); i < n; i++) {
        const r = p + 4 + i * 6;
        for (let g = t.readUInt16BE(r); g <= t.readUInt16BE(r + 2); g++) out.push(g);
      }
    }
    return out;
  };
  const steps = [];
  for (const li of [...want].sort((a, b) => a - b)) {
    const lo = lookupList + t.readUInt16BE(lookupList + 2 + li * 2);
    const type = t.readUInt16BE(lo);
    const step = new Map();
    for (let k = 0, n = t.readUInt16BE(lo + 4); k < n; k++) {
      let at = lo + t.readUInt16BE(lo + 6 + k * 2);
      let ty = type;
      if (ty === 7) { ty = t.readUInt16BE(at + 2); at += t.readUInt32BE(at + 4); }
      if (ty !== 1) throw new Error(`lookup ${li} of ${features.join(', ')} is not a single substitution`);
      const cov = coverage(at + t.readUInt16BE(at + 2));
      if (t.readUInt16BE(at) === 1) {
        const d = t.readInt16BE(at + 4);
        for (const g of cov) if (!step.has(g)) step.set(g, (g + d) & 0xffff);
      } else cov.forEach((g, i) => { if (!step.has(g)) step.set(g, t.readUInt16BE(at + 6 + i * 2)); });
    }
    steps.push(step);
  }
  return (g) => steps.reduce((x, step) => step.get(x) ?? x, g);
}

// ---- the patch ----
const before = readFileSync(FILE);
const font = readWoff2(before);
const table = (tag) => font.tables.find((t) => t.tag === tag);
const cmap = readCmap(table('cmap').data);
for (const c of [...cmap.keys()]) if (c >= 0xe000 && c <= 0xe0ff) cmap.delete(c);
const gsub = table('GSUB').data;
const glyph = (ch) => {
  const g = cmap.get(ch.codePointAt(0));
  if (!g) throw new Error(`the font has no ${ch}`);
  return g;
};
for (const b of BLOCKS) {
  const pick = substitutions(gsub, b.features);
  [...b.chars].forEach((ch, i) => cmap.set(b.at + i, pick(glyph(ch))));
}
table('cmap').data = buildCmap(cmap);
const fvar = Buffer.from(table('fvar').data);
const axes = fvar.readUInt16BE(4);
for (let i = 0, n = fvar.readUInt16BE(8), size = fvar.readUInt16BE(10); i < n; i++) {
  const a = axes + i * size;
  if (fvar.toString('latin1', a, a + 4) === 'opsz') fvar.writeInt32BE(fvar.readInt32BE(a + 8), a + 12);
}
table('fvar').data = fvar;
const after = writeWoff2(font);

// Read back: the new cmap keeps every old mapping and adds the private ones, and nothing else changed.
const again = readWoff2(after);
const back = readCmap(again.tables.find((t) => t.tag === 'cmap').data);
for (const [c, g] of cmap) if (back.get(c) !== g) throw new Error(`U+${c.toString(16)} reads back wrong`);
if (back.size !== cmap.size) throw new Error('the cmap reads back a different size');
for (const t of again.tables) {
  if (t.tag === 'cmap' || t.tag === 'fvar') continue;
  if (!t.data.equals(font.tables.find((x) => x.tag === t.tag).data)) throw new Error(`${t.tag} changed`);
}
for (const b of BLOCKS) console.log(`U+${b.at.toString(16)} ${b.features.join(' ')}: ${[...b.chars].map((ch, i) => `${ch}=${back.get(b.at + i)}`).join(' ')}`);
if (check) {
  const same = after.equals(before);
  console.log(same ? 'the served font is patched' : 'the served font is NOT patched: run node tools/share/font.mjs');
  process.exit(same ? 0 : 1);
}
writeFileSync(FILE, after);
console.log(`wrote ${path.relative(process.cwd(), FILE)}: ${before.length} -> ${after.length} bytes`);
