// Price history for the chart panel: GET /api/history?s=<SYMBOL>&i=<1H|4H|1D|1W>, served from memory: the latest 150
// candles of that size (fewer when the market is younger than that), which serve the line (their closes) and the
// candles alike. Coins come from the venues' public candle APIs, stocks from CNBC's chart bars with Robinhood's public
// historicals as the backup; none needs a key. Every symbol has a chain of sources (the first sensible answer wins).
// Results are normalised here and cached per symbol and candle size, so visitors never reach a venue and no amount of
// traffic calls one more than once per symbol and size per TTL. Sources and their quirks were checked live on 2026-10-06
// and 2026-10-08.
import { AsyncLocalStorage } from 'node:async_hooks';
import { COINS } from './coins.js';
import { STOCKS } from './stocks.js';
import { COMMODITIES } from './commodities.js';
import { machine } from './machine.js';
import { MAX_BODY, TIMEOUT_MS, UA, num, valid } from './net.js';

// The user agent, the 8 s timeout and the 4 MB body cap are the feeds' (net.js); the largest real chart answer (Robinhood,
// five years of dailies for a group of four stocks) is about 1 MB.
const PARALLEL = 4; // upstream calls in flight at once, all venues together
const PER_HOST = 2; // ... and to any one host, so a host that hangs can never hold every slot
const GAP_MS = { 'api.hyperliquid.xyz': 300, 'api.kraken.com': 1000 }; // spacing between calls to one host (else 100)
const REST_MS = 60_000; // a host that fails venue-wide is skipped this long, doubling while it keeps failing...
const REST_MAX = 10 * 60_000; // ... up to 10 minutes (or as long as its Retry-After asks, up to a day)
const DEADLINE_MS = 12_000; // a visitor waits this long for a chart nobody has asked for yet; the build carries on
const STALE_WAIT_MS = 300; // a chart more than twice its TTL old waits this long for its refresh before going out stale
const WARM_MS = 60_000; // the start-up warm-up of every 1H chart is spread over about this long
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const W = 7 * D;
const KEEP_STALE = 24 * H; // while refreshes fail, the last good chart is served this long
const RETRY = MIN; // a failed refresh is retried after this long at the earliest (or the TTL, if shorter)
const WRONG_MARKET = 0.05; // a source whose latest close is further than 5% from the card price is the wrong market

// Candles per chart: the page shows the latest ones that fit its width at chunky slots (about 67 on a wide desktop
// panel, 25 to 40 on a phone); 150 keep more than twice that in hand, for any width.
const CANDLES = 150;
// Per candle size: its length; how long a chart is served before it is refreshed (the newest candle is still forming,
// and the page moves its close with every price update in between, so only its high, low and the next candle wait);
// and how much later than asked a series may start before it counts as starting late (a market younger than the
// window).
const INTERVALS = {
  '1H': { step: H, ttl: MIN, slack: 6 * H },
  '4H': { step: 4 * H, ttl: 2 * MIN, slack: D },
  '1D': { step: D, ttl: 5 * MIN, slack: 3 * D },
  '1W': { step: W, ttl: 30 * MIN, slack: 2 * W },
};

// valid and num (strict number parsing) are the feeds' too (net.js).
const arr = (v) => (Array.isArray(v) ? v : []);
const r6 = (n) => Number(n.toPrecision(6)); // 6 significant figures: still 3 for PUMP at 0.004
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const NAMES = {
  binance: 'Binance', coinbase: 'Coinbase', hyperliquid: 'Hyperliquid', backpack: 'Backpack', kraken: 'Kraken',
  okx: 'OKX', bybit: 'Bybit', mexc: 'MEXC', bigone: 'BigONE', robinhood: 'Robinhood', cnbc: 'CNBC', yahoo: 'Yahoo Finance',
};

// ---- where each coin's candles come from, in fallback order (spot first, perps last; verified 2026-10-06, the weekly
// candles 2026-10-08) ----
// only: the candle sizes a source may serve. from: candles before this UTC day are dropped (a perp's pre-market
// trading). join: an older market renamed 1:1 into this one, put in front when the window reaches back before the
// rename: Binance TONUSDT became GRAMUSDT (last TON candle 2026-06-30, first GRAM candle 2026-07-02); from about May 2029
// not even 150 weeks reach TON and the join costs nothing. A backup with a shorter history than the coin's still serves
// every size, last: its chart says from when.
const src = (venue, market, extra = {}) => ({ venue, market, ...extra });
const usual = (sym) => [src('binance', `${sym}USDT`), src('coinbase', `${sym}-USD`), src('hyperliquid', sym)];
const NOT_1W = ['1H', '4H', '1D'];
const CANDLE_SOURCES = {
  ...Object.fromEntries(['BTC', 'ETH', 'XRP', 'SOL', 'ZEC', 'AVAX', 'SUI', 'UNI', 'NEAR', 'ENA', 'ONDO', 'ZRO', 'TAO', 'PUMP']
    .map((sym) => [sym, usual(sym)])),
  QNT: [src('binance', 'QNTUSDT'), src('coinbase', 'QNT-USD'), src('bybit', 'QNTUSDT')],
  // Hyperliquid's STRK perp traded from 2024-02-14, a week before the token went live on 2024-02-20 (Binance's first
  // day; Coinbase's is the 21st): its pre-market days are cut.
  STRK: [src('binance', 'STRKUSDT'), src('coinbase', 'STRK-USD'), src('hyperliquid', 'STRK', { from: '2024-02-20' })],
  // QTC trades on BigONE alone among the venues here (from 2026-10-05; before that only on NEAR DEXes, which have no
  // candle API): one source, no backup, so a BigONE outage is a "Chart unavailable" while the card's price goes on.
  QTC: [src('bigone', 'QTC-USDT')],
  BNB: [src('binance', 'BNBUSDT'), src('bybit', 'BNBUSDT'), src('hyperliquid', 'BNB'), src('coinbase', 'BNB-USD')],
  JUP: [src('binance', 'JUPUSDT'), src('okx', 'JUP-USDT'), src('bybit', 'JUPUSDT'), src('hyperliquid', 'JUP')],
  // Never Backpack RAY_USDC: three trades a day, flat candles, 1-2% off.
  RAY: [src('binance', 'RAYUSDT'), src('okx', 'RAY-USDT'), src('coinbase', 'RAY-USD')],
  // Binance lists MET from 2025-11-13, three weeks after the token launch: its weeks come after Bybit's and OKX's.
  MET: [
    src('binance', 'METUSDT', { only: NOT_1W }), src('bybit', 'METUSDT'), src('okx', 'MET-USDT'),
    src('binance', 'METUSDT', { only: ['1W'] }), src('hyperliquid', 'MET', { from: '2025-10-23' }),
  ],
  // Bybit's GRAMUSDT keeps TON's history, but with a 5-day gap in June 2026 and a reopening print at 1.1 after a 1.706
  // close inside one week: the Binance join comes first. Coinbase's TON-USD (from 2025-11) reaches back further than
  // OKX's GRAM-USDT (from 2026-06-17) and Hyperliquid's GRAM (from 2026-07-02).
  GRAM: [
    src('binance', 'GRAMUSDT', { join: { market: 'TONUSDT', until: Date.UTC(2026, 6, 2) } }), src('bybit', 'GRAMUSDT'),
    src('coinbase', 'TON-USD'), src('okx', 'GRAM-USDT'), src('hyperliquid', 'GRAM'),
  ],
  // Hyperliquid's own HYPE/USDC spot market is "@107" (never "@20" or "@129", which are other tokens).
  HYPE: [src('hyperliquid', '@107'), src('bybit', 'HYPEUSDT'), src('hyperliquid', 'HYPE'), src('coinbase', 'HYPE-USD')],
  // Kraken keeps only its latest 720 candles and starts its weeks on Thursday: XMR's weeks come from MEXC first.
  XMR: [
    src('kraken', 'XMRUSD', { only: NOT_1W }), src('mexc', 'XMRUSDT'), src('kraken', 'XMRUSD', { only: ['1W'] }),
    src('hyperliquid', 'XMR'),
  ],
  BP: [src('backpack', 'BP_USDC'), src('mexc', 'BPUSDT')],
  LIT: [src('okx', 'LIT-USDT'), src('bybit', 'LITUSDT'), src('hyperliquid', 'LIT', { from: '2026-01-15' })],
  VVV: [src('coinbase', 'VVV-USD'), src('bybit', 'VVVUSDT'), src('hyperliquid', 'VVV')],
  // Hyperliquid's UMON spot market is "@243" (never "@129", another token).
  MON: [src('coinbase', 'MON-USD'), src('bybit', 'MONUSDT'), src('backpack', 'MON_USDC'), src('hyperliquid', '@243')],
};
for (const c of COINS) if (!CANDLE_SOURCES[c.symbol]) throw new Error(`history.js has no chart sources for ${c.symbol}`);
const STOCK_SYMBOLS = new Set(STOCKS.map((s) => s.symbol));
// Robinhood's 5-minute bars are sound, but about one in seven of its 30-minute bars is cut short (a stale close, a
// clipped range), a daily open can be off the official one (checked 2026-10-06 against its own 5-minute bars and CNBC),
// and its hourly bars run on the clock and leave out 09:30 to 10:00 (2026-10-08). CNBC's bars match the official
// numbers, so every size comes from CNBC first and Robinhood is the backup.
const STOCK_CANDLE_SOURCES = [src('cnbc'), src('robinhood')];
// A commodity's candles are its front-month future's, from Yahoo Finance (hours and days; the same contracts as the
// card's price), with Hyperliquid's perp on it as the backup where the card has one (commodities.js). future: the
// market shuts for an hour a day and over the weekend, so its candles are counted, not timed (futureCandles).
const COMMODITY_SOURCES = Object.fromEntries(COMMODITIES.map((c) => [c.symbol, [
  src('yahoo', c.yahoo, { future: true }), ...(c.hl ? [src('hyperliquid', c.hl, { future: true })] : []),
]]));
const SYMBOLS = new Set([...COINS.map((c) => c.symbol), ...STOCK_SYMBOLS, ...COMMODITIES.map((c) => c.symbol)]);
// The listing days of the markets younger than the window of some size (checked 2026-10-06 and 2026-10-08). A chart
// that starts late says "since listing" only when it starts then; a source whose history is shorter than the market's,
// or any other late start, says "from" its first day.
// SNDK, SPCX and SKHY: the listing days Robinhood's instruments give (read 2026-11-14).
const LISTED = Object.fromEntries(Object.entries({ MET: '2025-10-23', MON: '2025-11-24', LIT: '2026-01-15', BP: '2026-03-23', CRCL: '2025-06-05', STRK: '2024-02-20', SNDK: '2025-02-21', SPCX: '2026-06-12', SKHY: '2026-07-10', STRC: '2025-07-25' })
  .map(([sym, date]) => [sym, Date.parse(date)]));

