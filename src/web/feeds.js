// Coin price feeds. CoinGecko is the primary (aggregated spot price with 24h change, market cap and volume, no key
// needed); Hyperliquid's public info API, Backpack, Coinbase, Binance and BigONE fill in anything CoinGecko misses.
import { ok, warn } from './log.js';
import { getJson, num, valid } from './net.js';

/** Map of symbol -> { price, change24h, mcap, vol24h, updatedAt, source } for every coin CoinGecko returned sensibly. */
export async function fetchCoinGecko(coins) {
  const ids = coins.map((c) => c.coingecko).join(',');
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true`);
  const out = new Map();
  for (const c of coins) {
    const row = data?.[c.coingecko];
    const price = num(row?.usd);
    const change = num(row?.usd_24h_change);
    const mcap = num(row?.usd_market_cap);
    const vol = num(row?.usd_24h_vol);
    const updated = num(row?.last_updated_at) * 1000;
    // A row CoinGecko has not updated for 10 minutes (a thin market, a stalled aggregation) is left for a backup to
    // price live; a row without the stamp is taken as it is. Its own cache alone makes rows a minute or so old.
    if (valid(price) && (!updated || Date.now() - updated < 600_000)) out.set(c.symbol, {
      price, change24h: Number.isFinite(change) ? change : null, mcap: valid(mcap) ? mcap : null,
      vol24h: valid(vol) ? vol : null, updatedAt: valid(updated) ? updated : null, source: 'coingecko',
    });
  }
  return out;
}

/** Same shape from Hyperliquid perp mark prices; 24h change from prevDayPx. */
export async function fetchHyperliquid(coins) {
  const [meta, ctxs] = await getJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const universe = meta?.universe ?? [];
  const names = universe.map((u) => u.name);
  const out = new Map();
  for (const c of coins) {
    const i = names.indexOf(c.hyperliquid);
    // A delisted perp keeps a context with its last mark price frozen: not a price, so the next source gets a turn.
    if (i < 0 || universe[i].isDelisted) continue;
    const price = num(ctxs?.[i]?.markPx);
    const prev = num(ctxs?.[i]?.prevDayPx);
    if (valid(price)) out.set(c.symbol, { price, change24h: valid(prev) ? (price / prev - 1) * 100 : null, source: 'hyperliquid' });
  }
  return out;
}

/** One request per coin, in parallel; a coin whose request fails is just missing, so the next source gets a turn. */
async function perCoin(coins, fetchOne) {
  const results = await Promise.allSettled(coins.map(async (c) => [c.symbol, await fetchOne(c)]));
  const out = new Map();
  for (const r of results) if (r.status === 'fulfilled' && r.value[1]) out.set(r.value[0], r.value[1]);
  const failed = results.find((r) => r.status === 'rejected');
  if (!out.size && failed) throw failed.reason;
  return out;
}

/** Backpack Exchange public ticker (BP, which Hyperliquid does not list, and the other coins with a Backpack market).
 * A symbol Backpack does not know gets a 204 with no body, which getJson hands back as null: no quote, not a failure. */
export function fetchBackpack(coins) {
  return perCoin(coins, async (c) => {
    const t = await getJson(`https://api.backpack.exchange/api/v1/ticker?symbol=${encodeURIComponent(c.backpack)}`);
    const price = num(t?.lastPrice);
    // A fraction: 0.27 means +27%.
    const change = num(t?.priceChangePercent);
    return valid(price) ? { price, change24h: Number.isFinite(change) ? change * 100 : null, source: 'backpack' } : null;
  });
}

/** Coinbase Exchange 24h stats (USD): the last trade and the price 24 hours ago. */
export function fetchCoinbase(coins) {
  return perCoin(coins, async (c) => {
    const s = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(c.coinbase)}/stats`);
    const price = num(s?.last);
    const open = num(s?.open);
    return valid(price) ? { price, change24h: valid(open) ? (price / open - 1) * 100 : null, source: 'coinbase' } : null;
  });
}

/** Binance spot 24h ticker (USDT, within a fraction of a percent of USD): rolling 24h change. */
export function fetchBinance(coins) {
  return perCoin(coins, async (c) => {
    const t = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(c.binance)}`);
    const price = num(t?.lastPrice);
    const change = num(t?.priceChangePercent);
    return valid(price) ? { price, change24h: Number.isFinite(change) ? change : null, source: 'binance' } : null;
  });
}

/** BigONE public ticker (USDT): QTC, which trades on no other exchange the site reads. open is the price 24 hours ago,
 * close the last trade. */
export function fetchBigone(coins) {
  return perCoin(coins, async (c) => {
    const t = (await getJson(`https://big.one/api/v3/asset_pairs/${encodeURIComponent(c.bigone)}/ticker`))?.data;
    const price = num(t?.close);
    const open = num(t?.open);
    return valid(price) ? { price, change24h: valid(open) ? (price / open - 1) * 100 : null, source: 'bigone' } : null;
  });
}

/** CoinGecko first; Hyperliquid, Backpack, Coinbase, Binance, then BigONE fill whatever is missing. Throws only if nothing
 * responds. A source that fails (CoinGecko's keyless API often answers Railway's shared address with 429) is logged
 * when it starts, once an hour while it lasts, and when it recovers (log.js), not every minute. */
export async function fetchPrices(coins) {
  let prices = new Map();
  try {
    prices = await fetchCoinGecko(coins);
    // A 200 with nothing usable in it (an empty object, an error document) is a failure, not a recovery.
    if (!prices.size) throw new Error('no usable rows');
    ok('coingecko');
  } catch (e) {
    warn('coingecko', e.message);
  }
  const backups = [
    ['hyperliquid', (c) => c.hyperliquid, fetchHyperliquid],
    ['backpack', (c) => c.backpack, fetchBackpack],
    ['coinbase', (c) => c.coinbase, fetchCoinbase],
    ['binance', (c) => c.binance, fetchBinance],
    ['bigone', (c) => c.bigone, fetchBigone],
  ];
  for (const [name, listed, fetcher] of backups) {
    const missing = coins.filter((c) => !prices.has(c.symbol) && listed(c));
    if (!missing.length) continue;
    try {
      for (const [k, v] of await fetcher(missing)) prices.set(k, v);
      ok(name);
    } catch (e) {
      warn(name, e.message);
    }
  }
  if (!prices.size) throw new Error('no price source responded');
  return prices;
}
