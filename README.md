# printerino-site

The source of **https://printerino.com**: live prices for 28 coins, 23 stocks and 6 commodities, ranked by market
cap and refreshed every minute, each with a price chart. Dark and light themes, with liquid glass on the things you
press. Not financial advice.

## How it works

- `src/web/server.js` is plain `node:http` with no dependencies. It fetches prices once a minute, keeps them in
  memory and serves every visitor from there, so visitors never call a data source. The page polls `/api/prices`
  every 30 s.
- **Coins** (`coins.js`, `feeds.js`): one CoinGecko call for all of them, then Hyperliquid, Backpack, Coinbase,
  Binance and BigONE for anything missing. When CoinGecko rate-limits, prices come from the backups and market caps
  follow them at the supply implied by CoinGecko's last answer. Ranks use `ranking.js` (a 1% margin before two
  coins swap).
- **Stocks** (`stocks.js`): one keyless CNBC quote call, Robinhood's public quotes for anything missing.
- **Commodities** (`commodities.js`): the front-month futures. CNBC first, Yahoo Finance next, Hyperliquid's `xyz`
  perps last. Gold and silver carry a market cap (metal above ground x price); the others have none.
- **Charts** (`history.js`): `GET /api/history?s=BTC&i=4H` (1H, 4H, 1D, 1W) returns the latest 150 candles. Each
  symbol has a chain of public, keyless sources, cached per symbol and size, served stale while a refresh runs, with
  a per-host limiter and back-off. A source that is down, stale or more than 5% off the card price hands over to the
  next.
- **Week lines** (`history.js`): every symbol's 1H chart is kept warm in the background, one at a time, a pass every
  ten minutes. `GET /api/week` returns each card's last week or so as at most 48 closes, read off those cached
  charts, so the lines call no source of their own.
- Every feed call goes through `net.js`: one user agent, an 8 s timeout, a 4 MB body cap. A feed that fails is
  logged when it starts failing, once an hour while it lasts, and when it recovers (`log.js`).
- Stateful code is written as explicit state machines (`machine.js` on the server, the same small factory in each
  page script).

## The page

The watchlist opens on a stage of three leaders (on All, the first coin, stock and commodity; on a tab, that tab's
top three), and lists everything else under it as a board of rows or as tiles, whichever the switch over the list
says. Once the page is scrolled past that switch, a twin of it stands in the top bar, between the theme switch and
the X link, and leaves again when the list's own bar is back in the window. Every card draws its last seven days as
a line from `/api/week`, fetched after the first paint. In the light
theme each coin is drawn from its own light twin (`iconLight`).

A card opens into the chart panel, laid out as a leader opened up: the coin and its names, the price under them, the
day's four figures on the header's right, the pickers on the chart's top edge, and the chart under them. On a phone it is a bottom sheet in the same order. The share card redraws that panel.

`src/web/public/`:

- `index.html`: the markup, plus two JSON blocks the server fills (the first prices, and fingerprinted asset URLs).
- `style.css`: both themes' tokens, the glass and every fallback.
- `theme-boot.js`: a tiny blocking script that sets the theme before the first paint.
- `app.js`: the data, the grid, the chart panel and chart, the theme switch, one shared frame loop.
- `glass.js`: an ES module loaded after the first paint, with the glass in motion (presses, sliding pills, lenses).
  Without it the page works fully, just stiller.
- `share.js`: an ES module loaded once a chart panel has settled; redraws the panel on a canvas as a share card.
- `glass/`: the displacement and light maps the glass reads, all drawn by `tools/glass/`. The rim lenses that only
  clear glass bends through are fetched once the glass is clear, never under frosted glass.
- `min/`: minified scripts and stylesheet, built by `tools/min/build.mjs`.

## Security

- No secrets, no `.env`. Only a fixed list of files, read into memory at start, can be served; nothing on disk is
  reachable by path.
- Strict Content-Security-Policy (same origin only, no inline script or style), HSTS, nosniff, no framing,
  COOP/CORP, no referrer, GET and HEAD only, header and request timeouts. Prices are rendered with `textContent`;
  there is no `innerHTML`.
- `/api/history` accepts exactly `s` and `i` from fixed lists and never echoes them. Its cache has one entry per
  symbol and size, so traffic cannot raise how often a source is called.

## Run locally

```bash
npm start
```

Serves http://localhost:8080 (`PORT` changes it). No install needed. The server reads the page's files once, at
start, so restart it after an edit. `MIN=0` serves the unminified sources, `WEBP=0` the PNGs instead of WebP.

## Build tools

`tools/` is never served. It has its own `tools/package.json` (esbuild, sharp) and a Python venv (fonttools):

```bash
cd tools && npm install
```

```bash
python3 -m venv tools/.venv && tools/.venv/bin/pip install fonttools brotli
```

- `node tools/min/build.mjs`: rebuild `min/` after editing a script or the stylesheet. Without a matching build the
  server serves the source, so a stale build costs bytes, never correctness.
- `node tools/glass/all.mjs`: redraw every glass map (`--check` proves the served maps match).
- `node tools/png/squeeze.mjs <file>` and `node tools/png/webp.mjs`: the smallest PNG with the same pixels, and a
  lossless WebP beside each one that comes out smaller that way, checked pixel for pixel (`--check` on either covers
  the icons, their light twins and the glass maps).
- `node tools/png/light.mjs`: write the light theme's twin of every icon (`assets/coin-icons/192/light/`), the same
  art with its two dark outlines softened; run `webp.mjs` after it (`--check` proves the twins are current).
- `tools/.venv/bin/python tools/font/trim.py`: cut the Inter font to the page's own characters.
- `node tools/colour/law.mjs --check`: confirm the light palette is derived from the dark one.

Text is served with brotli (gzip as the fallback); the font and images are already compressed formats.

## Licences

Inter is under the SIL Open Font License (`src/web/public/fonts/LICENSE-Inter.txt`). Everything else is
© notsupernoel, all rights reserved.