// ---- upstream calls: at most PARALLEL in flight (PER_HOST to one host), spaced per host, with a timeout and a body
// size cap ----
// A venue-wide failure (no answer, timeout, refused, banned, rate-limited, server error) is logged once per venue;
// anything else once per market. After a venue-wide failure the host rests (a circuit breaker): every chain skips it
// straight to its backup for a minute, then two, four... up to ten (or its Retry-After), and when the rest is over one
// call goes through as a probe; an answer ends the rest. So a venue that hangs costs one 8 s timeout per rest, not one
// per chart, and a venue that rate-limits or bans this server's IP is left alone instead of being asked again.
class VenueDown extends Error {}
class Resting extends VenueDown {}
const planned = new Map(); // host -> earliest start of its next call, reserved before waiting for a slot
const started = new Map(); // host -> start of its latest call (a freed slot can release several calls to one host)
const busy = new Map(); // host -> calls in flight
const queue = []; // calls waiting for a slot: { host, go }
let inFlight = 0;
let calls = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits for p, or ms at most (resolving undefined then), whichever comes first.
function within(p, ms) {
  let timer;
  return Promise.race([p, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}
// The start-up warm-up's calls run in this context ({ urgent }), so the limiter can put them after every visitor's.
const background = new AsyncLocalStorage();

// Each host's breaker is a machine of its own, in one of three states:
//   up:      calls go through.
//   resting: every call is skipped (Resting) until `until`; the first call to go ahead after that is the probe.
//   probing: the rest is over and the probe is out; every other call is still skipped.
// An answer from any call ends a rest. A venue-wide failure counts only against the breaker run it went ahead in (the
// epoch when it passed the last check): from up it starts a rest of a minute, the probe's doubles the rest (up to
// REST_MAX). One from an older run (a call already under way when the rest began, or when the probe went out) counts
// no more: it only lengthens a rest in progress to its Retry-After, and never doubles a rest or frees a second probe.
const BREAKER_MOVES = {
  up: ['resting'],
  resting: ['probing', 'up'],
  probing: ['up', 'resting'],
};
const breakers = new Map(); // host -> { m, until, ms, reason, cause }
function breakerOf(host) {
  let b = breakers.get(host);
  if (!b) {
    b = { m: machine('up', BREAKER_MOVES), until: 0, ms: 0, reason: '', cause: null };
    // What follows from a rest, in one place: its length (doubled after a failed probe) and what it says.
    b.m.on((to, from) => {
      if (to !== 'resting') return;
      const { reason, asked } = b.cause;
      b.ms = from === 'probing' ? Math.min(b.ms * 2, REST_MAX) : REST_MS;
      b.until = Date.now() + Math.max(b.ms, asked);
      b.reason = reason;
    });
    breakers.set(host, b);
  }
  return b;
}
// Throws while the host rests. Once the rest is over, the first call to claim it goes through as the probe. Gives the
// breaker run the call goes ahead in (its epoch), which its failure is counted against.
function checkRest(host, claim) {
  const b = breakerOf(host);
  if (b.m.is('up')) return b.m.epoch;
  if (b.m.is('probing') || Date.now() < b.until) throw new Resting(b.reason);
  if (claim) b.m.go('probing');
  return b.m.epoch;
}
// A venue-wide failure of a call that went ahead in breaker run `run`.
function rest(host, run, reason, retryAfter) {
  const b = breakerOf(host);
  const asked = Math.min(Number.isFinite(retryAfter) ? retryAfter : 0, D);
  if (run !== b.m.epoch) {
    if (b.m.is('resting')) b.until = Math.max(b.until, Date.now() + asked);
    return;
  }
  b.cause = { reason, asked };
  b.m.go('resting');
}
// Retry-After in seconds or as an HTTP date, in ms from now (NaN when absent or unreadable).
function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return NaN;
  return /^\d+$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now();
}

// A freed slot goes to the first waiting call whose host is under its own cap, so the caps hold exactly.
function take(host) {
  inFlight++;
  busy.set(host, (busy.get(host) ?? 0) + 1);
}
function release(host) {
  inFlight--;
  const n = busy.get(host) - 1;
  if (n > 0) busy.set(host, n);
  else busy.delete(host);
  for (let i = 0; i < queue.length && inFlight < PARALLEL;) {
    const w = queue[i];
    if ((busy.get(w.host) ?? 0) >= PER_HOST) { i++; continue; }
    queue.splice(i, 1);
    take(w.host);
    w.go();
  }
}

// A warm-up call waits for a quiet moment: no call waiting for a slot, a slot to spare, and its host idle and past its
// spacing. Then it takes its slot at once, so it never holds up a visitor's call. A visitor asking for the very chart
// it is building ends the wait (job.urgent).
async function quiet(host, job) {
  while (!job.urgent && (queue.length || inFlight >= PARALLEL - 1 || busy.has(host) || (planned.get(host) ?? 0) > Date.now())) await sleep(250);
}

async function upstream(url, init = {}) {
  const host = new URL(url).host;
  checkRest(host, false);
  const job = background.getStore();
  if (job) await quiet(host, job);
  const gap = GAP_MS[host] ?? 100;
  const at = Math.max(Date.now(), planned.get(host) ?? 0);
  planned.set(host, at + gap);
  if (at > Date.now()) await sleep(at - Date.now());
  if (inFlight < PARALLEL && (busy.get(host) ?? 0) < PER_HOST) take(host);
  else await new Promise((go) => queue.push({ host, go }));
  let run = -1;
  try {
    // The host may have started resting while this call waited: it then gives up at once.
    run = checkRest(host, true);
    const go = Math.max(Date.now(), (started.get(host) ?? 0) + gap);
    started.set(host, go);
    if (go > Date.now()) await sleep(go - Date.now());
    calls++;
    let res;
    try {
      res = await fetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': UA, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new VenueDown(e?.name === 'TimeoutError' ? `timeout from ${host}` : `no answer from ${host}`);
    }
    if (!res.ok) res.body?.cancel().catch(() => {});
    // 418 is Binance's IP ban, which grows if the calls go on.
    if (res.status === 403 || res.status === 418 || res.status === 429 || res.status >= 500) {
      const e = new VenueDown(`HTTP ${res.status} from ${host}`);
      e.retryAfter = retryAfterMs(res);
      throw e;
    }
    // The venue answered: its rest, if any, is over.
    breakerOf(host).m.go('up');
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
    // The body is counted as it arrives: an oversized answer is cut off at the cap, never buffered whole.
    if (Number(res.headers.get('content-length')) > MAX_BODY) {
      res.body?.cancel().catch(() => {});
      throw new Error(`answer over 4 MB from ${host}`);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > MAX_BODY) break;
        chunks.push(chunk);
      }
    } catch (e) {
      throw new VenueDown(e?.name === 'TimeoutError' ? `timeout from ${host}` : `broken answer from ${host}`);
    }
    if (size > MAX_BODY) throw new Error(`answer over 4 MB from ${host}`);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error(`unreadable answer from ${host}`);
    }
  } catch (e) {
    if (e instanceof VenueDown && !(e instanceof Resting)) rest(host, run, e.message, e.retryAfter);
    throw e;
  } finally {
    release(host);
  }
}

