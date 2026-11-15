// printerino.com: one coin price call per minute (feeds.js) plus one stock quote call (stocks.js), served to every
// visitor from memory; price charts (history.js) are fetched when first asked for and cached. Holds no secrets. Runs on
// Railway (`npm start`).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { COINS } from './coins.js';
import { fetchPrices } from './feeds.js';
import { historyCalls, historyResponse, warmHistory } from './history.js';
import { ok, warn } from './log.js';
import { machine } from './machine.js';
import { rerankPartial } from './ranking.js';
import { STOCKS, fetchStocks } from './stocks.js';
import { COMMODITIES, fetchCommodities } from './commodities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.resolve(HERE, '../../assets/coin-icons/192');
const BRAND = path.resolve(HERE, '../../brand'); // the brand pack: tab icons and the logo, served as they are
const PORT = Number(process.env.PORT) || 8080;
const INTERVAL_MS = 60_000;
const STALE_MS = 5 * 60_000;
// How long a card keeps showing the last 24h volume it was given. Only CoinGecko reports one (the backups have none)
// and it moves slowly, so the bound is longer than STALE_MS on purpose: the 429 minute CoinGecko gives about every ten
// minutes must never flip the volume cells to n/a and back.
const VOL_MS = 30 * 60_000;
const YEAR = 'public, max-age=31536000, immutable';

// ---- every file the site can ever serve, loaded into memory once; nothing else on disk is reachable ----
const read = (rel) => readFileSync(path.join(HERE, 'public', rel));
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
// Visitors get the CSS and JS without their comments (the comments stay in the repo). CSS: every /* */ block (no string
// in style.css contains one). JS: whole comment lines only, so app.js keeps every comment on a line of its own.
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n');
const stripJs = (s) => s.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

// The minified copies (tools/min/build.mjs writes them to public/min/ with a manifest of the source each was made
// from): a copy is served only while its source is unchanged since; otherwise the source itself goes out, its comments
// stripped as above, with a warning (a rebuild forgotten costs bytes, never correctness). MIN=0 in the environment
// serves the sources, for comparing the two.
const MIN = (() => {
  if (process.env.MIN === '0') return {};
  try { return JSON.parse(read('min/manifest.json').toString('utf8')); } catch { return {}; }
})();
function shipped(rel, strip) {
  const src = read(rel);
  if (MIN[rel]?.src === hash(src)) return read(`min/${rel}`);
  if (MIN[rel]) console.warn(`[web] ${rel} changed since it was minified: serving it as it is (node tools/min/build.mjs)`);
  return Buffer.from(strip(src.toString('utf8')));
}

