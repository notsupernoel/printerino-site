// The minified copies of the page's scripts and stylesheet: esbuild (tools/package.json, never installed on the
// server) shortens every local name and drops every space and comment it can, with no lowering (target esnext: the
// code that runs is the code that was written, only shorter).
// Each copy goes to src/web/public/min/ with min/manifest.json, which records the hash of the source it was made from.
// server.js serves a copy only while its source still has that hash; a source edited since falls back to itself
// (comments stripped) with a warning, so a forgotten rebuild costs bytes, never correctness.
//   app.js and theme-boot.js are classic scripts: their top-level names are globals and are kept as they are.
//   glass.js and share.js are ES modules: their top-level names are private to them and are shortened too; their
//   exports keep their names.
// Usage: cd tools && npm install (once), then from the repo root:
//        node tools/min/build.mjs            writes the copies and the manifest
//        node tools/min/build.mjs --check    exits 1 unless every copy is current
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from '../node_modules/esbuild/lib/main.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUB = path.join(ROOT, 'src/web/public');
const OUT = path.join(PUB, 'min');
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const FILES = [
  ['app.js', { loader: 'js' }],
  ['theme-boot.js', { loader: 'js' }],
  ['glass.js', { loader: 'js', format: 'esm' }],
  ['share.js', { loader: 'js', format: 'esm' }],
  // The stylesheet loses its spaces and comments only: rewriting its values (0.16 to .16, 400ms to .4s) would change
  // custom properties that the scripts read as numbers, and merging rules would change which one wins.
  ['style.css', { loader: 'css', minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false }],
];
const check = process.argv.includes('--check');
const manifest = {};
const stale = [];
for (const [file, opts] of FILES) {
  const src = readFileSync(path.join(PUB, file));
  const { code } = await transform(src.toString('utf8'), { ...(opts.minifyWhitespace ? {} : { minify: true }), ...opts, target: 'esnext', legalComments: 'none', charset: 'utf8' });
  manifest[file] = { src: hash(src), out: hash(Buffer.from(code)), bytes: [src.length, Buffer.byteLength(code)] };
  const dest = path.join(OUT, file);
  if (check) { if (!existsSync(dest) || readFileSync(dest, 'utf8') !== code) stale.push(file); continue; }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(dest, code);
}
if (check) {
  const on = existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : {};
  for (const f of Object.keys(manifest)) if (on[f]?.src !== manifest[f].src && !stale.includes(f)) stale.push(f);
  if (stale.length) { console.log(`out of date (node tools/min/build.mjs): ${stale.join(', ')}`); process.exit(1); }
  console.log(`all ${FILES.length} minified copies are current`);
} else {
  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [f, m] of Object.entries(manifest)) console.log(`${f.padEnd(14)} ${m.bytes[0]} -> ${m.bytes[1]} bytes`);
}