/** Upstream chart calls since the last time this was asked (for the hourly log line). */
export function historyCalls() {
  const n = calls;
  calls = 0;
  return n;
}

// A failing source is logged when it starts failing, every 60th failure while it lasts, and when it answers again
// (the same pattern as the price feeds). Repeats are recognised by the error's fixed message; a changing detail (how
// far off a wrong market is) is printed with it but never makes a repeat look new.
// Each source is a machine of its own: clean (no record) or failing (its record: the message, how many
// failures in a row, since when). A different failure while failing is not a move: its record starts again and its
// line is printed, as a first failure's is. A time on another UTC day than now is printed with its date.
const SOURCE_MOVES = { clean: ['failing'], failing: ['clean'] };
const chartSources = new Map(); // source -> { m, f: { msg, count, since } | null }
const sinceText = (ms) => {
  const at = new Date(ms).toISOString();
  return (at.slice(0, 10) === new Date().toISOString().slice(0, 10) ? '' : `${at.slice(0, 10)} `) + `${at.slice(11, 16)} UTC`;
};
function chartSource(source) {
  let s = chartSources.get(source);
  if (!s) chartSources.set(source, (s = { m: machine('clean', SOURCE_MOVES), f: null }));
  return s;
}
function down(source, e) {
  const msg = e?.message ?? String(e);
  const text = e?.detail ? `${msg} (${e.detail})` : msg;
  const s = chartSource(source);
  if (s.m.is('failing') && s.f.msg === msg) {
    if (++s.f.count % 60 === 0) console.warn(`[web] chart source ${source}: ${text}, ${s.f.count} times in a row since ${sinceText(s.f.since)}`);
    return;
  }
  s.f = { msg, count: 1, since: Date.now() };
  s.m.go('failing');
  console.warn(`[web] chart source ${source}: ${text}`);
}
function up(source) {
  const s = chartSources.get(source);
  if (!s?.m.go('clean')) return;
  console.log(`[web] chart source ${source}: answering again after ${s.f.count} failed attempt(s) since ${sinceText(s.f.since)}`);
  s.f = null;
}

// Stock calls serve several charts at once (one Robinhood call holds a group of four stocks; the same bars serve several
// sizes): each is shared, fetched once at a time, and reused for as long as the asking chart accepts its age.
const memo = new Map(); // key -> { value, at, pending, job }
function shared(key, maxAge, load) {
  let m = memo.get(key);
  if (!m) memo.set(key, (m = {}));
  if (m.at && Date.now() - m.at < maxAge) return Promise.resolve(m.value);
  const job = background.getStore();
  if (!m.pending) {
    m.job = job ?? null;
    m.pending = load().then((value) => Object.assign(m, { value, at: Date.now() }).value).finally(() => { m.pending = null; m.job = null; });
  }
  // A visitor joining a load the warm-up started (its call may be waiting for a quiet moment): the load now goes as a
  // visitor's would, as in chart().
  if (!job && m.job) m.job.urgent = true;
  return m.pending;
}