// Fingerprinted assets (?v=<hash>) are cached for a year; a changed file gets a new URL on the next deploy. Text ones
// also get brotli and gzip copies (br, gz) once the port is open (packStatic).
const VERSIONED = new Map();
const version = (p, body, type) => VERSIONED.set(p, { body, type, v: hash(body), br: null, gz: null });
version('/app.js', shipped('app.js', stripJs), 'text/javascript; charset=utf-8');
// The theme before the first paint (a blocking script in <head>, kept tiny).
version('/theme-boot.js', shipped('theme-boot.js', stripJs), 'text/javascript; charset=utf-8');
// The glass in motion: an ES module app.js imports once the page has painted (its URL goes out in #assets).
version('/glass.js', shipped('glass.js', stripJs), 'text/javascript; charset=utf-8');
// The share card: an ES module app.js imports once a chart panel has settled (its URL goes out in #assets).
version('/share.js', shipped('share.js', stripJs), 'text/javascript; charset=utf-8');
version('/fonts/InterVariable-page.woff2', read('fonts/InterVariable-page.woff2'), 'font/woff2'); // the page's Inter subset (SIL OFL, fonts/LICENSE-Inter.txt)
version('/og-image.png', read('og-image.png'), 'image/png'); // the brand's link preview with this page's own line under the logo
// The logo for each ground: white type on dark, ink on light.
version('/lockup.svg', readFileSync(path.join(BRAND, 'logo/lockup.svg')), 'image/svg+xml');
version('/lockup-ink.svg', readFileSync(path.join(BRAND, 'logo/lockup-ink.svg')), 'image/svg+xml');
// The liquid glass maps: exactly these files of public/glass/ are served, nothing else in that folder.
const GLASS_FILES = [
  // the coins sealed in glass: lens, normals, environment, reflection bar (every visitor)
  'e-ref.png', 'e-nrm.png', 'e-env.png', 'e-bar.png',
  // the segmented controls' droplet lens and the theme change's drop lens (Chromium only)
  'k-lens.png', 't-lens.png',
  // the top bar's merge: the shape of the switch and the X link flowing into one body, and its rim's light (the
  // stylesheet names them; browsers with scroll timelines)
  'm-mask.png', 'm-rim.png',
  // and how that body bends the page at its rim (Chromium only; glass.js asks for it)
  'm-lens.png',
  // the dock's rim lens, its round button's and its pill's (Chromium only; glass.js asks for them)
  'd-lens.png', 'd-round-lens.png', 'p-lens.png', 'p-apple-lens.png', 'p-apple-split.png',
];
for (const f of GLASS_FILES) version(`/glass/${f}`, read(`glass/${f}`), 'image/png');
// Lossless WebP copies (tools/png/webp.mjs writes them beside the PNGs, the very same pixels, about a fifth smaller):
// where one sits beside a PNG it is served in the PNG's place, every reference to the PNG (in the stylesheet, the page's
// filters and #assets) pointing to it instead. WEBP=0 in the environment serves the PNGs, for comparing the two.
const WEBP = new Map(); // a PNG's path -> its WebP's
if (process.env.WEBP !== '0') for (const f of GLASS_FILES) {
  const w = f.replace(/\.png$/, '.webp');
  if (!existsSync(path.join(HERE, 'public/glass', w))) continue;
  version(`/glass/${w}`, read(`glass/${w}`), 'image/webp');
  WEBP.set(`/glass/${f}`, `/glass/${w}`);
}

