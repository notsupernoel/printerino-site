// Stock quotes for the page (the STOCKS below), keyless. CNBC's quote service answers for all of them in one call;
// Robinhood's public market data fills in whatever CNBC misses. Neither is a documented API, which is why there are
// two. Prices are the regular session's: outside US market hours a stock shows its last close and that session's
// change, as finance sites do.
import { ok, warn } from './log.js';
import { getJson, num, valid } from './net.js';

// Display order before the first market caps arrive; after that the stocks are ranked by market cap among themselves.
// shares: Class A + Class B from each company's latest 10-Q/10-K cover page, used for the market cap only when a source
// has none. Refresh after every 10-Q/10-K (COIN 10-Q filed 2026-07-30, CRCL 2026-08-05, HOOD 2026-07-30; MU 10-K filed
// 2026-10-09, its count as of 2026-10-02). The next ones due are the Q3 10-Qs of COIN, HOOD and CRCL, late October to
// early November 2026.
// The others (all but these four and STRC): both sources give a market cap for every one of them, so their counts are
// only the fallback, and they are the sources' own share counts on 2026-11-14 (Robinhood's fundamentals, which agree
// with CNBC's cap over price), not yet read off a filing's cover page; SPY and QQQ are funds, so theirs are units
// outstanding and their "market cap" is the fund's size. GOOGL is Alphabet's Class A; its count is all classes.
// STRC is Strategy's Stretch preferred, not a company: CNBC gives it no market cap and Robinhood gives the whole
// company's, so ownCap makes its cap always price x its own shares, the size of the issue.
// Its count is Strategy's stated notional of $9,316.2M at the $100 stated amount (strategy.com/strc, record date
// 2026-09-30); Strategy issues and buys back STRC often, so refresh it from that page after each record date.
export const STOCKS = [
  { symbol: 'AAPL', name: 'Apple', exchange: 'Nasdaq', shares: 14_532_200_000 },
  { symbol: 'NVDA', name: 'Nvidia', exchange: 'Nasdaq', shares: 24_598_300_000 },
  { symbol: 'MSFT', name: 'Microsoft', exchange: 'Nasdaq', shares: 7_426_194_336 },
  { symbol: 'GOOGL', name: 'Alphabet', exchange: 'Nasdaq', shares: 12_223_000_000 },
  { symbol: 'AMZN', name: 'Amazon', exchange: 'Nasdaq', shares: 10_813_137_794 },
  { symbol: 'TSM', name: 'TSMC', exchange: 'NYSE', shares: 5_186_480_000 },
  { symbol: 'SPCX', name: 'SpaceX', exchange: 'Nasdaq', shares: 13_581_063_744 },
  { symbol: 'META', name: 'Meta', exchange: 'Nasdaq', shares: 2_556_240_994 },
  { symbol: 'AVGO', name: 'Broadcom', exchange: 'Nasdaq', shares: 4_773_630_000 },
  { symbol: 'TSLA', name: 'Tesla', exchange: 'Nasdaq', shares: 3_952_760_000 },
  { symbol: 'SKHY', name: 'SK hynix', exchange: 'Nasdaq', shares: 7_288_651_350 },
  { symbol: 'MU', name: 'Micron', exchange: 'Nasdaq', shares: 1_131_423_212 }, // one class of common stock
  { symbol: 'AMD', name: 'AMD', exchange: 'Nasdaq', shares: 1_640_090_000 },
  { symbol: 'SPY', name: 'S&P 500 ETF', exchange: 'NYSE Arca', shares: 1_060_582_116 },
  { symbol: 'PLTR', name: 'Palantir', exchange: 'Nasdaq', shares: 2_409_502_133 },
  { symbol: 'QQQ', name: 'Nasdaq-100 ETF', exchange: 'Nasdaq', shares: 691_650_000 },
  { symbol: 'INTC', name: 'Intel', exchange: 'Nasdaq', shares: 5_315_000_066 },
  { symbol: 'SNDK', name: 'Sandisk', exchange: 'Nasdaq', shares: 142_289_370 },
  { symbol: 'HOOD', name: 'Robinhood', exchange: 'Nasdaq', shares: 899_082_273 },
  { symbol: 'MSTR', name: 'Strategy', exchange: 'Nasdaq', shares: 430_100_000 },
  { symbol: 'COIN', name: 'Coinbase', exchange: 'Nasdaq', shares: 263_836_923 },
  { symbol: 'CRCL', name: 'Circle', exchange: 'NYSE', shares: 253_875_881 },
  { symbol: 'STRC', name: 'Stretch', exchange: 'Nasdaq', shares: 93_162_000, ownCap: true },
];

