// Every liquid glass map the site serves (server.js GLASS_FILES, in src/web/public/glass/), made again from its
// generator with the numbers it shipped with:
//   k/gen-lens.mjs          the droplet's magnifier: k-lens
//   t/gen-lens.mjs          the theme change's drop lens: t-lens
//   m/gen-merge.mjs         the top bar's merge, 24 frames: m-mask, m-rim, m-lens; and the merged body holding the
//                           list's switch as a fourth control, one frame: m4-rim, m4-lens
//   d/gen-dock.mjs          the dock's rim lens and its round button's: d-lens, d-round-lens
//   p/gen-pill.mjs          the dock pill's lens (flat middle, bending rim): p-lens; and the same lens on UIKit's
//                           numbers, a bend map and a dispersion map: p-apple-lens, p-apple-split
// Usage: node tools/glass/all.mjs            writes them into src/web/public/glass/ (then restart the server)
//        node tools/glass/all.mjs --check    writes them into a temporary folder and compares every served map with
//                                            its copy byte for byte (exit 1 on any difference); changes nothing
// Zero dependencies. The bytes depend on Node's zlib: a different Node may compress the same pixels differently, which
// --check reports; the pixels themselves do not change.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SHIPPED = path.join(REPO, 'src/web/public/glass');
// Only the two forms above: anything else (a typo, --help) prints the usage and writes nothing, so it can never
// overwrite the served maps by mistake.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.log('Usage: node tools/glass/all.mjs            writes every served map into src/web/public/glass/');
  console.log('       node tools/glass/all.mjs --check    compares every served map with a fresh copy, changes nothing');
  process.exit(1);
}
const check = args[0] === '--check';
const out = check ? mkdtempSync(path.join(tmpdir(), 'printerino-glass-')) : SHIPPED;

const run = (script, args = [], env = {}) => execFileSync(process.execPath, [path.join(HERE, script), ...args], { env: { ...process.env, ...env, OUT: out }, stdio: check ? 'pipe' : 'inherit' });
run('k/gen-lens.mjs', ['2', path.join(out, 'k-lens.png')]);
run('t/gen-lens.mjs', ['512', '0.16', path.join(out, 't-lens.png')]);
run('m/gen-merge.mjs', [out]);
run('d/gen-dock.mjs', [path.join(out, 'd-lens.png')]);
run('p/gen-pill.mjs', [path.join(out, 'p-lens.png')]);

// The served list, read from server.js itself, so a map added there without a generator here shows up as missing.
const server = readFileSync(path.join(REPO, 'src/web/server.js'), 'utf8');
const block = /const GLASS_FILES = \[([\s\S]*?)\];/.exec(server);
const served = block ? [...block[1].matchAll(/'([\w.-]+\.png)'/g)].map((m) => m[1]) : [];
if (!check) {
  console.log(`${served.length} maps written to ${SHIPPED}`);
} else {
  let bad = 0;
  for (const f of served) {
    let same = false;
    let note = '';
    try {
      same = readFileSync(path.join(out, f)).equals(readFileSync(path.join(SHIPPED, f)));
    } catch (e) {
      note = ` (${e.code === 'ENOENT' ? 'no generator writes it' : e.message})`;
    }
    if (!same) bad++;
    console.log(`${same ? 'same' : 'DIFF'}  ${f}${note}`);
  }
  rmSync(out, { recursive: true, force: true });
  console.log(served.length && !bad ? `all ${served.length} served maps regenerate byte for byte` : `${bad} of ${served.length} served maps differ`);
  process.exitCode = served.length && !bad ? 0 : 1;
}