// Every reference to a fingerprinted file gets its ?v=<hash>: in an attribute, a url() or an absolute URL, wherever it
// is followed by a quote, a bracket or a space. A reference under /glass/ or /fonts/, to a lockup, to the link preview
// image or to a page script that the whitelist lacks stops the start, so a missing file can never ship.
const REF = /(?<=["'(\s]|\/\/[\w.-]+)\/[\w./-]+(?=["')\s])/g;
const MUST_SERVE = /^\/(glass\/|fonts\/|lockup|og-image\.png$|theme-boot\.js$|glass\.js$|share\.js$)/;
const fingerprint = (text, file) => text.replace(REF, (ref) => {
  const p = WEBP.get(ref) ?? ref;
  const e = VERSIONED.get(p);
  if (e) return `${p}?v=${e.v}`;
  if (MUST_SERVE.test(p)) throw new Error(`${file} refers to ${p}, which server.js does not serve: add it to the whitelist`);
  return p;
});
const vurl = (ref) => { const p = WEBP.get(ref) ?? ref; return `${p}?v=${VERSIONED.get(p).v}`; };
// The stylesheet is hashed after its url()s are fingerprinted, since that changes its bytes.
version('/style.css', Buffer.from(fingerprint(shipped('style.css', stripCss).toString('utf8'), 'style.css')), 'text/css; charset=utf-8');
for (const [p, e] of VERSIONED) {
  if (/css|javascript/.test(e.type) && /\/\*|(^|[^:])\/\/\s/m.test(e.body.toString())) console.warn(`[web] a comment survived stripping in ${p}: keep JS comments on lines of their own`);
}
// The URLs the page's scripts load at runtime (glass.js and share.js, and the lens maps glass.js fetches on demand),
// handed over in the page's #assets JSON.
// The coin maps need no entry: the page names them.
const ASSETS = {
  glass: vurl('/glass.js'),
  share: vurl('/share.js'),
  kLens: vurl('/glass/k-lens.png'),
  tLens: vurl('/glass/t-lens.png'),
  mLens: vurl('/glass/m-lens.png'),
  dLens: vurl('/glass/d-lens.png'),
  dRound: vurl('/glass/d-round-lens.png'),
  pLens: vurl('/glass/p-lens.png'),
  pApple: vurl('/glass/p-apple-lens.png'),
  pAppleSplit: vurl('/glass/p-apple-split.png'),
};
// Each icon carries its own fingerprint in its address (iconUrl), as the scripts and the glass maps do, so a browser
// keeps it for a year and asks again only when the icon itself changes (kept a day with no way to revalidate, every
// visitor would fetch all of them again each day). The plain address still answers, kept a day.
const ICON_FILES = new Map();
for (const c of [...COINS, ...STOCKS, ...COMMODITIES]) {
  const sym = c.symbol.toLowerCase();
  const body = readFileSync(path.join(ICONS, `${sym}.png`));
  ICON_FILES.set(`/icons/${sym}.png`, { body, v: hash(body), type: 'image/png' });
  // Its lossless WebP copy, the address the page is given when there is one (the PNG's still answers).
  const webp = path.join(ICONS, `${sym}.webp`);
  if (process.env.WEBP !== '0' && existsSync(webp)) { const w = readFileSync(webp); ICON_FILES.set(`/icons/${sym}.webp`, { body: w, v: hash(w), type: 'image/webp' }); }
}
const iconUrl = (sym) => {
  const s = sym.toLowerCase();
  const p = ICON_FILES.has(`/icons/${s}.webp`) ? `/icons/${s}.webp` : `/icons/${s}.png`;
  const f = ICON_FILES.get(p);
  return f ? `${p}?v=${f.v}` : p;
};
const BRAND_FILES = new Map([
  ['/favicon.svg', { body: readFileSync(path.join(BRAND, 'web/favicon.svg')), type: 'image/svg+xml' }],
  ['/favicon.ico', { body: readFileSync(path.join(BRAND, 'web/favicon.ico')), type: 'image/x-icon' }],
  ['/apple-touch-icon.png', { body: readFileSync(path.join(BRAND, 'web/apple-touch-icon.png')), type: 'image/png' }],
]);

const [HEAD, TAIL] = fingerprint(read('index.html').toString('utf8'), 'index.html')
  // A function, so nothing in the JSON is read as a "$" replacement pattern; a page without the marker is left as it is.
  .replace('<!--ASSETS-->', () => JSON.stringify(ASSETS).replace(/</g, '\\u003c'))
  // The status line's first-paint counts (also what a visitor without JavaScript sees) always match the lists.
  .replace(/id="count">\d+</, `id="count">${COINS.length}<`)
  .replace(/id="scount">\d+</, `id="scount">${STOCKS.length}<`)
  .replace(/id="ccount">\d+</, `id="ccount">${COMMODITIES.length}<`)
  .split('<!--DATA-->');
if (TAIL === undefined) throw new Error('index.html is missing the <!--DATA--> marker');

// ---- compression: text goes out as brotli or gzip when the browser takes it ----
const TEXT = /^(text\/|application\/json|image\/svg\+xml)/;
const Z = zlib.constants;
const brotliOpts = (quality, size) => ({ params: { [Z.BROTLI_PARAM_QUALITY]: quality, [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT, [Z.BROTLI_PARAM_SIZE_HINT]: size } });
const brotli = (buf, quality) => zlib.brotliCompressSync(buf, brotliOpts(quality, buf.length));
const gzip = (buf, level) => zlib.gzipSync(buf, { level });
const brotliLater = promisify(zlib.brotliCompress);
const gzipLater = promisify(zlib.gzip);
// A body rebuilt about twice a minute (the page, the prices): both copies at quick settings, under a millisecond each.
const packNow = (body) => ({ body, br: brotli(body, 5), gz: gzip(body, 6) });
// The fixed text files at the best settings (brotli 11, gzip 9), on the thread pool once the port is open, so a deploy
// never waits for them; until a file's copies are ready it goes out uncompressed.
async function packStatic() {
  for (const e of VERSIONED.values()) {
    if (!TEXT.test(e.type)) continue;
    const [br, gz] = await Promise.all([brotliLater(e.body, brotliOpts(11, e.body.length)), gzipLater(e.body, { level: 9 })]);
    Object.assign(e, { br, gz });
  }
}
// A chart's body is the same for every visitor until its cache entry refreshes (history.js), so its copies are made
// once per body, not once per request: compressing on every request made a chart the cheapest way to load the server
// (about five times the CPU of the same answer uncompressed). One entry per chart (history.js names it: a symbol and a
// candle size), and only for those that answered 200, which history.js gives only for its own whitelist: at most 30 x 4.
// A body built per request (a stale copy) differs from the one kept and is packed again.
const chartPacks = new Map();
function chartPack(key, body) {
  if (body.length <= 1024) return undefined;
  let c = chartPacks.get(key);
  if (c?.src !== body) chartPacks.set(key, (c = { src: body, packed: packNow(Buffer.from(body)) }));
  return c.packed;
}
// The encoding a request takes: brotli, then gzip, when its accept-encoding lists it with a q above 0.
function encodingOf(req) {
  const q = new Map();
  for (const part of String(req.headers['accept-encoding'] ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const w = params.find((s) => s.startsWith('q='));
    q.set(name, w ? Number(w.slice(2)) : 1);
  }
  return q.get('br') > 0 ? 'br' : q.get('gzip') > 0 ? 'gzip' : null;
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};
// A PNG or ICO opened on its own: the browser's image viewer styles the page it builds, which the page CSP would block
// (console errors, an off-centre image). Raster images can carry no script; SVGs keep the strict CSP.
const IMG_CSP = { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" };

// ---- prices, refreshed in the background ----
const latest = new Map(); // coin symbol -> { price, change24h, mcap, supply, vol24h, volAt, source, at }
let order = COINS.map((c) => c.symbol);
// The stocks are ranked in their own market-cap order, never against the coins.
const latestStocks = new Map(); // stock symbol -> { price, change24h, mcap, supply, vol24h, volAt, source, at }
let stockOrder = STOCKS.map((s) => s.symbol);
// The commodities likewise: gold and silver by their market caps, the four without one after them in the list's order.
const latestCommodities = new Map();
let commodityOrder = COMMODITIES.map((c) => c.symbol);
// When the coins' latest round was fetched (updatedAt, which the status line judges "live" by: the coins alone), 0
// until one has landed.
let lastFetchAt = 0;
let missingMcapNote = '';
let snapshot = null; // the /api/prices body and its compressed copies: { body, br, gz }
let page = null; // the page with the snapshot inlined, likewise

// Each side (the coins, the stocks, the commodities) is a machine of its own, in one of four states:
//   cold:     no round has started (the moment between the port opening and the first refresh).
//   first:    the first round is out: until it ends, a stock or a commodity without a quote is pending, not stale, and
//             for the coins /healthz says starting.
//   idle:     at least one round has ended, well or not, and none is out.
//   fetching: a later round is out. One round at a time: an ask meanwhile (the coins' cap retry, retryMissingCaps)
//             joins it instead of asking every source a second time.
const SIDE_MOVES = {
  cold: ['first'],
  first: ['idle'],
  idle: ['fetching'],
  fetching: ['idle'],
};
// round(current) is the side's fetch and merge, which never throws; current() says whether the run it started in is
// still the side's own (the epoch it began at), so a round that was overtaken lands nothing.
function side(round) {
  const m = machine('cold', SIDE_MOVES);
  let flight = null; // the round out, while the side is first or fetching
  return {
    m,
    out: () => m.is('first', 'fetching'),
    tried: () => m.is('idle', 'fetching'),
    refresh() {
      if (m.is('first', 'fetching')) return flight;
      m.go(m.is('cold') ? 'first' : 'fetching');
      const epoch = m.epoch;
      flight = round(() => m.epoch === epoch).finally(() => { flight = null; m.go('idle'); });
      return flight;
    },
  };
}

// The card price a chart is checked against (a source more than 5% away is the wrong market) and a stock chart's last
// point is pinned to, while it is fresh.
const livePrice = (sym) => {
  const q = latest.get(sym) ?? latestStocks.get(sym) ?? latestCommodities.get(sym);
  return q && Date.now() - q.at <= STALE_MS ? q.price : null;
};

function rebuild() {
  const now = Date.now();
  const card = (list, quotes, extra, tried = true) => (sym, i) => {
    const c = list.find((x) => x.symbol === sym);
    const q = quotes.get(sym);
    return {
      rank: i + 1, symbol: sym, name: c.name, ...extra(c), icon: iconUrl(sym),
      price: q?.price ?? null, change24h: q?.change24h ?? null, mcap: q?.mcap ?? null,
      // A carried volume goes out only while it is recent; older than VOL_MS it reads n/a on the card.
      vol24h: q && now - q.volAt <= VOL_MS ? q.vol24h : null,
      stale: q ? now - q.at > STALE_MS : tried,
    };
  };
  const coins = order.map(card(COINS, latest, () => ({})));
  const stocks = stockOrder.map(card(STOCKS, latestStocks, (s) => ({ exchange: s.exchange }), stockSide.tried()));
  // A commodity card names its unit (what one price buys); kind tells the page it is neither a coin nor a stock.
  const commodities = commodityOrder.map(card(COMMODITIES, latestCommodities, (c) => ({ kind: 'commodity', unit: c.unit }), commoditySide.tried()));
  const json = JSON.stringify({ updatedAt: lastFetchAt, intervalSec: INTERVAL_MS / 1000, coins, stocks, commodities });
  snapshot = packNow(Buffer.from(json));
  // Concatenation, not String.replace: replace() would expand "$'"-style patterns inside the data.
  page = packNow(Buffer.from(HEAD + json.replace(/</g, '\\u003c') + TAIL));
}

// Fetch time, not quote time, decides staleness: a stock's weekend close, fetched fine, is not stale.
function merge(quotes, fresh, now) {
  for (const [sym, q] of fresh) {
    const prev = quotes.get(sym);
    // The supply implied by the last price that came with a market cap (CoinGecko). When a backup feed has only a
    // price, the market cap follows that price at the same supply, so caps and ranks stay live while CoinGecko is out.
    const supply = q.mcap && q.price ? q.mcap / q.price : prev?.supply ?? null;
    const mcap = q.mcap ?? (supply ? q.price * supply : prev?.mcap ?? null);
    // The last reported 24h volume is carried the same way, with the time it was fetched (volAt), so rebuild() can
    // stop showing it once it is old.
    const volAt = q.vol24h != null ? now : prev?.volAt ?? 0;
    quotes.set(sym, { ...q, mcap, supply, vol24h: q.vol24h ?? prev?.vol24h ?? null, volAt, at: now });
  }
  return new Map([...quotes].map(([s, q]) => [s, q.mcap]));
}

// A side with no source left at all ('coins', 'stocks') is logged like a single feed: at onset, hourly, on recovery.
const stockSide = side(async (current) => {
  try {
    const fresh = await fetchStocks(STOCKS);
    if (!current()) return;
    stockOrder = rerankPartial(stockOrder, merge(latestStocks, fresh, Date.now()));
    ok('stocks');
  } catch (e) {
    warn('stocks', e.message);
  }
});

const commoditySide = side(async (current) => {
  try {
    const fresh = await fetchCommodities(COMMODITIES);
    if (!current()) return;
    commodityOrder = rerankPartial(commodityOrder, merge(latestCommodities, fresh, Date.now()));
    ok('commodities');
  } catch (e) {
    warn('commodities', e.message);
  }
});

// A coin round that started before the one already published (the clock stepped back) is dropped, so prices and
// updatedAt never move backwards.
const coinSide = side(async (current) => {
  try {
    const now = Date.now();
    const fresh = await fetchPrices(COINS);
    ok('coins');
    if (!current() || now < lastFetchAt) return;
    const mcaps = merge(latest, fresh, now);
    lastFetchAt = now;
    order = rerankPartial(order, mcaps);
    const missing = COINS.map((c) => c.symbol).filter((s) => !(mcaps.get(s) > 0)).join(', ');
    if (missing !== missingMcapNote) { if (missing) console.warn(`[web] no market cap for: ${missing} (ranked last)`); missingMcapNote = missing; }
  } catch (e) {
    warn('coins', e.message);
  }
});

// Coins, stocks and commodities are fetched side by side and each side is published the moment it lands, so a slow or failing
// feed on one side never holds up the other.
async function refresh() {
  await Promise.allSettled([
    coinSide.refresh().finally(rebuild),
    stockSide.refresh().finally(rebuild),
    commoditySide.refresh().finally(rebuild),
  ]);
  retryMissingCaps();
}

// Right after a restart CoinGecko may refuse the first calls, leaving coins without a market cap (and so unranked)
// until it answers once. For the first 5 minutes, while any cap is missing, the coins are asked again after 15 s, then
// 30 s, 60 s and so on (about four extra rounds, not twenty: the endpoint is rate-limiting already), never while a
// round is in flight, and never past the window. The retry is a machine of its own:
//   idle:     no retry waits; the end of the next round may arm one.
//   armed:    a timer waits capRetryMs (doubled at every arming) to ask the coins again.
//   retrying: its round is out (or it joined the minute's round); that round's end republishes and asks again.
//   over:     the window is past: no retry ever again.
const STARTED_AT = Date.now();
const RETRY_MOVES = {
  idle: ['armed', 'over'],
  armed: ['retrying'],
  retrying: ['idle'],
  over: [],
};
const capRetry = machine('idle', RETRY_MOVES);
let capRetryMs = 15_000;
capRetry.on((to) => {
  if (to !== 'armed') return;
  // The timer belongs to this arming: it fires only into the state it was armed in.
  const epoch = capRetry.epoch;
  setTimeout(() => {
    if (capRetry.epoch !== epoch || !capRetry.go('retrying')) return;
    coinSide.refresh().finally(() => { rebuild(); capRetry.go('idle'); retryMissingCaps(); });
  }, capRetryMs).unref();
  capRetryMs *= 2;
});
function retryMissingCaps() {
  if (!capRetry.is('idle') || coinSide.out()) return;
  if (Date.now() - STARTED_AT + capRetryMs > 5 * 60_000) { capRetry.go('over'); return; }
  if (COINS.every((c) => latest.get(c.symbol)?.mcap > 0)) return;
  capRetry.go('armed');
}

// Where the prices on the cards come from, for the hourly line: 'coingecko 24, hyperliquid 2, cnbc 4'.
function sourceTally() {
  const n = new Map();
  for (const q of [...latest.values(), ...latestStocks.values(), ...latestCommodities.values()]) n.set(q.source, (n.get(q.source) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(', ') || 'none';
}

let requests = 0;
const server = http.createServer({ connectionsCheckingInterval: 2_000, headersTimeout: 10_000, requestTimeout: 15_000 }, (req, res) => {
  requests++;
  // Every response leaves here. Text says vary: Accept-Encoding and goes out compressed where the browser takes it:
  // the copies made ahead (packed: the files, the page, the prices, each chart body), or for any other body over 1 KB
  // one made now, at the same quick settings as the page (brotli 4 came out larger than gzip on chart data).
  // content-length is the size of what is sent, so a HEAD reports it too.
  const send = (status, headers, body, packed) => {
    let out = typeof body === 'string' ? Buffer.from(body) : body;
    const more = {};
    if (TEXT.test(headers['content-type'] ?? '')) {
      more.vary = 'Accept-Encoding';
      const enc = encodingOf(req);
      let zipped = null;
      if (enc && packed) zipped = enc === 'br' ? packed.br : packed.gz;
      else if (enc && out.length > 1024) zipped = enc === 'br' ? brotli(out, 5) : gzip(out, 6);
      if (zipped) { out = zipped; more['content-encoding'] = enc; }
    }
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers, ...more, 'content-length': out.length });
    res.end(req.method === 'HEAD' ? undefined : out);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }, 'Method not allowed');
  let url;
  // "//anything" and its backslash spelling "/\anything" would both parse as a host and reach a real route; neither
  // is a path this site has.
  if (/^\/[\/\\]/.test(req.url ?? '')) return send(404, { 'content-type': 'text/plain' }, 'Not found');
  try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return send(400, { 'content-type': 'text/plain' }, 'Bad request'); }
  const p = url.pathname;

  if (p === '/' || p === '/index.html') return send(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, page.body, page);
  // Until the first fetch lands the snapshot has no prices, so it must not be cached anywhere.
  if (p === '/api/prices') return send(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': lastFetchAt ? 'public, max-age=20' : 'no-store' }, snapshot.body, snapshot);
  if (p === '/api/history') {
    historyResponse(url.searchParams, livePrice).then(
      ({ status, headers, body, key }) => send(status, headers, body, status === 200 ? chartPack(key, body) : undefined),
      () => send(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, '{"error":"unavailable"}'),
    );
    return;
  }
  // Ready once the coins' first round has ended, well or not.
  if (p === '/healthz') return send(coinSide.tried() ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, coinSide.tried() ? 'ok' : 'starting');
  const v = VERSIONED.get(p);
  if (v) {
    // Only the exact current fingerprint may be cached for a year; anything else is served uncached.
    const fresh = url.searchParams.get('v') === v.v;
    return send(200, { 'content-type': v.type, 'cache-control': fresh ? YEAR : 'no-store', ...(/^image\/(png|webp)$/.test(v.type) ? IMG_CSP : {}) }, v.body, v);
  }
  const brandFile = BRAND_FILES.get(p);
  if (brandFile) return send(200, { 'content-type': brandFile.type, 'cache-control': 'public, max-age=86400', ...(brandFile.type === 'image/svg+xml' ? {} : IMG_CSP) }, brandFile.body);
  const icon = ICON_FILES.get(p);
  if (icon) return send(200, { 'content-type': icon.type, 'cache-control': url.searchParams.get('v') === icon.v ? YEAR : 'public, max-age=86400', ...IMG_CSP }, icon.body);
  return send(404, { 'content-type': 'text/plain' }, 'Not found');
});

// Open the port first (with the coin list and no prices yet), then fetch, so a deploy never refuses visitors.
rebuild();
server.listen(PORT, () => {
  console.log(`[web] price page on :${PORT}; ${COINS.length} coins; node ${process.version}`);
  packStatic().catch((e) => console.error(`[web] compressing the static files failed, they go out uncompressed: ${e.message}`));
});
// Once the first prices are in, every card's 1H chart (the panel's default) is warmed in the background, one at a time.
refresh().then(() => warmHistory(livePrice));
setInterval(refresh, INTERVAL_MS).unref();
setInterval(() => { console.log(`[web] ${requests} requests in the last hour (${historyCalls()} chart source calls); prices from ${new Date(lastFetchAt).toISOString()} (${sourceTally()})`); requests = 0; }, 3_600_000).unref();

process.on('unhandledRejection', (e) => console.error('[web] unhandledRejection:', e));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    console.log(`[web] ${sig} received, closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
