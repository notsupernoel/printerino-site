// Commodity quotes for the page (the COMMODITIES below), keyless. They are the front-month futures, as finance sites
// show a commodity's price: CNBC's quote service answers for all six in one call (the stocks' own source); Yahoo
// Finance, on the same contracts, fills in whatever CNBC misses; Hyperliquid's builder market "xyz" (perps that follow
// the same commodities, trading round the clock) comes last. None is a documented API, which is why there are three.
// CoinGecko was checked as a backup: its keyless API serves only the tokenized side (gold and silver tokens at their
// on-chain price, about 1% off the metal, and nothing at all for oil, gas or copper), so it cannot back these up.
import { ok, warn } from './log.js';
import { getJson, num, valid } from './net.js';

// The page's order before the first quotes: gold and silver lead by their market caps, the rest follow in a fixed
// order (they have no market cap to be ranked by).
// unit: what one price buys. lot: the units in one futures contract, which turns the session's contract count into
// dollars. supply: gold and silver alone have a market cap, all the metal above ground times the price, as the
// asset rankings give it; the ounce counts are the ones CoinGecko's commodities page implied on 2026-11-15 (its cap
// over its price). Copper, oil and gas are used up, not held, so no ranking gives them one and neither does the page.
// hl: the Hyperliquid market. NATGAS has none: on 2026-11-15 (a weekend, the futures shut) xyz:NATGAS stood 12% above
// the future, too far for a weekend's drift, so it is left out until the two are compared with the futures open. The
// other five stood 1 to 3% away that day; they are in as the last resort and are due the same comparison.
export const COMMODITIES = [
  { symbol: 'GOLD', name: 'Gold', unit: 'oz', cnbc: '@GC.1', yahoo: 'GC=F', hl: 'xyz:GOLD', lot: 100, supply: 7_628_532_000 },
  { symbol: 'SILVER', name: 'Silver', unit: 'oz', cnbc: '@SI.1', yahoo: 'SI=F', hl: 'xyz:SILVER', lot: 5_000, supply: 61_763_455_000 },
  { symbol: 'COPPER', name: 'Copper', unit: 'lb', cnbc: '@HG.1', yahoo: 'HG=F', hl: 'xyz:COPPER', lot: 25_000 },
  { symbol: 'WTI', name: 'WTI Crude', unit: 'bbl', cnbc: '@CL.1', yahoo: 'CL=F', hl: 'xyz:CL', lot: 1_000 },
  { symbol: 'BRENT', name: 'Brent Crude', unit: 'bbl', cnbc: '@LCO.1', yahoo: 'BZ=F', hl: 'xyz:BRENTOIL', lot: 1_000 },
  { symbol: 'NATGAS', name: 'Natural Gas', unit: 'MMBtu', cnbc: '@NG.1', yahoo: 'NG=F', lot: 10_000 },
];

const plain = (v) => (typeof v === 'string' ? num(v.replace(/[,%+\s]/g, '')) : num(v)); // "3,887.60" -> 3887.6

/**
 * The card's fields from one source's numbers; null when there is no usable price (the next source gets a turn).
 * changePct: the source's own session change when it gives one, else the move from the previous close.
 * contracts: the session's volume in contracts (a source that reports 0, as CNBC does for ICE Brent, has none).
 */
function quote(c, price, prevClose, contracts, source, changePct = NaN) {
  if (!valid(price)) return null;
  return {
    price,
    change24h: Number.isFinite(changePct) ? changePct : valid(prevClose) ? (price / prevClose - 1) * 100 : null,
    mcap: c.supply ? price * c.supply : null,
    vol24h: valid(contracts) ? contracts * c.lot * price : null,
    source,
  };
}

async function fetchCnbc(list) {
  const symbols = list.map((c) => encodeURIComponent(c.cnbc)).join('%7C');
  const data = await getJson(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`);
  const rows = data?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(rows)) throw new Error('cnbc: unexpected response');
  const out = new Map();
  for (const c of list) {
    const r = rows.find((x) => x?.symbol === c.cnbc && Number(x?.code) === 0);
    // "UNCH" is CNBC's word for no change.
    const pct = r?.change_pct === 'UNCH' ? 0 : plain(r?.change_pct);
    const q = r && quote(c, plain(r.last), plain(r.previous_day_closing), plain(r.volume), 'cnbc', pct);
    if (q) out.set(c.symbol, q);
  }
  // An answer with nothing usable in it (every row an error code, no price) is a failure, not a recovery, as it is
  // for CoinGecko (feeds.js): logged as one, and every commodity is left for Yahoo.
  if (!out.size) throw new Error('no usable rows');
  return out;
}

// One call per commodity (Yahoo's chart answer carries the quote in its meta); one that fails is just missing.
async function fetchYahoo(list) {
  const results = await Promise.allSettled(list.map(async (c) => {
    const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c.yahoo)}?interval=1d&range=1d`);
    const m = data?.chart?.result?.[0]?.meta;
    return [c.symbol, m && quote(c, num(m.regularMarketPrice), num(m.chartPreviousClose), num(m.regularMarketVolume), 'yahoo')];
  }));
  const out = new Map();
  for (const r of results) if (r.status === 'fulfilled' && r.value[1]) out.set(r.value[0], r.value[1]);
  const failed = results.find((r) => r.status === 'rejected');
  if (!out.size && failed) throw failed.reason;
  return out;
}

// The perps' mark price and its move over 24 hours. Their volume is the perp's own, not the commodity's, so none is
// given: the card keeps the last one a futures source reported while it is recent.
async function fetchHyperliquid(list) {
  const [meta, ctxs] = await getJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
  });
  const universe = meta?.universe ?? [];
  const out = new Map();
  for (const c of list) {
    const i = universe.findIndex((u) => u?.name === c.hl);
    if (i < 0 || universe[i].isDelisted) continue;
    const q = quote(c, num(ctxs?.[i]?.markPx), num(ctxs?.[i]?.prevDayPx), NaN, 'hyperliquid');
    if (q) out.set(c.symbol, q);
  }
  return out;
}

/** Map of symbol -> { price, change24h, mcap, vol24h, source }. CNBC first, then Yahoo, then Hyperliquid for anything
 * still missing. A source that fails is logged when it starts, once an hour while it lasts, and when it recovers
 * (log.js), as the coin and stock feeds are. */
export async function fetchCommodities(list = COMMODITIES) {
  const out = new Map();
  const sources = [['cnbc', (c) => c.cnbc, fetchCnbc], ['yahoo', (c) => c.yahoo, fetchYahoo], ['hyperliquid', (c) => c.hl, fetchHyperliquid]];
  for (const [name, listed, fetcher] of sources) {
    const missing = list.filter((c) => !out.has(c.symbol) && listed(c));
    if (!missing.length) continue;
    try {
      for (const [k, v] of await fetcher(missing)) out.set(k, v);
      ok(`commodities ${name}`);
    } catch (e) {
      warn(`commodities ${name}`, e.message);
    }
  }
  // A price that came without a volume (CNBC reports none for ICE Brent) takes Yahoo's, the same contract's session.
  const noVol = list.filter((c) => c.yahoo && out.get(c.symbol)?.source === 'cnbc' && out.get(c.symbol).vol24h == null);
  if (noVol.length) {
    try {
      for (const [k, v] of await fetchYahoo(noVol)) if (v.vol24h != null) out.get(k).vol24h = v.vol24h;
    } catch {
      // The card says n/a for this volume, as it would have without the extra call.
    }
  }
  if (!out.size) throw new Error('no commodity source responded');
  return out;
}