// ---- coin venues: rows() returns raw rows [t ms, o, h, l, c] (any order, numbers or numeric strings) for interval iv,
// from start (the first wanted candle) to now, n candles at most; normalise() validates, sorts and trims them. iv maps
// this file's interval names to each venue's own; an interval a venue lacks is built from a finer one. reach: the most
// candles rows() can return (none: as many as asked) ----
const VENUES = {
  binance: {
    iv: { '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' },
    reach: 1000,
    rows: async (m, iv, start, n) => arr(await upstream(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(m)}&interval=${iv}&startTime=${start}&limit=${Math.min(n, 1000)}`)),
  },
  coinbase: {
    // Granularity in seconds; no 4h and no weeks (4H is built from hours, 1W from days). Newest
    // first, rows [t s, LOW, HIGH, open, close], empty buckets left out, at most 300 buckets a call: 150 weeks of days
    // take four.
    iv: { '1h': 3600, '1d': 86400 },
    async rows(m, g, start, n) {
      const iso = (s) => new Date(s * 1000).toISOString();
      const out = [];
      let end = Math.floor(Date.now() / 1000 / g) * g + g;
      for (let left = n; left > 0; left -= 300) {
        const from = end - Math.min(300, left) * g;
        const page = arr(await upstream(`https://api.exchange.coinbase.com/products/${encodeURIComponent(m)}/candles?granularity=${g}&start=${iso(from)}&end=${iso(end)}`));
        for (const x of page) out.push([num(x?.[0]) * 1000, x?.[3], x?.[2], x?.[1], x?.[4]]);
        if (!page.length) break;
        end = from;
      }
      return out;
    },
  },
  hyperliquid: {
    // Perps by name, spot markets by "@index". Only the latest ~5000 candles per interval (1h: about 208 days). Its
    // weeks start on Thursday, so 1W is built from its days.
    iv: { '1h': '1h', '4h': '4h', '1d': '1d' },
    rows: async (m, iv, start) => arr(await upstream('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: m, interval: iv, startTime: start, endTime: Date.now() } }),
    })).map((x) => [x?.t, x?.o, x?.h, x?.l, x?.c]),
  },
  backpack: {
    // Times in seconds; candles start "YYYY-MM-DD HH:MM:SS" (UTC). Hours without trades come back as flat candles.
    iv: { '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' },
    rows: async (m, iv, start) => arr(await upstream(`https://api.backpack.exchange/api/v1/klines?symbol=${encodeURIComponent(m)}&interval=${iv}&startTime=${Math.floor(start / 1000)}&endTime=${Math.ceil(Date.now() / 1000)}`))
      .map((x) => [Date.parse(`${String(x?.start).replace(' ', 'T')}Z`), x?.open, x?.high, x?.low, x?.close]),
  },
  kraken: {
    // Always the latest 720 candles plus the one in progress, whatever is asked; the result key is "XXMRZUSD". Its
    // weeks start on Thursday, so 1W is built from its days (720 of them: about 103 weeks).
    iv: { '1h': 60, '4h': 240, '1d': 1440 },
    reach: 720,
    async rows(m, iv) {
      const data = await upstream(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(m)}&interval=${iv}`);
      if (arr(data?.error).length) throw new Error('error answer from api.kraken.com');
      const key = Object.keys(data?.result ?? {}).find((k) => k !== 'last');
      return arr(data?.result?.[key]).map((x) => [num(x?.[0]) * 1000, x?.[1], x?.[2], x?.[3], x?.[4]]);
    },
  },
  okx: {
    // Newest first. /candles covers the latest ~1440 candles, 300 a call; /history-candles pages further back. 1Dutc and
    // 1Wutc, because OKX's plain 1D days start at 16:00 UTC (Hong Kong midnight).
    iv: { '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' },
    reach: 600,
    async rows(m, bar, start, n) {
      const page = async (path) => {
        const data = await upstream(`https://www.okx.com/api/v5/market/${path}`);
        if (data?.code !== '0' || !Array.isArray(data.data)) throw new Error('error answer from www.okx.com');
        return data.data;
      };
      const inst = encodeURIComponent(m);
      const out = await page(`candles?instId=${inst}&bar=${bar}&limit=${Math.min(n, 300)}`);
      for (let i = 0; i < 3 && out.length < n; i++) {
        const oldest = num(out.at(-1)?.[0]);
        if (!(oldest > start)) break;
        const more = await page(`history-candles?instId=${inst}&bar=${bar}&limit=100&after=${oldest}`);
        if (!more.length) break;
        out.push(...more);
      }
      return out;
    },
  },
  bybit: {
    // Newest first, the latest `limit` candles.
    iv: { '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' },
    reach: 1000,
    async rows(m, iv, start, n) {
      const data = await upstream(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(m)}&interval=${iv}&limit=${Math.min(n + 1, 1000)}`);
      if (data?.retCode !== 0) throw new Error('error answer from api.bybit.com');
      return arr(data.result?.list);
    },
  },
  mexc: {
    // Binance-style rows (at most 500 a call); the hourly interval is "60m".
    iv: { '1h': '60m', '4h': '4h', '1d': '1d', '1w': '1W' },
    reach: 500,
    rows: async (m, iv, start, n) => arr(await upstream(`https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(m)}&interval=${iv}&limit=${Math.min(n + 1, 1000)}`)),
  },
  yahoo: {
    // Futures only (commodities). Hours and days; 4H is built from the hours and 1W from the days. An hour's bar starts
    // on the hour (a last, unaligned row with the latest trade is dropped by normalise). A day's bar is its trading
    // day: the session opens at 18:00 New York time the evening before, so a bar belongs to the New York date six
    // hours after its stamp, and it is put at 00:00 UTC of that date like every other day here.
    iv: { '1h': '1h', '1d': '1d' },
    async rows(m, iv, start) {
      const data = await upstream(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m)}?interval=${iv}&period1=${Math.floor(start / 1000)}&period2=${Math.ceil(Date.now() / 1000)}`);
      const r = data?.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      if (!r || !q) throw new Error('error answer from query1.finance.yahoo.com');
      return arr(r.timestamp).map((ts, i) => {
        const t = num(ts) * 1000;
        return [iv === '1d' ? Date.parse(nyClock(t + 6 * H).date) : t, q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
      });
    },
  },
  bigone: {
    // Newest first, at most 500 a call, each candle { time (ISO, UTC), open, high, low, close } inside { code, data };
    // its days start at 00:00 UTC and its weeks on Monday, like the site's.
    iv: { '1h': 'hour1', '4h': 'hour4', '1d': 'day1', '1w': 'week1' },
    reach: 500,
    async rows(m, iv, start, n) {
      const res = await upstream(`https://big.one/api/v3/asset_pairs/${encodeURIComponent(m)}/candles?period=${iv}&limit=${Math.min(n + 1, 500)}`);
      if (res?.code !== 0) throw new Error('error answer from big.one');
      return arr(res.data).map((x) => [Date.parse(x?.time), x?.open, x?.high, x?.low, x?.close]);
    },
  },
};
const IV_MS = { '1h': H, '4h': 4 * H, '1d': D, '1w': W };

// The start of a candle's bucket; weeks start on Monday 00:00 UTC (1970-01-01 was a Thursday).
const bucketStart = (t, step) => (step === W ? t - (t % D) - ((Math.floor(t / D) + 3) % 7) * D : t - (t % step));

