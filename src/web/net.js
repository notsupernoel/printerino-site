// The upstream call every price and stock feed makes (feeds.js, stocks.js): one JSON answer with the site's user agent,
// an 8 s timeout and a 4 MB cap on the body, so a venue that streams an endless answer can never fill the container's
// memory. history.js guards its chart calls the same way, inside its own limiter, which the price feeds do not use.
export const UA = 'printerino-site/1.0 (price page)';
export const TIMEOUT_MS = 8000;
// The same cap as the charts'; the largest real answer here (CNBC's quotes for the 23 stocks) is about a hundred KB.
export const MAX_BODY = 4 * 1024 * 1024;

export const valid = (n) => Number.isFinite(n) && n > 0;
// Strict number parsing: real numbers and numeric strings only. Number() would turn null, '', false and [5]
// into 0 or 5, so an explicit null 24h change from an API would show as a made-up flat 0.00%.
export const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** The parsed JSON of one upstream answer, or null for a 204 or an empty body (what Backpack answers for a symbol it
 * does not list: no quote, not an error). Every failure throws a message fixed per host and reason ('HTTP 429 from
 * api.coingecko.com', 'timeout from ...', 'no answer from ...', 'answer over 4 MB from ...', 'unreadable answer from
 * ...'), so the log reads the same line for the same trouble. */
export async function getJson(url, init = {}) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? `timeout from ${host}` : `no answer from ${host}`);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} from ${host}`);
  }
  if (res.status === 204) return null;
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
    throw new Error(e?.name === 'TimeoutError' ? `timeout from ${host}` : `broken answer from ${host}`);
  }
  if (size > MAX_BODY) throw new Error(`answer over 4 MB from ${host}`);
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(`unreadable answer from ${host}`);
  }
}