const plain = (v) => (typeof v === 'string' ? num(v.replace(/[,%+\s]/g, '')) : num(v)); // "12,026,836" -> 12026836
const SUFFIX = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
const scaled = (v) => { // "48.282B" -> 48282000000
  const m = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMBT])?\s*$/i.exec(typeof v === 'string' ? v : '');
  return m ? plain(m[1]) * (m[2] ? SUFFIX[m[2].toUpperCase()] : 1) : NaN;
};

/**
 * The card's fields from one source's numbers; null when there is no usable price (the backup gets a turn).
 * changePct: the source's own session change when it gives one. CNBC rolls its previous close forward overnight before
 * the next session (price / that close would read 0.00% until the open), while its change field keeps the last
 * session's move, as finance sites show it. Otherwise the change is computed from the previous close.
 */
function quote(s, price, prevClose, volShares, mcap, source, changePct = NaN) {
  if (!valid(price)) return null;
  return {
    price,
    change24h: Number.isFinite(changePct) ? changePct : valid(prevClose) ? (price / prevClose - 1) * 100 : null,
    mcap: valid(mcap) && !s.ownCap ? mcap : price * s.shares,
    vol24h: valid(volShares) ? volShares * price : null, // the session's share volume in dollars
    source,
  };
}

async function fetchCnbc(stocks) {
  const symbols = stocks.map((s) => s.symbol).join('%7C');
  const data = await getJson(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`);
  const rows = data?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(rows)) throw new Error('cnbc: unexpected response');
  const out = new Map();
  for (const s of stocks) {
    const r = rows.find((x) => x?.symbol === s.symbol && Number(x?.code) === 0);
    const q = r && quote(s, plain(r.last), plain(r.previous_day_closing), plain(r.volume), scaled(r.mktcapView), 'cnbc', plain(r.change_pct));
    if (q) out.set(s.symbol, q);
  }
  // An answer with nothing usable in it (every row an error code, no price) is a failure, not a recovery, as it is
  // for CoinGecko (feeds.js): logged as one, and every stock is left for the backup.
  if (!out.size) throw new Error('no usable rows');
  return out;
}

async function fetchRobinhood(stocks) {
  const symbols = stocks.map((s) => s.symbol).join(',');
  const [quotes, fundamentals] = await Promise.all([
    getJson(`https://api.robinhood.com/quotes/?symbols=${symbols}`),
    getJson(`https://api.robinhood.com/fundamentals/?symbols=${symbols}`).catch(() => null), // volume and mcap are optional
  ]);
  const out = new Map();
  for (const s of stocks) {
    const r = (quotes?.results ?? []).find((x) => x?.symbol === s.symbol && x?.state === 'active');
    if (!r) continue;
    // Fundamentals have no symbol: match on the instrument URL, and only when there is one to match.
    const f = r.instrument ? (fundamentals?.results ?? []).find((x) => x?.instrument === r.instrument) : undefined;
    const adj = num(r.adjusted_previous_close);
    const q = quote(s, num(r.last_trade_price), valid(adj) ? adj : num(r.previous_close), num(f?.volume), num(f?.market_cap), 'robinhood');
    if (q) out.set(s.symbol, q);
  }
  return out;
}

/** Map of symbol -> { price, change24h, mcap, vol24h, source }. CNBC first, Robinhood for anything missing. A source
 * that fails is logged when it starts, once an hour while it lasts, and when it recovers (log.js), as the coin feeds. */
export async function fetchStocks(stocks = STOCKS) {
  let out = new Map();
  try {
    out = await fetchCnbc(stocks);
    ok('stocks cnbc');
  } catch (e) {
    warn('stocks cnbc', e.message);
  }
  const missing = stocks.filter((s) => !out.has(s.symbol));
  if (missing.length) {
    try {
      for (const [k, v] of await fetchRobinhood(missing)) out.set(k, v);
      ok('stocks robinhood');
    } catch (e) {
      warn('stocks robinhood', e.message);
    }
  }
  if (!out.size) throw new Error('no stock source responded');
  return out;
}