// Valid, aligned, ascending, de-duplicated candles from start to now, with high and low repaired to hold the open and
// the close.
function normalise(rows, step, start) {
  const now = Date.now();
  const byTime = new Map();
  for (const r of rows) {
    const t = num(r?.[0]);
    const [o, h, l, c] = [num(r?.[1]), num(r?.[2]), num(r?.[3]), num(r?.[4])];
    if (!Number.isInteger(t) || bucketStart(t, step) !== t || t < start || t > now || ![o, h, l, c].every(valid)) continue;
    byTime.set(t, [t, o, Math.max(h, o, c), Math.min(l, o, c), c]);
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

// A candle that opens a market (its listing day) or reopens it after a gap can carry an auction print far from where
// trading settled: Backpack BP's first day opens at 0.02 and closes at 0.228, Bybit GRAM's 2026-06-22 reopening opens
// at 1.1 after a 1.706 close. When such an open is more than 20% from its close, it becomes the close and the low is
// held to 80% of it.
function clipReopenings(series, step, late) {
  series.forEach((x, i) => {
    const reopens = i === 0 ? late : x[0] - series[i - 1][0] > step;
    if (!reopens || Math.abs(x[1] / x[4] - 1) <= 0.2) return;
    x[1] = x[4];
    x[3] = Math.max(x[3], x[4] * 0.8);
  });
}

// Coarser candles from finer ones: o first, h max, l min, c last. A stock bar's New York date (and anything else after
// the close) is the last bar's.
function aggregate(rows, bucketOf) {
  const out = [];
  for (const x of rows) {
    const b = bucketOf(x);
    const cur = out.at(-1);
    if (cur && cur[0] === b) {
      cur[2] = Math.max(cur[2], x[2]);
      cur[3] = Math.min(cur[3], x[3]);
      cur[4] = x[4];
      cur.splice(5, Infinity, ...x.slice(5));
    } else out.push([b, ...x.slice(1)]);
  }
  return out;
}

// A halted market keeps serving its old candles (Binance's BREAK pairs do).
function checkCurrent(series, step) {
  if (series.at(-1)[0] >= bucketStart(Date.now(), step) - Math.max(2 * step, H)) return;
  const e = new Error('latest candle too old');
  e.detail = new Date(series.at(-1)[0]).toISOString().slice(0, 16);
  throw e;
}

// ---- coins: the latest CANDLES candles of one size from one source ----
// Native where the venue has the size, else built from its finer candles (FINER): Coinbase's 4H from its hours, and the
// weeks of Coinbase (none), Hyperliquid and Kraken (both starting on Thursday) from their days. Weeks start on Monday
// 00:00 UTC everywhere.
const NATIVE = { '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w' };
const FINER = { '4H': '1h', '1W': '1d' };

// Valid candles of venue interval iv (a key of IV_MS) from start to now, with the renamed market joined in front when the
// window reaches back before the rename, and a source's pre-market cut.
async function candlesFrom(s, iv, start) {
  const venue = VENUES[s.venue];
  const n = Math.floor((Date.now() - start) / IV_MS[iv]) + 1;
  let rows = await venue.rows(s.market, venue.iv[iv], start, n);
  if (s.join && start < s.join.until) {
    const first = Math.min(...rows.map((r) => num(r?.[0])).filter(Number.isFinite));
    rows = [...(await venue.rows(s.join.market, venue.iv[iv], start, n)).filter((r) => num(r?.[0]) < first), ...rows];
  }
  return normalise(rows, IV_MS[iv], Math.max(start, s.from ? Date.parse(s.from) : 0));
}

async function coinCandles(s, interval, listed) {
  const venue = VENUES[s.venue];
  const { step, slack } = INTERVALS[interval];
  const start = bucketStart(Date.now(), step) - (CANDLES - 1) * step;
  let iv = venue.iv[NATIVE[interval]] !== undefined ? NATIVE[interval] : FINER[interval];
  let series = await candlesFrom(s, iv, start);
  if (!series.length) throw new Error('no candles');
  checkCurrent(series, IV_MS[iv]);
  const late = series[0][0] > start + slack;
  // A market younger than the window starts inside it: its weeks are rebuilt from its days (one call more, cached like
  // the chart), so its first day's auction print is clipped like any day's and the chart can name that day. They stay as
  // they came when the venue cannot reach that far back (its reach: Binance 1000 days, OKX 600).
  if (late && iv === '1w' && Math.floor((Date.now() - series[0][0]) / D) + 1 <= (venue.reach ?? Infinity)) {
    const days = await candlesFrom(s, '1d', series[0][0]).catch(() => []);
    if (days.length && days[0][0] < series[0][0] + W && days.at(-1)[0] >= bucketStart(Date.now(), D) - D) [series, iv] = [days, '1d'];
  }
  const young = late && series[0][0] <= listed + slack;
  clipReopenings(series, IV_MS[iv], late);
  const candles = (IV_MS[iv] === step ? series : aggregate(series, (x) => bucketStart(x[0], step))).slice(-CANDLES);
  return {
    since: young ? day(Math.max(series[0][0], listed)) : null,
    from: late && !young ? day(series[0][0]) : null,
    candles,
    last: candles.at(-1)[4],
  };
}

// ---- commodities: the latest CANDLES candles of a future, counted back over its closed hours ----
// A future trades about 23 hours a day on five days, so 150 candles reach further back than 150 steps of the clock:
// the window asked for is that much longer and the latest 150 are kept. The latest candle may be as old as a long
// weekend (IDLE) before the source counts as stopped. Weeks start on Monday 00:00 UTC, days at 00:00 UTC, as the
// coins' do; a week or a 4-hour block with no trading in it is simply not there, and the chart draws by index.
const IDLE = 5 * D;
async function futureCandles(s, interval) {
  const venue = VENUES[s.venue];
  const { step } = INTERVALS[interval];
  const iv = venue.iv[NATIVE[interval]] !== undefined ? NATIVE[interval] : FINER[interval];
  const span = (CANDLES + 2) * step * (step < W ? 1.6 : 1.05) + 5 * D;
  const start = bucketStart(Date.now() - span, IV_MS[iv]);
  const series = await candlesFrom(s, iv, start);
  if (!series.length) throw new Error('no candles');
  if (series.at(-1)[0] < Date.now() - IDLE - step) {
    const e = new Error('latest candle too old');
    e.detail = new Date(series.at(-1)[0]).toISOString().slice(0, 16);
    throw e;
  }
  const all = IV_MS[iv] === step ? series : aggregate(series, (x) => bucketStart(x[0], step));
  const candles = all.slice(-CANDLES);
  // Fewer than asked: the market is younger than the window (Hyperliquid's perps on these are months old).
  return { since: null, from: all.length < CANDLES ? day(series[0][0]) : null, candles, last: candles.at(-1)[4] };
}

// ---- stocks: regular sessions only, bucketed in New York time (Intl, so EDT and EST both just work) ----
// A stock bar is [t ms, o, h, l, c, New York date]. Intraday t is the bar's real start; a daily bar's t is 09:30 New
// York time on its date, so it reads as that date in every visitor's time zone.
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function nyClock(ms) {
  const p = {};
  for (const { type, value } of NY.formatToParts(ms)) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// The instant of a New York wall-clock time (the offset is read back from Intl for that very day).
function nyEpoch(date, hm) {
  const asUtc = Date.parse(`${date}T${hm}:00Z`);
  if (!Number.isFinite(asUtc)) return NaN;
  const ny = nyClock(asUtc);
  return asUtc - (Date.parse(`${ny.date}T${ny.hm}:00Z`) - asUtc);
}
const shiftDate = (date, days) => day(Date.parse(`${date}T00:00:00Z`) + days * D);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday ... 6 Saturday
// NYSE's calendar: the 13:00 closes (only CNBC's bars need them; Robinhood trims each session itself) and the weekday
// full closures (the market is shut all day, so a weekday inside session hours is not a session). Both lists come from
// NYSE's published calendar, which covers three years at a time; add the next year's dates each year. 2028 has no New
// Year's Day closure (January 1 is a Saturday).
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
const CLOSED = new Set([
  '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23',
  '2028-12-25',
]);

function stockBar(t, o, h, l, c, date) {
  const v = [num(o), num(h), num(l), num(c)];
  if (!Number.isFinite(t) || !v.every(valid)) return null;
  return [t, v[0], Math.max(v[1], v[0], v[3]), Math.min(v[2], v[0], v[3]), v[3], date];
}
const tidy = (bars) => [...new Map(bars.filter(Boolean).map((b) => [b[0], b])).values()].sort((a, b) => a[0] - b[0]);

// Whether the card's quote belongs to session `date`: it does when that is today in New York, or when the market is
// shut right now (the quote is then the last close): a night, a weekend or a weekday holiday (CLOSED). In the first
// minutes of a session the bars can still be the day before's.
function quoteIsSession(date) {
  const now = nyClock(Date.now());
  const wd = weekdayOf(now.date);
  return date === now.date || CLOSED.has(now.date) || !(wd >= 1 && wd <= 5 && now.hm >= '09:30' && now.hm < '16:00');
}

// One Robinhood call holds four stocks (the stock's own group of four: with 23 stocks one call for all of them would
// be several MB, past the body cap). bounds=regular trims each session (half-days included). Interpolated bars
// are placeholders (the latest daily bar is one until the next day: open = high = low = close = the previous close; so
// are CRCL's dailies before its listing). Intraday begins_at is a real UTC time; a daily "2026-10-05T00:00:00Z" is only
// a date label.
const RH_SYMBOLS = STOCKS.map((s) => s.symbol).join(',');
const RH_GROUPS = [];
for (let i = 0; i < STOCKS.length; i += 4) RH_GROUPS.push(STOCKS.slice(i, i + 4).map((s) => s.symbol));
const RH_GROUP_OF = new Map(RH_GROUPS.flatMap((g, i) => g.map((sym) => [sym, i])));
function robinhood(interval, span, maxAge, sym) {
  const group = RH_GROUP_OF.get(sym) ?? 0;
  return shared(`robinhood ${interval}/${span}/${group}`, maxAge, async () => {
    const data = await upstream(`https://api.robinhood.com/marketdata/historicals/?symbols=${RH_GROUPS[group].join(',')}&interval=${interval}&span=${span}&bounds=regular`);
    const out = new Map();
    for (const r of arr(data?.results)) {
      if (!STOCK_SYMBOLS.has(r?.symbol)) continue;
      const bars = arr(r.historicals).filter((b) => b && !b.interpolated && (b.session ?? 'reg') === 'reg').map((b) => {
        if (interval !== 'day') {
          const t = Date.parse(b.begins_at);
          return Number.isFinite(t) ? stockBar(t, b.open_price, b.high_price, b.low_price, b.close_price, nyClock(t).date) : null;
        }
        const date = String(b.begins_at).slice(0, 10);
        return stockBar(nyEpoch(date, '09:30'), b.open_price, b.high_price, b.low_price, b.close_price, date);
      });
      out.set(r.symbol, { bars: tidy(bars), instrument: r.instrument });
    }
    return out;
  });
}
// The latest session's open (its first print, a little off the official open), high and low (fundamentals carry no
// symbol: matched on the instrument URL).
function robinhoodFundamentals() {
  return shared('robinhood fundamentals', MIN, async () => {
    const data = await upstream(`https://api.robinhood.com/fundamentals/?symbols=${RH_SYMBOLS}`);
    return new Map(arr(data?.results).filter((f) => f?.instrument).map((f) => [f.instrument, { date: f.market_date, o: num(f.open), h: num(f.high), l: num(f.low) }]));
  });
}

// What a stock chart needs from its source, besides the 5-minute bars (which name the latest session and hold its bars
// to the minute): need.m30, the 30-minute bars (a month from Robinhood; from CNBC 57 days, or 115 when it is 'long');
// need.days, the dailies over Robinhood's span 'year' or '5year' (CNBC: 1100 days), with the latest session's official
// open, high and low. ttl: the asking chart's, which bounds the age of what it reuses.
async function robinhoodKit(sym, need, ttl) {
  const bars = async (interval, span, maxAge) => {
    const x = (await robinhood(interval, span, maxAge, sym)).get(sym);
    if (!x?.bars.length) throw new Error('no bars');
    return x;
  };
  const fresh = ttl * 0.9;
  const m5 = await bars('5minute', 'week', 50_000);
  const kit = { m5: m5.bars };
  if (need.m30) kit.m30 = (await bars('30minute', 'month', fresh)).bars;
  if (need.days) kit.days = (await bars('day', need.days, fresh)).bars;
  if (kit.days) kit.official = await robinhoodFundamentals().then((m) => m.get(m5.instrument), () => undefined);
  return kit;
}

// CNBC's chart bars, one stock per call. Bars are aligned to the requested start, so it is always 00:00 New York time.
// Extended hours are always included: intraday bars are kept on weekdays from 09:30 to the close by tradeTime (New York
// wall clock), with volume (CNBC also has weekend and night junk bars, and a volume-0 reference bar at the listing
// price). Its hourly bars run on the clock (09:00, 10:00), so session hours are built from its 30-minute bars. One call
// returns at most about 2260 bars (the latest ones of the window, extended hours included: about 100 days of 30-minute
// bars), so the windows, [days ago from, days ago to], cover 150 candles of every size in parts: the latest 57 days of
// 30-minute bars (about 40 sessions, every 1H chart's), for 4H also the 115 to 50 days before (with them about 80
// sessions; 150 4H candles need 75; a week of overlap, so a refresh of either part never leaves a gap, and history, so
// it is reused for 6 hours), and 1100 days of dailies (about 157 weeks).
const CNBC_DAYS = { '5M': [12, 0], '30M': [57, 0], '30M before': [115, 50], '1D': [1100, 0] };
const CNBC_MINUTES = { '5M': 5, '30M': 30 };
function cnbc(sym, part, maxAge) {
  return shared(`cnbc ${sym} ${part}`, maxAge, async () => {
    const ymd = (ms) => nyClock(ms).date.replace(/-/g, '');
    const now = Date.now();
    const gran = part.split(' ')[0];
    const [from, to] = CNBC_DAYS[part];
    const data = await upstream(`https://ts-api.cnbc.com/harmony/app/bars/${sym}/${gran}/${ymd(now - from * D)}000000/${ymd(now - to * D)}235959/adjusted/EST5EDT.json`);
    const rows = data?.barData?.priceBars;
    if (!Array.isArray(rows)) throw new Error('error answer from ts-api.cnbc.com');
    const bars = [];
    for (const b of rows) {
      const tt = String(b?.tradeTime ?? '');
      if (!/^\d{14}$/.test(tt) || !(num(b.volume) > 0)) continue;
      const date = `${tt.slice(0, 4)}-${tt.slice(4, 6)}-${tt.slice(6, 8)}`;
      if (gran === '1D') {
        bars.push(stockBar(nyEpoch(date, '09:30'), b.open, b.high, b.low, b.close, date));
        continue;
      }
      const hm = `${tt.slice(8, 10)}:${tt.slice(10, 12)}`;
      const wd = weekdayOf(date);
      if (wd < 1 || wd > 5 || hm < '09:30' || hm >= (EARLY_CLOSE.has(date) ? '13:00' : '16:00') || Number(tt.slice(10, 12)) % CNBC_MINUTES[gran]) continue;
      bars.push(stockBar(num(b.tradeTimeinMills), b.open, b.high, b.low, b.close, date));
    }
    const out = tidy(bars);
    if (!out.length) throw new Error('no bars');
    return out;
  });
}
async function cnbcKit(sym, need, ttl) {
  const fresh = ttl * 0.9;
  const kit = { m5: await cnbc(sym, '5M', 50_000) };
  const latest = kit.m5.at(-1)[5];
  if (need.m30) kit.m30 = await cnbc(sym, '30M', fresh);
  if (need.m30 === 'long') kit.m30 = tidy([...await cnbc(sym, '30M before', 6 * H), ...kit.m30]);
  if (need.days) {
    kit.days = await cnbc(sym, '1D', fresh);
    // CNBC's own bar for the latest session (final after the close) holds the official open, high and low.
    const own = kit.days.find((b) => b[5] === latest);
    if (own) kit.official = { date: latest, o: own[1], h: own[2], l: own[3] };
  }
  return kit;
}
const stockKit = (venue, sym, need, ttl) => (venue === 'robinhood' ? robinhoodKit(sym, need, ttl) : cnbcKit(sym, need, ttl));

// The latest session's daily bar: Robinhood's is a placeholder (dropped) or missing until the next day, CNBC's is missing
// until the session's first minutes are over and still forming after that. Open, high and low come from the official
// numbers when they describe that session, else from its 5-minute bars; the close is the card's quote (the session's
// last bar when the quote is another session's).
function patchDay(days, date, session, official, close) {
  if (!session.length) return days;
  const f = official?.date === date ? official : {};
  const o = valid(f.o) ? f.o : session[0][1];
  const h = Math.max(valid(f.h) ? f.h : Math.max(...session.map((b) => b[2])), o, close);
  const l = Math.min(valid(f.l) ? f.l : Math.min(...session.map((b) => b[3])), o, close);
  return [...days.filter((b) => b[5] < date), [nyEpoch(date, '09:30'), o, h, l, close, date]];
}

// Weekly candles from the dailies, weeks starting Monday in New York (Robinhood's weekly bars leave out the week in
// progress, CNBC's are labelled on the Sunday).
function weekly(days) {
  const mondays = new Map();
  return aggregate(days, (b) => {
    const monday = shiftDate(b[5], -((weekdayOf(b[5]) + 6) % 7));
    if (!mondays.has(monday)) mondays.set(monday, nyEpoch(monday, '09:30'));
    return mondays.get(monday);
  });
}

// Session buckets the way TradingView draws US stocks: hours from the 09:30 open (09:30, 10:30 ... 15:30, the last one
// half an hour; a 13:00 close ends at 12:30's half hour) and 4 hours from the open (09:30 and 13:30, the second two and a
// half hours). A bucket's t is its New York start.
const OPENS = new Map(); // New York date -> its 09:30 instant
function openOf(date) {
  let t = OPENS.get(date);
  if (t === undefined) {
    if (OPENS.size > 5000) OPENS.clear();
    OPENS.set(date, (t = nyEpoch(date, '09:30')));
  }
  return t;
}
const sessionBucket = (ms) => (b) => {
  const open = openOf(b[5]);
  return open + Math.floor((b[0] - open) / ms) * ms;
};

// The latest CANDLES candles of a size, nights, weekends and holidays taking no room: 1H and 4H from the 5-minute bars for
// the sessions they hold (the session in progress included) and the 30-minute bars before those; 1D from the dailies
// with the latest session patched; 1W from those dailies, weeks from Monday. The latest session is read from the data,
// never from a calendar. The last candle, when it is the latest session's, ends at the card's quote.
async function stockCandles(venue, sym, interval, live) {
  const intraday = interval === '1H' || interval === '4H';
  const need = interval === '4H' ? { m30: 'long' } : interval === '1H' ? { m30: true } : { days: interval === '1W' ? '5year' : 'year' };
  const kit = await stockKit(venue, sym, need, INTERVALS[interval].ttl);
  const latest = kit.m5.at(-1)[5];
  if (latest < shiftDate(nyClock(Date.now()).date, -6)) {
    const e = new Error('no bars this week');
    e.detail = latest;
    throw e;
  }
  const session = kit.m5.filter((b) => b[5] === latest);
  const quoteFits = valid(live) && quoteIsSession(latest);
  const close = quoteFits ? live : session.at(-1)[4];
  let bars, candles;
  if (intraday) {
    bars = [...kit.m30.filter((b) => b[5] < kit.m5[0][5]), ...kit.m5];
    candles = aggregate(bars, sessionBucket(INTERVALS[interval].step));
  } else {
    bars = patchDay(kit.days, latest, session, kit.official, close);
    // Robinhood's listing-day bar opens and dips at the offer price (CRCL: 31; its first trade was 69, CNBC's open):
    // when a listing day opens more than 20% from its close, the open becomes the close and the low is held to 80% of
    // it, as for a coin's.
    const f = bars[0];
    if (f && openOf(f[5]) <= LISTED[sym] + D && Math.abs(f[1] / f[4] - 1) > 0.2) bars = [[f[0], f[4], f[2], Math.max(f[3], f[4] * 0.8), f[4], f[5]], ...bars.slice(1)];
    candles = interval === '1D' ? bars : weekly(bars);
  }
  candles = candles.slice(-CANDLES);
  if (!candles.length) throw new Error('no bars');
  const c = candles.at(-1);
  if (quoteFits && c[5] === latest) candles[candles.length - 1] = [c[0], c[1], Math.max(c[2], live), Math.min(c[3], live), live, latest];
  // Fewer candles than asked: the stock is younger than the window (CRCL's weeks) or the source holds less (Robinhood's
  // 4H: a month of 30-minute bars).
  const late = candles.length < CANDLES;
  const young = late && openOf(bars[0][5]) <= LISTED[sym] + INTERVALS[interval].slack;
  return {
    since: young ? bars[0][5] : null, from: late && !young ? bars[0][5] : null, candles,
    last: quoteFits ? session.at(-1)[4] : NaN, checked: quoteFits,
  };
}

// ---- one chart: the first source in the chain that answers with fresh candles near the card price ----
// VIEWS: every chart the endpoint can answer, "<param> <value>" -> { ttl, chain(sym, stock), series(source, sym, stock,
// live), json(sym, result, fetchedAt) }.
const VIEWS = new Map();
for (const [i, v] of Object.entries(INTERVALS)) {
  VIEWS.set(`i ${i}`, {
    ttl: v.ttl,
    chain: (sym, stock) => (stock ? STOCK_CANDLE_SOURCES : COMMODITY_SOURCES[sym] ?? CANDLE_SOURCES[sym].filter((s) => !s.only || s.only.includes(i))),
    series: (s, sym, stock, live) => (stock ? stockCandles(s.venue, sym, i, live) : s.future ? futureCandles(s, i) : coinCandles(s, i, LISTED[sym])),
    // { s, i, src, since, from, step, ttl, candles: [[t, o, h, l, c], ...] (ascending, the last one still forming), fetchedAt }:
    // ttl is this size's cache time, so the page keeps the answer exactly as long as the server keeps its own copy.
    json: (sym, r, fetchedAt) => JSON.stringify({
      s: sym, i, src: r.src, since: r.since, from: r.from, step: v.step, ttl: v.ttl,
      candles: r.candles.map(([t, o, h, l, c]) => [t, r6(o), r6(h), r6(l), r6(c)]),
      fetchedAt,
    }),
  });
}

async function build(sym, view, livePrice) {
  const stock = STOCK_SYMBOLS.has(sym);
  const live = livePrice(sym);
  for (const s of view.chain(sym, stock)) {
    const label = `${s.venue} ${s.market ?? sym}`;
    try {
      const out = await view.series(s, sym, stock, live);
      if (valid(live) && valid(out.last) && Math.abs(out.last / live - 1) > WRONG_MARKET) {
        const e = new Error('latest close too far from the card price, a wrong market');
        e.detail = `${((out.last / live - 1) * 100).toFixed(1)}% off`;
        throw e;
      }
      up(s.venue);
      up(label);
      return { ...out, src: NAMES[s.venue], checked: out.checked ?? valid(live) };
    } catch (e) {
      // A resting venue is skipped quietly: its failure was logged when it happened.
      if (!(e instanceof Resting)) down(e instanceof VenueDown ? s.venue : label, e);
    }
  }
  throw new Error('no chart source answered');
}

// ---- the cache: one entry per symbol and view (a finite key space), refreshed once at a time ----
// Fresh: served as it is. Older than the TTL: served at once while one refresh runs (stale-while-revalidate); more than
// twice the TTL old (nobody asked for it in a while), the refresh gets 0.3 s to land first (a fast venue makes it; a
// slow one would hold up the panel's first draw), and a copy that still goes out is marked stale (historyResponse). A
// failed refresh keeps the last good chart for up to 24 h and is retried after a minute at the earliest. A chart that
// could not be checked against a card price (just after a restart) is kept for a minute only.
// Each entry is a machine of its own, in one of four states, which say what last happened to it (how old its body is
// is read off the clock instead, ageOf below):
//   empty:    never built.
//   building: a build is out (the first one, or a refresh while the last good body goes on being served).
//   built:    the last build landed: body, fetchedAt and expires are its.
//   failed:   the last build failed, at failedAt; the next waits out the backoff (the TTL or RETRY, whichever is
//             shorter), and a body an older build left is served meanwhile while it is usable.
const ENTRY_MOVES = {
  empty: ['building'],
  building: ['built', 'failed'],
  built: ['building'],
  failed: ['building'],
};
// How an entry's body reads at a moment, from the clock alone:
//   none:    no body, or one older than KEEP_STALE: unusable.
//   fresh:   before its expiry: served as it is.
//   expired: past it: served at once while one refresh runs (stale-while-revalidate).
//   old:     more than twice the TTL old: the refresh gets STALE_WAIT_MS to land first, and a copy that still goes out is
//            marked stale (historyResponse).
function ageOf(e, ttl, now) {
  if (!e.body || now - e.fetchedAt >= KEEP_STALE) return 'none';
  if (now < e.expires) return 'fresh';
  return now - e.fetchedAt > 2 * ttl ? 'old' : 'expired';
}
const cache = new Map(); // "BTC i 1H" -> { m, body, fetchedAt, expires, failedAt, pending, job }
function entryOf(name) {
  let e = cache.get(name);
  if (!e) {
    e = { m: machine('empty', ENTRY_MOVES), body: null, fetchedAt: 0, expires: 0, failedAt: 0, pending: null, job: null };
    // The build and the warm-up job it runs for belong to the building state alone.
    e.m.on((to, from) => { if (from === 'building') { e.pending = null; e.job = null; } });
    cache.set(name, e);
  }
  return e;
}
// One build at a time per entry; it lands only into the run it started (its epoch).
function refreshEntry(e, sym, view, livePrice, job) {
  if (!e.m.go('building')) return;
  const run = e.m.epoch;
  e.job = job ?? null;
  e.pending = build(sym, view, livePrice).then((r) => {
    if (e.m.epoch !== run) return;
    const at = Date.now();
    Object.assign(e, { body: view.json(sym, r, at), fetchedAt: at, expires: at + (r.checked ? view.ttl : Math.min(view.ttl, MIN)) });
    e.m.go('built');
  }, () => {
    if (e.m.epoch !== run) return;
    e.failedAt = Date.now();
    e.m.go('failed');
  });
}
async function chart(sym, key, livePrice) {
  const view = VIEWS.get(key);
  const e = entryOf(`${sym} ${key}`);
  const now = Date.now();
  const age = ageOf(e, view.ttl, now);
  if (age === 'fresh') return e;
  const job = background.getStore();
  if (!e.m.is('building') && !(e.m.is('failed') && now - e.failedAt < Math.min(view.ttl, RETRY))) refreshEntry(e, sym, view, livePrice, job);
  // A visitor asking for a chart the warm-up is building: it now goes as a visitor's would.
  if (!job && e.job) e.job.urgent = true;
  if (age !== 'none') {
    if (age === 'old' && e.m.is('building')) await within(e.pending, STALE_WAIT_MS);
    return e;
  }
  if (e.m.is('building')) await e.pending;
  return ageOf(e, view.ttl, Date.now()) !== 'none' ? e : null;
}

/**
 * Warms every symbol's 1H chart (the panel's default candle size) once, after the server's first price fetch, so first
 * opens find it ready. One chart at a time, spread over about a minute, each call in a quiet moment of the limiter (see
 * quiet()), so the warm-up never bursts and never holds up a visitor's chart. Price fetches do not use this limiter.
 * @param {(symbol: string) => number | null} livePrice the card price, while it is fresh
 */
export async function warmHistory(livePrice) {
  const list = [...SYMBOLS];
  const step = WARM_MS / list.length;
  for (const sym of list) {
    const t0 = Date.now();
    await background.run({ urgent: false }, () => chart(sym, 'i 1H', livePrice)).catch(() => {});
    await sleep(Math.max(0, step - (Date.now() - t0)));
  }
}

/**
 * The answer to GET /api/history: { status, headers, body, key }. Exactly two parameters, each once: s (a symbol on the
 * page) and i (1H, 4H, 1D or 1W); anything else is a 400. Never echoes the request.
 * key names the chart of a 200 (the same body for every visitor until it refreshes), so the server can keep one
 * compressed copy per chart.
 * @param {URLSearchParams} params
 * @param {(symbol: string) => number | null} livePrice the card price, while it is fresh
 */
export async function historyResponse(params, livePrice) {
  const keys = [...params.keys()];
  const sym = params.get('s');
  const key = `i ${params.get('i')}`;
  if (keys.length !== 2 || params.getAll('s').length !== 1 || params.getAll('i').length !== 1 || !SYMBOLS.has(sym) || !VIEWS.has(key)) {
    return { status: 400, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'Bad request' };
  }
  const { ttl } = VIEWS.get(key);
  // A chart nobody has asked for yet is waited for 12 s at most: past that the visitor hears 503 (the page retries in
  // 4 s) while the build carries on and fills the cache.
  const e = await within(chart(sym, key, livePrice).catch(() => null), DEADLINE_MS);
  const json = 'application/json; charset=utf-8';
  if (!e) return { status: 503, headers: { 'content-type': json, 'cache-control': 'no-store' }, body: '{"error":"unavailable"}' };
  // More than twice its TTL old (its refresh did not land in time, or is failing): marked "stale": true and never
  // cached, so the page asks once more a few seconds later and morphs to the fresh chart.
  if (['old', 'none'].includes(ageOf(e, ttl, Date.now()))) return { status: 200, headers: { 'content-type': json, 'cache-control': 'no-store' }, body: `${e.body.slice(0, -1)},"stale":true}`, key: `${sym} ${key}` };
  // Browsers may keep a chart until the server's own copy expires (a minute at most); a stale one only briefly.
  const left = Math.ceil((e.expires - Date.now()) / 1000);
  return { status: 200, headers: { 'content-type': json, 'cache-control': `public, max-age=${left > 0 ? Math.min(left, 60) : 5}` }, body: e.body, key: `${sym} ${key}` };
}
