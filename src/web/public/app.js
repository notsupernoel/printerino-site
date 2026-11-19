// Renders the watchlist (a stage of three leaders, then the list as a board or as tiles) from /api/prices and refreshes
// it, draws each card's last seven days as a line (/api/week, asked for after the first paint), and opens a chart
// panel for any card. The first render uses
// the JSON the server embedded in the page, so prices show without waiting for a second request. Direction is shown
// by sign and colour only, unknown values read "n/a", and no figure ever animates.
// Only drawings move (the panel, the coin, the line, the candles), and every motion can be interrupted.
// Every comment in this file sits on a line of its own: the server strips comment lines before serving it.
// The page loads it at the very end of its body, a plain script and not a deferred one, so it never runs before the
// stylesheet has arrived: WebKit runs deferred and module scripts without waiting for stylesheets, and the notice's
// toggle and the entrance read the laid-out page. The page is small (about 6 KB compressed) and arrives in one go, so
// browsers find this about as soon as they did in the head. Chrome even sends for it sooner than for a deferred script,
// and at a higher priority: on a slow line the cards come in sooner, for a slightly later first paint. No preload in
// the head: with scripting off it would be fetched for nothing.
// The list (#grid), the stage of leaders above it and the bar between them. The stage and the bar are optional: a page
// cached from an older deploy has neither, and then every card sits in the list.
const grid = document.getElementById('grid');
const stage = document.getElementById('stage');
const listbar = document.querySelector('.listbar');
// The boxes that hold cards, in page order.
const cardBoxes = [stage, grid].filter(Boolean);
const updatedEl = document.getElementById('updated');
const dotEl = document.getElementById('dot');
const countEl = document.getElementById('count');
const stockCountEl = document.getElementById('scount');
const commodCountEl = document.getElementById('ccount');
const tapeEl = document.getElementById('tape');
const REFRESH_MS = 30_000;
// A real minus sign, not a hyphen.
const MINUS = '−';
const NA = 'n/a';
// The hero's ghost tape, five rows whatever the market-cap order: the trifecta, MET and ZEC (only the tops of ZEC's row
// show above the hero's bottom edge).
const TAPE = ['BTC', 'ETH', 'SOL', 'MET', 'ZEC'];
// Beside it on wide screens, row for row: the stock trio, ANT and SPCX.
const TAPE_STOCKS = ['COIN', 'HOOD', 'CRCL', 'ANT', 'SPCX'];
let data = null;
let retry = 0;
// What the tape and the status line show now, so each is written only when its words change.
let tapeShown = '';
let statusShown = '';
// Server clock minus this device's clock, from the Date header of fresh responses.
let offset = 0;

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Whole dollars from $1,000, cents from $1, three significant figures under $1.
function fmtPrice(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return NA;
  if (n === 0) return '$0';
  if (Math.round(n * 100) / 100 >= 1000) return `$${WHOLE.format(n)}`;
  if (n >= 1) return `$${CENTS.format(n)}`;
  const fixed = n.toFixed(Math.min(100, Math.max(2, -Math.floor(Math.log10(n)) + 2)));
  return Number(fixed) >= 1 ? `$${CENTS.format(n)}` : `$${fixed}`;
}
// A compact figure with a dollar sign, always two decimals: $1.74T, $333.81B, $7.10B, $812K.
function fmtCompact(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return NA;
  for (const [unit, letter] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']]) {
    const fixed = (n / unit).toFixed(2);
    if (n >= unit || Number(fixed) >= 1) return `$${fixed}${letter}`;
  }
  return n >= 1e4 ? `$${Math.round(n / 1e3)}K` : `$${WHOLE.format(n)}`;
}
function fmtChange(ch) {
  if (!Number.isFinite(ch)) return { text: NA, tone: '' };
  if (Math.abs(ch) < 0.005) return { text: '0.00%', tone: '' };
  return { text: `${ch > 0 ? '+' : MINUS}${Math.abs(ch).toFixed(2)}%`, tone: ch > 0 ? 'gain' : 'loss' };
}
// A signed dollar move at the precision of the price beside it: whole dollars next to $85,310 (−$882), cents next to
// $112.82 (+$0.08), and the price's own decimals under $1 (−$0.00021 next to $0.004123).
function fmtMove(v, price) {
  if (!Number.isFinite(v)) return NA;
  const a = Math.abs(v);
  const p = price > 0 ? price : a;
  let s;
  if (Math.round(p * 100) / 100 >= 1000) s = `$${WHOLE.format(a)}`;
  else if (p >= 1) s = `$${CENTS.format(a)}`;
  else s = `$${a.toFixed(Math.max(2, -Math.floor(Math.log10(p)) + 2))}`;
  if (/^\$0(\.0*)?$/.test(s)) return s;
  return `${v > 0 ? '+' : MINUS}${s}`;
}

// Builds DOM with textContent-style children only: no innerHTML anywhere on the page.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // A style attribute is refused: the page's CSP forbids inline styles (styles go through node.style instead).
    if (k === 'style') continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (k !== 'style') node.setAttribute(k, v);
  return node;
}
const setText = (node, s) => { if (node.textContent !== s) node.textContent = s; };
const setClass = (node, s) => { if (node.className !== s) node.className = s; };
// Wrapped: storage can be missing or throw (private windows, blocked site data); it only ever holds conveniences.
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {
    // Nothing to do: the choice just is not remembered.
  }
}

// An explicit state machine (every state machine on the site is declared, not implied):
// its states are the keys of `moves`, each listing the states it may move to. go() refuses any other move (false,
// nothing changes); epoch counts the moves, so a callback that started in one state can tell it has been overtaken;
// on() hears every move as (to, from), which is where what follows from a state is applied.
function machine(initial, moves) {
  const subs = [];
  const m = {
    state: initial,
    epoch: 0,
    is: (...names) => names.includes(m.state),
    can: (next) => next !== m.state && (moves[m.state] || []).includes(next),
    go(next) {
      if (!m.can(next)) return false;
      const from = m.state;
      m.state = next;
      m.epoch += 1;
      for (const f of subs) f(next, from);
      return true;
    },
    on(f) { subs.push(f); return m; },
  };
  return m;
}
// A module fetched when first wanted (glass.js, share.js). Its states:
//   idle     never asked for;
//   loading  asked for, on its way;
//   ready    in (or known to be missing: there is nothing to retry);
//   failed   the fetch failed (offline for a moment): the next trigger asks again, at most once every `rest` ms.
// get() hands back the one promise of the load under way or done (null for a failure), or starts one.
function lazyModule(load, rest) {
  const m = machine('idle', { idle: ['loading'], loading: ['ready', 'failed'], failed: ['loading'], ready: [] });
  let promise = null;
  let failedAt = 0;
  m.on((to) => { if (to === 'failed') { failedAt = performance.now(); promise = null; } });
  m.get = () => {
    if (m.is('loading', 'ready')) return promise;
    if (m.is('failed') && performance.now() - failedAt < rest) return Promise.resolve(null);
    m.go('loading');
    const run = m.epoch;
    promise = Promise.resolve(load()).then((v) => {
      if (m.epoch === run) m.go('ready');
      return v;
    }, () => {
      if (m.epoch === run) m.go('failed');
      return null;
    });
    return promise;
  };
  return m;
}

// ---- motion ----
// The page's ease (the iOS sheet curve): fades, the veil, the sheet. Springs use SwiftUI's response and damping.
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';
// A glint crosses at an even pace (EASE would be gone before the eye found it).
const SWEEP = 'cubic-bezier(0.45, 0.05, 0.3, 1)';
const SPRING = {
  gentle: { response: 0.5, damping: 0.85 },
  snappy: { response: 0.3, damping: 0.9 },
  smooth: { response: 0.42, damping: 1 },
  ret: { response: 0.42, damping: 0.92 },
  pop: { response: 0.38, damping: 0.72 },
  // The coin's turn on its way to the panel. The turn itself is COIN_TURN below (none); the spring
  // still times the flight.
  spin: { response: 0.55, damping: 0.86 },
  // The coin's size as it lands: one soft overshoot (damping 0.72, about Apple's "bouncy").
  bounce: { response: 0.46, damping: 0.72 },
  // The phone sheet's coin: the same, quick enough to land with the sheet.
  spinSheet: { response: 0.42, damping: 0.86 },
  bounceSheet: { response: 0.36, damping: 0.75 },
};
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const FINE = matchMedia('(hover: hover) and (pointer: fine)');
const PHONE = matchMedia('(max-width: 639px), (pointer: coarse) and (max-height: 500px)');
// The engine, for the glass's paths (glass.js): Chromium draws SVG lenses in backdrop-filter, WebKit (every browser on
// an iPhone) does not, and Firefox is untested there. Read from the client hints, else the user agent.
const ENGINE = (() => {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands ?? [];
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1 && !brands.length);
  const chromium = brands.some((b) => /Chromium/.test(b.brand)) || (!ios && /(Chrome|Chromium)\/\d/.test(ua));
  const gecko = !chromium && /Firefox\/\d/.test(ua);
  return { ios, chromium, webkit: !chromium && !gecko && /AppleWebKit\//.test(ua), gecko };
})();
// html.wk marks WebKit for the stylesheet: the top bar's merge stays off there until glass.js cuts it (style.css).
if (ENGINE.webkit) document.documentElement.classList.add('wk');
// The fingerprinted URLs the server hands over for what is loaded later: glass.js and its lens maps.
const ASSETS = (() => {
  try { return JSON.parse(document.getElementById('assets')?.textContent || '{}') || {}; } catch { return {}; }
})();
// glass.js's hooks, once it is in (loadGlass); until then every G?.x() is nothing.
let G = null;
const lerp = (a, b, p) => a + (b - a) * p;
// Degrees the coin turns as it flies to the panel and back. None: a full turn (-360) would be a flourish on the page's
// most frequent action, which Apple's motion rules advise against, so the coin only grows into place.
const COIN_TURN = 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A spring from 0 to 1. v0 is the starting velocity in whole distances per second (toward the target is positive).
function springFn({ response, damping, v0 = 0 }) {
  const w = (2 * Math.PI) / response;
  if (damping < 1) {
    const wd = w * Math.sqrt(1 - damping * damping);
    const B = (damping * w - v0) / wd;
    return (t) => 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + B * Math.sin(wd * t));
  }
  const B = w - v0;
  return (t) => 1 - Math.exp(-w * t) * (1 + B * t);
}
const settled = new Map();
// Milliseconds until the spring stays within 0.1% of its target.
function settleMs(spring) {
  const key = `${spring.response}|${spring.damping}|${spring.v0 ?? 0}`;
  let ms = settled.get(key);
  if (ms === undefined) {
    const f = springFn(spring);
    let last = 0;
    for (let t = 0; t <= 2000; t += 2) if (Math.abs(f(t / 1000) - 1) > 0.001) last = t;
    ms = last + 2;
    // Remembered for the fixed springs only: one that sets off at a release velocity (the sheet's) is never the same
    // twice, and would fill the map for nothing.
    if (!spring.v0) settled.set(key, ms);
  }
  return ms;
}
// A spring from 0 to 1 that is home before its last frame. settleMs stops with up to 0.1% of the way still to go, a
// pixel or two on a long flight, which whatever takes over at the end (the card after a close, the panel at rest after
// an open) would show as a snap. From 140 ms before the end the spring is drawn the rest of the way home (smoothly,
// still easing to a stop), and it is home 24 ms early, so the last frame or two (whenever the display draws them) show
// every part exactly at rest.
const homed = new Map();
function homing(spring) {
  let h = homed.get(spring);
  if (!h) {
    const f = springFn(spring);
    const D = settleMs(spring);
    h = (ms) => {
      if (ms >= D - 24) return 1;
      const w = clamp((ms - D + 140) / 116, 0, 1);
      return 1 - (1 - f(ms / 1000)) * (1 - w * w * (3 - 2 * w));
    };
    homed.set(spring, h);
  }
  return h;
}
// Keyframes every ~16 ms, linear between them: a composited animation that follows any curve the frame function draws.
function sampled(node, duration, frameAt, extra = {}) {
  const K = Math.max(12, Math.ceil(duration / 16));
  const frames = [];
  for (let k = 0; k <= K; k++) frames.push({ offset: k / K, ...frameAt((k / K) * duration, k === K) });
  return node.animate(frames, { duration, easing: 'linear', ...extra });
}
function springAnim(node, spring, frame, extra = {}) {
  const f = springFn(spring);
  return sampled(node, settleMs(spring), (ms, last) => frame(last ? 1 : f(ms / 1000)), extra);
}
// A critically damped step toward a target (closed form, frame-rate independent): the pointer-led motions.
function follow(s, target, dt, w) {
  const x = s.x - target;
  const B = s.v + w * x;
  const e = Math.exp(-w * dt);
  s.x = target + (x + B * dt) * e;
  s.v = (s.v - w * B * dt) * e;
}

// ---- one frame loop for everything that springs or follows the pointer ----
// The coins' tilt below, and glass.js's controls, droplets and theme change: each is a job, called once a frame with
// the frame's step (in seconds) and its time, that returns false once it is still. The loop runs only while a job
// does, so a page at rest draws nothing.
// The loop is a machine of its own: asleep (no frame asked for) or awake (a frame asked for, or one
// running). A job that wakes it while a frame runs leaves it awake: the end of that frame asks for the next, so two
// chains of frames can never run side by side (they could, when a job woke the loop from inside a frame).
const jobs = new Set();
const loop = machine('asleep', { asleep: ['awake'], awake: ['asleep'] });
let wakeLast = 0;
function wake(job) {
  jobs.add(job);
  if (loop.go('awake')) { wakeLast = 0; requestAnimationFrame(wakeFrame); }
}
function wakeFrame(now) {
  // The first frame after a wake counts as one frame (its time can come from before the event that woke it).
  const dt = wakeLast ? clamp((now - wakeLast) / 1000, 0.001, 0.05) : 1 / 60;
  wakeLast = now;
  for (const job of [...jobs]) {
    let more = false;
    try {
      more = job(dt, now) !== false;
    } catch (e) {
      // One broken job never stops the others: it leaves the loop, and its error is reported.
      setTimeout(() => { throw e; });
    }
    if (!more) jobs.delete(job);
  }
  if (jobs.size) requestAnimationFrame(wakeFrame);
  else loop.go('asleep');
}

// ---- tilt: the coin turns toward the pointer (card hover, and the open panel) ----
const tilts = new Map();
// Aims node at (rx, ry) degrees. It eases there and parks: its last transform stays written and nothing runs until it
// is aimed again (a pointer resting on the open panel costs nothing). Back at rest it lets go of its transform.
function aim(node, rx, ry, persp, response = 0.3) {
  let s = tilts.get(node);
  if (!s) { s = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0, persp, w: (2 * Math.PI) / response, parked: false }; tilts.set(node, s); }
  s.tx = rx; s.ty = ry; s.persp = persp; s.w = (2 * Math.PI) / response; s.parked = false;
  wake(tiltJob);
}
function tiltJob(dt) {
  let moving = false;
  for (const [node, s] of tilts) {
    if (s.parked) continue;
    follow(s.x, s.tx, dt, s.w);
    follow(s.y, s.ty, dt, s.w);
    const still = Math.abs(s.x.x - s.tx) < 0.01 && Math.abs(s.y.x - s.ty) < 0.01 && Math.abs(s.x.v) + Math.abs(s.y.v) < 0.05;
    if (still && s.tx === 0 && s.ty === 0) { node.style.transform = ''; tilts.delete(node); continue; }
    if (still) { s.x.x = s.tx; s.y.x = s.ty; s.x.v = 0; s.y.v = 0; s.parked = true; } else moving = true;
    node.style.transform = `perspective(${s.persp}px) rotateX(${s.x.x.toFixed(2)}deg) rotateY(${s.y.x.toFixed(2)}deg)`;
  }
  return moving;
}
function unaim(node) {
  if (tilts.has(node)) aim(node, 0, 0, tilts.get(node).persp);
}

// ---- the coin's pixel glint ----
// A coin's middle and radius, where it is drawn now.
function centreOf(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
}
// The glint: a band of light that crosses the coin's art once, a composited animation.
function glintPlay(band, dur, delay = 0) {
  for (const a of band.getAnimations()) a.cancel();
  band.animate([{ transform: 'translateX(-130%)' }, { transform: 'translateX(130%)' }], { duration: dur, delay, easing: SWEEP });
}

// ---- the dock: what the stage and the list show (All, Coins, Stocks, Commods) ----
// A stock is the item with an exchange, a commodity the one the server marks so (it names a unit instead: per oz, per
// bbl). The choice lasts for this visit only: every arrival starts on All.
function isCommodity(c) { return c?.kind === 'commodity'; }
const kindOf = (c) => (c.exchange ? 'stock' : isCommodity(c) ? 'commod' : 'coin');
// What stands after a card's name: a stock's exchange, a commodity's unit.
const tailOf = (c) => (c.exchange ? c.exchange : isCommodity(c) && c.unit ? `per ${c.unit}` : '');
const dock = document.querySelector('.dock');
const dockSeg = dock?.querySelector('.seg-show') ?? null;
// What the stage and the list show, the dock's choice. Its states:
//   all     every card;
//   coin    the coins only;
//   stock   the stocks only;
//   commod  the commodities only.
// Any choice may follow any other; setShow is the one way in, and what follows from it (the pressed segment, the pill,
// the cards sorted out) is applied there.
const KINDS = ['all', 'coin', 'stock', 'commod'];
const filter = machine('all', Object.fromEntries(KINDS.map((k) => [k, KINDS.filter((j) => j !== k)])));
const shown = (c) => filter.is('all', kindOf(c));
function dockPlace(animate, byUser = false) {
  const b = dockSeg?.querySelector(`button[data-k="${filter.state}"]`);
  if (b) segPlace([[dockSeg, b.offsetLeft, b.offsetWidth, filter.state]], animate, byUser);
}
// A panel flying home into its card (flightCard: landing) lands at once, without handing focus back to that card, as
// it does for a card clicked or a theme chosen mid-close. The dock's choice and the layout switch call this before
// they change anything: either would re-seat or re-form the card under a flight aimed at the box it had.
function landNow() {
  if (flightCard.is('landing')) finishClose(false);
}
function setShow(kind, byUser = true) {
  if (!dockSeg || !filter.can(kind)) return;
  landNow();
  filter.go(kind);
  segSet(dockSeg, 'data-k', kind);
  dockPlace(!REDUCED.matches, byUser);
  sortGrid();
}
// The stage and the list take the dock's choice (arrange, below): the cards sorted out go at once, the ones that stay
// glide to their new places on the re-rank's spring, and the ones that come back, or that step onto the stage or off
// it, rise in. A page scrolled into the list goes back to the stage's top first (where the hero's Price Watchlist
// capsule lands), so the answer is in view. Nothing moves under reduced motion.
function sortGrid() {
  revealAll();
  arrange('dock');
}
// The dock comes up once the stage has reached it and stays over the rest of the page (the stage above the window
// still counts); it goes back under the window when the stage is below it again. An observer says so: no scroll
// listener.
// The dock's states:
//   under  below the window, inert (no card yet, or the stage not reached);
//   up     over the page (.on), taking clicks.
// The observer only reports a crossing, so its box reaches far above the window: a stage above the window is then
// inside it like one on screen, and a jump straight past the stage (the End key, a restored scroll in a window too
// short to show the stage at the top) is a crossing too. With the window's own box such a jump was never reported.
const dockBar = machine('under', { under: ['up'], up: ['under'] });
dockBar.on((to) => {
  dock.classList.toggle('on', to === 'up');
  dock.inert = to !== 'up';
});
let dockReach = false;
function dockSync() {
  if (!dock) return;
  dockBar.go(dockReach && nodes.size > 0 ? 'up' : 'under');
}
if (dock && grid && typeof IntersectionObserver === 'function') {
  new IntersectionObserver(([e]) => {
    dockReach = e.isIntersecting || e.boundingClientRect.top < 0;
    dockSync();
  }, { rootMargin: '100000px 0px -96px 0px' }).observe(stage ?? grid);
}
dockSeg?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setShow(b.getAttribute('data-k')); });
// The pill stands where a press put it, in pixels, and the dock's segments change width with the window (the
// stylesheet's narrower dock, a phone turned): it is placed again, without motion, whenever the dock's box changes
// size. An observer says so: nothing is read per frame.
if (dockSeg && typeof ResizeObserver === 'function') new ResizeObserver(() => dockPlace(false)).observe(dockSeg);
// The way back up: a round bud beside the dock as soon as the picks row (the LIVE PRICES line) has left the top of the
// window. An observer says so: no scroll
// listener, and a jump down the page is seen as well as a scroll.
const toTop = dock?.querySelector('.totop') ?? null;
const picksRow = document.querySelector('.bar');
// The bud's states:
//   hidden  the picks row is still on screen (or below it);
//   shown   the row has left the top of the window: .up on the dock shows the bud.
const topBud = machine('hidden', { hidden: ['shown'], shown: ['hidden'] });
topBud.on((to) => dock.classList.toggle('up', to === 'shown'));
if (toTop && picksRow && typeof IntersectionObserver === 'function') {
  new IntersectionObserver(([e]) => { topBud.go(!e.isIntersecting && e.boundingClientRect.bottom < 0 ? 'shown' : 'hidden'); }).observe(picksRow);
  toTop.addEventListener('click', () => {
    // The bud goes as the page nears the top, and a control that is not drawn cannot keep the focus (it would fall to
    // the page): a focus the bud holds goes on to where the page is going, the top bar's first control, its ring as
    // the bud's was (none after a pointer's press).
    const first = document.activeElement === toTop && [...(topBar?.querySelectorAll('a[href], button') ?? [])].find((node) => node.getClientRects().length);
    const ring = ringed(toTop);
    scrollTo({ top: 0, behavior: REDUCED.matches ? 'auto' : 'smooth' });
    if (first) focusTo(first, ring);
  });
}

// ---- the cards: patched in place, so a hovered card or an open one survives every refresh ----
// One card per asset, the same node whatever it is laid out as: a leader on the stage, a row of the board or a tile
// (the stylesheet lays the same children out three ways).
// symbol -> { li, refs, item, names, reveal, seat, line, tick }
const nodes = new Map();
// The cards in the data's order: the coins, then the stocks, then the commodities, each by market cap.
let ranked = [];
// The page's entrance, played once per page load as the first cards are drawn (enter(), below, plays it and says what
// it is). Its states:
//   due      not played yet (no card drawn yet);
//   playing  the cards' wave and the stylesheet's entrance are running;
//   done     played, or skipped: glass.js is not loaded in the middle of it (glassSoon).
// Declared here, above everything that asks it: until the first cards are drawn (due) nothing on the page moves, so a
// figure does not roll, a chip does not flash and the cards take their places at once.
const entrance = machine('due', { due: ['playing', 'done'], playing: ['done'], done: [] });
const ICON_URL = /^\/icons\/(light\/)?[a-z0-9]+\.(png|webp)(\?v=[0-9a-f]+)?$/;
// Each coin has two pictures: its art as drawn (icon), for the dark ground, and a twin for paper (iconLight, the same
// art with its dark ring softened). The twin is only ever named on paper, so a dark page never fetches one. An item
// that names no twin (an answer cached from an older deploy) keeps its one picture on both grounds.
// The ground the page draws, which is the theme applied (the theme chosen is `theme`, in the theme's section: the page
// may still be on its way to it). Its states:
//   dark   the dark ground;
//   light  paper.
// It starts on what theme-boot.js drew before the first paint (html[data-theme], read here once), and applyTheme is the
// one place that moves it. What follows from it is written on the move (groundShow, in the theme's section): the
// attribute the stylesheet reads, the browser's bar colour, the logo's naming and every coin's picture. Whatever asks
// which ground the page is on asks this machine, never the attribute.
const ground = machine(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', { dark: ['light'], light: ['dark'] });
const onPaper = () => ground.is('light');
const coinUrl = (c, paper = onPaper()) => (paper && ICON_URL.test(c.iconLight ?? '') ? c.iconLight : c.icon);
// A coin's picture, named twice more beside its image: the glint's mask (the light is cut to the coin's own pixels) and
// --art on the coin's box, the twin that casts its contact shadow on paper (style.css).
function coinArt(box, glint, url) {
  if (!ICON_URL.test(url)) return;
  glint.style.webkitMaskImage = `url("${url}")`;
  glint.style.maskImage = `url("${url}")`;
  box.style.setProperty('--art', `url("${url}")`);
}
// Points a coin at a picture, in all three places that name it: its image, then its glint and its box (coinArt).
// Nothing is written when the image already shows that picture.
function coinShow(img, box, glint, url) {
  if (typeof url !== 'string' || img.getAttribute('src') === url) return;
  img.setAttribute('src', url);
  coinArt(box, glint, url);
}

function buildCard(c) {
  const art = coinUrl(c);
  const icon = el('img', { class: 'icon', src: art, alt: '', width: '48', height: '48', decoding: 'async' });
  const band = el('span', { class: 'glint-band' });
  const glint = el('span', { class: 'glint', 'aria-hidden': 'true' }, band);
  // The coin: the art (the theme's own picture of it) and its glint. The tilt turns both together.
  const coin = el('span', { class: 'coin' }, icon, glint);
  coinArt(coin, glint, art);
  const sym = el('span', { class: 'sym' }, c.symbol);
  const open = el('button', { class: 'card-open', type: 'button', 'aria-haspopup': 'dialog' }, sym);
  const name = el('span', { class: 'name' });
  const price = el('div', { class: 'price' });
  const chg = el('span', { class: 'chg' });
  const key = el('span', { class: 'chg-key' });
  const mcap = el('dd');
  const vol = el('dd');
  const volKey = el('dt');
  const mcapBox = el('div', { class: 'st-mcap' }, el('dt', {}, 'Mcap'), mcap);
  const volBox = el('div', { class: 'st-vol' }, volKey, vol);
  // Its rank in its own kind (a board row's first cell) and its place as a leader ("No. 1 in Coins"): arrange() writes
  // both. The week's line is drawn into .spark (lineSet), an empty box of each form's own size until then.
  const rank = el('span', { class: 'rank' });
  const place = el('span', { class: 'place' });
  const spark = el('span', { class: 'spark', 'aria-hidden': 'true' });
  // The week's line in words, for assistive technology alone (the drawing is hidden from it, and so is the board's
  // header that names its column): read after the day's change, out of the layout (.sr-only), empty until the card
  // has a line (lineSet writes it).
  const week7 = el('span', { class: 'sr-only' });
  // Its role said outright: WebKit reads a list without markers (list-style: none) as a plain group unless it does.
  const li = el('li', { class: 'card', 'data-sym': c.symbol, role: 'listitem' },
    rank,
    el('div', { class: 'head' }, coin, el('div', { class: 'id' }, open, name)),
    place,
    spark,
    price,
    el('div', { class: 'move' }, chg, key, week7),
    el('dl', { class: 'stats' }, mcapBox, volBox));
  // ar, ln and end are the week line's wash, line and end dot, once it has one (lineSet).
  const n = {
    li, item: c, names: '',
    refs: { icon, coin, band, glint, open, sym, name, price, chg, key, week7, mcap, vol, volKey, mcapBox, volBox, rank, place, spark, ar: null, ln: null, end: null },
  };
  n.reveal = revealMachine(n);
  n.rise = riseMachine();
  n.seat = seatMachine(li);
  n.line = lineMachine(n);
  n.tick = tickMachine(n);
  return n;
}
// Where a card sits. Each card's states:
//   list   in the list under the stage: a row of the board or a tile, as the view says;
//   stage  on the stage, one of the leaders (.lead: the stylesheet lays it out as one);
//   out    sorted out by the dock's choice: kept at the list's end, undrawn (.out).
// arrange() is the one place that moves a card from one to another, and it puts the node in the box its seat names (a
// card that is out stays in the list's box). The two classes are written here and read by the stylesheet alone: what
// asks whether a card is drawn asks its seat.
function seatMachine(li) {
  return machine('list', { list: ['stage', 'out'], stage: ['list', 'out'], out: ['list', 'stage'] }).on((to) => {
    li.classList.toggle('lead', to === 'stage');
    li.classList.toggle('out', to === 'out');
  });
}
// The card a line of the stage or the list stands for; nothing for a line that is not a card (a header).
const cardOf = (li) => nodes.get(li.getAttribute('data-sym'));

// ---- the page's motions, numbered 1 to 8 (each stands alone) ----
// 2 and 8: a figure that changes rolls. Only the characters that changed move: the new one comes in from below when the
// figure rose (from above when it fell) while the old one leaves the other way. The node keeps its exact text (the old
// characters are drawn by the stylesheet from data-o), and is one text node again once the roll is over. Nothing rolls
// off screen, in a hidden tab, before the first cards are drawn (entrance: due) or under reduced motion.
const ROLL_MS = 440;
function roll(node, prev, next, dir) {
  if (REDUCED.matches || document.hidden || entrance.is('due') || !prev || prev === NA || next === NA || prev === next) return;
  if (node.childNodes.length !== 1 || node.firstChild.nodeType !== 3) return;
  const box = node.getBoundingClientRect();
  if (!box.width || box.bottom < 0 || box.top > innerHeight) return;
  const same = prev.length === next.length;
  const chars = [...next];
  const first = chars.findIndex((ch, i) => ch !== prev[i]);
  if (first < 0) return;
  const kids = [];
  let run = '';
  let k = 0;
  chars.forEach((ch, i) => {
    if (i < first || (same && ch === prev[i]) || ch === ' ') { run += ch; return; }
    if (run) { kids.push(run); run = ''; }
    const s = el('span', { class: `rc${dir < 0 ? ' dn' : ''}`, 'data-o': prev[i] ?? '' }, el('span', { class: 'rc-n' }, ch));
    s.style.setProperty('--rd', `${Math.min(k++ * 28, 140)}ms`);
    kids.push(s);
  });
  if (run) kids.push(run);
  node.replaceChildren(...kids);
  setTimeout(() => { if (node.querySelector('.rc') && node.textContent === next) node.textContent = next; }, ROLL_MS + 200);
}
// 2: the change chip answers a new figure with one soft flash.
function flash(node) {
  if (REDUCED.matches || document.hidden || entrance.is('due')) return;
  const box = node.getBoundingClientRect();
  if (!box.width || box.bottom < 0 || box.top > innerHeight) return;
  node.animate([{ filter: 'brightness(1.5) saturate(1.3)', scale: '1.07' }, { filter: 'brightness(1) saturate(1)', scale: '1' }], { duration: 560, easing: EASE, id: 'flash' });
}
// 4: a card below the fold waits unseen (.wait) and rises in the first time it scrolls into view. Each card's states:
//   shown    drawn (every card at first, and for good once it has been seen);
//   waiting  held back unseen (.wait) by the entrance until it first scrolls into view, watched for that.
// A card only ever waits once: the entrance sends it there, its scroll into view (or the dock's re-sort) brings it out.
function revealMachine(n) {
  return machine('shown', { shown: ['waiting'], waiting: ['shown'] }).on((to) => {
    n.li.classList.toggle('wait', to === 'waiting');
    cardWatch(n);
  });
}
// A card's coming in. Each card's states:
//   rest    it stands where it is laid out (or glides there: a glide is not a rise);
//   rising  it fades in and rises into its place: with the entrance's wave (enter), at its first scroll into view
//           (revealIO), or as the dock's choice or a step onto the stage or off it brings it in (settleIn).
// rise() starts one, with the animations that play it (anims, kept for their timing: riseWait); the card is at rest
// again when the last of them has ended, finished or cut. A rise that starts while another still plays joins it: the
// card rests when both are over. It joins only what still plays or has played out: an animation already cut (idle:
// stillAll, before the rise that follows it) has a new finished promise that never settles, and would hold the card
// in rising for good.
function riseMachine() {
  const m = machine('rest', { rest: ['rising'], rising: ['rest'] });
  m.anims = [];
  return m.on((to) => { if (to === 'rest') m.anims = []; });
}
function rise(n, anims) {
  const m = n.rise;
  const all = [...m.anims.filter((a) => a.playState !== 'idle'), ...anims];
  m.go('rest');
  m.anims = all;
  m.go('rising');
  const run = m.epoch;
  Promise.allSettled(all.map((a) => a.finished)).then(() => { if (m.epoch === run) m.go('rest'); });
}
// A card is watched for its coming on screen (revealIO) for as long as something of it waits for that: its own rise
// (reveal: waiting), or its week line's draw-in (line: held). Both machines call this on every move.
function cardWatch(n) {
  if (n.reveal.is('waiting') || n.line.is('held')) revealIO?.observe(n.li);
  else revealIO?.unobserve(n.li);
}
const revealIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  let k = 0;
  const lines = [];
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const li = e.target;
    const n = nodes.get(li.getAttribute('data-sym'));
    if (!n || n.li !== li) { revealIO.unobserve(li); continue; }
    if (n.reveal.go('shown') && !REDUCED.matches && !document.hidden && panel.is('closed')) {
      const delay = Math.min(k++ * 60, 180);
      rise(n, [
        li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 460, delay, easing: EASE, fill: 'backwards', id: 'reveal' }),
        springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(22, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'reveal' }),
      ]);
    }
    // Its week line, held back until now, draws in with it (after the rise just started, for a card that rises).
    if (n.line.is('held')) lines.push([n, e.boundingClientRect]);
  }
  linesIn(lines);
}, { rootMargin: '0px 0px -4% 0px' }) : null;
function revealAll() {
  for (const n of nodes.values()) n.reveal.go('shown');
}

// A stock card names its exchange and labels its change and volume "1d" (the trading session's); a coin's are "24h".
// A commodity card names its unit there and is "1d" too: its change is against the last settlement.
// Only what changed is written, so an unchanged card costs no DOM write and no style recalculation.
// Returns which way the card's price moved since the figure it showed: 1 up, -1 down, 0 for no move, a first figure or
// an unknown one (renderGrid answers the moves with a wave of bands: tickWave).
function patchCard(n, c, fetched) {
  const r = n.refs;
  // Before the first fetch every coin is "stale": say nothing then.
  const stale = Boolean(c.stale && fetched);
  const stock = Boolean(c.exchange) || isCommodity(c);
  n.li.classList.toggle('stale', stale);
  const tail = tailOf(c);
  const names = `${c.name}|${tail}`;
  if (n.names !== names) {
    n.names = names;
    r.name.replaceChildren(c.name, ...(tail ? [el('span', { class: 'exch' }, el('span', { class: 'sep' }, ' · '), tail)] : []));
    r.open.setAttribute('aria-label', `${c.symbol}, ${c.name}: open chart`);
  }
  coinShow(r.icon, r.coin, r.glint, coinUrl(c));
  const price = fmtPrice(c.price);
  const priceWas = r.price.textContent;
  const was = n.item?.price;
  setText(r.price, price);
  if (priceWas !== price) roll(r.price, priceWas, price, c.price >= (was ?? c.price) ? 1 : -1);
  setClass(r.price, `price${price === NA ? ' unknown' : ''}`);
  const moved = priceWas && priceWas !== price && priceWas !== NA && price !== NA && Number.isFinite(was) ? Math.sign(c.price - was) : 0;
  const chg = fmtChange(c.change24h);
  const chgWas = r.chg.textContent;
  setText(r.chg, chg.text);
  if (chgWas && chgWas !== chg.text) flash(r.chg);
  // Today's tone, said twice: by the chip, and by the dot at the end of the week's line (nothing for a stale card).
  const tone = stale ? '' : chg.tone;
  setClass(r.chg, `chg${tone ? ` ${tone}` : ''}`);
  r.spark.classList.toggle('gain', tone === 'gain');
  r.spark.classList.toggle('loss', tone === 'loss');
  setText(r.key, stale ? 'stale' : stock ? '1d' : '24h');
  const mcap = fmtCompact(c.mcap);
  const vol = fmtCompact(c.vol24h);
  setText(r.mcap, mcap);
  setClass(r.mcap, mcap === NA ? 'unknown' : '');
  setText(r.vol, vol);
  setClass(r.vol, vol === NA ? 'unknown' : '');
  setText(r.volKey, stock ? 'Vol 1d' : 'Vol 24h');
  n.item = c;
  return moved;
}

// ---- the week: every card's line of the last seven days ----
// The server keeps each asset's closes of the last seven days (/api/week: symbol -> closes, oldest first); a card draws
// them as a line over a wash, with a dot on the last close. The feed's states:
//   idle     no card is drawn yet: nothing is asked for;
//   due      cards are drawn: the first request waits for the page to have painted them and the browser to be idle;
//   loading  a request is out;
//   early    the server has no line yet (a 503, moments after it started): asked again in 20 s, a few times;
//   ready    the last answer's lines are in the cards;
//   failed   the last request failed (no answer within 15 s counts), or the server stayed early: every card keeps what
//            it shows.
// From early, ready and failed the next request goes out when its time has come (weekDue): 10 minutes on, while the
// page is visible; a hidden page lets its time pass and asks as it shows again. Three answers are asked for again
// sooner, each a bounded number of times: an early one in 20 s; one that lacks a line for a card on the page (a server
// still warming its charts sends the ones it has) in 30 s, so the last boxes fill within moments of the first; and a
// failure while the page has no line at all in 30 s, so the boxes do not stay empty for 10 minutes. Such a retry must
// reach the server: the browser may keep an answer for 5 minutes (the server's max-age), and would hand a retry the
// same one. What follows from each state (the first wait, the request, the lines handed to the cards, the next time)
// is applied on the move into it.
const WEEK_MS = 600_000;
const WEEK_EARLY_MS = 20_000;
const WEEK_EARLY_TRIES = 5;
const WEEK_PART_MS = 30_000;
const WEEK_PART_TRIES = 6;
const WEEK_FAIL_MS = 30_000;
const WEEK_FAIL_TRIES = 4;
const WEEK_TIMEOUT_MS = 15_000;
const week = machine('idle', { idle: ['due'], due: ['loading'], loading: ['ready', 'early', 'failed'], early: ['loading'], ready: ['loading'], failed: ['loading'] });
// The lines of the last good answer (symbol -> closes), which a card built later draws from too. Empty until one comes.
let weekLines = new Map();
// When the next request is due (this device's clock) and the timer that brings it; whether that request is a retry
// (it comes sooner than a turn, and must not be answered from the browser's cache); and how many answers in a row were
// early, or lacked a line for a card on the page, and how many requests have failed while the page had no line.
let weekDue = 0;
let weekTimer = 0;
let weekRetry = false;
let weekEarly = 0;
let weekPart = 0;
let weekFail = 0;
week.on((to) => {
  clearTimeout(weekTimer);
  if (to === 'due') { weekSoon(week.epoch); return; }
  if (to === 'loading') { weekFetch(week.epoch, weekRetry); return; }
  weekEarly = to === 'early' ? weekEarly + 1 : 0;
  if (to === 'ready') for (const n of nodes.values()) lineSet(n);
  const part = to === 'ready' && [...nodes.keys()].some((sym) => !weekLines.has(sym));
  weekPart = part ? weekPart + 1 : 0;
  const bare = to === 'failed' && weekLines.size === 0;
  if (bare) weekFail += 1;
  const wait = to === 'early' ? WEEK_EARLY_MS
    : part && weekPart <= WEEK_PART_TRIES ? WEEK_PART_MS
      : bare && weekFail <= WEEK_FAIL_TRIES ? WEEK_FAIL_MS : WEEK_MS;
  weekRetry = wait < WEEK_MS;
  weekDue = Date.now() + wait;
  weekTimer = setTimeout(() => { if (!document.hidden) week.go('loading'); }, wait);
});
// The first request: after the load, once the browser has reported the page's first paint (two frames on, where it
// reports none), when it is next idle. A hidden tab paints nothing and runs no frame, so it asks for nothing until it
// is shown.
function weekSoon(run) {
  const go = () => { if (week.epoch === run) week.go('loading'); };
  const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 200));
  const painted = () => {
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('paint')) {
      requestAnimationFrame(() => requestAnimationFrame(idle));
      return;
    }
    // Buffered: a paint already reported is told at once.
    const seen = new PerformanceObserver(() => { seen.disconnect(); idle(); });
    seen.observe({ type: 'paint', buffered: true });
  };
  if (document.readyState === 'complete') painted();
  else addEventListener('load', painted, { once: true });
}
// One request. Whatever fails is quiet (the cards keep what they show) and the next turn asks again; an answer that
// lands after the feed has moved on is dropped. A request that never answers (a stalled connection) gives up after
// 15 s, as a chart's does, and has failed. A retry is checked with the server (cache: 'no-cache'), never answered from
// the browser's own copy of the answer it retries; the first request and the 10-minute turns may be.
async function weekFetch(run, retry) {
  let to = 'failed';
  let lines = null;
  try {
    const opts = typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(WEEK_TIMEOUT_MS) } : {};
    if (retry) opts.cache = 'no-cache';
    const res = await fetch('/api/week', opts);
    if (res.status === 503) to = weekEarly < WEEK_EARLY_TRIES ? 'early' : 'failed';
    else if (res.ok) lines = weekClean(await res.json());
  } catch {
    // Offline for a moment, or an answer that is not JSON: failed.
  }
  if (week.epoch !== run) return;
  if (lines) { weekLines = lines; to = 'ready'; }
  week.go(to);
}
// An answer's lines, each checked: at least two closes (a line), at most 96 places, every close a number; a young
// market's line begins with nulls, the hours before its listing. Null for an answer of another shape.
function weekClean(body) {
  const src = body?.lines;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const lines = new Map();
  for (const [sym, h] of Object.entries(src)) {
    if (!Array.isArray(h) || h.length < 2 || h.length > 96) continue;
    const k = h.findIndex((v) => v !== null);
    if (k >= 0 && h.length - k >= 2 && h.every((v, i) => (i < k ? v === null : Number.isFinite(v)))) lines.set(sym, h);
  }
  return lines;
}
// The page is shown again: a request whose time passed while it was hidden goes out now.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && week.is('early', 'ready', 'failed') && Date.now() >= weekDue) week.go('loading');
});

// A card's line. Each card's states:
//   none     no line yet: its box is empty (the symbol has no line, or none has arrived);
//   held     its line is written but not shown (.held) until the card is first on screen: watched for that (cardWatch);
//   drawing  the line draws itself in, once;
//   drawn    there for good: a later answer only swaps its path.
// lineSet writes the path and moves a card out of none; revealIO (linesIn) moves it from held as it comes on screen.
// delay is how long after the move to drawing the draw-in starts (the wave's step: linesIn sets it before the move).
// The line comes in from its first close to its last over 900 ms, and its wash and its dot fade in over 500 ms from
// 520 ms on. The line is uncovered from the left rather than dashed along its length: its square is stretched to the
// box and the stroke keeps its width (non-scaling), and browsers measure a dash on such a path in different spaces, so
// a dashed line would stop short of its end in some of them.
const LINE_EASE = 'cubic-bezier(0.3, 0, 0.2, 1)';
// A card that rises in as it comes on screen starts its line this long into its rise.
const LINE_AFTER = 180;
function lineMachine(n) {
  const m = machine('none', { none: ['held', 'drawn'], held: ['drawing', 'drawn'], drawing: ['drawn'], drawn: [] });
  m.delay = 0;
  return m.on((to) => {
    const r = n.refs;
    r.spark.classList.toggle('held', to === 'held');
    cardWatch(n);
    if (to !== 'drawing') return;
    const run = m.epoch;
    const fade = { duration: 500, delay: m.delay + 520, easing: 'ease', fill: 'backwards' };
    const anims = [
      r.ln.ownerSVGElement.animate([{ clipPath: 'inset(-4px 100% -4px -4px)' }, { clipPath: 'inset(-4px -4px -4px -4px)' }], { duration: 900, delay: m.delay, easing: LINE_EASE, fill: 'backwards', id: 'week' }),
      r.ar.animate([{ opacity: 0 }, { opacity: 1 }], { ...fade, id: 'week' }),
      r.end.animate([{ opacity: 0 }, { opacity: 1 }], { ...fade, id: 'week' }),
    ];
    Promise.allSettled(anims.map((a) => a.finished)).then(() => { if (m.epoch === run) m.go('drawn'); });
  });
}
// Draws a card's week from the last answer: builds the line's parts the first time, then only rewrites the path and
// the dot's height when the closes changed. The closes run across a square of 100 by 100, the lowest 8 above its
// bottom edge and the highest 8 under its top. A symbol the answer does not have keeps what its card shows.
function lineSet(n) {
  const h = weekLines.get(n.item.symbol);
  if (!h) return;
  const r = n.refs;
  // k: the line's first close (after a young market's empty hours, which keep their room on the left).
  const k = h.findIndex((v) => v !== null);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = k; i < h.length; i++) { lo = Math.min(lo, h[i]); hi = Math.max(hi, h[i]); }
  const span = hi - lo || 1;
  const y = (v) => (8 + (1 - (v - lo) / span) * 84).toFixed(2);
  const x = (i) => ((i / (h.length - 1)) * 100).toFixed(2);
  let d = '';
  for (let i = k; i < h.length; i++) d += `${i === k ? 'M' : 'L'}${x(i)} ${y(h[i])}`;
  // A card with no line yet (none) has no parts either: they are built here, once, just before it leaves that state.
  const first = n.line.is('none');
  if (first) {
    const svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', focusable: 'false' });
    r.ar = svgEl('path', { class: 'ar' });
    r.ln = svgEl('path', { class: 'ln' });
    r.end = el('span', { class: 'end' });
    svg.append(r.ar, r.ln);
    r.spark.append(svg, r.end);
  }
  if (r.ln.getAttribute('d') !== d) {
    r.ln.setAttribute('d', d);
    r.ar.setAttribute('d', `${d}L100 100L${x(k)} 100Z`);
    r.end.style.top = `${y(h[h.length - 1])}%`;
  }
  // The same line in words: the change from its first close to its last, as the board's column names it.
  setText(r.week7, h[k] > 0 ? `Last 7 days ${fmtChange((h[h.length - 1] / h[k] - 1) * 100).text}` : '');
  // Its first line: held back until the card is on screen, or just there where nothing draws in (reduced motion, no
  // observer to say when the card is seen).
  if (first) n.line.go(REDUCED.matches || !revealIO ? 'drawn' : 'held');
}
// How long from now a card's line may start, for a card that is rising in (its rise machine says so): LINE_AFTER into
// that rise, timed by the rise's own animations that still play (how far each is past its delay). Null for a card at
// rest.
function riseWait(n) {
  if (!n.rise.is('rising')) return null;
  let wait = 0;
  for (const a of n.rise.anims) {
    if (a.playState !== 'running') continue;
    const into = (Number(a.currentTime) || 0) - (a.effect?.getComputedTiming().delay || 0);
    wait = Math.max(wait, LINE_AFTER - into);
  }
  return wait;
}
// The lines of the cards that have just come on screen (list: [card, its box]) draw in. A card that is rising in
// draws its line with its rise, so the lines cross the page as the entrance's wave does; the cards at rest draw theirs
// as a wave of their own by place, a step per row and per column, 40 ms at most and 300 ms across at most. Not under
// an open panel: the lines stay held and are looked for again once it has closed (linesLook). Where nothing may move
// they are just there.
function linesIn(list) {
  if (!list.length || !panel.is('closed')) return;
  if (REDUCED.matches || document.hidden) {
    for (const [n] of list) n.line.go('drawn');
    return;
  }
  const waits = new Map(list.map(([n]) => [n, riseWait(n)]));
  const rest = list.filter(([n]) => waits.get(n) === null);
  const rows = [...new Set(rest.map(([, b]) => Math.round(b.top)))].sort((a, b) => a - b);
  const cols = [...new Set(rest.map(([, b]) => Math.round(b.left)))].sort((a, b) => a - b);
  const span = rows.length + cols.length - 2;
  const step = span > 0 ? Math.min(40, 300 / span) : 0;
  for (const [n, b] of list) {
    const wait = waits.get(n);
    n.line.delay = Math.round(wait ?? (rows.indexOf(Math.round(b.top)) + cols.indexOf(Math.round(b.left))) * step);
    n.line.go('drawing');
  }
}
// Every card with a held line is observed afresh, so the observer says again which of them are on screen (it only
// speaks of a card when that changes).
function linesLook() {
  if (!revealIO) return;
  for (const n of nodes.values()) {
    if (!n.line.is('held')) continue;
    revealIO.unobserve(n.li);
    revealIO.observe(n.li);
  }
}

// ---- a price ticks: one band of the move's colour crosses its card ----
// A refresh that moved a card's price is answered on that card: a soft band of the move's colour crosses it from left
// to right in 900 ms and is gone, and on a row or a tile the figure takes the move's ink at once and eases back over
// the same time (a leader's figure is too large to flash). Each card's states:
//   still  nothing plays, and the card holds no band;
//   gain   a green band is on its way across (.tick.gain, a box the card holds for that long);
//   loss   a red one (.tick.loss).
// The box and its two animations are made on the move into gain or loss and taken away on the move out of it, when the
// band has crossed (or at once, for a new move while it still plays). delay is the card's turn in the wave and ink the
// figure's colour for the move (tickWave sets both before the move).
const TICK_MS = 900;
const TICK_STEP = 40;
function tickMachine(n) {
  const m = machine('still', { still: ['gain', 'loss'], gain: ['still', 'loss'], loss: ['still', 'gain'] });
  m.delay = 0;
  m.ink = '';
  let band = null;
  let anims = [];
  return m.on((to) => {
    for (const a of anims) a.cancel();
    band?.remove();
    band = null;
    anims = [];
    if (to === 'still') return;
    const light = el('i');
    band = el('span', { class: `tick ${to}`, 'aria-hidden': 'true' }, light);
    n.li.append(band);
    // The light is three cards wide with its stripe in the middle: from two cards to the left, where the stripe is
    // just off the card's left edge, to its own place, where it has just left the right one.
    anims = [light.animate([{ opacity: 1, transform: 'translateX(-66.667%)' }, { opacity: 0, transform: 'translateX(0)' }], { duration: TICK_MS, delay: m.delay, easing: 'ease-out', id: 'tick' })];
    // One keyframe: the figure eases from the move's ink back to whatever colour it has.
    if (n.seat.is('list') && m.ink) anims.push(n.refs.price.animate([{ offset: 0, color: m.ink }], { duration: TICK_MS, delay: m.delay, easing: 'ease', id: 'tick' }));
    const run = m.epoch;
    const over = () => { if (m.epoch === run) m.go('still'); };
    anims[0].finished.then(over, over);
  });
}
// The cards whose price a refresh moved (moved: [card, 1 or -1]) answer in a wave: the ones on screen, in the order
// they are laid out (row by row, left to right), 40 ms apart, so a refresh that moves every price reads as a wave down
// the list and never as one flash. Nothing plays before the entrance is over, in a hidden tab, under a panel or under
// reduced motion.
function tickWave(moved) {
  if (!moved.length || !entrance.is('done') || REDUCED.matches || document.hidden || !panel.is('closed')) return;
  const seen = [];
  for (const [n, dir] of moved) {
    if (n.seat.is('out') || n.reveal.is('waiting')) continue;
    const b = n.li.getBoundingClientRect();
    if (b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth) seen.push([n, dir, Math.round(b.top), b.left]);
  }
  if (!seen.length) return;
  seen.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const cs = getComputedStyle(document.documentElement);
  const ink = { gain: `rgb(${cs.getPropertyValue('--gain-rgb').trim()})`, loss: `rgb(${cs.getPropertyValue('--loss-rgb').trim()})` };
  seen.forEach(([n, dir], i) => {
    const to = dir > 0 ? 'gain' : 'loss';
    n.tick.delay = i * TICK_STEP;
    n.tick.ink = ink[to];
    // A band still crossing gives way to the new one.
    if (!n.tick.can(to)) n.tick.go('still');
    n.tick.go(to);
  });
}

// ---- the list's layout: a board or tiles ----
// The viewer's choice of what the list under the stage is laid out as, remembered on this device; every other open tab
// follows. Its states:
//   board  one slab per asset under a line of column headers (the default);
//   tiles  a grid of cards.
// What follows from it (the list's data-view, which the stylesheet lays the cards out by, and the pressed segment) is
// applied on the move; the pill is placed by every press, as a press on the segment already chosen still answers.
const VIEW_KEY = 'printerino-view';
const viewSeg = listbar?.querySelector('.seg-view') ?? null;
// The same switch again in the top bar (.seg-twin), where it stands while the list's bar is above the window (viewJoin,
// below): both show the one choice and either sets it.
const topBar = document.querySelector('.top');
const viewTwin = (viewSeg && topBar?.querySelector('.seg-twin')) ?? null;
const listView = machine(recall(VIEW_KEY) === 'tiles' ? 'tiles' : 'board', { board: ['tiles'], tiles: ['board'] });
function viewShow(to) {
  if (grid) grid.dataset.view = to;
  for (const seg of [viewSeg, viewTwin]) if (seg) segSet(seg, 'data-v', to);
}
listView.on(viewShow);
// The bar over the list: the first shown group's name and the layout switch. Its states:
//   hidden  no card is drawn (the page ships the bar hidden);
//   shown   cards are drawn: the bar is laid out, and the switch's pill is placed as it shows.
// arrange() shows it with the first cards, and hides it while the dock's choice shows none; a page left with no prices
// hides it again (renderGrid).
const viewBar = machine('hidden', { hidden: ['shown'], shown: ['hidden'] });
viewBar.on((to) => {
  if (!listbar) return;
  listbar.hidden = to === 'hidden';
  if (to === 'shown') viewPlace(false);
});
// While the list's own bar is above the window its switch stands in the top bar too, between the theme switch and the
// X link: the twin. Its states:
//   list     the switch is the list bar's alone: the twin is not drawn, so not focusable and not announced;
//   due      the list's bar has gone above the window and the twin is wanted, but what draws its place is not in yet
//            (viewArrive: glass.js, the merged body's four-part maps, the merge itself whole);
//   joining  laid out in the bar and on its way in, on glass.js's springs (.view-in and .view-moving on the bar);
//   bar      in the bar, at rest: the stylesheet's alone (.view-in);
//   leaving  on its way out (.view-in and .view-moving), inert already.
// A join turns round into a leave from where it is, and a leave into a join. Without motion (reduced motion, a hidden
// tab, no glass.js where the bar keeps separate capsules) due goes straight to bar and bar to list; a bar that changes
// form under the twin (viewRefit) takes it out at once from any state.
const viewJoin = machine('list', { list: ['due'], due: ['joining', 'bar', 'list'], joining: ['bar', 'leaving', 'list'], bar: ['leaving', 'list'], leaving: ['list', 'joining'] });
const viewLaid = (state) => state === 'joining' || state === 'bar' || state === 'leaving';
// A twin that is due and was refused asks again (viewArrive): timer brings its next ask, tries counts the asks refused
// since it became due. Both are the due state's alone, let go of on every move.
viewJoin.timer = 0;
viewJoin.tries = 0;
viewJoin.on((to, from) => {
  clearTimeout(viewJoin.timer);
  viewJoin.tries = 0;
  // A key's focus on the twin goes back to the same segment of the list's own switch, in the window again.
  if (!viewLaid(to) || to === 'leaving') {
    if (viewTwin.contains(document.activeElement)) viewSeg.querySelector(`button[data-v="${listView.state}"]`)?.focus({ preventScroll: true });
  }
  topBar.classList.toggle('view-in', viewLaid(to));
  topBar.classList.toggle('view-moving', to === 'joining' || to === 'leaving');
  viewTwin.hidden = !viewLaid(to);
  viewTwin.inert = to === 'leaving';
  // Laid out again: its pill goes under the chosen segment, without motion.
  if (viewLaid(to) && !viewLaid(from)) viewPlace(false);
  G?.viewJoin(to);
});
function viewPlace(animate, byUser = false) {
  // Not while its bar is hidden, or the twin out of the top bar: a segment has no place then, and each places its pill
  // as it shows.
  for (const seg of [viewBar.is('shown') ? viewSeg : null, viewLaid(viewJoin.state) ? viewTwin : null]) {
    const b = seg?.querySelector(`button[data-v="${listView.state}"]`);
    if (b) segPlace([[seg, b.offsetLeft, b.offsetWidth, listView.state]], animate, byUser);
  }
}
// The stylesheet's own conditions for merging the bar's controls into one body (style.css), asked as they stand now.
const BAR_MERGES = matchMedia('(prefers-reduced-motion: no-preference) and (min-width: 360px)');
const BAR_FORCED = matchMedia('(forced-colors: active)');
const barMerges = () => typeof CSS !== 'undefined' && Boolean(CSS.supports?.('animation-timeline: scroll()')) && BAR_MERGES.matches && !BAR_FORCED.matches;
// due: the twin goes in once what draws its place is there. Where the bar's controls are one body that is glass.js
// (asked for now if it is not in), which says when the body can hold a fourth control (viewRoom: its rim's map decoded, the
// merge whole), or that it cannot. Separate capsules need nothing. The epoch tells an answer that comes after the
// list's bar is back in the window.
// A refusal may pass (glass.js failed to load, or a map of the body did: offline for a moment), so a twin still due
// asks again by itself: 3 s on, then twice as long each time, four times in all (45 s), and at once when glass.js
// arrives or the network is back (viewAgain). After that it waits for the list's bar to leave the window again.
const VIEW_AGAIN_MS = 3000;
const VIEW_TRIES = 4;
function viewArrive() {
  const run = viewJoin.epoch;
  const arrive = (room) => {
    if (viewJoin.epoch !== run) return;
    if (room) viewJoin.go(G && !REDUCED.matches && !document.hidden ? 'joining' : 'bar');
    else if (viewJoin.tries < VIEW_TRIES) viewJoin.timer = setTimeout(viewArrive, VIEW_AGAIN_MS * 2 ** viewJoin.tries++);
  };
  if (!G && !barMerges()) arrive(true);
  else Promise.resolve(G ?? loadGlass()).then((g) => (g ? g.viewRoom() : false)).then(arrive, () => {});
}
// What a due twin waited for may be there now: it is due afresh (through list, so the epoch drops any answer still on
// its way and the asks are counted from none) and asks at once. The list's bar is still above the window: its return
// would have taken the twin out of due.
function viewAgain() {
  if (viewJoin.is('due') && viewJoin.go('list')) viewWant(true);
}
// What the list's bar asks for: its switch's twin in the top bar (the bar is above the window), or out of it. A motion
// under way is only ever turned into the other motion, which goes on from where the twin is (never cut to rest); a
// twin at rest in the bar leaves, at once where nothing moves; one that was only due is due no longer.
function viewWant(inBar) {
  if (inBar) {
    if (viewJoin.go('due')) viewArrive();
    else if (viewJoin.is('leaving')) viewJoin.go('joining');
  } else if (viewJoin.is('joining')) viewJoin.go('leaving');
  else if (viewJoin.is('bar')) viewJoin.go(G && !REDUCED.matches && !document.hidden ? 'leaving' : 'list');
  else if (viewJoin.is('due')) viewJoin.go('list');
}
// glass.js has brought the twin all the way in ('bar') or out ('list').
function viewLanded(where) {
  if (viewJoin.is(where === 'bar' ? 'joining' : 'leaving')) viewJoin.go(where);
}
if (viewTwin && typeof IntersectionObserver === 'function') {
  // The root is the window under the top bar's 56px, carried down past the end of any page: the list's switch is
  // outside it only once its bottom edge is above the bar's line, however the page got there (a scroll, a jump, a
  // reload part way down), and every crossing of that line is reported. No scroll listener.
  const io = new IntersectionObserver(([e]) => viewWant(viewBar.is('shown') && !e.isIntersecting), { rootMargin: '-56px 0px 1000000px 0px' });
  // Observed afresh, the observer reports where the switch stands now.
  const ask = () => { io.unobserve(viewSeg); io.observe(viewSeg); };
  // The list's bar has lost its cards, or has them again: out at once, or asked afresh.
  viewBar.on((to) => { if (to === 'hidden') viewWant(false); else ask(); });
  // The bar's form changed under the twin (the merge on or off): it leaves at once and comes back in the new form, if
  // the list's bar is still above the window.
  const viewRefit = () => { if (viewJoin.go('list')) ask(); };
  for (const mq of [BAR_MERGES, BAR_FORCED]) mq.addEventListener?.('change', viewRefit);
  addEventListener('online', viewAgain);
  ask();
}
// The list changes form: every card in it is the same node laid out anew, so each one on screen moves from its old top
// left corner to its new one on the re-rank's spring, fading in as it goes (its content is never scaled), and the ones
// that come into view rise in; the headers fade in where they now stand. Under reduced motion, in a hidden tab or
// under an open panel it just swaps. A panel flying home into its card lands first (landNow): its flight is aimed at
// the card's box in the old form.
function setView(choice, { byUser = true, keep = true } = {}) {
  const next = choice === 'tiles' ? 'tiles' : 'board';
  // A click on the side already chosen chooses nothing: the press itself answers it (the pill swells and settles),
  // as on the dock. Placed again as a choice, the pill would have its glyph play its arrival once more.
  if (byUser && !listView.can(next)) return;
  if (listView.can(next)) {
    landNow();
    const animate = !entrance.is('due') && !document.hidden && !REDUCED.matches && (!PANEL || panel.is('closed'));
    revealAll();
    const before = animate ? placesOf(grid.children) : null;
    stillAll(grid.children);
    listView.go(next);
    if (animate) settleIn([...grid.children], before, { fade: true });
  }
  if (keep) remember(VIEW_KEY, next);
  viewPlace(byUser && !REDUCED.matches, byUser);
}
// The page starts on the stored choice: the list's layout is set before the first card is drawn.
viewShow(listView.state);
for (const seg of [viewSeg, viewTwin]) seg?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.getAttribute('data-v')); });
addEventListener('storage', (e) => {
  if (e.key === VIEW_KEY && (e.newValue === 'board' || e.newValue === 'tiles')) setView(e.newValue, { byUser: false, keep: false });
});
// A page restored from the back-forward cache missed what other tabs chose while it was away.
addEventListener('pageshow', (e) => {
  const v = e.persisted ? recall(VIEW_KEY) : null;
  if (v === 'board' || v === 'tiles') setView(v, { byUser: false, keep: false });
});

// ---- who leads, and the order of the list ----
// The three kinds in the order the list shows them, each with its group's name.
const GROUPS = [['coin', 'Coins'], ['stock', 'Stocks'], ['commod', 'Commods']];
const LEADERS = 3;
// The lines of the list that are not cards, each built once: the board's column header, and a header for each group
// that is not the first one shown (the first group's is the bar over the list).
const colsRow = el('li', { class: 'cols', 'aria-hidden': 'true' }, ...['#', 'Asset', 'Last 7 days', 'Price', 'Change', 'Mcap', 'Volume'].map((w) => el('span', {}, w)));
const groupRows = new Map();
function groupRow(g) {
  let row = groupRows.get(g.kind);
  if (!row) {
    const count = el('span', { class: 'group-n' });
    row = { count, li: el('li', { class: 'group', role: 'listitem' }, el('h2', { class: 'group-h' }, el('span', { class: 'group-name' }, g.label), ' ', count)) };
    groupRows.set(g.kind, row);
  }
  setText(row.count, String(g.all.length));
  return row.li;
}
// Who leads and what the list holds, from the data's order and the dock's choice. On All the first of each kind leads
// (three kinds, three leaders; were a kind missing, the next in line of the kinds there are fills its place); on a tab
// that kind's first three do. The list holds every shown card that does not lead, kind after kind.
function lineup() {
  const groups = GROUPS.map(([kind, label]) => ({ kind, label, all: ranked.filter((n) => kindOf(n.item) === kind) })).filter((g) => g.all.length);
  const on = groups.filter((g) => filter.is('all', g.kind));
  const lead = new Set();
  if (stage) {
    if (filter.is('all')) for (const g of on) lead.add(g.all[0]);
    for (const g of on) for (const n of g.all) if (lead.size < LEADERS) lead.add(n);
  }
  for (const g of on) g.rows = g.all.filter((n) => !lead.has(n));
  return { groups, on, lead: ranked.filter((n) => lead.has(n)) };
}
// Where each node of a list is drawn now (a card whose seat is out is not drawn, and has no place).
function placesOf(list) {
  const places = new Map();
  for (const li of list) if (li.isConnected && !cardOf(li)?.seat.is('out')) places.set(li, li.getBoundingClientRect());
  return places;
}
// A move still playing ends where it stands: the next one starts from where the node is drawn. The moves are a glide
// ('rerank'), the fade a glide gets when the list changes form ('fade'), and a rise or a header's fade ('show').
function stillAll(list) {
  for (const li of list) for (const a of li.getAnimations()) if (a.id === 'rerank' || a.id === 'fade' || a.id === 'show') a.cancel();
}
// Plays each node of a list into the place it now has: one that was on screen before (before: node -> its old box)
// glides there from its old top left corner on the re-rank's spring (fading in as it goes, when the list changed form
// under it); one that was not, or that changed boxes (arrived), rises in where it stands, if that is on screen. A line
// that is not a card (a header) never glides: it fades in.
function settleIn(list, before, { arrived = null, fade = false } = {}) {
  const vh = innerHeight;
  const seen = (r) => r.bottom > 0 && r.top < vh;
  let k = 0;
  for (const li of list) {
    // The card this line is (none for a header). One the dock has sorted out is not drawn; one still waiting for its
    // first scroll into view comes in by that (revealIO), not here.
    const n = cardOf(li);
    if (n?.seat.is('out') || n?.reveal.is('waiting')) continue;
    const card = li.hasAttribute('data-sym');
    const b = li.getBoundingClientRect();
    const a = arrived?.has(li) ? null : before.get(li);
    if (card && a && seen(a)) {
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      // A glide's fade is not a rise: the card is at rest all along (its line draws in as any resting card's does).
      if (fade) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: EASE, id: 'fade' });
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      springAnim(li, SPRING.gentle, (p) => ({ transform: `translate(${lerp(dx, 0, p)}px, ${lerp(dy, 0, p)}px)` }), { id: 'rerank' });
    } else if (seen(b) && (fade || !a || card)) {
      if (!card) { li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: EASE, id: 'show' }); continue; }
      const delay = Math.min(k++, 8) * 20;
      const anims = [
        li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, easing: EASE, fill: 'backwards', id: 'show' }),
        springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(12, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'show' }),
      ];
      if (n) rise(n, anims);
    }
  }
}
// Puts every card where the data and the dock's choice say: the leaders on the stage in order, the rest in the list
// under their groups' headers, the cards the dock has sorted out undrawn at the list's end. Both ways in go through
// here: new data (how = 'data', a re-rank) and the dock (how = 'dock'). Each card's seat is moved here and nowhere
// else, and its rank and place are written here.
function arrange(how) {
  const { groups, on, lead } = lineup();
  const wantStage = lead.map((n) => n.li);
  // The list's lines: the board's column header first (the stylesheet draws it on the board only), then each group's
  // cards, under a header of their own from the second group on (the first group's is the bar over the list).
  const wantGrid = on.some((g) => g.rows.length) ? [colsRow] : [];
  on.forEach((g, i) => {
    if (!g.rows.length) return;
    if (i || !listbar) wantGrid.push(groupRow(g));
    for (const n of g.rows) wantGrid.push(n.li);
  });
  // A card the dock has sorted out stays in the list, undrawn (a new coin or stock arrives already sorted).
  for (const n of ranked) if (!shown(n.item)) wantGrid.push(n.li);
  const same = (box, want) => box.children.length === want.length && want.every((li, i) => box.children[i] === li);
  // The seat each card should have: out for one the dock has sorted out, else the stage for a leader, else the list.
  const leading = new Set(lead);
  const seatOf = (n) => (!shown(n.item) ? 'out' : leading.has(n) ? 'stage' : 'list');
  const seated = ranked.every((n) => n.seat.is(seatOf(n)));
  if (seated && (!stage || same(stage, wantStage)) && same(grid, wantGrid)) return;
  // The panel is flying home into its card: a new order waits until it has landed (owed), or the card would move out
  // from under it. Only new data comes here during a flight: the dock and the layout switch land it first (landNow).
  if (flightCard.is('landing')) { owed.go('owed'); return; }
  // The order changed: FLIP. Read every card where it is now (mid-move if a re-rank is still playing), move the nodes
  // with as few moves as possible, read again, and play each card from its old place to its new one, all together.
  // Not under an open panel: nobody sees it through the glass, and each of its frames would have the whole window
  // blurred again. The cards move at once there; a close lands on the card's new place.
  const under = panel.is('opening', 'open');
  const animate = !entrance.is('due') && !document.hidden && !REDUCED.matches && (how === 'dock' ? panel.is('closed') : !under && !(cd.lite && !panel.is('closed')));
  const lines = cardBoxes.flatMap((box) => [...box.children]);
  const before = animate ? placesOf(lines) : null;
  stillAll(lines);
  // A card that changes seats (onto the stage or off it, or back from being sorted out) has arrived where it now
  // sits: it rises in, it does not glide.
  const arrived = new Set();
  for (const n of ranked) if (n.seat.go(seatOf(n))) arrived.add(n.li);
  // Each card's rank in its own kind, and a leader's place in words.
  for (const g of groups) {
    g.all.forEach((n, i) => {
      setText(n.refs.rank, String(i + 1));
      if (leading.has(n)) setText(n.refs.place, `No. ${i + 1}${filter.is('all') ? ` in ${g.label}` : ''}`);
    });
  }
  // A symbol the data no longer has leaves the page (its node is not in either list of wanted nodes).
  const kept = new Set(ranked);
  for (const [sym, n] of nodes) if (!kept.has(n)) nodes.delete(sym);
  // Each box takes its nodes in order, with as few moves as possible; whatever else it held (a header no longer
  // wanted, the empty state, a dropped card) ends up after them and goes.
  const fill = (box, want) => {
    for (let i = 0; i < want.length; i++) if (box.children[i] !== want[i]) box.insertBefore(want[i], box.children[i] ?? null);
    while (box.children.length > want.length) box.lastElementChild.remove();
  };
  // A node taken out of the page to be put back elsewhere loses the focus: a card's button that had it takes it back
  // once its card is in place (still drawn: a card the dock has sorted out cannot hold it), its ring as it was.
  const held = cardBoxes.some((box) => box.contains(document.activeElement)) ? document.activeElement : null;
  const ring = Boolean(held) && ringed(held);
  if (stage) fill(stage, wantStage);
  fill(grid, wantGrid);
  if (held?.isConnected && document.activeElement !== held) focusTo(held, ring);
  // The bar over the list names the first group shown, and shows from the first cards on (viewBar). A choice of the
  // dock's that no card answers (a kind the data lacks) leaves it no group to name: it goes, as on a page with no
  // cards.
  if (listbar && on[0]) {
    setText(listbar.querySelector('.group-name'), on[0].label);
    setText(listbar.querySelector('.group-n'), String(on[0].all.length));
    viewBar.go('shown');
  } else viewBar.go('hidden');
  if (how === 'dock') {
    // New leaders start from the stage's left end (a phone's stage is a row that scrolls sideways).
    if (stage) stage.scrollLeft = 0;
    const topBar = document.querySelector('.top')?.offsetHeight || 56;
    const bar = document.querySelector('.bar');
    if (bar && (stage ?? grid).getBoundingClientRect().top < topBar) scrollTo(0, Math.max(0, bar.getBoundingClientRect().top + scrollY - topBar - 6));
  }
  // A painted veil is a still picture of the page: painted again in the new order.
  if (under && G?.veilPainted()) G.veilPaint();
  if (animate) settleIn([...wantStage, ...wantGrid], before, { arrived });
}

function renderGrid(list, fetched) {
  if (!list.length) {
    nodes.clear();
    ranked = [];
    stage?.replaceChildren();
    viewBar.go('hidden');
    grid.replaceChildren(el('li', { class: 'empty', role: 'listitem' }, el('p', { class: 'empty-title' }, 'No prices yet'), el('p', { class: 'empty-body' }, 'They will show here as soon as they load.')));
    return;
  }
  // Figures first: they swap at once. Except on the card the panel is flying home into (flightCard: landing): new
  // figures there would move its words (a wider chip pushes "24h" along) out from under their twins in flight, so they
  // are owed until it has landed, and swap then.
  const next = [];
  // The cards whose price this answer moved, each with the way it went.
  const moved = [];
  for (const c of list) {
    let n = nodes.get(c.symbol);
    const built = !n;
    if (built) { n = buildCard(c); nodes.set(c.symbol, n); }
    if (flightCard.is('landing') && n.li === flightCard.li) owed.go('owed');
    else {
      const dir = patchCard(n, c, fetched);
      if (dir) moved.push([n, dir]);
    }
    // A card built after the week's lines came in draws its own from them.
    if (built) lineSet(n);
    next.push(n);
  }
  ranked = next;
  arrange('data');
  tickWave(moved);
}

function render() {
  if (!Array.isArray(data?.coins)) return;
  // One list in the data's order: the coins, then the stocks in their own market-cap order (never ranked against the
  // coins), then the commodities the same way. arrange() groups it and picks the leaders.
  const stocks = Array.isArray(data.stocks) ? data.stocks : [];
  const commodities = Array.isArray(data.commodities) ? data.commodities : [];
  renderGrid(data.coins.length ? [...data.coins, ...stocks, ...commodities] : [], Boolean(data.updatedAt));
  dockSync();
  enter();
  // The first cards are drawn: the week's lines are asked for once the page has painted them (week: due).
  if (nodes.size) week.go('due');
  // Every element is optional: a page cached from an older deploy may lack some of them.
  if (countEl) setText(countEl, String(data.coins.length));
  if (stockCountEl) setText(stockCountEl, String(stocks.length));
  if (commodCountEl) setText(commodCountEl, String(commodities.length));
  // The hero's ghost tape, drawn faintly and never animated: BTC, ETH, SOL, MET and ZEC with their 24h change, and on wide
  // screens COIN, HOOD, CRCL, ANT and SPCX beside them (the .stk cells, hidden by the stylesheet until there is room). Written
  // only when a word in it changed.
  const pick = (list, sym) => (Array.isArray(list) ? list : []).find((c) => c.symbol === sym);
  const words = (c) => [c ? c.symbol : '', c ? fmtChange(c.change24h).text : ''];
  const rows = TAPE.map((sym, i) => [words(pick(data.coins, sym)), words(pick(data.stocks, TAPE_STOCKS[i]) || pick(data.coins, TAPE_STOCKS[i]))]);
  const tape = JSON.stringify(rows);
  if (tapeEl && tape !== tapeShown) {
    tapeShown = tape;
    const cells = () => rows.flatMap(([coin, stock]) => [...coin.map((w) => el('span', {}, w)), ...stock.map((w) => el('span', { class: 'stk' }, w))]);
    // 5: the strip drifts upward for ever: two copies of its rows, so the loop has no seam (the stylesheet moves it by
    // exactly one copy). One copy and no motion under reduced motion.
    const drift = !REDUCED.matches;
    tapeEl.classList.toggle('drift', drift);
    tapeEl.replaceChildren(...cells(), ...(drift ? cells() : []));
  }
  if (panel.is('closed')) tick();
  panelLive();
  openFromHash();
}

// ---- the page's entrance: once per page load, as the first cards are drawn ----
// The stylesheet brings in the top bar, the hero and the picks row (a fade and a soft rise, only with scripting on); the
// watchlist follows as a wave from the top left, over the stage and then down the list as it is laid out (the leaders,
// the bar, the list's headers and its cards on screen), each rising with the smooth spring. The cards below the window
// wait for their own scroll into view.
// Nothing waits for it: every figure is written before it starts, and a card takes a click mid-rise. It never
// plays on a refresh, on a page brought back from history (the back-forward cache runs no script; a reload from history
// is a return, not an arrival) or when the address opens a chart at once; reduced motion gets a short plain fade.
// Its machine is entrance (declared above the cards, with its states).
function enter() {
  if (!entrance.is('due') || !nodes.size) return;
  const lead = [...document.querySelectorAll('.top, .hero, .bar')].flatMap((node) => node.getAnimations().filter((a) => a.animationName?.startsWith('page-')));
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  if (document.hidden || nav?.type === 'back_forward' || (PANEL && hashSym())) {
    for (const a of lead) a.finish();
    entrance.go('done');
    return;
  }
  entrance.go('playing');
  const calm = REDUCED.matches;
  const vh = innerHeight;
  // Everything the watchlist draws, in page order: the leaders, the bar over the list, then the list's lines (its
  // headers and its cards) as they are laid out.
  const seen = [];
  for (const node of [...(stage?.children ?? []), ...(listbar ? [listbar] : []), ...grid.children]) {
    const r = node.getBoundingClientRect();
    if (r.height > 0 && r.bottom > 0 && r.top < vh) seen.push([node, Math.round(r.top), Math.round(r.left)]);
  }
  // 4: every card not on screen now waits for its own scroll into view.
  if (!calm && revealIO) {
    const first = new Set(seen.map((s) => s[0]));
    for (const n of nodes.values()) if (!first.has(n.li) && !n.seat.is('out')) n.reveal.go('waiting');
  }
  const played = [...lead];
  const over = () => Promise.allSettled(played.map((a) => a.finished)).then(() => { entrance.go('done'); });
  // Each line's animations join the entrance's; a card's are its rise too (the bar and the headers are not cards).
  const plays = (li, anims) => {
    played.push(...anims);
    const n = cardOf(li);
    if (n) rise(n, anims);
  };
  if (calm) {
    for (const [li] of seen) plays(li, [li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear', id: 'enter' })]);
    over();
    return;
  }
  // Rows and columns as laid out; the wave crosses the screen's diagonals in 300 ms at most (40 ms a step at most),
  // starting 180 ms into the stylesheet's entrance (at once if that has already played, or never ran).
  const rows = [...new Set(seen.map((s) => s[1]))].sort((a, b) => a - b);
  const cols = [...new Set(seen.map((s) => s[2]))].sort((a, b) => a - b);
  const span = rows.length + cols.length - 2;
  const step = span ? Math.min(40, 300 / span) : 0;
  const into = lead.length ? Math.max(...lead.map((a) => Number(a.currentTime) || 0)) : Infinity;
  const start = Math.max(0, 180 - into);
  for (const [li, top, left] of seen) {
    const delay = Math.round(start + (rows.indexOf(top) + cols.indexOf(left)) * step);
    // The rise is added to whatever the card's own translate is (a hover's lift), never in place of it.
    plays(li, [
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, delay, easing: EASE, fill: 'backwards', id: 'enter' }),
      springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(16, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'enter' }),
    ]);
  }
  over();
}

// The status line: the dot's state and the prices' age. Written only when they change (the age moves once a second
// under a minute, once a minute after), and it keeps the clock going while it can be seen.
// The feed's states, judged from the coins' updatedAt only (coins trade round the clock; stocks and commodities close
// at night and at weekends, so their age says nothing about the feed):
//   loading  no fetched prices yet;
//   down     still none 20 s after the page started, though the page holds coins (the server cannot fetch);
//   live     prices at most 5 minutes old;
//   late     older than that ("prices delayed").
// Prices never step back to older ones (load), so once fetched the feed only moves between live and late.
const feed = machine('loading', { loading: ['down', 'live', 'late'], down: ['live', 'late'], live: ['late'], late: ['live'] });
// The dot's state, and the line's colour for a feed that is late or down.
feed.on((to) => {
  if (dotEl) dotEl.className = `dot${to === 'loading' ? '' : ` ${to}`}`;
  if (updatedEl) updatedEl.className = to === 'late' || to === 'down' ? to : '';
});
let ageShown = '';
function tick() {
  let words = '';
  let age = '';
  if (!data?.updatedAt) {
    if (Boolean(data?.coins?.length) && Date.now() - startedAt > 20_000) feed.go('down');
    words = feed.is('down') ? 'prices unavailable' : 'loading…';
  } else {
    const s = Math.max(0, Math.round((Date.now() + offset - data.updatedAt) / 1000));
    feed.go(s > 300 ? 'late' : 'live');
    if (s > 300) words = 'prices delayed';
    else age = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
  }
  const shown = `${feed.state}|${words}|${age}`;
  if (shown !== statusShown) {
    statusShown = shown;
    if (updatedEl) {
      // A short age (12s, 2m) in a fixed-width slot, so the line never changes width as it ticks.
      const ageEl = age ? el('span', { class: 'd age' }, age) : null;
      updatedEl.replaceChildren(...(ageEl ? ['updated ', ageEl, ' ago'] : [words]));
      // 8: the age rolls as it ticks.
      if (ageEl) roll(ageEl, ageShown, age, 1);
      ageShown = age;
      // The page ships its slot hidden (with scripting off, an empty one would leave a dangling separator): shown at
      // its first words.
      const upd = updatedEl.closest('.upd');
      if (upd) upd.hidden = false;
    }
  }
  statusClock();
}
// The status line's clock ticks once a second, and only while the line is on screen (an IntersectionObserver says
// so), the tab is shown and no panel is open: under the glass it is unreadable and every write would make the blur
// redraw. It stops itself when any of that ends; a tick (the next render, a panel's close, the line coming back into
// view) starts it again.
const statusEl = document.querySelector('.status');
let statusSeen = true;
let clockTimer = 0;
const clockWanted = () => statusSeen && panel.is('closed') && !document.hidden;
function statusClock() {
  if (clockWanted()) {
    if (!clockTimer) clockTimer = setInterval(() => (clockWanted() ? tick() : statusClock()), 1000);
  } else if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = 0;
  }
}
if (statusEl && typeof IntersectionObserver === 'function') {
  new IntersectionObserver((entries) => {
    statusSeen = entries[entries.length - 1].isIntersecting;
    if (statusSeen && panel.is('closed')) tick();
    else statusClock();
  }).observe(statusEl);
}

async function load() {
  try {
    const res = await fetch('/api/prices', { cache: 'no-cache' });
    if (res.ok) {
      // The server's clock as the response left it, read now (before the body), but only taken with the prices.
      const skew = Date.parse(res.headers.get('date') ?? '') - Date.now();
      const next = await res.json();
      // Never step back to older prices (e.g. a just-restarted server that has not fetched yet). The clock offset comes
      // with an answer that is taken, never from one that is dropped (an older server's, or a slower overtaken fetch).
      if (!data?.updatedAt || next.updatedAt >= data.updatedAt) {
        if (Number.isFinite(skew)) offset = skew;
        data = next;
        // A fault in the drawing is reported, never taken for a failed fetch and kept quiet with it.
        try { render(); } catch (e) { setTimeout(() => { throw e; }); }
      }
    }
  } catch {
    // Keep showing the last prices; the next refresh retries.
  }
  // The server may have just started and not fetched yet: retry soon for the first minute, then every 30 s.
  clearTimeout(retry);
  if (!data?.updatedAt && Date.now() - startedAt < 60_000) retry = setTimeout(load, 3000);
}

// ---- price history for the charts: fetched when first wanted, kept in memory as long as the server keeps it ----
// One chart per candle size: the latest candles of that size (150 at most), which the line (their closes) and the
// candles both draw. Kept as long as the server keeps its own copy (its cache time for that size).
const SIZES = ['1H', '4H', '1D', '1W'];
// Each answer carries the server's cache time for its size (ttl) and its candle length (step); these tables are the
// fallback for an answer without them (an older server during a deploy).
const TTL = { '1H': 60_000, '4H': 120_000, '1D': 300_000, '1W': 1_800_000 };
const STEP = { '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000, '1W': 604_800_000 };
const hist = new Map();
const histKey = (sym, size) => `${sym}:${size}`;
function freshHist(sym, size) {
  const h = hist.get(histKey(sym, size));
  return h?.data && Date.now() - h.at < h.data.ttl ? h.data : null;
}
function cleanHist(d, sym, size) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  if (!d || d.s !== sym || d.i !== size || !Array.isArray(d.candles)) return null;
  const candles = [];
  for (const c of d.candles) {
    if (!Array.isArray(c) || c.length < 5 || !c.slice(0, 5).every(ok)) continue;
    const [t, o, hi, lo, cl] = c;
    // Ascending and one candle per time, whatever arrives.
    if (candles.length && t <= candles[candles.length - 1][0]) continue;
    candles.push([t, o, Math.max(hi, o, cl), Math.min(lo, o, cl), cl]);
  }
  // One candle is a chart too: a stock's daily on its listing day, its weekly through its first week.
  if (!candles.length) return null;
  return {
    i: size,
    src: typeof d.src === 'string' ? d.src.slice(0, 40) : '',
    since: day(d.since),
    from: day(d.from),
    step: ok(d.step) ? d.step : STEP[size],
    ttl: ok(d.ttl) ? Math.min(Math.max(d.ttl, 10_000), 3_600_000) : TTL[size],
    candles,
    stale: d.stale === true,
  };
}
// A chart the server marked stale (its refresh was still on the way) is shown, but never counts as fresh: the next ask
// fetches again.
function fetchHist(sym, size) {
  const k = histKey(sym, size);
  const h = hist.get(k) ?? { data: null, at: 0, promise: null };
  hist.set(k, h);
  if (h.promise) return h.promise;
  if (h.data && Date.now() - h.at < h.data.ttl) return Promise.resolve(h.data);
  // A request that never answers (a stalled connection) gives up after 15 s and takes the retry path; the server's own
  // wait is 12 s at most.
  const opts = typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(15_000) } : {};
  h.promise = fetch(`/api/history?s=${encodeURIComponent(sym)}&i=${size}`, opts)
    .then((res) => { if (!res.ok) throw new Error(`history ${res.status}`); return res.json(); })
    .then((d) => {
      const clean = cleanHist(d, sym, size);
      if (!clean) throw new Error('history unreadable');
      const live = nodes.get(sym)?.item?.price;
      patchLast(clean, live);
      h.data = clean;
      h.at = clean.stale ? 0 : Date.now();
      // When a run of stale answers began (dayStuck).
      h.staleSince = clean.stale ? h.staleSince || performance.now() : 0;
      return clean;
    })
    .finally(() => { h.promise = null; });
  return h.promise;
}
// A card about to be opened: its chart in the remembered size, and the hourly candles its stats row reads.
function prefetchHist(sym) {
  fetchHist(sym, cd.size).catch(() => {});
  if (cd.size !== '1H') fetchHist(sym, '1H').catch(() => {});
}
// The last candle (the one still forming) closes at the card's live price, so the panel's figures and the end of its
// line always agree; its high and low take that price in.
function patchLast(d, price) {
  if (!d || !(price > 0)) return false;
  const c = d.candles[d.candles.length - 1];
  if (c[4] === price) return false;
  c[4] = price;
  c[2] = Math.max(c[2], price);
  c[3] = Math.min(c[3], price);
  return true;
}

// ---- the chart panel ----
const dlg = document.getElementById('cd');
const PANEL = Boolean(grid && dlg && typeof dlg.showModal === 'function');
const q = (sel) => dlg.querySelector(sel);
const P = PANEL ? {
  veil: q('.cd-veil'), panel: q('.cd-panel'), bg: q('.cd-bg'), edge: q('.cd-edge'), body: q('.cd-body'), grab: q('.cd-grab'),
  lift: q('.cd-lift'), shade: q('.cd-shade'), shadeRest: q('.cd-shade-rest'), shadeLift: q('.cd-shade-lift'),
  coin: q('.cd-coin'), tilt: q('.cd-tilt'), icon: q('.cd-icon'), glint: q('.cd-glint'), band: q('.cd-glint .glint-band'),
  starA: q('.cd-star-a'), starB: q('.cd-star-b'),
  move: q('.cd-move'), sym: q('#cd-sym'), name: q('#cd-name'), price: q('.cd-price'), chg: q('.cd-chg'),
  abs: q('.cd-abs'), key: q('.cd-key'), sess: q('.cd-sess'), tr: q('.cd-tr'), ctrl: q('.cd-ctrl'),
  // The header's glass circles: the share button, the cross (the last of them), and the copy offer a download leaves.
  share: q('.cd-share'), x: q('.cd-tr > .cd-x:last-child'), copy: q('.cd-copy'), said: q('#cd-said'),
  segS: q('.seg-size'), segT: q('.seg-type'),
  chart: q('.cd-chart'), stats: q('.cd-stats'), stMcap: q('.cd-st-mcap'), stVol: q('.cd-st-vol'), stHi: q('.cd-st-hi'), stLo: q('.cd-st-lo'),
  src: q('.cd-src'), sum: q('#cd-sum'),
} : null;
const PREF_SIZE = 'printerino.chart.size';
const PREF_TYPE = 'printerino.chart.type';
// The candle size the viewer picked last; 1H until they pick. The panel used to offer ranges (1D, 7D, 1M, 1Y) under
// another key: a range kept there becomes, once, the candle size nearest to the candles its chart drew (1D drew 15
// minutes: 1H).
function storedSize() {
  const v = recall(PREF_SIZE);
  if (SIZES.includes(v)) return v;
  const old = { '1D': '1H', '7D': '4H', '1M': '1D', '1Y': '1W' }[recall('printerino.chart.range')];
  try { localStorage.removeItem('printerino.chart.range'); } catch {
    // Nothing was kept.
  }
  if (old) remember(PREF_SIZE, old);
  return old ?? '1H';
}

// ---- the frame guard: lite glass for a device that cannot keep up ----
// Judged on what the viewer does (an open, a finger on the sheet), never on load or at rest. The beat is the display's
// own frame, measured once (15 frames, the panel closed) when the viewer first points at, touches or tabs to a card, and
// never taken as faster than 60 Hz: 60 fps glass is smooth glass on a 90 or 120 Hz screen too. A stretch of frames is
// slow when more than 15% of them miss the beat by half (a compositor that cannot keep up drops one frame in four to
// six), or its median frame is over 1.1 beats. Two notches, so one bad stretch never costs the glass: the first is only
// noted (soft), the second gives later opens the lite veil (no live blur behind the panel). A view keeps the glass it
// opened with. Both are kept for this tab only: a new tab starts fresh, and no downgrade is ever kept for good.
const LOW_MEMORY = (navigator.deviceMemory ?? 8) <= 2;
const GUARD_SOFT = 'printerino.glass.soft';
const GUARD_FLAT = 'printerino.glass.flat';
const BEATS = [33.33, 16.67, 11.11, 8.33, 6.94];
function tabRecall(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function tabRemember(key, value) {
  try { sessionStorage.setItem(key, value); } catch {
    // Kept for this page view only.
  }
}
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const guard = {
  // The glass's notch, kept for this tab. Its states:
  //   full  the whole glass;
  //   soft  one slow stretch noted, nothing given up yet;
  //   flat  a second one: later opens get the lite veil, and nothing is watched any more.
  // It only ever steps down.
  notch: machine(tabRecall(GUARD_FLAT) ? 'flat' : tabRecall(GUARD_SOFT) ? 'soft' : 'full', { full: ['soft'], soft: ['flat'], flat: [] }),
  // The display's beat. Its states:
  //   unmeasured  not measured yet (or a measure was cut short: tried again later);
  //   sampling    15 frames of the page at rest being timed;
  //   measured    known (beat, in ms), for good.
  beatState: machine('unmeasured', { unmeasured: ['sampling'], sampling: ['unmeasured', 'measured'], measured: [] }),
  beat: 0,
  // The stretch being watched. Its states:
  //   idle      none (one stretch at a time);
  //   watching  the frames of an open or a drag are being timed, then judged.
  watchState: machine('idle', { idle: ['watching'], watching: ['idle'] }),
  // Measures the beat, once, over 15 frames of the page at rest (a panel opening stops it: it tries again later).
  sample() {
    if (!panel.is('closed') || document.hidden || !guard.beatState.go('sampling')) return;
    const run = guard.beatState.epoch;
    const d = [];
    let last = 0;
    const frame = (now) => {
      if (guard.beatState.epoch !== run) return;
      if (!panel.is('closed') || document.hidden) { guard.beatState.go('unmeasured'); return; }
      if (last) d.push(now - last);
      last = now;
      if (d.length < 15) { requestAnimationFrame(frame); return; }
      guard.beat = median(d);
      guard.beatState.go('measured');
    };
    requestAnimationFrame(frame);
  },
  // Watches the next n frames, after skipping the first few (a stretch's one-off work, the open's first layout and
  // paint), for as long as alive() says the stretch goes on, then judges them. One stretch at a time; nothing after the
  // second notch.
  watch(kind, n, skip, alive) {
    if (guard.notch.is('flat') || document.hidden || !guard.watchState.go('watching')) return;
    const run = guard.watchState.epoch;
    const w = { kind, d: [], last: 0, skip };
    const frame = (now) => {
      if (guard.watchState.epoch !== run) return;
      const on = alive() && !document.hidden;
      if (on && w.skip > 0) { w.skip--; w.last = now; requestAnimationFrame(frame); return; }
      // A gap of a quarter second or more is not a frame (the tab was hidden, the machine slept).
      if (on && w.last && now - w.last < 250) w.d.push(now - w.last);
      w.last = now;
      if (on && w.d.length < n) { requestAnimationFrame(frame); return; }
      guard.watchState.go('idle');
      guard.judge(kind, w.d);
    };
    requestAnimationFrame(frame);
  },
  judge(kind, d) {
    if (d.length < 12 || guard.notch.is('flat')) return;
    // Unmeasured (a chart opened from the address before any card was touched): the stretch's own quick frames.
    const seen = guard.beat || [...d].sort((a, b) => a - b)[Math.floor(d.length / 4)] || 16.67;
    const beat = Math.max(16.67, BEATS.reduce((a, r) => (Math.abs(Math.log(seen / r)) < Math.abs(Math.log(seen / a)) ? r : a)));
    const missed = d.filter((x) => x > 1.5 * beat).length / d.length;
    const mid = median(d);
    if (missed <= 0.15 && mid <= 1.1 * beat) return;
    const why = `${kind}: ${Math.round(missed * 100)}% of ${d.length} frames missed the ${beat.toFixed(1)} ms beat, median ${mid.toFixed(1)} ms`;
    const next = guard.notch.is('full') ? 'soft' : 'flat';
    if (guard.notch.go(next)) tabRemember(next === 'soft' ? GUARD_SOFT : GUARD_FLAT, why);
  },
};
// The lite glass used to be kept in localStorage for good, after one slow open: it is forgotten, and never read again.
try { localStorage.removeItem('printerino.chart.lite'); } catch {
  // Nothing was kept.
}

// ---- the chart panel's machines ----
// The panel's life. Its states:
//   closed   no panel: the dialog is shut, the page scrolls;
//   opening  the panel flies, slides or fades in (mode says which); the page is locked under it (html.cd-lock,
//            .cd-open on the stage and the list) and the chart is on its way;
//   open     at rest: it takes a scrub, a drag, the controls and live figures;
//   closing  it flies, slides or fades home; the dialog has closed (.closing keeps it drawn), the page takes clicks.
// An open may be cut short by a close at any moment; a close is never turned round (a click on another card, or a
// theme change, ends it at once). A callback started for one open checks cd.run against the open it is for.
const panel = machine('closed', { closed: ['opening'], opening: ['open', 'closing'], open: ['closing'], closing: ['closed'] });
// How the panel moves in and out, chosen at each open. Its states:
//   none   no panel;
//   morph  the card grows into the panel (and the panel flies home into it);
//   sheet  the phone's sheet slides up from the bottom (and down again);
//   fade   reduced motion, a deep link or a card off screen: the panel fades in (and out).
// A window crossing the phone breakpoint while a panel is up turns a morph or a fade into a sheet, or a sheet into a
// fade: the new layout leaves its own way.
const mode = machine('none', { none: ['morph', 'sheet', 'fade'], morph: ['sheet', 'fade', 'none'], sheet: ['fade', 'none'], fade: ['sheet', 'none'] });
// The panel's place in the history. Its states:
//   bare     no entry of the panel's own (a deep link's hash may still be in the address);
//   pushed   the panel opened by a click pushed its own entry (#btc), the current one;
//   leaving  a close asked history.back() to take that entry away, and its popstate has not come yet;
//   waiting  as leaving, and a card clicked since wants its own entry: it is pushed once that popstate has landed, so
//            the late popstate can never be taken for this panel's (that would leave the old hash in the address).
// The history calls themselves are made on the moves (addr.on below).
const addr = machine('bare', { bare: ['pushed'], pushed: ['leaving', 'bare'], leaving: ['bare', 'waiting'], waiting: ['leaving', 'pushed'] });
const cd = {
  sym: null, item: null, li: null,
  size: storedSize(),
  type: recall(PREF_TYPE) === 'candles' ? 'candles' : 'line',
  // run: the open this is (the panel's epoch as it went to opening), for the callbacks an open starts.
  run: 0,
  // fly: the open's morph (its pose, its target, its clock). queued: live figures owed to a panel that could not take
  // them yet (it was flying in or its chart moving).
  anims: new Set(), coinAnim: null, fly: null, t0: 0, timer: 0, queued: false,
  hashDone: false,
  // ghost: the copy of the card that rides a flight (ghostFor), while there is one.
  ghost: null,
  // The corner radii a morph runs between, the card's and the panel's, as the stylesheet draws them (read at each open).
  r: { card: 20, panel: 32 },
  // Lite glass for this view: no live blur on a device that could not keep up (the guard), or with 2 GB of memory or
  // less. Settled at each open.
  lite: LOW_MEMORY || guard.notch.is('flat'),
};
// What the page owes the card a panel is flying home into (flightCard: landing). Its states:
//   clean  nothing: every answer is drawn as it comes;
//   owed   an answer came during the flight and part of it waits: new figures for the landing card (renderGrid), or a
//          new order of the cards (arrange).
// The move back to clean draws the page from the newest data (render): the cards move to their order from where they
// are, and the card swaps in its figures. The panel makes that move once it has closed (panel.on).
const owed = machine('clean', { clean: ['owed'], owed: ['clean'] });
owed.on((to) => { if (to === 'clean') render(); });
// The open this callback was started for is still the one on screen, and still opening or open.
const runLive = (run) => run === cd.run && panel.is('opening', 'open');
// A timer for the panel's current state: it does nothing once the panel has moved on (every move clears it too).
function panelLater(fn, ms) {
  const at = panel.epoch;
  cd.timer = setTimeout(() => { if (panel.epoch === at) fn(); }, ms);
}
// Whether the backdrop is filtered live by the compositor, and the media that ask for plain glass (a solid ground).
const LIVE_BACKDROP = typeof CSS !== 'undefined' && Boolean(CSS.supports?.('backdrop-filter', 'blur(1px)') || CSS.supports?.('-webkit-backdrop-filter', 'blur(1px)'));
const PLAIN = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
// The veil is painted (glass.js) where the live blur cannot or should not run, unless plain glass is asked for.
const veilWantsPaint = () => !PLAIN.matches && (cd.lite || !LIVE_BACKDROP);
// The viewer's last input was a key (Tab, Enter, Esc), not a pointer: only then does a card that takes focus back show
// its ring.
let keyed = false;
// Parts of the card that fly to their twins in the panel. Each twin has the card's own words, but a card's type is its
// form's (a leader's symbol is 22px, a board row's 15px, a tile's price 22px; the panel's are 17px and 44px), so every
// twin starts scaled to the card's size and grows to its own, its weight and letter-spacing easing over with it
// (partPose). A part the card does not show, or shows in another shape (a board row's stat is its figure alone; a
// tile's label stands beside its figure, not over it), has nothing to fly from: its twin fades in where it rests.
const FLY = ['sym', 'name', 'price', 'chg', 'key', 'mcap', 'vol'];
const flyCard = (r) => ({ sym: r.sym, name: r.name, price: r.price, chg: r.chg, key: r.key, mcap: r.mcapBox, vol: r.volBox });
const flyPanel = () => ({ sym: P.sym, name: P.name, price: P.price, chg: P.chg, key: P.key, mcap: P.stMcap, vol: P.stVol });
// Words with no twin that sit beside one ride along with it and fade in: the dollar move and the session note after the
// chip's key (the card has nothing there, so they never cover a word), the day's high and low with the stats row
// (later: on the card they would sit past its edge).
const FOLLOW = { abs: 'key', sess: 'key', hi: 'vol', lo: 'vol' };
const FOLLOW_DELAY = { abs: 100, sess: 100, hi: 250, lo: 250 };
const followers = () => ({ abs: P.abs, sess: P.sess, hi: P.stHi, lo: P.stLo });
// The rest fade in once the growing card has reached them: the header's circles (share and close) together.
const reveals = () => [P.tr, P.ctrl, P.chart, P.src];
const track = (a) => { cd.anims.add(a); const drop = () => cd.anims.delete(a); a.finished.then(drop, drop); return a; };

// A flying part as it is drawn: its box; the box of every run of text in it, in reading order (a run is one text
// node's stretch on one line); and what sets the shape of its first run's glyphs: their size, their weight and their
// letter-spacing (in em). A part that is not drawn has no runs. For a part that is one line of words (line), base is
// where its baseline lies: measured (baselineIn), as a run's box says where its glyphs are only to within the rounding
// of the font's ascent, which is not the same at two sizes.
function readPart(node, line = false) {
  const part = { box: node.getBoundingClientRect(), runs: [], size: 0, weight: 400, spacing: 0, base: null };
  if (!part.box.width || !part.box.height) return part;
  const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let first = null;
  for (let t = texts.nextNode(); t; t = texts.nextNode()) {
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue;
      part.runs.push(r);
      first ??= t.parentElement;
    }
  }
  if (first) {
    const cs = getComputedStyle(first);
    part.size = parseFloat(cs.fontSize) || 0;
    part.weight = Number(cs.fontWeight) || 400;
    part.spacing = part.size ? (parseFloat(cs.letterSpacing) || 0) / part.size : 0;
    if (line) part.base = part.box.top + baselineIn(node);
  }
  return part;
}
// The flying parts that are one line of words: they may land scaled, on their baselines.
const LINE = new Set(['sym', 'name', 'price', 'key']);
// The card wherever it sits (the stage or the list) and whatever it is laid out as.
function readCard(n) {
  const out = { card: n.li.getBoundingClientRect(), icon: n.refs.coin.getBoundingClientRect() };
  // A leader's stage cuts it at its own edges where the stage is a row that scrolls sideways (onScreen).
  out.clip = n.seat.is('stage') ? stage.getBoundingClientRect() : null;
  const parts = flyCard(n.refs);
  for (const k of FLY) out[k] = readPart(parts[k], LINE.has(k));
  out.nameCut = n.refs.name.scrollWidth > n.refs.name.clientWidth;
  // How far its hover lift (its shadow layer) is in, from 0 to 1: the open leaves the card as it is drawn.
  out.lifted = clamp(Number(getComputedStyle(n.li, '::after').opacity) || 0, 0, 1);
  return out;
}
// The panel starts on a whole pixel. Centred in the window it falls half a pixel off whenever the room left over is
// odd, and then every capsule in it is half a pixel off its digits: a browser draws text on whole pixels but a box
// wherever it falls (style.css, "Whole pixels down the page"). Never while it moves: a slide or a drag has it on a
// transform, and it is measured again once that is over.
function snapPanel() {
  if (sheet.is('dragging') || P.panel.getAnimations().some((a) => a.playState === 'running')) return;
  P.panel.style.top = '';
  const top = P.panel.getBoundingClientRect().top;
  const y = Math.round(top) - top;
  if (Math.abs(y) > 1 / 128) P.panel.style.top = `${y}px`;
}
function readPanel() {
  snapPanel();
  const out = { bg: P.bg.getBoundingClientRect(), panel: P.panel.getBoundingClientRect(), body: P.body.getBoundingClientRect(), icon: P.coin.getBoundingClientRect(), fly: {}, reveals: [], segs: segRead() };
  const parts = flyPanel();
  for (const k of FLY) out.fly[k] = readPart(parts[k], LINE.has(k));
  for (const node of reveals()) out.reveals.push([node, node.getBoundingClientRect()]);
  return out;
}
// At least half the card on screen, or the panel does not fly into it or out of it. On screen is inside the window
// and, for a card in a box that scrolls (clip: the stage's box), inside that box too.
function onScreen(r, clip = null) {
  const left = Math.max(r.left, 0, clip?.left ?? 0);
  const right = Math.min(r.right, innerWidth, clip?.right ?? Infinity);
  const top = Math.max(r.top, 0, clip?.top ?? 0);
  const bottom = Math.min(r.bottom, innerHeight, clip?.bottom ?? Infinity);
  return r.width > 0 && Math.max(0, right - left) * Math.max(0, bottom - top) >= 0.5 * r.width * r.height;
}

// The corners a flight runs between, as the stylesheet draws them: read at each open (any panel may close into its
// card). The card and the panel's surface share their corner's shape (a squircle where the browser draws one, round
// elsewhere), in both themes, so a flight only runs between the two radii.
const cornerOf = (node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
function readRadii(li) {
  cd.r = { card: cornerOf(li), panel: cornerOf(P.bg) };
}

// How a card's part (a) sits against its twin (b) as a flight sets off or lands: the twin scaled about its box's top
// left corner by the two sizes of type, so that its first run of text lies on the card's, in the weight and the
// letter-spacing the card draws it in (w, ls; w1 and ls1 are the twin's own, and type says they differ). Null when the
// card's part is not the twin's shape: it is not drawn, it has another number of runs, or a run of it is more than
// 15% off the twin's run in size (a pixel at least) or more than 1.5px off its place among the others.
function partPose(a, b) {
  if (!a.runs.length || a.runs.length !== b.runs.length || !a.size || !b.size) return null;
  const s = a.size / b.size;
  const a0 = a.runs[0];
  const b0 = b.runs[0];
  const off = (v, w) => Math.abs(v - w) > Math.max(1, 0.15 * w);
  for (let i = 0; i < a.runs.length; i++) {
    const ra = a.runs[i];
    const rb = b.runs[i];
    if (off(ra.width, s * rb.width) || off(ra.height, s * rb.height)) return null;
    if (Math.abs(ra.left - a0.left - s * (rb.left - b0.left)) > 1.5 || Math.abs(ra.top - a0.top - s * (rb.top - b0.top)) > 1.5) return null;
  }
  // Scaled, it lies on the card's baseline (measured); at its own size the two runs' boxes say the same thing exactly.
  const scaled = s !== 1 && a.base !== null && b.base !== null;
  return {
    dx: a0.left - b.box.left - s * (b0.left - b.box.left), dy: scaled ? a.base - b.box.top - s * (b.base - b.box.top) : a0.top - b.box.top - s * (b0.top - b.box.top), s, o: 1,
    w: a.weight, ls: a.spacing, w1: b.weight, ls1: b.spacing, type: a.weight !== b.weight || Math.abs(a.spacing - b.spacing) > 1e-4,
  };
}
// The pose of every flying part when the panel sits at the card, measured against where it rests in the panel. fade
// lists the twins with no part in the card to fly from or into (partPose): they fade in, and out, where they rest.
function cardPose(from, to) {
  const pose = {
    bg: { dx: from.card.left - to.bg.left, dy: from.card.top - to.bg.top, sx: from.card.width / to.bg.width, sy: from.card.height / to.bg.height, r: cd.r.card, edge: 0, lift: 0, hand: 0 },
    icon: {
      dx: from.icon.left + from.icon.width / 2 - (to.icon.left + to.icon.width / 2),
      dy: from.icon.top + from.icon.height / 2 - (to.icon.top + to.icon.height / 2),
      s: from.icon.width / to.icon.width, rot: COIN_TURN,
    },
    parts: {},
    fade: [],
  };
  for (const k of FLY) {
    if (!to.fly[k].box.width) continue;
    const part = partPose(from[k], to.fly[k]);
    if (part) pose.parts[k] = part;
    else pose.fade.push(k);
  }
  return pose;
}
// When a twin that fades in (cardPose's fade) starts to, ms into an open: the header's words early, the stats row later
// (the growing card reaches the panel's foot last).
const FADE_DELAY = { sym: 80, name: 80, price: 80, chg: 80, key: 100, mcap: 250, vol: 250 };
// A card shows more than the panel's header holds: its rank, a leader's place, its week, and whatever it lays out in
// another shape than the panel does (a board row's bare figures). None of these can fly, and none may blink out as the
// card hides under the panel, or pop in as the panel hands the card back. So a copy of the card, less everything that
// does fly, rides the flying surface by its top left corner: there in the open's first frame and gone moments later,
// and back over the close's last stretch, when the surface is all but the card (openMorph and closeMorph move and fade
// it). The copy sits in the panel's body, which is cut to the flying card, inside a box that stands in for the card's
// own (the list's class and layout, for a row or a tile), so the stylesheet lays it out as it does the card.
const GHOST_PART = { sym: '.sym', name: '.name', price: '.price', chg: '.chg', key: '.chg-key', mcap: '.st-mcap', vol: '.st-vol' };
function ghostFor(n, from, to, pose) {
  ghostOff();
  const li = n.li.cloneNode(true);
  for (const k of ['data-sym', 'role', 'style']) li.removeAttribute(k);
  li.classList.remove('is-source', 'handing', 'landing', 'wait', 'out', 'pressed', 'vt-out', 'vt-back');
  // A tick's band is the card's alone. The week's line rides along as it stands: the copy holds its paths and its dot
  // (a line still held back stays undrawn in the copy too), and none of the draw-in, which is the card's own animation.
  li.querySelector('.tick')?.remove();
  // What flies is the panel's to draw: the coin (its box keeps its place) and each part with a pose.
  const coin = li.querySelector('.coin');
  coin.replaceChildren();
  for (const node of [coin, ...Object.keys(pose.parts).map((k) => li.querySelector(GHOST_PART[k]))]) node.style.visibility = 'hidden';
  li.style.height = `${from.card.height}px`;
  const box = el('ol', n.seat.is('stage') ? { class: 'cd-ghost', 'aria-hidden': 'true' } : { class: 'cd-ghost grid', 'data-view': listView.state, 'aria-hidden': 'true' }, li);
  box.inert = true;
  // Where the surface's own corner rests, so the surface's translate carries it.
  box.style.left = `${to.bg.left - to.body.left}px`;
  box.style.top = `${to.bg.top - to.body.top}px`;
  box.style.width = `${from.card.width}px`;
  P.body.append(box);
  cd.ghost = box;
  return box;
}
function ghostOff() {
  cd.ghost?.remove();
  cd.ghost = null;
}
const REST = { bg: { dx: 0, dy: 0, sx: 1, sy: 1, edge: 1, lift: 1, hand: 1 }, icon: { dx: 0, dy: 0, s: 1, rot: 0 }, part: { dx: 0, dy: 0, s: 1, o: 1 } };
// The flying surface's shadows (style.css, .cd-lift and .cd-shade): lift is how far the panel's own lift is in, against
// the card's shadows (1 - lift). The card's sit on a box the card's size, scaled up to the surface's box by the inverse
// of the scale (sx, sy) at which the surface is the card's size, so drawn at that scale they are the card's own shadows,
// not the panel's shrunk. Set at the start of each flight, for the card it leaves or lands on. Flying, the surface is
// above the page and casts them over the neighbouring cards too; at rest a card's shadows lie under its neighbours. So
// the card itself (its shadows only: .handing) holds them while the surface is on it, and hand is how far the surface
// holds them instead: taken from the card in the open's first moments, given back in the close's last, never in one
// frame.
// The card the panel flies from and home to is a machine of its own; its classes follow from its state
// (the stylesheet's .is-source, .handing and .landing), set in one place:
//   home:     an ordinary card, on the stage or in the list;
//   source:   its panel is open over it: the card is hidden under the panel;
//   handing:  hidden, and holding its own shadows while the panel's surface is on it (an open's first moments);
//   landing:  hidden, holding its shadows, and the panel flying home into it: a pointer over it lifts both.
// flightCard.li is the card it is about; cardTo() sends a card to a state, first sending the one before it home.
const CARD_LOOK = { home: [], source: ['is-source'], handing: ['is-source', 'handing'], landing: ['is-source', 'landing', 'handing'] };
const flightCard = machine('home', {
  home: ['source', 'handing', 'landing'],
  source: ['handing', 'landing', 'home'],
  handing: ['source', 'landing', 'home'],
  landing: ['home'],
});
flightCard.li = null;
flightCard.on((to) => {
  const li = flightCard.li;
  if (!li) return;
  li.classList.remove('is-source', 'handing', 'landing');
  if (CARD_LOOK[to].length) li.classList.add(...CARD_LOOK[to]);
});
function cardTo(to, li = flightCard.li) {
  if (li !== flightCard.li) {
    flightCard.go('home');
    flightCard.li = li;
  }
  return flightCard.go(to);
}
// The card's shadows sized for card n: its box, its corner (cd.r.card, read for this flight) and, for a row of the
// board, the slab's own tone and top line (.slab; the stylesheet's .cd-shade-rest).
function shadeFor(sx, sy, bg, n) {
  P.shade.style.width = `${bg.width * sx}px`;
  P.shade.style.height = `${bg.height * sy}px`;
  P.shade.style.transform = `scale(${1 / sx}, ${1 / sy})`;
  P.shade.style.borderRadius = `${cd.r.card}px`;
  P.shade.classList.toggle('slab', n.seat.is('list') && listView.is('board'));
}
function shadeOff() {
  for (const k of ['width', 'height', 'transform', 'borderRadius']) P.shade.style[k] = '';
  P.shade.classList.remove('slab');
}
// The panel's lift comes in over the middle of the open, as the card's shadows go: never both at full, never neither.
const smooth01 = (u) => { const s = clamp(u, 0, 1); return s * s * (3 - 2 * s); };
const liftAt = (p) => smooth01((p - 0.1) / 0.6);

// Every part of a close lands on the pixels of its twin in the card, not only on its box. A browser draws text, images
// and boxes on whole device pixels (a line's baseline, an image's corner and a box's edges are rounded where they are
// laid out, in the page). A moving layer is drawn once, where its animation starts, and from then on only those pixels
// move: Chromium does not draw it again until it stops, so a word that has flown a fraction of a pixel shows soft,
// between two rows, a pixel off its twin, and sharpens with a jump at the hand-off. Each flying word is first nudged
// (relative positioning, under half a pixel; the nudge stays, the word is drawn on the same pixels either way) onto
// the same fraction of a pixel as its twin, sets off from a whole pixel, and flies a whole number of pixels, so it is
// drawn as its twin is and lands on its twin's pixels. A word that lands scaled (the price, laid out at 44px and scaled
// to the card's size; a symbol or a name the card sets larger or smaller than the panel) is nudged so its baseline
// sits on the pixel it is drawn on, and lands on the card's word, its baseline on the pixel the card's is drawn on
// (the price also rests with its left on a whole pixel where it can); the coin (64px, scaled to the card's coin) is
// nudged onto a whole pixel of its own and lands on the card's; the surface lands on the pixels the card's box is
// drawn on.
// Chromium too: at its real scale (a Retina screen, a zoomed page) it rounds to device pixels, not CSS ones; only its
// emulated scale (DevTools' device mode) rounds to whole CSS pixels. The fractions are worked out on the grid the
// browser lays out on (dev) and written so that it keeps them whole (nudge): a nudge that fell a hair short of its step
// would draw a word that sits 0.48 of a pixel down at 0.5 down, a row lower than its twin.
const pixel = () => 1 / (devicePixelRatio || 1);
// v in device pixels, on the grid of 1/64 of a device pixel the browser lays out on. A place read back through the
// page's scroll comes with a float error (a scroll of 1324 device pixels at 1.25x reads 1323.99994), which on a card
// laid out on half a pixel would round it the wrong way.
const dev = (v) => Math.round((v / pixel()) * 64) / 64;
// v on the pixel the browser draws it on (from half a pixel, the next one right or down, as the browser rounds).
const onPixel = (v) => Math.round(dev(v)) * pixel();
// The fraction of a pixel v is past the pixel it starts on, in pixels.
const frac = (v) => dev(v) - Math.floor(dev(v));
// A nudge as written to an element's style: a hair (1/256 of a device pixel) further from zero, as the browser keeps
// a length to 1/64 of a pixel by cutting it toward zero, and a nudge that falls a float error short of a step would
// lose that step.
const nudge = (v) => `${v ? v + Math.sign(v) * (pixel() / 256) : 0}px`;
// The step, under half a pixel either way, that brings v onto the same fraction of a pixel as w.
function toFraction(v, w) {
  const d = frac(w) - frac(v);
  return (d >= 0.5 ? d - 1 : d < -0.5 ? d + 1 : d) * pixel();
}
// A step under 1/256 of a pixel is a float error, not a step (the browser lays out to 1/64 of a device pixel).
const stepOrNone = (d) => (Math.abs(d) < 0.004 ? 0 : d);
let probe = null;
// How far below the top of node's box its first baseline is (a zero-size box sitting on the baseline, measured and
// taken out again at once).
function baselineIn(node) {
  if (!probe) probe = el('span', { class: 'cd-probe', 'aria-hidden': 'true' });
  node.append(probe);
  const y = probe.getBoundingClientRect().top - node.getBoundingClientRect().top;
  probe.remove();
  return y;
}
// The nudge (x, y) and the landing pose of every part. The card sits in the scrolled page, where it is drawn by its
// place in the page; the panel in the fixed dialog. Reads only; the panel's parts must be at rest (no transform).
function landOnPixels(n, from, to, pose) {
  const X = scrollX;
  const Y = scrollY;
  const parts = {};
  for (const k of FLY) {
    const t = pose.parts[k];
    if (!t) continue;
    const b = to.fly[k].box;
    if (t.s !== 1 && from[k].base !== null && to.fly[k].base !== null) {
      // A part that lands scaled (the price, and any word the card sets in another size): it takes no sideways step
      // (the price's left is already on a whole pixel where it must be: priceOnPixel), and it lands with its baseline
      // on the pixel the card's own is drawn on (both baselines as measured: readPart).
      const bp = to.fly[k].base - b.top;
      const y = onPixel(b.top + bp) - (b.top + bp);
      parts[k] = { x: 0, y, dx: t.dx, dy: onPixel(from[k].base + Y) - Y - t.s * bp - (b.top + y) };
    } else {
      // A part that lands at its own size: where its box comes to rest on the card (its words on the card's words).
      const x = toFraction(b.left, b.left + t.dx + X);
      const y = toFraction(b.top, b.top + t.dy + Y);
      parts[k] = { x, y, dx: t.dx - x, dy: t.dy - y };
    }
  }
  // The coin turns and scales about its centre.
  const ic = from.icon;
  const ip = to.icon;
  const x = onPixel(ip.left) - ip.left;
  const y = onPixel(ip.top) - ip.top;
  const icon = {
    x, y,
    dx: onPixel(ic.left + X) - X + ic.width / 2 - (ip.left + x + ip.width / 2),
    dy: onPixel(ic.top + Y) - Y + ic.height / 2 - (ip.top + y + ip.height / 2),
  };
  const c = from.card;
  const L = onPixel(c.left + X) - X;
  const T = onPixel(c.top + Y) - Y;
  const R = onPixel(c.right + X) - X;
  const B = onPixel(c.bottom + Y) - Y;
  // A scaled box is drawn from the pixel its corner is laid out on, so the panel's surface scales from there.
  const g = to.bg;
  const gl = onPixel(g.left);
  const gt = onPixel(g.top);
  const bg = { dx: L - gl, dy: T - gt, sx: (R - L) / (onPixel(g.right) - gl), sy: (B - T) / (onPixel(g.bottom) - gt) };
  return { parts, icon, bg };
}
// The panel's surface with its top left corner on a whole device pixel (its right and bottom edges stay put): scaled, as
// it is in a morph, a browser draws it from the pixel its corner is on and rounds its size, not its far edges, so a
// corner between two pixels would draw it a pixel short or long of where it rests. Drawn at rest, nothing moves.
function bgOnPixels() {
  P.bg.style.left = '';
  P.bg.style.top = '';
  const g = P.bg.getBoundingClientRect();
  P.bg.style.left = nudge(onPixel(g.left) - g.left);
  P.bg.style.top = nudge(onPixel(g.top) - g.top);
}
// The panel's price with its left edge on a whole device pixel, set as the panel opens and again as it closes (a window
// resized in between has moved it). Scaled as it flies, Chromium draws the price from the whole pixel its box is laid
// out on, its fraction dropped; at rest it is drawn on that fraction. A centred panel on half a pixel (an odd window
// width) would show the flying price half a pixel off its place, and the open would end, and the close begin, with a
// sideways step. Where the browser cannot place it on a whole pixel (WebKit keeps a length to 1/64 of a CSS pixel,
// which at 3x falls between device pixels), it stays where it is laid out: WebKit keeps the fraction as it flies, and
// a price a hair off a whole pixel would be drawn a quarter of a pixel off at rest.
function priceOnPixel() {
  P.price.style.left = '';
  const l = P.price.getBoundingClientRect().left;
  const d = stepOrNone(onPixel(l) - l);
  if (!d) return;
  P.price.style.left = nudge(d);
  const m = dev(P.price.getBoundingClientRect().left);
  if (m !== Math.round(m)) P.price.style.left = '';
}
// The surface grows to its full size and no further: its place overshoots with the spring, its size eases into a cap
// instead (the same as the spring's until 98% of the way, then rounding off with no step in speed). Chromium draws a
// scaling layer once, at the largest scale its animation reaches, so a surface that grew past its size would land
// drawn from pixels made a little larger: a soft edge, a pixel off, that sharpens with a jump as the panel settles.
function capped(p) {
  if (p <= 0.98) return p;
  if (p >= 1) return 1;
  const u = (p - 0.98) / 0.02;
  return 0.98 + 0.02 * (u + u * u - u * u * u);
}
// Where everything is, ms into the open (springs share one clock, so every part stays on the growing card).
function openPose(pose, ms) {
  const t = ms / 1000;
  const p = homing(SPRING.gentle)(ms);
  const size = capped(p);
  const spin = ms >= settleMs(SPRING.spin) ? 1 : springFn(SPRING.spin)(t);
  const grow = ms >= settleMs(SPRING.bounce) ? 1 : springFn(SPRING.bounce)(t);
  const out = {
    bg: { dx: lerp(pose.bg.dx, 0, p), dy: lerp(pose.bg.dy, 0, p), sx: lerp(pose.bg.sx, 1, size), sy: lerp(pose.bg.sy, 1, size), r: lerp(cd.r.card, cd.r.panel, p), edge: clamp(p * 1.6 - 0.45, 0, 1), lift: liftAt(p), hand: smooth01(p / 0.05) },
    icon: { dx: lerp(pose.icon.dx, 0, p), dy: lerp(pose.icon.dy, 0, p), s: lerp(pose.icon.s, 1, grow), rot: lerp(COIN_TURN, 0, spin) },
    parts: {},
  };
  for (const [k, v] of Object.entries(pose.parts)) out.parts[k] = { dx: lerp(v.dx, 0, p), dy: lerp(v.dy, 0, p), s: lerp(v.s, 1, p), o: 1, w: lerp(v.w, v.w1, p), ls: lerp(v.ls, v.ls1, p) };
  return out;
}
const bgFrame = (b) => ({ transform: `translate(${b.dx}px, ${b.dy}px) scale(${b.sx}, ${b.sy})` });
// The corner stays round at every frame: the radius is divided by the scale on each axis.
const radiusFrame = (b) => ({ borderRadius: `${b.r / b.sx}px / ${b.r / b.sy}px` });
const partFrame = (v) => ({ transform: `translate(${v.dx}px, ${v.dy}px) scale(${v.s})` });
// A flying word's weight and letter-spacing on the way between the card's and the panel's. An animation of its own: it
// is laid out on the main thread, and must not drag the word's transform off the compositor.
const typeFrame = (v) => ({ fontWeight: v.w.toFixed(1), letterSpacing: `${v.ls.toFixed(4)}em` });
const iconFrame = (v) => ({ transform: v.flat ? `translate(${v.dx}px, ${v.dy}px) scale(${v.s})` : `translate(${v.dx}px, ${v.dy}px) perspective(600px) rotateY(${v.rot}deg) scale(${v.s})` });
// The coin's turn on the way home, against the flight's progress c: a quarter faster than the flight, easing to a stop
// nine tenths of the way, so it lies flat for the last stretch (closeMorph).
const turnHome = (c) => (c <= 0.7 ? 1.25 * c : c >= 0.9 ? 1 : 0.875 + 1.25 * (c - 0.7) - 3.125 * (c - 0.7) ** 2);
// The coin's flight: its pose at each keyframe, as one sampled animation.
function coinFlight(duration, poseAt, extra) {
  return sampled(P.coin, duration, (ms, last) => iconFrame(poseAt(ms, last)), extra);
}
// The panel's words are cut to the flying card, so nothing ever paints outside it (at rest the body and the card share
// one box): an inset from each side, negative where the card reaches past the panel's own box.
const clipFrame = (b, rest) => {
  const px = (v) => `${v.toFixed(2)}px`;
  return { clipPath: `inset(${px(b.dy)} ${px(rest.width * (1 - b.sx) - b.dx)} ${px(rest.height * (1 - b.sy) - b.dy)} ${px(b.dx)} round ${px(b.r)})` };
};

function openMorph(n, from, to) {
  const pose = cardPose(from, to);
  // Each word sets off on the same fraction of a device pixel as its place in the panel (under half a pixel from its
  // twin in the card, which hides in that same frame) and flies a whole number of pixels, so it lands as sharp as it
  // rests and the panel settles without a word moving (a moving layer keeps the pixels it was first drawn with: see
  // landOnPixels).
  for (const v of Object.values(pose.parts)) { v.dx = onPixel(v.dx); v.dy = onPixel(v.dy); }
  cd.fly = { pose, to };
  cd.t0 = performance.now();
  morph.go('flying');
  const D = settleMs(SPRING.gentle);
  const at = (ms) => openPose(pose, ms);
  const surface = track(sampled(P.bg, D, (ms) => bgFrame(at(ms).bg)));
  cd.fly.clock = surface;
  // Its own animation: the radius is painted on the main thread and must not drag the transform off the compositor.
  track(sampled(P.bg, D, (ms) => radiusFrame(at(ms).bg)));
  track(sampled(P.edge, D, (ms) => ({ opacity: at(ms).bg.edge })));
  // It leaves the card with the card's own shadows (its hover lift as far as it was in) and grows into the panel's lift.
  // For its first moments the card keeps them itself, under its neighbours.
  shadeFor(pose.bg.sx, pose.bg.sy, to.bg, n);
  cardTo('handing', n.li);
  track(sampled(n.li, D, (ms) => ({ opacity: 1 - at(ms).bg.hand }), { id: 'hand' }));
  track(sampled(P.shade, D, (ms) => ({ opacity: at(ms).bg.hand })));
  track(sampled(P.lift, D, (ms) => ({ opacity: at(ms).bg.lift })));
  track(sampled(P.shadeRest, D, (ms) => ({ opacity: 1 - at(ms).bg.lift })));
  if (from.lifted) track(sampled(P.shadeLift, D, (ms) => ({ opacity: from.lifted * (1 - at(ms).bg.lift) })));
  track(sampled(P.body, D, (ms) => clipFrame(at(ms).bg, to.bg)));
  for (const [k, node] of Object.entries(flyPanel())) {
    if (pose.parts[k]) {
      track(sampled(node, D, (ms) => partFrame(at(ms).parts[k])));
      if (pose.parts[k].type) track(sampled(node, D, (ms) => typeFrame(at(ms).parts[k])));
    } else if (pose.fade.includes(k)) {
      // Nothing in the card to fly from: it fades in where it rests (the body's clip shows it once the card is there).
      track(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: FADE_DELAY[k], easing: EASE, fill: 'backwards' }));
    }
  }
  // The name is the card's own words, so it simply flies and never blinks out. Only a name the card cut short fades in
  // as it flies, as the card shows only its start.
  if (pose.parts.name && (from.nameCut || n.refs.name.textContent !== P.name.textContent)) {
    track(P.name.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80, easing: EASE, fill: 'backwards' }));
  }
  // A follower rides along with its lead; where the lead itself only fades in, it fades in beside it, at rest.
  for (const [k, node] of Object.entries(followers())) {
    const lead = FOLLOW[k];
    if (pose.parts[lead]) track(sampled(node, D, (ms) => { const v = at(ms).parts[lead]; return partFrame({ dx: v.dx, dy: v.dy, s: 1 }); }));
    track(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: FOLLOW_DELAY[k], easing: EASE, fill: 'backwards' }));
  }
  // What the card shows and the panel does not sets off with the surface and is gone within 140 ms.
  const ghost = ghostFor(n, from, to, pose);
  track(sampled(ghost, D, (ms) => { const g = at(ms).bg; return { transform: `translate(${g.dx}px, ${g.dy}px)` }; }));
  track(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE, fill: 'forwards' }));
  // The coin flips once on the way and lands with a small bounce. The panel is live as soon as the card has landed;
  // the coin's last few degrees go on without holding anything up.
  const iconMs = Math.max(settleMs(SPRING.spin), settleMs(SPRING.bounce), D);
  cd.coinAnim = track(coinFlight(iconMs, (ms) => at(ms).icon));
  track(P.veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: EASE }));
  // Each part without a twin appears once the growing card covers it, so the cascade spreads out from the card. As from
  // the middle column, it also waits until the card is 85% of the way in and the card's own spot under it is within
  // 36px of its place: a card that starts under the controls (a column right of the centre, a low row) or far from them
  // (the right edge of a wide screen) would otherwise show them fading in on the spot while it still slides beneath.
  const ease = springFn(SPRING.gentle);
  const late = reachMs(ease, 0.85, D);
  let chartDelay = 200;
  for (const [node, r] of to.reveals) {
    let delay = clamp(Math.max(coverMs(r, from.card, to.bg, ease, D), nearMs(r, from.card, to.bg, ease, D), late) - 20, 60, 320);
    // The circles also wait for the flying words to have passed them: from a card whose corner starts right of the
    // panel's (the right columns of a wide window), the symbol travels left straight through their spot. So does the
    // source line, which the stats row crosses on its way up from a card in a low row.
    if (node === P.tr || node === P.src) delay = Math.max(delay, Math.min(passMs(r, pose, to, D), D - 260));
    track(node.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay, easing: EASE, fill: 'backwards' }));
    if (node === P.chart) {
      chartDelay = delay + 60;
      // The axis words wait the same way for the stats row: from a card high on a tall window, the stats fly down
      // through the time words' line under the plot while the chart is already fading in. The plot keeps its timing.
      // That line starts 8px under the plot and is 12px tall (paintFrame, .cd-axis span).
      const row = { left: r.left, right: r.right, top: r.bottom - PLOT_PAD + 8, bottom: r.bottom - PLOT_PAD + 20 };
      const words = Math.min(passMs(row, pose, to, D), D - 260);
      if (words > delay) track(C.axis.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: words, easing: EASE, fill: 'backwards' }));
    }
  }
  chartEnter(chartDelay);
  // The panel settles once its card has drawn its last frame, at rest (an animation starts on the frame after it is
  // made, so a timer of the same length would settle it a frame early, a pixel short of its place, and finish it with a
  // jump). The timer stays as a backstop.
  const move = panel.epoch;
  surface.finished.then(() => { if (panel.epoch === move) openSettled(); }, () => {});
  panelLater(openSettled, D + 250);
  glintPanel(Math.round(settleMs(SPRING.spin) * 0.55));
}
// First moment (ms) at which the growing card holds all of rect r (to within a pixel), with the 8px under it that it
// rises from: a wide part (the chart's price words at its right edge, the source line) never shows cut by the card's
// moving edge.
function coverMs(r, from, to, ease, dur) {
  if (!r.width || !r.height) return 0;
  for (let ms = 0; ms <= dur; ms += 8) {
    const p = ease(ms / 1000);
    const L = lerp(from.left, to.left, p);
    const T = lerp(from.top, to.top, p);
    const R = lerp(from.right, to.right, p);
    const B = lerp(from.bottom, to.bottom, p);
    if (L <= r.left + 1 && T <= r.top + 1 && R >= r.right - 1 && B >= r.bottom + 7) return ms;
  }
  return dur;
}
// First moment (ms) after which no flying word touches rect r (taken 8px deeper, as a revealed part rises 8px into place).
function passMs(r, pose, to, dur) {
  let last = -1;
  for (let ms = 0; ms <= dur; ms += 8) {
    const parts = openPose(pose, ms).parts;
    for (const [k, v] of Object.entries(parts)) {
      const b = to.fly[k].box;
      const L = b.left + v.dx;
      const T = b.top + v.dy;
      if (L < r.right && L + b.width * v.s > r.left && T < r.bottom + 8 && T + b.height * v.s > r.top) { last = ms; break; }
    }
  }
  return last < 0 ? 0 : last + 8;
}
// First moment (ms) at which a curve from 0 to 1 has come a share p of the way.
function reachMs(ease, p, dur) {
  for (let ms = 0; ms <= dur; ms += 8) if (ease(ms / 1000) >= p) return ms;
  return dur;
}
// First moment (ms) at which the spot of the growing card under the middle of rect r is within 36px of where it lands.
function nearMs(r, from, to, ease, dur) {
  const u = (r.left + r.width / 2 - to.left) / to.width;
  const v = (r.top + r.height / 2 - to.top) / to.height;
  const far = Math.hypot(from.left + u * from.width - (to.left + u * to.width), from.top + v * from.height - (to.top + v * to.height));
  for (let ms = 0; ms <= dur; ms += 8) if (Math.abs(1 - ease(ms / 1000)) * far <= 36) return ms;
  return dur;
}

// How far the phone sheet slides to be wholly off the screen: its own height and the gap it floats above the bottom
// edge (8px and the home indicator's inset), with a little more for its shadow.
const sheetOff = (r) => Math.max(r.height, innerHeight - r.top) + 16;
function openSheet(to) {
  const h = sheetOff(to.panel);
  // The slide and the veil run to their own end, even once the sheet takes a drag (a drag cancels them).
  track(P.panel.animate([{ transform: `translateY(${h}px)` }, { transform: 'none' }], { duration: 500, easing: EASE, id: 'slide' }));
  track(P.veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: EASE, id: 'slide' }));
  // No morph on a phone (the platform's own sheet), but the coin still flips in as the sheet rises, and the chart draws
  // in on the way up (as Apple overlaps them), so coin, line and sheet all land together.
  const ms = Math.max(settleMs(SPRING.spinSheet), settleMs(SPRING.bounceSheet));
  const spin = springFn(SPRING.spinSheet);
  const grow = springFn(SPRING.bounceSheet);
  cd.coinAnim = track(coinFlight(ms, (t, last) => ({ dx: 0, dy: 0, s: last ? 1 : lerp(0.55, 1, grow(t / 1000)), rot: last ? 0 : lerp(COIN_TURN, 0, spin(t / 1000)) })));
  chartEnter(40);
  // The sheet is within a pixel or two of its place by then: it takes a drag or a scrub as soon as it can, while its
  // last pixels still ease in.
  panelLater(openSettled, 440);
  glintPanel(Math.round(settleMs(SPRING.spinSheet) * 0.55));
}

// Reduced motion, a deep link, or a card that is off screen: the panel fades (and, with motion, settles from 96%).
function openFade() {
  const calm = REDUCED.matches;
  const d = calm ? 180 : 280;
  track(P.panel.animate(calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: d, easing: EASE }));
  track(P.veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calm ? 200 : 360, easing: EASE }));
  chartEnter(calm ? 0 : 120);
  panelLater(openSettled, calm ? 200 : 360);
  if (!calm) glintPanel(260);
}

// The panel has landed (its card's last frame drawn, or the backstop timer): what follows from open is applied on the
// move (panel.on, below).
function openSettled() {
  panel.go('open');
}

function openPanel(sym, via, byKey = false) {
  if (!PANEL) return;
  const n = nodes.get(sym);
  if (!n?.item) return;
  // A card clicked while another one's close plays: that close ends at once, without handing focus back to its card.
  if (panel.is('closing')) finishClose(false);
  if (!panel.is('closed')) return;
  const calm = REDUCED.matches;
  let how = calm || via === 'hash' || via === 'pop' ? 'fade' : PHONE.matches ? 'sheet' : 'morph';
  if (PHONE.matches && !calm) how = 'sheet';
  // A card still rising in with the page's entrance jumps to its place, so the panel grows out of where the card rests
  // (and the card can hide under it).
  for (const a of n.li.getAnimations()) if (a.id === 'enter') a.finish();
  // All reads of the card first, then writes, then one read of the laid-out panel, then animations only.
  const page = pageWidth();
  let from = null;
  if (how === 'morph') { from = readCard(n); if (!onScreen(from.card, from.clip)) how = 'fade'; }
  // openPanel is the only way into opening, so what opening means is applied here, in the order its reads and writes
  // need (the run's token and the timer are the move's own: panel.on).
  panel.go('opening');
  cd.sym = sym;
  cd.item = n.item;
  cd.li = n.li;
  mode.go(how);
  cd.queued = false;
  // The card's coin comes back to rest under the panel (its tilt), so a close lands on it at rest.
  unaim(n.refs.coin);
  fillHead(n.item);
  chartPrepare(sym);
  headLive();
  lockScroll(page);
  // The glass this view keeps, whatever the guard decides while it is open.
  cd.lite = LOW_MEMORY || guard.notch.is('flat');
  P.veil.classList.toggle('lite', cd.lite);
  // A picture painted for the last panel is not this one's: the veil starts plain (glass.js keeps that state).
  G?.veilClear();
  dlg.showModal();
  // Opened with a pointer (or a link): focus rests on the dialog, so the cross shows no keyboard ring; Tab reaches it next.
  // Opened from the keyboard: the cross, with its ring (on a short window the browser would pick the scrolling body,
  // which stops being focusable while the card flies).
  if (byKey) P.x.focus({ preventScroll: true });
  else dlg.focus({ preventScroll: true });
  // Focusing may have scrolled the dialog itself (where overflow: clip is missing): the sheet must sit where it is laid.
  // Its body starts at the top too (a browser keeps the last open's scroll in a sheet taller than the screen).
  dlg.scrollTop = 0;
  if (P.body.scrollTop) P.body.scrollTop = 0;
  for (const box of cardBoxes) box.classList.add('cd-open');
  if (how === 'morph') cardTo('source', n.li);
  if (how === 'morph') bgOnPixels();
  priceOnPixel();
  // The corners the panel grows from and to (and flies home between), as drawn: round, or squircles where the browser
  // has them.
  readRadii(n.li);
  const to = readPanel();
  segPlace(to.segs, false);
  chartSize(P.chart.clientWidth, P.chart.clientHeight);
  if (how === 'morph') openMorph(n, from, to);
  else if (how === 'sheet') openSheet(to);
  else openFade();
  // A card's own entry in the history, unless a close's step back is still on its way: then once it has landed.
  if (via === 'click') addr.go(addr.is('leaving') ? 'waiting' : 'pushed');
  // A veil the browser cannot (or this device should not) blur live is painted by glass.js, two frames into the open:
  // the device that needs it most never pays for it before the panel starts to move, and until then the veil is the
  // lite tint, at the opacity it fades in from.
  const run = cd.run;
  if (veilWantsPaint()) requestAnimationFrame(() => requestAnimationFrame(() => { if (runLive(run)) G?.veilPaint(); }));
  // The guard watches the open (45 frames, after the first three), unless this view is already lite.
  if (!calm && !cd.lite) guard.watch('open', 45, 3, () => runLive(run));
}

// Every way out of an open panel (closePanel, or the sheet dragged off the screen) goes to closing here, and steps the
// address back with it; what every close lets go of is applied on that move (panel.on, below). fromPop: Back or
// Forward has already taken the panel's entry away.
function closeBegin(fromPop) {
  if (!panel.go('closing')) return false;
  if (fromPop) addr.go('bare');
  else if (!addr.go('leaving') && addr.is('bare') && location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  return true;
}

function closePanel(opts = {}) {
  if (panel.is('closed')) return;
  // A second close request while the first one plays (Esc twice): finish at once.
  if (panel.is('closing')) { finishClose(); return; }
  const was = panel.state;
  closeBegin(Boolean(opts.fromPop));
  const n = nodes.get(cd.sym);
  const calm = REDUCED.matches;
  let kind = calm ? 'fade' : mode.is('sheet') ? 'sheet' : 'fallback';
  let from = null;
  let to = null;
  if (kind === 'fallback' && n && (was === 'open' || mode.is('morph'))) {
    // Reads: the card where it is now (it may have re-ranked while open; a re-rank still playing jumps to its end, so
    // the panel lands in the card's final place), and the panel where it rests. So does a lift or a press still easing
    // out (an Esc straight after the open), and the coin's hover tilt: the card is hidden, and the flight must aim at
    // where it rests, not at where it was a moment ago.
    for (const a of n.li.getAnimations()) if (a.id === 'rerank' || a.transitionProperty) a.finish();
    tilts.delete(n.refs.coin);
    n.refs.coin.style.transform = '';
    from = readCard(n);
    if (onScreen(from.card, from.clip)) {
      kind = 'morph';
      // The card's corner as it is now: the card may have changed form under the panel (a new leader, another layout
      // chosen in another tab).
      readRadii(n.li);
      if (was === 'opening' && cd.fly) to = cd.fly.to;
      else {
        bgOnPixels();
        priceOnPixel();
        to = readPanel();
      }
    }
  }
  // How far the open has come, timed from when the card's animation started, not from the click: it starts on the
  // frame after it is made (later still when that first frame is slow), so the time since the click runs ahead, and the
  // way home would set off a step or more further on than the panel was seen. Not started yet: still where it began.
  const clock = cd.fly?.clock;
  const elapsed = clock ? (clock.startTime == null ? 0 : performance.now() - clock.startTime) : performance.now() - cd.t0;
  // The dialog closes once the panel has been read where it rests: the page takes clicks at once, and .closing (set on
  // the move) keeps it drawn while the close plays.
  if (dlg.open) dlg.close();
  if (kind === 'morph') closeMorph(n, from, to, was === 'opening' && cd.fly ? openPose(cd.fly.pose, elapsed) : null);
  else if (kind === 'sheet') closeSheet();
  else closeFade(calm);
}

// Reverses the open from wherever it is now into the card's current place, with the return spring (no overshoot).
function closeMorph(n, from, to, now) {
  const veilFrom = Number(getComputedStyle(P.veil).opacity) || 1;
  const revealFrom = reveals().map((node) => [node, Number(getComputedStyle(node).opacity)]);
  const followFrom = Object.fromEntries(Object.entries(followers()).map(([k, node]) => [k, Number(getComputedStyle(node).opacity)]));
  const partFrom = Object.fromEntries(Object.entries(flyPanel()).map(([k, node]) => [k, Number(getComputedStyle(node).opacity)]));
  // How the card scales its coin's art (smoothly, or pixel for pixel): the panel's coin lands drawn the same way.
  const art = getComputedStyle(n.refs.icon).imageRendering;
  for (const a of [...cd.anims]) a.cancel();
  cd.anims.clear();
  // A panel scrolled on a short window: .morphing stops its body scrolling (a flying word must not be cut by it), so
  // everything in it drops by the scroll. The panel is read again where it now lies, and every part starts from where
  // it was seen.
  const scrolled = morph.is('flying') ? 0 : P.body.scrollTop;
  // .landing: the card under the pointer lifts as the panel flies home, and the panel lifts with it (the stylesheet).
  cardTo('landing', n.li);
  morph.go('flying');
  if (scrolled) to = readPanel();
  const target = cardPose(from, to);
  const land = landOnPixels(n, from, to, target);
  const cur = now ?? { bg: { ...REST.bg, r: cd.r.panel }, icon: REST.icon, parts: Object.fromEntries(FLY.map((k) => [k, REST.part])) };
  // It lands with the card's shadows, sized for the scale it lands at (its hover lift comes in with the card's own, from
  // the stylesheet, if the pointer is over the card).
  shadeFor(land.bg.sx, land.bg.sy, to.bg, n);
  const D = settleMs(SPRING.ret);
  // Home 24 ms early, so the last frame or two before the card takes over show every part exactly where the card's is.
  const home = (ms, last) => (last ? 1 : homing(SPRING.ret)(ms));
  // The coin's nudge is taken back in its first frame: turning and scaling, it is drawn afresh as it lands.
  P.coin.style.left = nudge(land.icon.x);
  P.coin.style.top = nudge(land.icon.y);
  const i0 = { ...cur.icon, dx: cur.icon.dx - land.icon.x, dy: cur.icon.dy - land.icon.y - scrolled };
  const at = (ms, last) => {
    const c = home(ms, last);
    const b = cur.bg;
    const e = land.bg;
    return {
      bg: { dx: lerp(b.dx, e.dx, c), dy: lerp(b.dy, e.dy, c), sx: lerp(b.sx, e.sx, c), sy: lerp(b.sy, e.sy, c), r: lerp(b.r, cd.r.card, c), edge: lerp(b.edge, 0, clamp(c * 1.5, 0, 1)), lift: last ? 0 : lerp(b.lift, 0, liftAt(c + 0.1)), hand: last ? 0 : lerp(b.hand, 0, smooth01((c - 0.97) / 0.03)) },
      icon: { dx: lerp(i0.dx, land.icon.dx, c), dy: lerp(i0.dy, land.icon.dy, c), s: lerp(i0.s, target.icon.s, c), rot: lerp(i0.rot, COIN_TURN, turnHome(c)), flat: turnHome(c) >= 1 },
      c,
    };
  };
  const hold = { fill: 'forwards' };
  track(sampled(P.bg, D, (ms, last) => radiusFrame(at(ms, last).bg), hold));
  track(sampled(P.edge, D, (ms, last) => ({ opacity: at(ms, last).bg.edge }), hold));
  track(sampled(P.lift, D, (ms, last) => ({ opacity: at(ms, last).bg.lift }), hold));
  track(sampled(P.shadeRest, D, (ms, last) => ({ opacity: 1 - at(ms, last).bg.lift }), hold));
  track(sampled(P.shade, D, (ms, last) => ({ opacity: at(ms, last).bg.hand }), hold));
  track(sampled(n.li, D, (ms, last) => ({ opacity: 1 - at(ms, last).bg.hand }), { ...hold, id: 'hand' }));
  track(sampled(P.body, D, (ms, last) => clipFrame(at(ms, last).bg, to.bg), hold));
  // The coin flies on the compositor until it lies flat and is within 2px of home, then the page draws its last few
  // frames itself, a still 2D transform each frame. A flying layer keeps the pixels it was first drawn with (Chromium
  // draws the 64px coin once, at full size, and only shrinks that picture), so it would land a little blurred and
  // sharpen into the card's coin at the hand-off; drawn still, it is drawn at its real size, as the card's coin is,
  // while it still moves (and a frame the page is late by moves it under half a pixel).
  const home0 = at(D, true).icon;
  const size = P.coin.offsetWidth || 64;
  const near = (v) => v.flat && Math.hypot(v.dx - home0.dx, v.dy - home0.dy) + (size * Math.abs(v.s - home0.s)) / 2 <= 2;
  let stillAt = D;
  for (let ms = 0; ms < D; ms += 2) if (near(at(ms).icon)) { stillAt = ms; break; }
  const coin = cd.coinAnim = track(coinFlight(Math.max(16, stillAt), (ms) => at(ms).icon, hold));
  // Everything without a twin fades within 70 ms; until then the clip cuts whatever the shrinking card has left. An open
  // cut short hides them at once: they were only fading in.
  const fade = now ? 0 : 70;
  const seen = scrolled ? `translateY(${-scrolled}px)` : 'none';
  const goes = (node, o) => track(node.animate([{ opacity: o, transform: seen }, { opacity: 0, transform: seen }], { duration: fade, easing: EASE_IN, fill: 'forwards' }));
  for (const [k, node] of Object.entries(flyPanel())) {
    const l = land.parts[k];
    const t = target.parts[k];
    // A twin with nothing in the card to fly into goes with the parts that have no twin.
    if (!l) { if (target.fade.includes(k)) goes(node, partFrom[k]); continue; }
    // The nudge moves the part's box onto the pixels it is drawn on; it starts from there, on a whole pixel (from a
    // close cut into an open, under half a pixel from where it was seen, as it is already moving). A part that lands
    // scaled takes no sideways step (the price's rest on a whole pixel stays).
    if (l.x) node.style.left = nudge(l.x);
    node.style.top = nudge(l.y);
    const p = cur.parts[k] ?? REST.part;
    const a = { dx: onPixel(p.dx - l.x), dy: onPixel(p.dy - l.y - scrolled), s: p.s, w: p.w ?? t.w1, ls: p.ls ?? t.ls1 };
    const b = { dx: l.dx, dy: l.dy, s: t.s, w: t.w, ls: t.ls };
    track(sampled(node, D, (ms, last) => { const c = home(ms, last); return partFrame({ dx: lerp(a.dx, b.dx, c), dy: lerp(a.dy, b.dy, c), s: lerp(a.s, b.s, c) }); }, hold));
    // It lands in the weight and the letter-spacing the card draws the word in.
    if (t.type) track(sampled(node, D, (ms, last) => { const c = home(ms, last); return typeFrame({ w: lerp(a.w, b.w, c), ls: lerp(a.ls, b.ls, c) }); }, hold));
  }
  for (const [node, o] of revealFrom) goes(node, o);
  for (const [k, node] of Object.entries(followers())) {
    const lead = FOLLOW[k];
    const p = cur.parts[lead] ?? REST.part;
    const a = { dx: p.dx, dy: p.dy - scrolled };
    const b = target.parts[lead];
    const o = followFrom[k];
    // Its lead has nowhere to fly: it goes where it stands.
    if (!b) { goes(node, o); continue; }
    track(sampled(node, D, (ms, last) => { const c = home(ms, last); return { transform: `translate(${lerp(a.dx, b.dx, c)}px, ${lerp(a.dy, b.dy, c)}px)`, opacity: fade ? o * clamp(1 - ms / fade, 0, 1) : 0 }; }, hold));
  }
  // What the card shows and the panel does not comes back over the last fifth of the way, on the surface's corner.
  const ghost = ghostFor(n, from, to, target);
  track(sampled(ghost, D, (ms, last) => { const f = at(ms, last); return { transform: `translate(${f.bg.dx}px, ${f.bg.dy}px)`, opacity: last ? 1 : smooth01((f.c - 0.8) / 0.2) }; }, hold));
  // The glass clears on the card's own spring, so the blur is gone just as the card lands.
  track(sampled(P.veil, D, (ms, last) => ({ opacity: last ? 0 : veilFrom * clamp(1 - home(ms), 0, 1) }), hold));
  // The card takes over when the flight has really ended, not after D ms of the clock: an animation starts on the next
  // frame, so a timer would hand over a frame early, short of the place. The timer stays as a backstop.
  const flight = track(sampled(P.bg, D, (ms, last) => bgFrame(at(ms, last).bg), hold));
  const move = panel.epoch;
  flight.finished.then(() => landWhenStill(move, n.li), () => {});
  // The page takes the coin over in that frame, on the flight's own clock, and draws it until the flight ends.
  const still = () => {
    if (panel.epoch !== move) return false;
    const ms = Math.min(D, Number(flight.currentTime) || 0);
    if (ms < stillAt) return true;
    if (coin.playState !== 'idle') coin.cancel();
    // Drawn afresh from here, so drawn as the card draws its own coin: the art scaled the card's way.
    P.icon.style.imageRendering = art;
    P.coin.style.transform = iconFrame({ ...at(ms, ms >= D).icon, flat: true }).transform;
    return ms < D;
  };
  wake(still);
  panelLater(finishClose, D + 250);
}
// The hand-off also waits for a lift still easing on the hidden card and, with it, on the panel: WebKit gives the card
// under the pointer its :hover only a few frames into the close (and a pointer can arrive late), so its lift can end
// after the flight. Handed over mid-lift, the card would finish the last fraction of a pixel itself and every word
// would then be redrawn a device pixel higher; the panel instead holds its landing pose, lifting with the card, until
// the lift is done. Never past the backstop timer.
function landWhenStill(move, li) {
  if (panel.epoch !== move) return;
  const easing = [...li.getAnimations(), ...P.panel.getAnimations()].filter((a) => a.transitionProperty && a.playState === 'running');
  if (!easing.length) { finishClose(); return; }
  Promise.allSettled(easing.map((a) => a.finished)).then(() => landWhenStill(move, li));
}
function closeSheet() {
  const r = P.panel.getBoundingClientRect();
  const y0 = dragY();
  const veilFrom = Number(getComputedStyle(P.veil).opacity) || 1;
  // The coin's flip runs on to its landing (cut, it would snap flat): the sheet never moves the coin itself, and
  // finishClose cancels whatever is left of it once the sheet is gone.
  for (const a of [...cd.anims]) { if (a === cd.coinAnim) continue; a.cancel(); }
  cd.anims.clear();
  track(P.panel.animate([{ transform: `translateY(${y0}px)` }, { transform: `translateY(${sheetOff(r)}px)` }], { duration: 400, easing: EASE, fill: 'forwards' }));
  track(P.veil.animate([{ opacity: veilFrom }, { opacity: 0 }], { duration: 400, easing: EASE, fill: 'forwards' }));
  P.panel.style.transform = '';
  P.veil.style.opacity = '';
  panelLater(finishClose, 400);
}
function closeFade(calm) {
  const veilFrom = Number(getComputedStyle(P.veil).opacity) || 1;
  const panelFrom = Number(getComputedStyle(P.panel).opacity) || 1;
  for (const a of [...cd.anims]) a.cancel();
  cd.anims.clear();
  morph.go('rest');
  const d = calm ? 140 : 200;
  track(P.panel.animate(calm ? [{ opacity: panelFrom }, { opacity: 0 }] : [{ opacity: panelFrom, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: d, easing: EASE, fill: 'forwards' }));
  track(P.veil.animate([{ opacity: veilFrom }, { opacity: 0 }], { duration: calm ? 200 : 260, easing: EASE, fill: 'forwards' }));
  panelLater(finishClose, calm ? 200 : 260);
}

// In one frame: the dialog goes, the card comes back exactly where the panel landed (same colour, same words), the
// page scrolls again (all on the move: panel.on, below) and focus returns to the card's button.
function finishClose(refocus = true) {
  const btn = nodes.get(cd.sym)?.refs.open;
  if (!panel.go('closed')) return;
  // Focus goes back to the card's button, unless the viewer has moved it somewhere else on purpose (closing the dialog
  // can hand it to the card focused before the panel opened, which is not on purpose). Its ring shows only after a key:
  // after a tap, a click, a swipe or Back the card takes focus quietly (WebKit would ring any focus given by a script).
  const active = document.activeElement;
  const stray = !active || active === document.body || dlg.contains(active) || (active !== btn && active.classList?.contains('card-open'));
  if (refocus && btn && stray) focusTo(btn, keyed);
  tick();
}
// What follows from each of the panel's states, applied on the move into it: the one place each is set or let go of.
panel.on((to, from) => {
  // A timer is only ever for the state it was set in (an open's backstop, a close's).
  clearTimeout(cd.timer);
  // opening: a new run, the token its callbacks carry (the rest of what opening means is openPanel's, in order).
  if (to === 'opening') cd.run = panel.epoch;
  if (to === 'open') {
    for (const a of [...cd.anims]) {
      if (a === cd.coinAnim || a.id === 'slide') continue;
      if (a.playState !== 'finished') a.finish();
      cd.anims.delete(a);
    }
    morph.go('rest');
    // At rest the surface is drawn on the same pixels with or without its nudge; a close nudges it afresh. The card's
    // shadows are out (the stylesheet's rest), and the next flight sizes them afresh.
    P.bg.style.left = '';
    P.bg.style.top = '';
    shadeOff();
    ghostOff();
    if (flightCard.is('handing')) cardTo('source');
    cd.fly = null;
    stars(true);
    measureCoin();
    sheetFits();
    if (cd.queued) { cd.queued = false; panelLive(); }
    if (ch.pending) { const d = ch.pending; ch.pending = null; chartShow(d, true); }
    // Another tab's theme change that came while the panel flew in is drawn now it has landed.
    themeSettle();
    const run = cd.run;
    loadShare().then(() => { if (runLive(run)) shareSoon(); });
  }
  // closing: what every close lets go of first, whichever way the panel leaves (closePanel, or the sheet dragged off
  // the screen): the scrub, a drag, the share sheet, the stars, the glint, the coin's tilt and the chart's motion and
  // its timers. One list, so no way out forgets a part (a share sheet left open would hold the next panel's button). A
  // scrub gives the header back its live figures first, so the words fly home as the card shows them.
  if (to === 'closing') {
    const scrubbed = xhair.is('on');
    scrubEnd(true);
    if (scrubbed && from === 'open') headWrite();
    dragStop();
    S?.close();
    stars(false);
    glintOff();
    unaim(P.tilt);
    chartHalt();
    // An open cut short leaves its copy of the card behind: a close that flies makes its own.
    ghostOff();
    dlg.classList.add('closing');
  }
  if (to === 'closed') {
    for (const a of dlg.getAnimations({ subtree: true })) a.cancel();
    cd.anims.clear();
    if (dlg.open) dlg.close();
    dlg.classList.remove('closing');
    morph.go('rest');
    for (const node of [P.bg, P.edge, P.lift, P.shadeRest, P.shadeLift, P.coin, P.panel, P.veil, ...Object.values(flyPanel()), ...Object.values(followers())]) { node.style.transform = ''; node.style.opacity = ''; }
    for (const node of [P.bg, P.coin, ...Object.values(flyPanel())]) { node.style.left = ''; node.style.top = ''; }
    P.bg.style.borderRadius = '';
    P.icon.style.imageRendering = '';
    shadeOff();
    ghostOff();
    P.tilt.style.transform = '';
    tilts.delete(P.tilt);
    for (const box of cardBoxes) box.classList.remove('cd-open');
    for (const a of cd.li?.getAnimations() ?? []) if (a.id === 'hand') a.cancel();
    cardTo('home');
    unlockScroll();
    cd.sym = null;
    cd.item = null;
    cd.li = null;
    cd.fly = null;
    cd.coinAnim = null;
    coinCentre = null;
    mode.go('none');
    chartHalt();
    // A new order, or new figures for this card, that arrived while the panel flew home into it are drawn now (owed).
    owed.go('clean');
    // Likewise a theme change that came while the panel flew in and was closed before it landed.
    themeSettle();
    // Week lines that arrived under the panel were held back: the ones on screen draw in now.
    linesLook();
    // A chart opened from the address before any card was touched: the guard measures the display's beat once the page
    // is still again.
    if (!guard.beatState.is('measured')) setTimeout(guard.sample, 300);
  }
});
// A window crossing the phone breakpoint into a sheet: nothing will fly back into the card it came from, so that card
// shows again under the glass.
mode.on((to, from) => {
  if (to !== 'sheet' || from === 'none') return;
  for (const a of cd.li?.getAnimations() ?? []) if (a.id === 'hand') a.cancel();
  cardTo('home');
  ghostOff();
});
// The history calls, made on the address's moves: the card's own entry pushed (at its open, or once the step back
// before it has landed), and taken away again by a close.
addr.on((to, from) => {
  if (to === 'pushed') history.pushState({ cd: cd.sym }, '', `#${cd.sym.toLowerCase()}`);
  if (to === 'leaving' && from === 'pushed') history.back();
});
// Whether a node shows its focus ring now (false where the browser cannot tell).
function ringed(node) {
  try { return node.matches(':focus-visible'); } catch { return false; }
}
// Hands the keyboard's focus to a node without scrolling to it. ring says whether its ring may show: only where the
// focus it takes over from showed one, or the viewer's last input was a key (WebKit would ring any focus given by a
// script).
function focusTo(node, ring) {
  node.focus({ preventScroll: true, focusVisible: ring });
  // A browser that does not know the focusVisible option may still ring it: then the focus is let go instead.
  if (!ring && ringed(node)) node.blur();
}

// Scroll lock with no shift: a classic scrollbar (Windows, Linux, a Mac with a mouse) is replaced by padding exactly as
// wide, so the page keeps its place and the panel's blur reaches the window's right edge (the stylesheet drops the
// gutter while locked). Its width is a fraction of a pixel at most scales (22 device pixels at 1.5x), so it is measured
// as the page's own width before and after it goes. Overlay scrollbars (phones, a Mac's trackpad) take no width: no
// measuring, nothing to pad. pageWidth is read first, with the page at rest (openPanel's reads).
function pageWidth() {
  const root = document.documentElement;
  return innerWidth - root.clientWidth > 0 ? root.getBoundingClientRect().width : 0;
}
function lockScroll(before) {
  const root = document.documentElement;
  root.classList.add('cd-lock');
  if (before) {
    const w = root.getBoundingClientRect().width - before;
    if (w > 0) root.style.paddingInlineEnd = `${w}px`;
  }
}
function unlockScroll() {
  const root = document.documentElement;
  root.classList.remove('cd-lock');
  root.style.paddingInlineEnd = '';
}

// ---- the panel's words ----
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
// Regular US hours by the New York clock (holidays show up as an old last bar instead). Callers pass the server's clock
// (serverNow), as every other time in the panel is read: a device clock set wrong never shuts or opens the market.
function marketOpen(now) {
  const parts = Object.fromEntries(NY.formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 570 && mins < 960;
}
// The chart's times and dates. A coin trades round the clock: its hours read in the viewer's own time zone, and its
// days and weeks, which every venue cuts at 00:00 UTC, in UTC (so a day reads as that day everywhere). A stock's
// sessions are New York's, so its axis and scrub readout read in New York time wherever the viewer is (marked "ET").
function clock(timeZone) {
  const f = (o) => new Intl.DateTimeFormat('en-US', { timeZone, ...o });
  return {
    hm: f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    md: f({ month: 'short', day: 'numeric' }),
    mdy: f({ month: 'short', day: 'numeric', year: 'numeric' }),
    m: f({ month: 'short' }),
    y: f({ year: 'numeric' }),
    parts: f({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }),
  };
}
const LOCAL = clock(undefined);
const UTC = clock('UTC');
const ET = clock('America/New_York');
const clockOf = (item, size) => (item?.exchange ? ET : size === '1D' || size === '1W' ? UTC : LOCAL);
// Every candle's hour, day (counted from 1970-01-01) and month (counted from the year 0) on a clock, worked out once per
// chart: the axis asks on every redraw.
const walls = new WeakMap();
function wallOf(d, k) {
  let w = walls.get(d);
  if (w?.k === k) return w;
  const n = d.candles.length;
  w = { k, hour: new Int8Array(n), day: new Int32Array(n), month: new Int32Array(n) };
  d.candles.forEach(([t], i) => {
    const p = {};
    for (const x of k.parts.formatToParts(t)) p[x.type] = Number(x.value);
    w.hour[i] = p.hour % 24;
    w.day[i] = Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
    w.month[i] = p.year * 12 + p.month - 1;
  });
  walls.set(d, w);
  return w;
}
// A UTC day (2026-01-14) as Jan 14, 2026, or Jan 14, in every time zone.
const fmtDay = (d, year = true) => (year ? UTC.mdy : UTC.md).format(new Date(`${d}T12:00:00Z`));
// The candle sizes in words: the picker's buttons say them, and the dialog's description.
const SIZE_WORDS = { '1H': 'hourly', '4H': '4-hour', '1D': 'daily', '1W': 'weekly' };
// The server's clock (the candles' times are its), from this device's and the offset the price fetches measure.
const serverNow = () => Date.now() + offset;

// The header's move is the card's own whatever the candle size: a coin's 24h change, a stock's session change (its
// "1d"), in percent and in dollars, so card and panel always agree.
function dayMove(item) {
  const pct = item.change24h;
  const price = item.price;
  const abs = Number.isFinite(pct) && price > 0 ? price - price / (1 + pct / 100) : NaN;
  return { pct, abs, key: item.exchange || isCommodity(item) ? '1d' : '24h' };
}
// A stock's change is its last session's while the market is shut, or while its hourly candles say the latest session
// was not today (a holiday). Only fresh candles can say that: a stale copy (the server's refresh still on the way) is
// simply old, and its newest hour would read as a holiday until the fresh one lands.
function lastSession(item) {
  if (!item.exchange) return false;
  if (!marketOpen(new Date(serverNow()))) return true;
  const d = hist.get(histKey(item.symbol, '1H'))?.data;
  return Boolean(d && !d.stale && serverNow() - d.candles[d.candles.length - 1][0] > 65 * 60_000);
}
// The stats row's high and low: a coin's over the last 24 hours, a stock's over its latest session (its "Day"), from the
// hourly candles whatever size is on show. They sit with the 24h change and the 24h volume, and never change with the
// candle size or the width of the screen. null until the hourly candles are in, and while the market is open and the
// only copy is a stale one from an earlier session (another day's figures): the fresh one is asked for a few seconds
// later (chartFetch, dayFetch).
function dayRange(item) {
  const d = hist.get(histKey(item.symbol, '1H'))?.data;
  if (!d) return null;
  const cs = d.candles;
  let k = cs.length - 1;
  if (item.exchange) {
    const day = ET.mdy.format(cs[k][0]);
    if (d.stale && marketOpen(new Date(serverNow())) && day !== ET.mdy.format(serverNow())) return null;
    while (k > 0 && ET.mdy.format(cs[k - 1][0]) === day) k--;
  } else {
    // A commodity's day is the 24 hours up to its latest candle: over a weekend that is Friday's, not an empty window.
    const since = (isCommodity(item) ? cs[k][0] + d.step : serverNow()) - 86_400_000;
    while (k > 0 && cs[k - 1][0] + d.step > since) k--;
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = k; j < cs.length; j++) { hi = Math.max(hi, cs[j][2]); lo = Math.min(lo, cs[j][3]); }
  return { hi, lo };
}
// Hourly candles still stale well after they were asked for again (the server's sources failing): figures that wait for
// fresh ones say "n/a" instead.
function dayStuck(item) {
  const h = hist.get(histKey(item.symbol, '1H'));
  return Boolean(h?.data?.stale && performance.now() - h.staleSince > 6000);
}
// What the day's high and low say while there are no hourly candles to read them from (dayRange: null): nothing while
// the candles are on their way (waiting is not failed), "n/a" once they could not be had. The panel and the share card
// both word them by this.
const dayNone = (item) => (ch.dayFailed || (ch.size === '1H' && ch.failed) || dayStuck(item) ? NA : '');
// The hourly candles the stats row reads, while another size is on show: due again once their newest hour is up (an
// hour has begun since; a stock's only while its market is open) and the server may have moved on too (their cache
// time), as chartRoll asks for the chart on show.
function dayDue(item) {
  const d = hist.get(histKey(item.symbol, '1H'))?.data;
  if (!d || ch.size === '1H' || freshHist(item.symbol, '1H')) return false;
  if (item.exchange && !marketOpen(new Date(serverNow()))) return false;
  return serverNow() >= d.candles[d.candles.length - 1][0] + d.step;
}

function fillHead(item) {
  coinShow(P.icon, P.tilt, P.glint, coinUrl(item));
  setText(P.sym, item.symbol);
  // Built as the card builds its name (the name, then the dot and the exchange in their own runs), so a stock's name is
  // set in the same runs and lands on the card's glyphs letter for letter. Plain spans: a phone card's rules for its
  // exchange line are not the sheet's.
  const tail = tailOf(item);
  if (P.name.textContent !== (tail ? `${item.name} · ${tail}` : item.name)) {
    P.name.replaceChildren(item.name, ...(tail ? [el('span', {}, el('span', {}, ' · '), tail)] : []));
  }
  P.chart.setAttribute('aria-label', `${item.symbol} price chart`);
}
// The live figures: the price, the move, the stats. A swap of text, never a count.
// While the panel flies in, only the parts that do not fly are rewritten (a flying word that changed width would land
// off its mark); the rest lands on settle, the dollar move and the session note with the chip they sit beside. Nothing is
// written once the panel is closing: its words are flying home as the card shows them, and an answer landing then (the
// hourly candles, a resize's redraw) would move them out from under their twins.
function headLive(extrasOnly = false) {
  if (panel.is('opening', 'open')) headWrite(extrasOnly);
}
// The writes themselves: headLive's, and the close's own, as a scrub hands the header back (panel.on: closing).
function headWrite(extrasOnly = false) {
  const item = cd.item;
  if (!item || xhair.is('on')) return;
  // Only a morph flies words; a sheet or a fade writes everything at once.
  const flying = extrasOnly && panel.is('opening') && mode.is('morph');
  if (flying) cd.queued = true;
  const stock = Boolean(item.exchange) || isCommodity(item);
  const price = fmtPrice(item.price);
  const d = ch.data;
  const m = dayMove(item);
  const chg = fmtChange(m.pct);
  const tone = chg.tone && !item.stale ? ` ${chg.tone}` : '';
  const dd = (box) => box.querySelector('dd');
  const dt = (box) => box.querySelector('dt');
  if (!flying) {
    const priceWas = P.price.textContent;
    setText(P.price, price);
    if (priceWas !== price && panel.is('open') && cd.rolled === item.symbol) roll(P.price, priceWas, price, parseFloat(price.replace(/[^0-9.]/g, '')) >= parseFloat(priceWas.replace(/[^0-9.]/g, '')) ? 1 : -1);
    cd.rolled = item.symbol;
    setClass(P.price, `price cd-price${price === NA ? ' unknown' : ''}`);
    setText(P.chg, chg.text);
    setClass(P.chg, `chg cd-chg${tone}`);
    setText(P.key, item.stale ? 'stale' : m.key);
    const mcap = fmtCompact(item.mcap);
    const vol = fmtCompact(item.vol24h);
    setText(dd(P.stMcap), mcap);
    setClass(dd(P.stMcap), mcap === NA ? 'unknown' : '');
    setText(dt(P.stVol), stock ? 'Vol 1d' : 'Vol 24h');
    setText(dd(P.stVol), vol);
    setClass(dd(P.stVol), vol === NA ? 'unknown' : '');
    setText(P.abs, Number.isFinite(m.abs) ? fmtMove(m.abs, item.price) : '');
    setClass(P.abs, `cd-abs${tone}`);
    setText(P.sess, lastSession(item) ? 'Last session' : '');
    fitMove();
  }
  const label = stock ? 'Day' : '24h';
  setText(dt(P.stHi), `${label} High`);
  setText(dt(P.stLo), `${label} Low`);
  // Waiting for the hourly candles (not failed): the figures wait empty rather than say "n/a" (a no-break space, so
  // the empty figure keeps its line).
  const day = dayRange(item);
  const none = dayNone(item) || ' ';
  const hi = day ? fmtPrice(day.hi) : none;
  const lo = day ? fmtPrice(day.lo) : none;
  setText(dd(P.stHi), hi);
  setClass(dd(P.stHi), hi === NA ? 'unknown' : '');
  setText(dd(P.stLo), lo);
  setClass(dd(P.stLo), lo === NA ? 'unknown' : '');
  const g = ch.geo;
  // A chart that starts later than its size's 150 candles would (a market younger than that) says since when, but only
  // while its first candle is on screen (a phone shows fewer candles than a desktop).
  const whole = Boolean(g && g.first === 0);
  const start = whole && d.since ? ` · Since listing, ${fmtDay(d.since)}` : whole && d.from ? ` · Since ${fmtDay(d.from)}` : '';
  setText(P.src, d ? `Chart data: ${d.src || NA}${start}` : '');
  // The dialog's description, for screen readers: the candles on show in one sentence.
  if (d && g) {
    const first = g.candles[0].o;
    const pct = (item.price / first - 1) * 100;
    const way = Math.abs(pct) < 0.005 ? 'unchanged' : `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}%`;
    setText(P.sum, `${g.candles.length} ${SIZE_WORDS[ch.size]} candles from ${fmtPrice(first)} to ${price}, ${way}. High ${fmtPrice(g.hi)}, low ${fmtPrice(g.lo)}.`);
  } else setText(P.sum, '');
}

// The chip row stays one line at every width, so the header never changes height while a scrub rewrites it. Where the
// day's figures stand beside it (a wide panel) it ends clear of them; where they do not (a phone, a narrow window) it
// may run to the panel's right gutter. What still does not fit gives way whole, the dollar move first, then the session
// note (never cut to a wrong figure). On-screen boxes, to the fraction of a pixel (whole-pixel offsets let a word run
// a pixel past the gutter): this runs with the panel at rest or moving as one (a sheet, a fade), never while the row's
// words fly on their own.
const MOVE_CLEAR = 24;
function fitMove() {
  const beside = P.stats.offsetTop < P.move.offsetTop + P.move.offsetHeight;
  const room = beside ? P.stats.getBoundingClientRect().left - MOVE_CLEAR : P.tr.getBoundingClientRect().right;
  const over = () => [P.key, P.abs, P.sess].some((n) => n.offsetWidth && n.getBoundingClientRect().right > room);
  P.abs.style.display = '';
  P.sess.style.display = '';
  if (over()) P.abs.style.display = 'none';
  if (over()) P.sess.style.display = 'none';
}

// Live data while the panel is open: figures swap at once; the last candle's close (the line's end) moves without a
// tween and the end dot breathes once. During a morph everything waits and lands on settle. The hourly candles the
// stats read are asked for again while they are missing, and when newer ones are due (dayDue).
function panelLive() {
  if (panel.is('closed') || !cd.sym) return;
  const n = nodes.get(cd.sym);
  if (!n) return;
  cd.item = n.item;
  if (!panel.is('open') || motion.is('moving')) { cd.queued = true; return; }
  let moved = false;
  for (const size of SIZES) {
    const h = hist.get(histKey(cd.sym, size));
    if (h?.data && patchLast(h.data, n.item.price) && h.data === ch.data) moved = true;
  }
  if (moved && ch.data) {
    chartLayout();
    paintAll();
    // A scrub held on the latest candle reads its new close too (headLive stands back while a scrub is on).
    if (xhair.is('on') && ch.geo && ch.scrub.idx === ch.geo.n - 1) readout(scrubPoint(ch.scrub.idx));
  }
  if (moved && ch.data) breathe();
  if (!dayRange(n.item) || dayDue(n.item)) dayFetch();
  headLive();
  // The slider's spoken "latest" price follows the live price too, unless a scrub is speaking for a point.
  if (!xhair.is('on')) chartAria();
  chartRoll();
  shareSoon();
}

// ---- segmented controls ----
// Where the panel's two controls' pills belong: under the segment of the chosen candle size and of the chosen chart
// type (cd.size, cd.type), each control's first segment if it has none for that choice.
function segRead() {
  const out = [];
  for (const [seg, attr, value] of [[P.segS, 'data-i', cd.size], [P.segT, 'data-t', cd.type]]) {
    const b = seg.querySelector(`button[${attr}="${value}"]`) ?? seg.querySelector('button');
    out.push([seg, b.offsetLeft, b.offsetWidth]);
  }
  return out;
}
// The pill moves to the pressed segment (a spring, from the stylesheet); placed without motion on open and resize. Once
// glass.js is in, the pill is its droplet, which it moves (and leaves at rest with this same place and width). Each
// entry of list is [control, the segment's left, its width, the value chosen]: the value is the choice's own machine's
// state where the control has one (the dock, the layout and the glass switches), and glass.js answers it on the
// chosen glyph.
function segPlace(list, animate, byUser = false) {
  for (const [seg, x, w, value] of list) {
    if (G?.dropPlace(seg, x, w, { still: !animate, byUser, value })) continue;
    const ind = seg.querySelector('.seg-ind');
    if (!animate) ind.style.transition = 'none';
    ind.style.width = `${w}px`;
    ind.style.translate = `${x - (parseFloat(getComputedStyle(seg).paddingLeft) || 2)}px 0`;
    if (!animate) requestAnimationFrame(() => { ind.style.transition = ''; });
  }
}
function segSet(seg, attr, value) {
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
}
function segPress(seg, attr, value) {
  segSet(seg, attr, value);
  segPlace(segRead(), !REDUCED.matches, true);
}

// ---- the chart ----
// One SVG in CSS pixels (no viewBox, so strokes never scale): the area and the line, the candles, the scrub crosshair
// and the end dot. No gridlines or any other hairline: the axis words, HTML on top, float on their own.
const ch = {
  // dpr: the screen's scale for strokes (1 to 3); px: the device pixels a CSS pixel has, which every edge snaps to
  w: 0, h: 0, dpr: 1, px: 1, gl: 0, gr: 0, size: '1H', type: 'line', data: null, geo: null, sym: null,
  // what the line shows right now (a morph starts from it): x and y per point
  disp: null,
  // anim: the motion's frame (motion below); soft: whether a scrub may carry on through it; undo: what a wave cut short
  // puts back. req: the latest ask for the chart (a late answer to an older one is dropped); pending: an answer held for
  // the landing (it came while the panel flew in).
  anim: 0, soft: false, undo: null, waitTimer: 0, dimTimer: 0, retryTimer: 0, retries: 0, req: 0, pending: null,
  // A stale chart's follow-ups (staleTries counts them along STALE_WAIT); whether the hourly candles the stats read
  // could not be had, and their own follow-ups when another size is on show (dayTries).
  staleTimer: 0, staleTries: 0, dayFailed: false, dayTimer: 0, dayTries: 0,
  // The scrub's data: the candle under it, the crosshair's spring toward it, its frame, the chart's box, and the finger
  // on the chart (xhair and finger below say what they are doing).
  scrub: { idx: -1, s: { x: 0, v: 0 }, target: 0, raf: 0, last: 0, rect: null, touch: null, keys: false },
};
// What the plot shows. Its states:
//   empty    nothing: a panel just opened with nothing cached yet, its waiting line not due yet;
//   waiting  the calm placeholder (C.wait.on): a flat line with a light passing along it, a chart on its way;
//   drawn    a chart on show (ch.geo), at rest or moving (motion says which);
//   dimmed   a chart on show, dimmed (svg.waiting) while another candle size is on its way;
//   failed   the note (C.err.on) alone on an empty plot: the size asked for could not be had, retried on a backoff.
// A refresh of the size on show that fails keeps its chart (drawn): older but true, with no note over it.
const view = machine('empty', {
  empty: ['waiting', 'drawn', 'failed'],
  waiting: ['empty', 'drawn', 'failed'],
  drawn: ['empty', 'dimmed', 'failed'],
  dimmed: ['empty', 'drawn', 'failed'],
  failed: ['empty', 'waiting', 'drawn'],
});
view.on((to) => {
  C.wait.classList.toggle('on', to === 'waiting');
  C.svg.classList.toggle('waiting', to === 'dimmed');
  C.err.classList.toggle('on', to === 'failed');
});
// Whether the drawing moves. Its states:
//   still   at rest (a draw-in's pen, wash and pop may still play: they are animations of their own, cut by drawCut);
//   moving  a frame loop runs (ch.anim): a new size or a refresh morphing in, or the Line and Candles wave.
// Cut short (chartStop: a resize, a new motion, a close), a wave puts back what it hid; live figures owed meanwhile
// (cd.queued) are taken as soon as the drawing is still, whether its motion ended or was cut.
// The panel's card as a whole: at rest, or flying between a price card and the panel (open or close). Flying, its parts
// start outside its box and fly on their own (.morphing: the stylesheet lifts the body's clip and the parts' pins).
const morph = machine('rest', { rest: ['flying'], flying: ['rest'] });
morph.on((to) => { P.panel.classList.toggle('morphing', to === 'flying'); });
// The sheet's body: taller than its window (it scrolls, and drags only from its top), or all on show (.fits: it drags
// from anywhere).
const sheetFit = machine('scrolls', { scrolls: ['fits'], fits: ['scrolls'] });
sheetFit.on((to) => { P.body.classList.toggle('fits', to === 'fits'); });
const motion = machine('still', { still: ['moving'], moving: ['still'] });
motion.on((to, from) => {
  if (from !== 'moving') return;
  // A frame still asked for: the motion is being cut, not ending (chartLoop clears it before its last move).
  const cut = Boolean(ch.anim);
  if (ch.anim) cancelAnimationFrame(ch.anim);
  ch.anim = 0;
  ch.soft = false;
  const undo = ch.undo;
  ch.undo = null;
  undo?.();
  // Cut short rather than played out (afterAnim takes them then): the owed figures, once whoever cut it has done.
  if (cut) queueMicrotask(() => { if (cd.queued && motion.is('still') && panel.is('open')) { cd.queued = false; panelLive(); } });
});
// A stale chart (the server's refresh still on its way) is asked for again after these waits, then every 5 minutes for
// as long as it stays stale and on show: asked for once more only, it could be left stale (for days, on 1W).
const STALE_WAIT = [4000, 15_000, 60_000, 300_000];
const staleWait = (tries) => STALE_WAIT[Math.min(tries, STALE_WAIT.length - 1)];
// The space above and below the plot in the chart's box; the time words sit in the one below.
const PLOT_PAD = 24;
const C = {};
function chartBuild() {
  const s = svgEl('svg', { class: 'cd-svg flat', 'aria-hidden': 'true', focusable: 'false' });
  const defs = svgEl('defs');
  // The wash's colour and its strength at the top are the stylesheet's (each theme has its own).
  for (const tone of ['up', 'down', 'flat']) {
    const g = svgEl('linearGradient', { id: `cd-grad-${tone}`, x1: '0', y1: '0', x2: '0', y2: '1' });
    g.append(svgEl('stop', { offset: '0', class: `stop-${tone}` }), svgEl('stop', { offset: '1', class: `stop-${tone}` }));
    defs.append(g);
  }
  // The wave that turns the line into candles (and back) uncovers or hides the line behind it.
  const wave = svgEl('clipPath', { id: 'cd-wave' });
  C.wave = svgEl('rect', { x: '-10', y: '-10', width: '100000', height: '100000' });
  wave.append(C.wave);
  // While scrubbing, everything right of the crosshair dims to 35%.
  const mask = svgEl('mask', { id: 'cd-past', maskUnits: 'userSpaceOnUse', x: '-10', y: '-10', width: '100000', height: '100000' });
  C.maskPast = svgEl('rect', { x: '-10', y: '-10', width: '0', height: '100000', fill: '#fff' });
  C.maskFut = svgEl('rect', { x: '0', y: '-10', width: '100000', height: '100000', fill: '#fff', 'fill-opacity': '0.35' });
  mask.append(C.maskPast, C.maskFut);
  defs.append(wave, mask);
  C.dataG = svgEl('g');
  C.lines = svgEl('g', { class: 'lines', 'clip-path': 'url(#cd-wave)' });
  C.areas = svgEl('g');
  C.areaUp = svgEl('path', { class: 'area area-up' });
  C.areaDown = svgEl('path', { class: 'area area-down' });
  C.areaFlat = svgEl('path', { class: 'area area-flat' });
  C.areas.append(C.areaUp, C.areaDown, C.areaFlat);
  C.ln = svgEl('path', { class: 'ln' });
  C.lines.append(C.areas, C.ln);
  C.cnd = svgEl('g', { class: 'cnd' });
  C.wUp = svgEl('path', { class: 'w-up' });
  C.wDown = svgEl('path', { class: 'w-down' });
  C.wUpCut = svgEl('path', { class: 'w-up w-cut' });
  C.wDownCut = svgEl('path', { class: 'w-down w-cut' });
  C.cUp = svgEl('path', { class: 'c-up' });
  C.cDown = svgEl('path', { class: 'c-down' });
  C.cnd.append(C.wUp, C.wDown, C.wUpCut, C.wDownCut, C.cUp, C.cDown);
  C.dataG.append(C.lines, C.cnd);
  C.end = svgEl('g');
  C.halo = svgEl('circle', { class: 'halo tf', r: '4', 'data-fx': '' });
  C.dot = svgEl('circle', { class: 'dot tf', r: '3.5', 'data-fx': '' });
  C.end.append(C.halo, C.dot);
  C.scrub = svgEl('g', { class: 'scrub' });
  C.sLine = svgEl('line', { class: 'scrub-line', x1: '0', x2: '0', y1: '0', y2: '0' });
  C.sHalo = svgEl('circle', { class: 'scrub-halo tf', r: '10' });
  C.sDot = svgEl('circle', { class: 'dot tf', r: '4.5', 'data-fx': '' });
  C.scrub.append(C.sLine, C.sHalo, C.sDot);
  s.append(defs, C.dataG, C.end, C.scrub);
  C.svg = s;
  C.axis = el('div', { class: 'cd-axis', 'aria-hidden': 'true' });
  C.ohlc = el('div', { class: 'cd-ohlc', 'aria-hidden': 'true' });
  C.wait = el('div', { class: 'cd-wait', 'aria-hidden': 'true' });
  C.err = el('div', { class: 'cd-err' }, el('span', {}, 'Chart unavailable right now'));
  // The watermark: the lockup as a ghost in one colour (the stylesheet draws it), first in the box so the line, its wash
  // and the candles all lie over it. It takes the plot's box with the axis words (paintFrame) and goes with them.
  C.wm = el('div', { class: 'cd-wm', 'aria-hidden': 'true' });
  P.chart.append(C.wm, s, C.axis, C.ohlc, C.wait, C.err);
}
function chartTone(tone) {
  const t = tone === 'gain' ? 'up' : tone === 'loss' ? 'down' : 'flat';
  for (const k of ['up', 'down', 'flat']) C.svg.classList.toggle(k, k === t);
}
function chartSize(w, h) {
  ch.w = Math.round(w);
  ch.h = Math.round(h);
  // The screen's own scale, under 1 too (a browser zoomed out on a 1x screen): every candle edge and the scrub's cursor
  // land on its device pixels.
  ch.dpr = Math.min(3, devicePixelRatio || 1);
  ch.px = devicePixelRatio || 1;
  ch.phone = PHONE.matches;
  // The chart's box runs to the panel's edges (so a scrub can start anywhere); the plot keeps to the panel's gutters,
  // the same x as the words above and below it.
  const cs = getComputedStyle(P.chart);
  ch.gl = Math.max(0, -Math.round(parseFloat(cs.marginLeft) || 0));
  ch.gr = Math.max(0, -Math.round(parseFloat(cs.marginRight) || 0));
}

// The geometry of one chart at the chart's size, by index, not by time: every candle gets the same slot, so a stock's
// nights, weekends and holidays take no room. As many of the latest candles show as fit at about 12px a slot on a
// desktop and 8px on a phone held upright (about 67 of the server's 150 on a wide panel, 25 on a 320px phone to 40 at
// 440px); a phone on its side has a chart as wide as a desktop's, and the desktop's row (a chart 640px wide or more): a
// page to be watched, so a calm row of chunky candles, never a crowd of thin stubs (beauty over density). The line runs
// through the same candles, so both views show the same window. A slot is a whole number of device pixels; a body is
// about 80% of it, with at least one device pixel between two, and a wick one CSS pixel wide in whole device pixels
// runs down its middle, where the line passes through the close: every edge lands on a device pixel, so the candles are
// crisp at any scale. A market younger than the window (fewer candles than fit) gets wider slots, up to SLOT_MAX, and
// ends where a full chart ends. Past the last candle (the one still forming, as wide as the others) the plot runs on,
// empty, for about two and a half slots, never under 24px (TradingView's right offset), so the latest candle and the
// live end dot stand clear of the price words; one gap for both views, so switching never moves the end. y: one domain
// for both views, so switching never rescales.
const SLOT = { desk: 12, phone: 8 };
const SLOT_PHONE_W = 640;
const SLOT_MAX = { desk: 20, phone: 14 };
const GAP_SLOTS = 2.5;
const GAP_MIN = 24;
// o: the box's screen, the panel's (ch) unless the share card asks for its own (its gutters, its scale, phone or not).
function geoFor(d, w, h, o = ch) {
  const edge = o.gr;
  const padR = edge + 60;
  const padT = PLOT_PAD;
  const padB = PLOT_PAD;
  // The plot starts on the left gutter, the same x as the words above and below it.
  const x0 = o.gl;
  const gl = o.gl;
  // The plot: the candles, then the gap (A wide in all).
  const A = Math.max(40, w - padR - x0);
  const H = Math.max(20, h - padT - padB);
  const px = o.px;
  const kind = o.phone && w < SLOT_PHONE_W ? 'phone' : 'desk';
  // In device pixels from here: the slot, the room for the candles (the plot less the gap), how many fit, and where a
  // full chart's last slot ends (the room's remainder joins the gap). A young chart ends there too, whatever its wider
  // slot, so the latest candle and the live dot stay put between sizes.
  const s0 = Math.max(3, Math.round(SLOT[kind] * px));
  let s = s0;
  const room = Math.floor((A - Math.max(GAP_MIN, (GAP_SLOTS * s0) / px)) * px);
  const fit = Math.max(2, Math.floor(room / s0));
  const end = fit * s0;
  const all = d.candles.length;
  const n = Math.min(all, fit);
  const first = all - n;
  if (n < fit) s = Math.max(s0, Math.min(Math.floor(end / n), Math.round(SLOT_MAX[kind] * px)));
  const xL = Math.round(x0 * px) + (n < fit ? end - n * s : 0);
  // The wick: a CSS pixel in whole device pixels. The body: about 80% of the slot, a device pixel short of it at most,
  // and as odd or even as the wick, so the wick sits exactly in its middle.
  const ww = Math.max(1, Math.floor(px));
  let bw = Math.min(s - 1, Math.round(s * 0.8));
  if ((bw - ww) % 2) bw += bw < s * 0.8 && bw + 1 <= s - 1 ? 1 : -1;
  bw = Math.max(ww, bw);
  const off = Math.floor((s - bw) / 2);
  const cs = d.candles.slice(first);
  // A robust y range: the bodies set it; wicks may reach beyond them by at most 30% of that span, so one extreme print
  // (a flash crash) cannot squash the chart. A wick past it is cut at the edge and marked.
  let bLo = Infinity;
  let bHi = -Infinity;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of cs) { bLo = Math.min(bLo, c[1], c[4]); bHi = Math.max(bHi, c[1], c[4]); hi = Math.max(hi, c[2]); lo = Math.min(lo, c[3]); }
  const span = bHi - bLo || bHi * 0.02;
  const top = Math.min(hi, bHi + span * 0.3);
  const bot = Math.max(lo, bLo - span * 0.3);
  const pad = (top - bot || top * 0.02) * 0.06;
  const d1 = top + pad;
  const d0 = Math.max(bot - pad, 0);
  const y = (v) => padT + (1 - (v - d0) / (d1 - d0)) * H;
  const sy = (v) => Math.round(y(v) * px) / px;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const times = new Float64Array(n);
  const candles = cs.map(([t, o, hv, lv, c], k) => {
    const bl = xL + k * s + off;
    const x = (bl + bw / 2) / px;
    const bt = sy(Math.max(o, c));
    let bb = sy(Math.min(o, c));
    if (bb - bt < ww / px) bb = bt + ww / px;
    xs[k] = x;
    ys[k] = y(c);
    times[k] = t;
    return { t, o, h: hv, l: lv, c, x, bw: bw / px, top: bt, bot: bb, yh: sy(Math.min(hv, d1)), yl: sy(Math.max(lv, d0)), cutH: hv > d1, cutL: lv < d0, up: c >= o, yc: y(c) };
  });
  // The colour of the drawing: the candles on show rose or fell (their first open to their last close).
  const tone = fmtChange((cs[n - 1][4] / cs[0][1] - 1) * 100).tone;
  // x1: the plot's right end (the gap's), where the time words stop; the candles run from xL for W.
  return { w, h, kind, x0, gl, x1: x0 + A, xL: xL / px, slot: s / px, ww: ww / px, W: (n * s) / px, H, padT, padB, padR, edge, n, first, xs, ys, y, d0, d1, hi, lo, candles, times, data: d, tone };
}
function chartLayout() {
  ch.geo = ch.data && ch.w ? geoFor(ch.data, ch.w, ch.h) : null;
  if (ch.geo) chartTone(ch.geo.tone);
}
// A new size or scale for the chart's box: redrawn at rest at once (a motion under way stops where it is).
function chartRedraw(w, h) {
  chartSize(w, h);
  ch.scrub.rect = null;
  if (!ch.data) return;
  chartStop();
  drawCut();
  chartLayout();
  paintAll();
  chartAria();
  headLive(true);
}

const f1 = (v) => v.toFixed(1);
// Candle edges sit on thirds of a pixel at 3x: three decimals keep them there.
const f3 = (v) => v.toFixed(3);
// A line's first point is the middle of the first candle's slot, half a slot in from the plot's left edge: where that
// slot is the plot's first (the point is within LINE_LEAD of the edge), the line and its wash start on the edge itself,
// level with the first close, so the line begins on the same x as the price and the pickers over it. A chart with
// fewer candles than fit starts further in, and starts where its data does.
const LINE_LEAD = 10;
const lineStart = (xs) => (xs[0] > ch.gl && xs[0] - ch.gl <= LINE_LEAD ? ch.gl : xs[0]);
function linePath(xs, ys, n) {
  const x0 = lineStart(xs);
  let d = x0 < xs[0] ? `M${f1(x0)},${f1(ys[0])}L${f1(xs[0])},${f1(ys[0])}` : `M${f1(xs[0])},${f1(ys[0])}`;
  for (let i = 1; i < n; i++) d += `L${f1(xs[i])},${f1(ys[i])}`;
  return d;
}
function paintLine(xs, ys, n, bottom) {
  const line = linePath(xs, ys, n);
  C.ln.setAttribute('d', line);
  const area = `${line}L${f1(xs[n - 1])},${f1(bottom)}L${f1(lineStart(xs))},${f1(bottom)}Z`;
  C.areaUp.setAttribute('d', area);
  C.areaDown.setAttribute('d', area);
  C.areaFlat.setAttribute('d', area);
  C.dot.setAttribute('cx', f1(xs[n - 1]));
  C.dot.setAttribute('cy', f1(ys[n - 1]));
  C.halo.setAttribute('cx', f1(xs[n - 1]));
  C.halo.setAttribute('cy', f1(ys[n - 1]));
  ch.disp = { xs, ys, n };
}
// Candles at progress p(i) in 0..1 (1 = drawn): each grows out of (or folds into) the y it is given at its own x. at(i),
// when given, is where candle i stands now ({ x, top, bot, yh, yl }: a refresh moving it from its old place).
function paintCandles(g, prog, from, at) {
  let up = '';
  let down = '';
  let wu = '';
  let wd = '';
  let wuc = '';
  let wdc = '';
  for (let i = 0; i < g.candles.length; i++) {
    const c = g.candles[i];
    const [pb, pw] = prog ? prog(i) : [1, 1];
    if (pb <= 0.001 && pw <= 0.001) continue;
    const q = at ? at(i) : c;
    const yl = from ? from(i) : (q.top + q.bot) / 2;
    const top = lerp(yl, q.top, pb);
    const bot = Math.max(top + g.ww, lerp(yl, q.bot, pb));
    const bw = lerp(Math.min(2, c.bw), c.bw, Math.min(1, Math.max(0, pb)));
    const left = q.x - bw / 2;
    const body = `M${f3(left)},${f3(top)}h${f3(bw)}V${f3(bot)}h${f3(-bw)}Z`;
    let wick = '';
    let cut = '';
    if (pw > 0.001) {
      const yh = lerp(yl, q.yh, pw);
      const ylo = lerp(yl, q.yl, pw);
      const wx = f3(q.x);
      // A cut wick: solid to 7px short of the edge, then dotted to it.
      if (c.cutH && pw >= 1) { wick += `M${wx},${f3(yh + 7)}V${f3(top)}`; cut += `M${wx},${f3(yh)}V${f3(yh + 7)}`; } else wick += `M${wx},${f3(yh)}V${f3(top)}`;
      if (c.cutL && pw >= 1) { wick += `M${wx},${f3(bot)}V${f3(ylo - 7)}`; cut += `M${wx},${f3(ylo - 7)}V${f3(ylo)}`; } else wick += `M${wx},${f3(bot)}V${f3(ylo)}`;
    }
    if (c.up) { up += body; wu += wick; wuc += cut; } else { down += body; wd += wick; wdc += cut; }
  }
  C.cUp.setAttribute('d', up);
  C.cDown.setAttribute('d', down);
  C.wUp.setAttribute('d', wu);
  C.wDown.setAttribute('d', wd);
  C.wUpCut.setAttribute('d', wuc);
  C.wDownCut.setAttribute('d', wdc);
  for (const w of [C.wUp, C.wDown, C.wUpCut, C.wDownCut]) w.setAttribute('stroke-width', f3(g.ww));
}
// The line's y at any x, on whatever the line shows now.
function lineYAt(x) {
  const d = ch.disp;
  if (!d || d.n < 2) return ch.h / 2;
  const span = d.xs[d.n - 1] - d.xs[0];
  const f = clamp(((x - d.xs[0]) / span) * (d.n - 1), 0, d.n - 1);
  const i = Math.floor(f);
  const j = Math.min(d.n - 1, i + 1);
  return lerp(d.ys[i], d.ys[j], f - i);
}

// Nice steps (1, 2, 2.5, 5 times a power of ten), about one price word every 50px; the domain is never stretched to them.
function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const ladder = [10, 5, 2.5, 2, 1, 0.5].map((k) => k * p);
  let i = ladder.findIndex((st, j) => j + 1 === ladder.length || ladder[j + 1] < raw);
  const make = (step) => {
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
    return out;
  };
  // Never fewer than three words: step down the ladder until there are.
  let ticks = make(ladder[i]);
  while (ticks.length < 3 && i + 1 < ladder.length) ticks = make(ladder[++i]);
  const step = ladder[i];
  const k = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (Math.abs(k - 2.5) < 1e-6 ? 1 : 0));
  return { ticks, fmt: new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) };
}
// Time words at the boundaries a reader expects, on the chart's clock (a stock's New York time, a coin's hours in the
// viewer's zone and its days and weeks in UTC): every 6 or 12 hours (a new day says its date), every day or few days,
// every week or two, every month or few months (January says its year). Of the plans that leave 28px between words
// (12px on a phone; a wide chart has the air for more) the coarsest that still puts 4 words on the
// chart (3 on a phone) wins, else the finest that fits: calm, never bare. A word that would leave the plot is
// dropped. Steps count from fixed dates (every other day is an even day since 1970, a quarter starts in January, April,
// July or October), so a word stays on its candle as the chart moves on; a weekend's two days keep a stock's every
// other session regular.
const TICKS = {
  coin: {
    '1H': [['hour', 6], ['hour', 12], ['day', 1], ['day', 2]],
    '4H': [['day', 1], ['day', 2], ['day', 3], ['week', 1], ['week', 2]],
    '1D': [['week', 1], ['week', 2], ['month', 1], ['month', 2], ['month', 3]],
    '1W': [['month', 1], ['month', 2], ['month', 3], ['month', 6], ['month', 12]],
  },
  stock: {
    '1H': [['day', 1], ['day', 2], ['week', 1], ['week', 2]],
    '4H': [['day', 2], ['week', 1], ['week', 2], ['month', 1], ['month', 2]],
    '1D': [['week', 2], ['month', 1], ['month', 2], ['month', 3]],
    '1W': [['month', 1], ['month', 2], ['month', 3], ['month', 6], ['month', 12]],
  },
};
const weekOf = (day) => Math.floor((day + 3) / 7);
function timeTicks(g) {
  const k = clockOf(cd.item, ch.size);
  const w = wallOf(g.data, k);
  const narrow = g.kind === 'phone';
  const room = narrow ? 12 : 28;
  const fits = [];
  let last = [];
  for (const [unit, stride] of TICKS[cd.item?.exchange ? 'stock' : 'coin'][ch.size]) {
    const out = [];
    let lastRight = -Infinity;
    let clash = false;
    for (let j = 0; j < g.n; j++) {
      // i: the candle's place in the whole series (the one before it may be off screen).
      const i = g.first + j;
      if (i === 0) continue;
      const newDay = w.day[i] !== w.day[i - 1];
      let on;
      if (unit === 'hour') on = newDay || (w.hour[i] !== w.hour[i - 1] && w.hour[i] % stride === 0);
      else if (unit === 'day') on = newDay && w.day[i] % stride === 0;
      else if (unit === 'week') on = weekOf(w.day[i]) !== weekOf(w.day[i - 1]) && weekOf(w.day[i]) % stride === 0;
      else on = w.month[i] !== w.month[i - 1] && (w.month[i] % 12) % stride === 0;
      if (!on) continue;
      const t = g.times[j];
      const text = unit === 'month' ? (w.month[i] % 12 === 0 ? k.y.format(t) : k.m.format(t)) : unit === 'hour' && !newDay ? k.hm.format(t) : k.md.format(t);
      const x = g.xs[j];
      const half = (text.length * 6 + 2) / 2;
      if (x - half < g.gl + 2 || x + half > g.x1 - 2) continue;
      if (x - half < lastRight + room) { clash = true; continue; }
      out.push({ x, text });
      lastRight = x + half;
    }
    if (!clash) fits.push(out);
    last = out;
  }
  if (!fits.length) return last;
  return [...fits].reverse().find((out) => out.length >= (narrow ? 3 : 4)) ?? fits[0];
}
// The axis words for a geometry, the panel's or the share card's (its kind of screen is in it): the price words, in
// the right-hand gutter, each centred on its own level (no line runs to it; one on the plot's floor sits just above it,
// clear of the time words), each with the top of its 12px line; the time words, each with its middle; and whether the
// axis's end says "ET" (a stock's days start with New York's: on its hourly and 4-hour charts, whose readout tells the
// hour).
function axisWords(g) {
  const { ticks, fmt } = niceTicks(g.d0, g.d1, clamp(Math.round(g.H / 50), 3, 6));
  const prices = [];
  for (const v of ticks) {
    const yy = g.y(v);
    if (yy < g.padT - 6 || yy > g.padT + g.H + 1) continue;
    prices.push({ top: Math.round(Math.min(yy - 6, g.padT + g.H - 10)), text: `$${fmt.format(v)}` });
  }
  const times = timeTicks(g).map((tk) => ({ x: Math.round(tk.x), text: tk.text }));
  return { prices, times, tz: Boolean(cd.item?.exchange) && (ch.size === '1H' || ch.size === '4H') };
}
// The axis words (crossfaded when the candle size changes: whole words, digits never tween) and the scrub's cursor.
function paintFrame(g, fade) {
  const hair = 1 / ch.dpr;
  const ax = axisWords(g);
  const words = [];
  for (const p of ax.prices) {
    const s = el('span', {}, p.text);
    s.style.translate = `${Math.round(g.w - g.edge)}px ${p.top}px`;
    s.style.transform = 'translateX(-100%)';
    words.push(s);
  }
  for (const tk of ax.times) {
    const s = el('span', {}, tk.text);
    s.style.translate = `${tk.x}px ${Math.round(g.padT + g.H + 8)}px`;
    s.style.transform = 'translateX(-50%)';
    words.push(s);
  }
  // The ET under the price words.
  if (ax.tz) {
    const s = el('span', { class: 'tz' }, 'ET');
    s.style.translate = `${Math.round(g.w - g.edge)}px ${Math.round(g.padT + g.H + 8)}px`;
    s.style.transform = 'translateX(-100%)';
    words.push(s);
  }
  C.sLine.setAttribute('y1', String(g.padT - 6));
  C.sLine.setAttribute('y2', String(g.padT + g.H));
  C.sLine.setAttribute('stroke-width', String(hair));
  const old = [...C.axis.children];
  if (fade && old.length && !REDUCED.matches) {
    for (const s of old) s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EASE_IN, fill: 'forwards' }).finished.then(() => s.remove(), () => s.remove());
    for (const s of words) s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 100, easing: EASE, fill: 'backwards' });
    C.axis.append(...words);
  } else C.axis.replaceChildren(...words);
  C.ohlc.style.translate = `${Math.round(g.gl + 2)}px 2px`;
  // The watermark gets the plot's box, clear of the price words on the right and the time words below, so the lockup
  // sits centred on the plot itself. It never moves or fades of its own: a new candle size or view leaves it where it is.
  C.wm.style.translate = `${Math.round(g.x0)}px ${Math.round(g.padT)}px`;
  C.wm.style.width = `${Math.round(g.x1 - g.x0)}px`;
  C.wm.style.height = `${Math.round(g.H)}px`;
  C.wm.classList.add('on');
}
// Everything at rest, at full resolution, with no motion.
function paintAll() {
  const g = ch.geo;
  if (!g) return;
  paintFrame(g, false);
  paintLine(g.xs, g.ys, g.n, g.padT + g.H);
  paintCandles(g);
  C.wave.setAttribute('x', '-10');
  C.wave.setAttribute('width', '100000');
  showType(ch.type);
  if (xhair.is('on')) scrubDraw(true);
}
function showType(t) {
  C.lines.style.display = t === 'line' ? '' : 'none';
  C.cnd.style.display = t === 'candles' ? '' : 'none';
  C.end.style.display = t === 'line' ? '' : 'none';
}

// Opening: whatever is cached is drawn at once; otherwise the calm placeholder, and the data draws in on arrival. The
// hourly candles the stats row reads are asked for too when another size is on show.
function chartPrepare(sym) {
  chartHalt();
  ch.sym = sym;
  ch.size = cd.size;
  ch.type = cd.type;
  ch.data = freshHist(sym, ch.size) ?? hist.get(histKey(sym, ch.size))?.data ?? null;
  ch.geo = null;
  ch.pending = null;
  ch.retries = 0;
  ch.staleTries = 0;
  ch.failed = false;
  ch.dayFailed = false;
  ch.dayTries = 0;
  ch.disp = null;
  // A finger left on the last panel's chart (its release went elsewhere) is not this one's.
  finger.go('none');
  view.go('empty');
  chartWipe();
  segSet(P.segS, 'data-i', ch.size);
  segSet(P.segT, 'data-t', ch.type);
  P.chart.setAttribute('aria-valuemax', '0');
  P.chart.setAttribute('aria-valuenow', '0');
  P.chart.setAttribute('aria-valuetext', 'Loading');
  if (ch.size !== '1H') dayFetch();
}
// An empty plot: no line, wash, candles, time words or end dot. No chart, no watermark either: the waiting line would
// run through its middle, and a note would sit on it.
function chartWipe() {
  C.axis.replaceChildren();
  C.wm.classList.remove('on');
  for (const p of [C.ln, C.areaUp, C.areaDown, C.areaFlat, C.cUp, C.cDown, C.wUp, C.wDown, C.wUpCut, C.wDownCut]) p.setAttribute('d', '');
  C.end.style.display = 'none';
}
// The hourly candles for the stats row's high and low (dayRange), quietly: a failure says "n/a" there until a later
// price update asks again. A stale answer is asked for again on the stale backoff (STALE_WAIT), as the chart's own is
// (with 1H on show, the chart's asks are these). An ask already on its way (a finger's or a hover's prefetch) is waited
// on, not left to land unseen until the next price update. An answer only counts for the open that asked, and only
// while it is opening or open: one landing as the panel flies home would rewrite its words in flight. Either answer
// changes what the high and the low say, so the share card hears of it as of any change of view (a phone's card drawn
// ahead while they waited is drawn again).
function dayFetch() {
  const sym = cd.sym;
  if (!sym) return;
  const run = cd.run;
  fetchHist(sym, '1H').then((d) => {
    if (!runLive(run)) return;
    ch.dayFailed = false;
    if (!d.stale) ch.dayTries = 0;
    else if (ch.size !== '1H') {
      clearTimeout(ch.dayTimer);
      ch.dayTimer = setTimeout(() => { if (runLive(run)) dayFetch(); }, staleWait(ch.dayTries++));
    }
    headLive(true);
    // With 1H on show these are the chart's candles too: newer ones slide in now rather than at the next update.
    if (ch.size === '1H') chartRoll();
    shareSoon();
  }, () => {
    if (!runLive(run)) return;
    ch.dayFailed = true;
    headLive(true);
    shareSoon();
  });
}
// Called once the panel is laid out and its entrance is planned: draws now (and plays the draw-in at `delay`), or waits.
function chartEnter(delay) {
  if (ch.data) {
    chartLayout();
    if (ch.geo) view.go('drawn');
    paintAll();
    chartAria();
    headLive(true);
    drawIn(delay);
    if (!freshHist(ch.sym, ch.size)) chartFetch(ch.size, false);
  } else {
    const at = view.epoch;
    ch.waitTimer = setTimeout(() => { if (view.epoch === at) waitOn(); }, Math.max(0, delay - 60));
    chartFetch(ch.size, true);
  }
}
// The calm placeholder: a flat line with a soft light passing along it.
function waitOn() {
  C.wait.style.left = `${ch.gl}px`;
  C.wait.style.width = `${Math.max(0, ch.w - ch.gl - ch.gr - 60)}px`;
  view.go('waiting');
}
// Asks for a candle size; when it lands, it is drawn (or morphed to) if that size is still the one chosen.
function chartFetch(size, first) {
  const sym = ch.sym;
  const req = ++ch.req;
  fetchHist(sym, size).then((d) => {
    if (req !== ch.req || ch.sym !== sym || cd.size !== size || panel.is('closed', 'closing')) return;
    clearTimeout(ch.retryTimer);
    ch.retries = 0;
    ch.failed = false;
    // A stale chart (the server's refresh was still on the way) is shown now and asked for again on the stale backoff
    // (4 s, 15 s, 1 minute, then every 5 minutes) for as long as it stays stale; the fresh one then morphs in over it.
    clearTimeout(ch.staleTimer);
    if (!d.stale) ch.staleTries = 0;
    else {
      const asked = ch.req;
      ch.staleTimer = setTimeout(() => { if (asked === ch.req && ch.sym === sym && cd.size === size && panel.is('opening', 'open')) chartFetch(size, false); }, staleWait(ch.staleTries++));
    }
    if (panel.is('opening') && !first) { ch.pending = d; return; }
    chartShow(d, !first || Boolean(ch.geo));
  }, () => {
    if (req !== ch.req || ch.sym !== sym || panel.is('closed', 'closing')) return;
    clearTimeout(ch.waitTimer);
    clearTimeout(ch.dimTimer);
    ch.failed = true;
    // Retry quietly: 4 s, 8 s, 16 s, then every 30 s while the panel stays on this size.
    const asked = ch.req;
    const again = () => { ch.retryTimer = setTimeout(() => { if (asked === ch.req) chartFetch(size, !ch.geo); }, Math.min(30_000, 4000 * 2 ** ch.retries++)); };
    // A refresh of the size on show that failed: its chart stays, older but true, and no note is laid over it.
    if (ch.geo && ch.data?.i === size) {
      if (view.is('dimmed')) view.go('drawn');
      again();
      return;
    }
    // Another size's chart would sit under the note and read as this size's (the 1D line stood under 1W's note): it
    // goes, and the note is alone on an empty plot, as when an open's first size fails.
    if (ch.geo) {
      chartStop();
      drawCut();
      chartWipe();
      ch.size = size;
      ch.data = null;
      ch.geo = null;
      ch.disp = null;
      P.chart.setAttribute('aria-valuemax', '0');
      P.chart.setAttribute('aria-valuenow', '0');
    }
    view.go('failed');
    // The note is inside the slider, whose children screen readers skip: its value says it instead (chartAria puts the
    // candle size back once a chart lands).
    P.chart.setAttribute('aria-valuetext', 'Chart unavailable right now');
    headLive(true);
    again();
  });
}
// The candle on the right is the one still forming. Once its time is up (the next one has begun: an hour on 1H, a week
// on 1W), the next price update asks for the chart again as soon as the server may have moved on too (its cache time),
// and the new candle slides in like any refresh; a stock's chart waits for its market to open. Quiet: a failure just
// waits for the next update.
function chartRoll() {
  const d = ch.data;
  if (!d || !ch.geo || motion.is('moving') || !panel.is('open')) return;
  const sym = ch.sym;
  const size = ch.size;
  const h = hist.get(histKey(sym, size));
  if (!h || h.promise) return;
  // Newer candles that came in while something else was moving.
  if (h.data && h.data !== d) { chartShow(h.data, true); return; }
  if (freshHist(sym, size) || serverNow() < d.candles[d.candles.length - 1][0] + d.step) return;
  if (cd.item?.exchange && !marketOpen(new Date(serverNow()))) return;
  const req = ch.req;
  fetchHist(sym, size).then((next) => {
    if (req !== ch.req || ch.sym !== sym || ch.size !== size || !panel.is('open') || next === ch.data || motion.is('moving')) return;
    chartShow(next, true);
  }, () => {});
}
// New data for the chosen size: drawn straight (first time) or morphed from what is on screen.
function chartShow(d, morph) {
  clearTimeout(ch.waitTimer);
  clearTimeout(ch.dimTimer);
  const had = ch.geo;
  // Newer data for the size already on show (a stale or cached chart refreshed, a new candle) rather than another size.
  const refresh = Boolean(had && ch.data?.i === d.i);
  ch.data = d;
  ch.size = d.i;
  if (!morph || !had) {
    chartLayout();
    view.go(ch.geo ? 'drawn' : 'empty');
    paintAll();
    chartAria();
    headLive(panel.is('opening'));
    drawIn(0);
    shareSoon();
    return;
  }
  sizeMorph(had, refresh);
}

function chartAria() {
  const g = ch.geo;
  if (!g) return;
  P.chart.setAttribute('aria-valuemax', String(Math.max(0, g.n - 1)));
  P.chart.setAttribute('aria-valuenow', String(Math.max(0, g.n - 1)));
  const words = SIZE_WORDS[ch.size];
  P.chart.setAttribute('aria-valuetext', `${words[0].toUpperCase()}${words.slice(1)} candles, latest ${fmtPrice(cd.item?.price)}`);
}

// The line draws in as a pen stroke; the area fades in under it and the end dot pops as the pen arrives. In candles
// mode the candles unfold from their midpoints in a wave instead. In the phone sheet all of it is quicker, so the chart
// lands with the sheet rather than after it.
function drawIn(delay) {
  const g = ch.geo;
  if (!g) return;
  if (REDUCED.matches) { C.dataG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay, fill: 'backwards' }); return; }
  const quick = mode.is('sheet');
  if (ch.type === 'candles') { candleWave('unfold', delay, quick); return; }
  const L = lineLength(g);
  // The dash ends sit 2px outside the path, so the round cap leaves no dot before the pen starts. The three are named
  // (pen, wash, pop) so a change of shape can cut just them (drawCut).
  C.ln.style.strokeDasharray = `${L}px ${L + 4}px`;
  const a = C.ln.animate([{ strokeDashoffset: `${L + 2}px` }, { strokeDashoffset: '0px' }], { duration: quick ? 420 : 640, delay, easing: EASE, fill: 'backwards', id: 'pen' });
  // The area waits for the pen (99.4% of the way across at 78% of its time: 500 ms of 640, 330 of 420), so the shape
  // never shows ahead of the line.
  C.areas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: quick ? 240 : 360, delay: delay + (quick ? 330 : 500), easing: EASE, fill: 'backwards', id: 'wash' });
  springAnim(C.dot, SPRING.pop, (p) => ({ opacity: Math.min(1, p), transform: `scale(${lerp(0.4, 1, p)})` }), { delay: delay + (quick ? 360 : 560), fill: 'backwards', id: 'pop' });
  // The dash goes once the pen is done or cut, unless a newer pen has set its own by then: a panel opened as the last
  // one's close ends cuts the old pen and draws the new chart in the same task, before this hears of it.
  const done = () => {
    if (!C.ln.getAnimations().some((b) => b.id === 'pen' && b !== a)) C.ln.style.strokeDasharray = '';
  };
  a.finished.then(done, done);
}
// The line's length, as the pen's dash wants it: the length of the path linePath writes, its lead-in from the plot's
// edge to the first point included (a dash that left it out stopped that far short of the line's end until the pen
// was done), at the path's own rounding.
function lineLength(g) {
  const at = (v) => Number(f1(v));
  let L = at(g.xs[0]) - at(lineStart(g.xs));
  for (let i = 1; i < g.n; i++) L += Math.hypot(at(g.xs[i]) - at(g.xs[i - 1]), at(g.ys[i]) - at(g.ys[i - 1]));
  return L;
}
// Cuts the draw-in short, the whole drawing on show at once, for a motion that is about to change the line's shape
// under it (another size, Line <> Candles, a resize): the pen's dash is the length of the line it set out on, and a
// longer line would lose its end behind it until the pen was done; the wash's fade and the dot's pop are cut with it,
// or they would come in late on a line already moving. The three go by name, never every animation on the line: its
// colour transition shares the node and runs on.
function drawCut() {
  for (const a of C.ln.getAnimations()) if (a.id === 'pen') a.cancel();
  for (const a of C.areas.getAnimations()) if (a.id === 'wash') a.cancel();
  for (const a of C.dot.getAnimations()) if (a.id === 'pop') a.cancel();
  C.ln.style.strokeDasharray = '';
}
// Whether a pen still drawing would hide the end of the line g draws: it is cut only then on a refresh, so the usual
// re-open (the same chart fetched afresh and drawn again, as long as it was) keeps its draw-in whole.
function penHides(g) {
  const dash = parseFloat(C.ln.style.strokeDasharray);
  return dash > 0 && lineLength(g) > dash + 1;
}
// One breath of the end dot's halo when a live price lands (never a loop: that would cost battery and pull the eye).
function breathe() {
  if (REDUCED.matches || ch.type !== 'line') return;
  C.halo.animate([{ opacity: 0.35, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(3.5)' }], { duration: 900, easing: EASE });
}

// Stops every chart motion where it is (a new one starts from what is on screen). A Line <> Candles wave cut short
// first puts back what it had hidden or clipped (motion.on).
function chartStop() {
  motion.go('still');
}
function chartHalt() {
  chartStop();
  clearTimeout(ch.waitTimer);
  clearTimeout(ch.dimTimer);
  clearTimeout(ch.retryTimer);
  clearTimeout(ch.staleTimer);
  clearTimeout(ch.dayTimer);
  ch.req++;
}
// A frame loop that runs `frame(ms)` until it returns false, then `done()`. A soft one (a refresh of the size on show)
// lets a scrub carry on through it.
// Played out, it clears its frame and its undo before it goes still, so the move knows it ended rather than was cut.
function chartLoop(frame, done, soft = false) {
  chartStop();
  motion.go('moving');
  ch.soft = soft;
  const run = motion.epoch;
  const t0 = performance.now();
  const step = (now) => {
    if (motion.epoch !== run) return;
    if (frame(now - t0) === false) {
      ch.anim = 0;
      ch.undo = null;
      motion.go('still');
      done?.();
      return;
    }
    ch.anim = requestAnimationFrame(step);
  };
  ch.anim = requestAnimationFrame(step);
}

// Resamples a line to N evenly spaced points between its first and last x.
function resample(xs, ys, n, N) {
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const f = (k / (N - 1)) * (n - 1);
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    out[k] = lerp(ys[i], ys[j], f - i);
  }
  return out;
}
// For a refresh: where each candle now on show stood before (its index in the old geometry, -1 for a new one), matched
// by time; null when none matches (nothing to move from).
function matchOld(old, g) {
  const at = new Map();
  for (let k = 0; k < old.n; k++) at.set(old.times[k], k);
  let any = false;
  const m = new Int32Array(g.n);
  for (let j = 0; j < g.n; j++) {
    m[j] = at.get(g.times[j]) ?? -1;
    if (m[j] >= 0) any = true;
  }
  return any ? m : null;
}
// Another candle size, line view: both shapes resampled to the same points, their pixel heights blended with the
// gentle spring. Candles view: the new candles unfold at once while a copy of the old ones fades out over them. Reduced
// motion: a plain crossfade. A refresh of the size on show (refresh) is quieter: the axis words swap in place (most are
// unchanged, and a crossfade would dip them), and every candle (and point of the line) moves from where it stood to
// where it stands now, matched by its time, so the chart slides on by the candles that came in, a new candle grows in
// at the right and nothing but the change moves; a scrub that is on carries on, its dot riding along.
function sizeMorph(old, refresh = false) {
  chartStop();
  chartLayout();
  const g = ch.geo;
  // A draw-in still playing is cut for a new shape; a refresh keeps it unless the pen would hide the new line's end.
  if (!refresh || penHides(g)) drawCut();
  headLive();
  chartAria();
  if (REDUCED.matches) {
    // A new size crossfades in; a refresh swaps in place (a fade from nothing would blink). Either way the view is new,
    // and the share card hears of it (afterAnim), as after a morph.
    if (!refresh) C.dataG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE });
    view.go('drawn');
    paintAll();
    afterAnim();
    return;
  }
  paintFrame(g, !refresh);
  view.go('drawn');
  const bottom = g.padT + g.H;
  const f = springFn(SPRING.gentle);
  const D = settleMs(SPRING.gentle);
  const match = refresh ? matchOld(old, g) : null;
  if (ch.type === 'candles') {
    paintLine(g.xs, g.ys, g.n, bottom);
    if (match) {
      const oc = old.candles;
      // Old candles with no place in the new set (fewer came back: a backup source with a shorter history) fade out
      // where they stood, as the no-match path's copy does, rather than going on the first frame: a copy of the old
      // drawing with only those candles on it, under the new ones. The usual refresh has none and makes no copy.
      const kept = new Uint8Array(old.n);
      for (let j = 0; j < g.n; j++) if (match[j] >= 0) kept[match[j]] = 1;
      if (kept.includes(0)) {
        paintCandles(old, (i) => (kept[i] ? [0, 0] : [1, 1]));
        const ghost = C.cnd.cloneNode(true);
        C.dataG.insertBefore(ghost, C.cnd);
        const gone = () => ghost.remove();
        ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE, fill: 'forwards' }).finished.then(gone, gone);
      }
      chartLoop((ms) => {
        if (ms >= D) return false;
        const p = f(ms / 1000);
        paintCandles(g, (i) => (match[i] >= 0 ? [1, 1] : [p, p]), null, (i) => {
          const b = g.candles[i];
          const a = match[i] >= 0 ? oc[match[i]] : null;
          return a ? { x: lerp(a.x, b.x, p), top: lerp(a.top, b.top, p), bot: lerp(a.bot, b.bot, p), yh: lerp(a.yh, b.yh, p), yl: lerp(a.yl, b.yl, p) } : b;
        });
        scrubDraw(false);
        return true;
      }, () => { paintCandles(g); afterAnim(); }, true);
      return;
    }
    const ghost = C.cnd.cloneNode(true);
    C.dataG.insertBefore(ghost, C.cnd);
    const gone = () => ghost.remove();
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: refresh ? 240 : 160, easing: EASE, fill: 'forwards' }).finished.then(gone, gone);
    if (refresh) { paintCandles(g); afterAnim(); } else candleWave('unfold', 0);
    return;
  }
  const from = ch.disp ?? { xs: old.xs, ys: old.ys, n: old.n };
  let N;
  let ax;
  let ay;
  let bx;
  let by;
  if (match && from.xs === old.xs) {
    // Each point from its own old place; a new one from the old end (or start), so it grows out of the line.
    N = g.n;
    [ax, ay, bx, by] = [new Float64Array(N), new Float64Array(N), g.xs, g.ys];
    const firstNew = match.findIndex((m) => m >= 0);
    for (let j = 0; j < N; j++) {
      const k = match[j] >= 0 ? match[j] : j < firstNew ? 0 : old.n - 1;
      ax[j] = old.xs[k];
      ay[j] = old.ys[k];
    }
  } else {
    // A refresh with nothing to match keeps every point (each one just moves to its new height); another size gets
    // about one point every 3px.
    N = refresh ? Math.max(from.n, g.n) : clamp(Math.round(g.W / 3), 60, 240);
    const spread = (x0, x1) => { const out = new Float64Array(N); for (let k = 0; k < N; k++) out[k] = lerp(x0, x1, k / (N - 1)); return out; };
    [ax, ay, bx, by] = [spread(from.xs[0], from.xs[from.n - 1]), resample(from.xs, from.ys, from.n, N), spread(g.xs[0], g.xs[g.n - 1]), resample(g.xs, g.ys, g.n, N)];
  }
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  chartLoop((ms) => {
    if (ms >= D) return false;
    const p = f(ms / 1000);
    for (let k = 0; k < N; k++) { xs[k] = lerp(ax[k], bx[k], p); ys[k] = lerp(ay[k], by[k], p); }
    paintLine(xs, ys, N, bottom);
    if (refresh) scrubDraw(false);
    return true;
  }, () => { paintLine(g.xs, g.ys, g.n, bottom); paintCandles(g); afterAnim(); }, refresh);
}
// A scrub that stayed on through a refresh reads the candle now under it (the dot glides on to it, never jumps).
function afterAnim() {
  const sc = ch.scrub;
  if (xhair.is('on')) {
    const i = Math.min(sc.idx, ch.geo.n - 1);
    sc.idx = -1;
    scrubTo(i, false);
  }
  if (cd.queued && panel.is('open')) { cd.queued = false; panelLive(); }
  shareSoon();
}

// Line <> Candles. Candles grow out of the line, left to right: each starts as a 2px dot on the line at its own x and
// springs (pop) to its body and wick, while the line clears just behind the wave. Back to Line, the candles fold into
// the line with the return spring and the line grows back behind them. A quick wave (the phone sheet's entrance) crosses
// in 60% of the time.
function candleWave(kind, delay = 0, quick = false) {
  const g = ch.geo;
  if (!g) return;
  chartStop();
  const n = g.candles.length;
  const S = clamp(n * 4, 180, 320) * (kind === 'fold' ? 0.7 : 1) * (quick ? 0.6 : 1);
  const spring = kind === 'fold' ? SPRING.ret : SPRING.pop;
  const f = springFn(spring);
  const D = settleMs(spring);
  const at = (i) => (n > 1 ? (i / (n - 1)) * S : 0);
  const mids = g.candles.map((c) => (kind === 'unfold' ? (c.top + c.bot) / 2 : lineYAt(c.x)));
  const p = (local) => (local <= 0 ? 0 : local >= D ? 1 : f(local / 1000));
  const total = S + D + 60;
  C.cnd.style.display = '';
  if (kind === 'grow') {
    C.lines.style.display = '';
    C.areas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: 'forwards' });
    C.end.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE, fill: 'forwards' });
  }
  if (kind === 'unfold') { C.lines.style.display = 'none'; C.end.style.display = 'none'; }
  if (kind === 'fold') {
    C.lines.style.display = '';
    C.areas.style.opacity = '0';
    C.end.style.display = 'none';
  }
  // Everything the wave hides, clips or fades, put back: at its end, or by whoever stops it midway.
  const reset = () => {
    for (const a of [...C.areas.getAnimations(), ...C.end.getAnimations()]) a.cancel();
    C.areas.style.opacity = '';
    C.wave.setAttribute('x', '-10');
    C.wave.setAttribute('width', '100000');
  };
  chartLoop((ms) => {
    const t = ms - delay;
    if (t >= total) return false;
    let front = g.x0 - 10;
    paintCandles(g, (i) => {
      const local = t - at(i);
      if (kind === 'fold') {
        const q = 1 - p(local);
        if (local > D * 0.35) front = Math.max(front, g.candles[i].x + g.slot / 2);
        return [q, 1 - p(local + 60)];
      }
      if (local >= 90) front = Math.max(front, g.candles[i].x + g.slot / 2);
      return [p(local), p(local - 60)];
    }, (i) => mids[i]);
    if (kind === 'grow') { C.wave.setAttribute('x', f1(front)); C.wave.setAttribute('width', '100000'); }
    if (kind === 'fold') { C.wave.setAttribute('x', '-10'); C.wave.setAttribute('width', f1(Math.max(0, front + 10))); }
    return true;
  }, () => {
    ch.undo = null;
    reset();
    if (kind === 'fold') {
      paintCandles(g, () => [0, 0]);
      showType('line');
      C.areas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: EASE });
      C.end.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE });
      paintCandles(g);
    } else {
      paintCandles(g);
      showType('candles');
    }
    afterAnim();
  });
  ch.undo = () => { reset(); paintCandles(g); showType(ch.type); };
}

function setSize(size) {
  if (!SIZES.includes(size) || panel.is('closed', 'closing')) return;
  starsAwake();
  if (size === cd.size && size === ch.size && ch.geo) return;
  cd.size = size;
  remember(PREF_SIZE, size);
  segPress(P.segS, 'data-i', size);
  scrubEnd(true);
  clearTimeout(ch.retryTimer);
  clearTimeout(ch.dimTimer);
  clearTimeout(ch.staleTimer);
  // The last size's note goes: this size has not failed (yet).
  if (view.is('failed')) view.go('empty');
  ch.retries = 0;
  ch.staleTries = 0;
  // The hourly candles' own follow-up was the 1H chart's (just cancelled): the stats row still waiting asks for them.
  if (size !== '1H' && cd.item && !dayRange(cd.item)) dayFetch();
  const d = freshHist(ch.sym, size);
  if (d && panel.is('open')) { ch.req++; chartShow(d, true); return; }
  if (d && panel.is('opening')) { ch.req++; ch.pending = d; ch.size = size; return; }
  // Not here yet: the choice moves at once, the line dims after 150 ms, and the morph starts from the dimmed line. With
  // no chart on show yet (the first size failed or is still loading), the chart waits for the new size over the
  // placeholder.
  if (ch.geo) {
    const at = view.epoch;
    ch.dimTimer = setTimeout(() => { if (view.epoch === at) view.go('dimmed'); }, 150);
  } else {
    ch.size = size;
    ch.failed = false;
    P.chart.setAttribute('aria-valuetext', 'Loading');
    headLive(true);
    waitOn();
  }
  chartFetch(size, !ch.geo);
}
function setType(t) {
  if (panel.is('closed', 'closing') || t === cd.type) return;
  starsAwake();
  cd.type = t;
  remember(PREF_TYPE, t);
  segPress(P.segT, 'data-t', t);
  scrubEnd(true);
  const was = ch.type;
  ch.type = t;
  chartAria();
  if (!ch.geo) return;
  if (motion.is('moving')) { chartStop(); ch.type = was; paintAll(); ch.type = t; }
  if (REDUCED.matches) {
    C.dataG.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 160, easing: EASE });
    paintAll();
    shareSoon();
    return;
  }
  // A draw-in still playing ends here: the wave sets off from the whole line, never from a half-drawn one.
  drawCut();
  if (was === 'line' && t === 'candles') candleWave('grow');
  else if (was === 'candles' && t === 'line') {
    const g = ch.geo;
    paintLine(g.xs, g.ys, g.n, g.padT + g.H);
    candleWave('fold');
  }
}

// ---- scrub: the crosshair, its dot and the header readout (Apple Stocks) ----
// Line and Candles draw the same candles, so both scrub them: the crosshair stops on a candle's middle (where the line
// passes through its close).
function scrubIndex(x) {
  const g = ch.geo;
  return clamp(Math.floor((x - g.xL) / g.slot), 0, g.n - 1);
}
function scrubPoint(i) {
  const c = ch.geo.candles[i];
  return { x: c.x, c };
}
// The crosshair. Its states:
//   off  the header shows the live figures;
//   on   the crosshair, its dot and the dimmed future are drawn (C.scrub.on, the mask), the header and the OHLC row read
//        the candle under it (readout), and the dot glides to that candle on a frame of its own (ch.scrub.raf).
// A mouse turns it on by hovering, the keyboard by an arrow, a finger once it has said it means a scrub (finger).
const xhair = machine('off', { off: ['on'], on: ['off'] });
xhair.on((to) => {
  const sc = ch.scrub;
  C.scrub.classList.toggle('on', to === 'on');
  if (to === 'on') {
    C.dataG.setAttribute('mask', 'url(#cd-past)');
    if (!REDUCED.matches) springAnim(C.sDot, SPRING.snappy, (p) => ({ transform: `scale(${lerp(0.4, 1, p)})` }));
    return;
  }
  sc.idx = -1;
  if (sc.raf) cancelAnimationFrame(sc.raf);
  sc.raf = 0;
  C.ohlc.classList.remove('on');
  C.dataG.removeAttribute('mask');
});
// A finger on the chart (touch only). Its states:
//   none       no finger (ch.scrub.touch is null);
//   undecided  down, not yet said what it means: a sideways move, or a rest of 90 ms (its hold timer), makes it a
//              scrub; a mostly vertical move in its first 10px hands it to the sheet's drag (or the sheet's scroll);
//   scrubbing  it leads the crosshair until it lifts.
const finger = machine('none', { none: ['undecided'], undecided: ['none', 'scrubbing'], scrubbing: ['none'] });
finger.on((to, from) => {
  if (from === 'undecided') clearTimeout(ch.scrub.touch?.hold);
  if (to === 'none') ch.scrub.touch = null;
});
function scrubTo(i, immediate) {
  const g = ch.geo;
  if (!g || (motion.is('moving') && !ch.soft)) return;
  starsAwake();
  const sc = ch.scrub;
  const pt = scrubPoint(i);
  if (xhair.is('off')) {
    sc.s.x = pt.x;
    sc.s.v = 0;
    xhair.go('on');
  }
  sc.target = pt.x;
  if (immediate || REDUCED.matches) { sc.s.x = pt.x; sc.s.v = 0; }
  if (i !== sc.idx) { sc.idx = i; readout(pt); }
  if (!sc.raf) { sc.last = performance.now(); sc.raf = requestAnimationFrame(scrubFrame); }
}
function scrubFrame(now) {
  const sc = ch.scrub;
  const on = xhair.is('on');
  const dt = Math.min(0.05, (now - sc.last) / 1000);
  sc.last = now;
  follow(sc.s, sc.target, dt, (2 * Math.PI) / 0.12);
  scrubDraw(false);
  sc.raf = on && (Math.abs(sc.s.x - sc.target) > 0.05 || Math.abs(sc.s.v) > 0.5) ? requestAnimationFrame(scrubFrame) : 0;
  if (!sc.raf && on) { sc.s.x = sc.target; scrubDraw(false); }
}
function scrubDraw(snapTo) {
  const sc = ch.scrub;
  const g = ch.geo;
  if (!xhair.is('on') || !g) return;
  if (snapTo && sc.idx >= 0) { sc.idx = Math.min(sc.idx, g.n - 1); sc.s.x = sc.target = scrubPoint(sc.idx).x; }
  const x = sc.s.x;
  const c = g.candles[clamp(sc.idx, 0, g.n - 1)];
  const y = ch.type === 'candles' ? c.yc : lineYAt(x);
  C.sLine.setAttribute('x1', f1(x));
  C.sLine.setAttribute('x2', f1(x));
  for (const dot of [C.sDot, C.sHalo]) { dot.setAttribute('cx', f1(x)); dot.setAttribute('cy', f1(y)); }
  // The dimmed future starts at the crosshair; in Candles view just past the chosen candle, so it stays whole.
  const cut = ch.type === 'candles' ? x + c.bw / 2 + 1 : x;
  C.maskPast.setAttribute('width', f1(cut + 10));
  C.maskFut.setAttribute('x', f1(cut));
}
// The header shows the candle under the crosshair: its close, its own change (open to close, the way its colour
// says), and its time (the start of its hour, its day, its week); over the chart, its open, high, low and close.
function readout(pt) {
  const c = pt.c;
  const chg = fmtChange((c.c / c.o - 1) * 100);
  const tone = chg.tone ? ` ${chg.tone}` : '';
  setText(P.price, fmtPrice(c.c));
  setText(P.chg, chg.text);
  setClass(P.chg, `chg cd-chg${tone}`);
  setText(P.abs, fmtMove(c.c - c.o, c.c));
  setClass(P.abs, `cd-abs${tone}`);
  const k = clockOf(cd.item, ch.size);
  const when = ch.size === '1W' ? `Week of ${k.mdy.format(c.t)}` : ch.size === '1D' ? k.mdy.format(c.t) : `${k.md.format(c.t)}, ${k.hm.format(c.t)}${k === ET ? ' ET' : ''}`;
  setText(P.key, when);
  setText(P.sess, '');
  fitMove();
  const f = (v) => fmtPrice(v).replace('$', '');
  C.ohlc.replaceChildren(...[['O', c.o], ['H', c.h], ['L', c.l], ['C', c.c]].map(([w, v]) => el('span', {}, el('b', {}, w), f(v))));
  C.ohlc.classList.add('on');
  // In Candles view the scrub dot takes the chosen candle's colour; on the line, the line's.
  C.scrub.classList.toggle('rise', ch.type === 'candles' && c.c >= c.o);
  C.scrub.classList.toggle('fall', ch.type === 'candles' && c.c < c.o);
  P.chart.setAttribute('aria-valuenow', String(ch.scrub.idx));
  P.chart.setAttribute('aria-valuetext', `${when}, open ${fmtPrice(c.o)}, high ${fmtPrice(c.h)}, low ${fmtPrice(c.l)}, close ${fmtPrice(c.c)}, ${chg.tone === 'gain' ? 'up' : chg.tone === 'loss' ? 'down' : 'unchanged'} ${chg.text.replace(/^[+−]/, '')}`);
}
function scrubEnd(quiet) {
  if (!xhair.go('off')) return;
  if (!quiet || panel.is('open')) headLive();
  chartAria();
  shareSoon();
}

// ---- the phone sheet: drag down to dismiss ----
// The sheet under a finger (or a mouse, in a narrow window). Its states:
//   idle      nobody holds it;
//   armed     a press on it (drag.id) that has not moved 6px yet: a tap, or a drag about to start. Any release or
//             cancel anywhere ends it (the window hears them: no capture is taken yet, and a mouse may let go off the
//             sheet), so it never outlives its press (shareBusy would read it as busy for good);
//   dragging  the sheet follows the finger: pointer capture, will-change, the frame guard watching;
//   settling  let go short of dismissing, it springs back into place; a new press may take it from there.
// A release far or fast enough dismisses it instead: the sheet is let go (idle) and the panel goes to closing, its own
// spring carrying the sheet off the screen. A second finger on a held sheet is not a new drag.
const sheet = machine('idle', { idle: ['armed'], armed: ['idle', 'dragging'], dragging: ['idle', 'settling'], settling: ['idle', 'armed'] });
// The press's data: its pointer, where it started, how far the sheet follows it, and its last moves (for the release
// velocity).
const drag = { id: null, x0: 0, y0: 0, dy: 0, h: 0, samples: [], raf: 0, v: 0, justDragged: false };
sheet.on((to, from) => {
  // The grabber (glass.js) springs back as the press ends, however it ends.
  if ((from === 'armed' || from === 'dragging') && to !== 'dragging') {
    G?.grab(null);
    drag.id = null;
  }
  if (from === 'dragging') {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag.raf = 0;
    P.panel.style.willChange = '';
  }
  if (to === 'dragging') {
    P.panel.style.willChange = 'transform';
    // The guard watches the sheet under the finger (40 frames, or as many as the drag lasts).
    const run = sheet.epoch;
    guard.watch('touch', 40, 0, () => sheet.epoch === run);
  }
  // Back in place after a spring (or a press that let go of it): a phone draws the share card it put off while the
  // sheet moved.
  if (to === 'idle' && (from === 'settling' || from === 'armed')) shareSoon();
});
// UIScrollView's rubber band: the further you pull, the less it follows.
const rubber = (x, h) => (1 - 1 / ((x * 0.55) / h + 1)) * h;
function dragY() {
  if (sheet.is('dragging')) return drag.dy;
  const tf = getComputedStyle(P.panel).transform;
  if (!tf || tf === 'none' || typeof DOMMatrixReadOnly !== 'function') return 0;
  return new DOMMatrixReadOnly(tf).m42 || 0;
}
// The grabber (glass.js) widens as the finger takes the sheet, stretches with the drag and springs back as it lets go.
function dragBegin(e, y0, t0 = e.timeStamp) {
  if (!sheet.go('armed')) return;
  drag.id = e.pointerId;
  drag.x0 = e.clientX;
  drag.y0 = y0;
  drag.dy = 0;
  drag.samples = [[t0, y0]];
  G?.grab(0, 0);
}
function dragMove(e) {
  if (!sheet.is('armed', 'dragging') || drag.id !== e.pointerId) return;
  const prev = drag.samples[drag.samples.length - 1];
  if (prev && e.timeStamp > prev[0]) G?.grab(e.clientX - drag.x0, ((e.clientY - prev[1]) / (e.timeStamp - prev[0])) * 1000);
  const raw = e.clientY - drag.y0;
  if (sheet.is('armed')) {
    if (Math.abs(raw) < 6) return;
    drag.h = sheetOff(P.panel.getBoundingClientRect());
    for (const a of [...cd.anims]) a.cancel();
    cd.anims.clear();
    try { P.panel.setPointerCapture(e.pointerId); } catch {
      // The pointer may already be gone.
    }
    sheet.go('dragging');
  }
  drag.dy = raw >= 0 ? raw : -rubber(-raw, drag.h);
  drag.samples.push([e.timeStamp, e.clientY]);
  while (drag.samples.length > 2 && e.timeStamp - drag.samples[0][0] > 80) drag.samples.shift();
  if (!drag.raf) drag.raf = requestAnimationFrame(dragPaint);
}
// The veil stays whole for the first half of the sheet's travel (past the point where a release dismisses it) and fades
// over the second: a linear fade would show the sharp page through the blur under the finger.
function dragPaint() {
  drag.raf = 0;
  if (!sheet.is('dragging')) return;
  P.panel.style.transform = `translateY(${drag.dy}px)`;
  const s = clamp((2 * drag.dy) / drag.h - 1, 0, 1);
  P.veil.style.opacity = String(1 - s * s * (3 - 2 * s));
}
function dragEnd(e, cancelled) {
  if (!sheet.is('armed', 'dragging') || drag.id !== e.pointerId) return;
  // A press that never became a drag: let go, nothing moves.
  if (sheet.is('armed')) { sheet.go('idle'); return; }
  drag.justDragged = true;
  setTimeout(() => { drag.justDragged = false; }, 0);
  if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; dragPaint(); }
  const s = drag.samples;
  const dt = s.length > 1 ? (s[s.length - 1][0] - s[0][0]) / 1000 : 0;
  const v = cancelled || dt <= 0 ? 0 : (s[s.length - 1][1] - s[0][1]) / dt;
  drag.v = v;
  // Projection by UIScrollView's fast deceleration (0.99): where the sheet would coast to.
  const projected = drag.dy + 0.099 * v;
  const dismiss = v > -200 && (projected > 0.4 * drag.h || (v > 900 && drag.dy > 12));
  settleSheet(drag.dy, v, dismiss ? drag.h : 0, drag.h);
}
// The sheet leaves the finger at the finger's speed: the spring starts with the release velocity.
function settleSheet(dy, v, target, h) {
  const veilFrom = Number(P.veil.style.opacity || 1);
  const veilTo = target === 0 ? 1 : 0;
  if (REDUCED.matches || Math.abs(target - dy) < 1) {
    sheet.go('idle');
    if (target !== 0) { closePanel(); return; }
    P.panel.style.transform = '';
    P.veil.style.opacity = '';
    shareSoon();
    return;
  }
  const v0 = clamp(v / (target - dy), -20, 20);
  const spring = target === 0 ? { ...SPRING.gentle, v0 } : { ...SPRING.smooth, v0 };
  const hold = { fill: target === 0 ? 'none' : 'forwards' };
  const a = track(springAnim(P.panel, spring, (p) => ({ transform: `translateY(${lerp(dy, target, p)}px)` }), hold));
  track(springAnim(P.veil, spring, (p) => ({ opacity: lerp(veilFrom, veilTo, Math.min(1, Math.max(0, p))) }), hold));
  P.panel.style.transform = '';
  P.veil.style.opacity = '';
  if (target === 0) {
    // Back in place once the spring has played out (sheet.on: idle).
    sheet.go('settling');
    const run = sheet.epoch;
    a.finished.then(() => { if (sheet.epoch === run) sheet.go('idle'); }, () => {});
    return;
  }
  // Dismissed: the dialog closes now (the page takes clicks at once) and cleans up when the sheet is gone. Its own spring
  // plays on (closePanel would replace it with a plain slide); everything else goes as on any close (closeBegin).
  sheet.go('idle');
  if (!closeBegin(false)) return;
  if (dlg.open) dlg.close();
  const move = panel.epoch;
  a.finished.then(() => { if (panel.epoch === move) finishClose(); }, () => {});
  panelLater(finishClose, settleMs(spring) + 50);
}
// The sheet let go of at once (any close).
function dragStop() {
  sheet.go('idle');
}
// A sheet whose content fits drags from anywhere; one that scrolls only from its top (the grabber and the header).
function sheetFits() {
  if (!PHONE.matches) return;
  sheetFit.go(P.body.scrollHeight <= P.body.clientHeight + 1 ? 'fits' : 'scrolls');
}

// ---- the coin in the panel: it follows the pointer, its two baked-in stars twinkle, a glint crosses it on landing ----
// Its middle and radius where it rests (measured when the panel lands, after a resize or a scroll in the panel, and
// whenever the pointer first needs it).
let coinCentre = null;
function measureCoin() {
  coinCentre = centreOf(P.coin);
}
function glintPanel(delay) {
  if (REDUCED.matches) return;
  glintPlay(P.band, 980, delay);
}
// A close puts the glint out as the coin turns to fly home. Left to run, it would sweep over the flying coin and vanish
// in one frame as the card takes over; and anything still moving inside the coin as its flight starts (even a fade)
// has Chromium draw the flying coin from other pixels than the card's, so it lands soft and sharpens with a jump.
function glintOff() {
  for (const a of P.band.getAnimations()) a.cancel();
}
// The stars twinkle while the viewer is busy with the panel (it has just opened; the pointer or a finger moves on it;
// a key, a scrub, a new candle size or chart type) and for 5 s after, then rest: an open panel left alone does no work.
const starTimers = new Map();
let starsUntil = 0;
const STARS_FOR = 5000;
function stars(on) {
  for (const t of starTimers.values()) clearTimeout(t);
  starTimers.clear();
  for (const s of [P.starA, P.starB]) for (const a of s.getAnimations()) a.cancel();
  starsUntil = 0;
  if (!on || REDUCED.matches) return;
  starsUntil = performance.now() + STARS_FOR;
  starTimers.set(P.starA, setTimeout(() => twinkle(P.starA), 250 + Math.random() * 500));
  starTimers.set(P.starB, setTimeout(() => twinkle(P.starB), 900 + Math.random() * 900));
}
// The viewer did something on the open panel: 5 s more, and a star at rest twinkles again soon.
function starsAwake() {
  if (!panel.is('open') || REDUCED.matches || document.hidden) return;
  starsUntil = performance.now() + STARS_FOR;
  for (const s of [P.starA, P.starB]) {
    if (starTimers.has(s) || s.getAnimations().length) continue;
    starTimers.set(s, setTimeout(() => twinkle(s), (s === P.starA ? 150 : 600) + Math.random() * 600));
  }
}
// A twinkle: the star swells, glows and fades, square to the pixel grid (a turned star would draw smooth diagonal arms
// over the hard-edged art); then waits an irregular while. Now and then it twinkles twice in a row.
function twinkle(star) {
  starTimers.delete(star);
  if (!panel.is('open') || document.hidden || performance.now() > starsUntil) return;
  const big = star === P.starA ? 1.65 : 1.9;
  const dur = 760 + Math.random() * 420;
  const a = star.animate([
    { opacity: 0, transform: 'scale(0.7)' },
    { opacity: 1, transform: `scale(${big})`, offset: 0.32 },
    { opacity: 0.85, transform: 'scale(1.1)', offset: 0.62 },
    { opacity: 0, transform: 'scale(0.6)' },
  ], { duration: dur, easing: 'cubic-bezier(0.3, 0, 0.25, 1)' });
  // Named, so the share card does not wait for it (a star's light runs on the compositor and comes and goes for seconds).
  a.id = 'twinkle';
  const again = Math.random() < 0.28;
  a.finished.then(() => {
    // The next twinkle only if it falls inside the busy while: none is left waiting once it is over (a move later
    // brings the star back, starsAwake).
    const wait = again ? 120 + Math.random() * 160 : 1600 + Math.random() * 3400;
    if (!panel.is('open') || performance.now() + wait > starsUntil) return;
    starTimers.set(star, setTimeout(() => twinkle(star), wait));
  }, () => {});
}

// ---- the share card: the open panel as a picture (share.js draws it, then shares or saves it) ----
// The card is the panel as the visitor sees it, redrawn in the current theme: the coin, the header's words, and the
// chart in the size and view on show, without the controls, the stats row or the source line. It has a desktop panel's
// proportions on every screen (one picture, wherever it is made), so a phone's card shows more of the chart than its
// sheet does, ending on the same candle. Its words come from the item, never from the header, which a scrub rewrites.
// The card's chart: the panel's geometry and axis words for its chart box (w x h CSS pixels), with a desktop panel's
// slots drawn at twice the pixels (the card is a 2x picture).
const SHARE_SCREEN = { gl: 0, gr: 0, px: 2, phone: false };
// gutter: a side margin the chart's box runs through, if the card's box is wider than its plot (none by default).
function shareChart(w, h, gutter = 0) {
  if (!ch.data) return null;
  const g = geoFor(ch.data, w, h, { ...SHARE_SCREEN, gl: gutter, gr: gutter });
  return { g, ...axisWords(g) };
}
// The day's four figures as the panel words them, each a label and its figure, in the panel's order. The high and
// the low wait empty for their hourly candles, as the panel's do (dayNone).
function dayFigures(item) {
  const stock = Boolean(item.exchange) || isCommodity(item);
  const label = stock ? 'Day' : '24h';
  const day = dayRange(item);
  const none = dayNone(item);
  return [
    ['Mcap', fmtCompact(item.mcap)], [stock ? 'Vol 1d' : 'Vol 24h', fmtCompact(item.vol24h)],
    [`${label} High`, day ? fmtPrice(day.hi) : none], [`${label} Low`, day ? fmtPrice(day.lo) : none],
  ];
}
// What the card says: null until a chart is drawn, and once the panel is closing.
function shareScene() {
  const item = cd.item;
  const d = ch.data;
  if (!PANEL || !item || !d || !ch.geo || (!panel.is('opening', 'open'))) return null;
  const m = dayMove(item);
  const chg = fmtChange(m.pct);
  const price = fmtPrice(item.price);
  const cs = d.candles;
  // The card is drawn on the ground the page draws now (its colours are the stylesheet's tokens, which follow the
  // ground): its theme is the ground's, and its coin that ground's picture. A change of ground asks for a new card
  // (applyTheme).
  const art = coinUrl(item);
  const figures = dayFigures(item);
  return {
    sym: item.symbol, name: item.name, exchange: tailOf(item), icon: ICON_URL.test(art) ? art : '',
    price, known: price !== NA,
    chg: chg.text, tone: item.stale ? '' : chg.tone, key: item.stale ? 'stale' : m.key,
    abs: Number.isFinite(m.abs) ? fmtMove(m.abs, item.price) : '',
    sess: lastSession(item) ? 'Last session' : '',
    size: ch.size, type: ch.type, theme: ground.state, figures,
    // The high and the low alone, the two figures that come in after the panel has opened (the hourly candles): a
    // phone's card drawn ahead of them is never shared once the panel shows them (share.js: tap).
    hilo: `${figures[2][1]}|${figures[3][1]}`,
    // When its prices are from (the server's clock); the card tells it in the viewer's own zone.
    at: data?.updatedAt || serverNow(),
    candles: `${cs.length}:${cs[0][0]}:${cs[cs.length - 1][0]}:${cs[cs.length - 1][4]}`,
    chart: shareChart,
  };
}
// Whether the panel is moving or under a finger (a morph or a wave, a scrub, a touch on the chart or the sheet, its open
// or its close): a card drawn ahead waits for it to end (scrubEnd, the sheet's settle and afterAnim ask again).
function shareBusy() {
  return !panel.is('open') || motion.is('moving') || xhair.is('on') || !finger.is('none') || sheet.is('armed', 'dragging');
}
// A word for screen readers, said once (the polite live region in the dialog).
function say(text) {
  if (P?.said) P.said.textContent = P.said.textContent === text ? `${text}\u00a0` : text;
}
// share.js comes in once a panel has settled (a fetch of a few kilobytes, then cached), so a press on the share button
// finds it there. It gets one object, the api below, and hands back its hooks (S); until then every S?.x() is nothing,
// and a press loads it first. Its states are lazyModule's; a failed fetch (offline for a moment) is asked for again at
// the next press or the next open, at once.
const SHARE_API = 1;
let S = null;
const shareModule = lazyModule(() => {
  const url = typeof ASSETS.share === 'string' && /^\/share\.js\?v=[0-9a-f]+$/.test(ASSETS.share) ? ASSETS.share : null;
  return !url ? null : import(url).then((m) => {
    try {
      S = typeof m.install === 'function' ? m.install({ version: SHARE_API, P, dlg, REDUCED, EASE, scene: shareScene, say, busy: shareBusy }) || null : null;
    } catch (e) {
      S = null;
      setTimeout(() => { throw e; });
    }
    return S;
  });
}, 0);
const loadShare = () => shareModule.get();
// The panel's view changed (it opened, a chart landed, a size, a view, a price or the theme changed): a phone draws its
// card again ahead of a press, once the panel is still and the browser next idle; a desktop only drops a copy offer for
// the old picture. Not while the chart moves (a morph or a wave): its end (afterAnim) asks again.
function shareSoon() {
  if (panel.is('open') && motion.is('still')) S?.soon();
}

// ---- deep links: an open card is #btc in the address; Back closes it; a link with it opens that card ----
function hashSym() {
  const h = location.hash.slice(1);
  if (!/^[a-z0-9]{1,12}$/i.test(h)) return null;
  const s = h.toUpperCase();
  return nodes.has(s) ? s : null;
}
function openFromHash() {
  if (cd.hashDone || !PANEL || !nodes.size) return;
  cd.hashDone = true;
  const s = hashSym();
  if (!s) return;
  // A chart opened from the address is an interaction: the glass comes in at once. The panel is solid in both themes,
  // so it never waits for the glass.
  loadGlass();
  // The panel's coin is decoded before the panel fades in (a quarter of a second at most, the time one round trip for
  // its art takes on a phone), so a cold deep link never shows the panel without its coin, then the coin popping in.
  const item = nodes.get(s)?.item;
  if (item) coinShow(P.icon, P.tilt, P.glint, coinUrl(item));
  const quarter = () => new Promise((r) => setTimeout(r, 250));
  Promise.race([P.icon.decode().catch(() => {}), quarter()]).then(() => { if (panel.is('closed') && hashSym() === s) openPanel(s, 'hash'); });
}

// ---- wiring ----
// A card's hover lift (and the panel's, as it lands in a lifted card) is 3px rounded to whole device pixels: a moving
// layer keeps the pixels it was first drawn with, so a lift of 4.5 device pixels (3px at 1.5x) would leave every
// landed word half a pixel off its row, soft, until the card takes over. Kept up to date as the scale changes (a
// zoom, another screen: a change of resolution, or the resize a zoom brings). The query is kept: one nothing holds on
// to can be collected, and its listener with it.
let liftScale = null;
function liftOnPixels() {
  const dpr = devicePixelRatio;
  if (liftScale?.dpr === dpr) return;
  // An open chart's candles snap to the new pixels too.
  if (liftScale && !panel.is('closed')) chartRedraw(P.chart.clientWidth, P.chart.clientHeight);
  document.documentElement.style.setProperty('--lift', `${-onPixel(3)}px`);
  const q = matchMedia(`(resolution: ${dpr}dppx)`);
  q.addEventListener('change', liftOnPixels, { once: true });
  liftScale = { dpr, q };
}

if (PANEL) {
  for (const box of cardBoxes) box.classList.add('js-cards');
  liftOnPixels();
  addEventListener('resize', liftOnPixels, { passive: true });
  chartBuild();
  // Esc is a key a mouse user presses too (to close the panel): it leaves the last way of pointing as it was, so a
  // panel opened by a click and closed by Esc gives its card quiet focus, and one opened from the keyboard its ring.
  addEventListener('keydown', (e) => { if (e.key !== 'Escape') keyed = true; }, true);
  addEventListener('pointerdown', () => { keyed = false; }, true);

  // The whole card opens its chart; selecting text on it with the mouse (to copy a price) does not. Enter and Space on
  // its button (a click with no detail) always open it, whatever is selected elsewhere.
  const onCards = (type, fn) => { for (const box of cardBoxes) box.addEventListener(type, fn); };
  onCards('click', (e) => {
    const li = e.target.closest?.('.card');
    if (!li || !e.currentTarget.contains(li)) return;
    if (e.detail > 0) {
      const sel = getSelection?.();
      if (sel && !sel.isCollapsed && String(sel).trim() && (li.contains(sel.anchorNode) || li.contains(sel.focusNode))) return;
    }
    openPanel(li.getAttribute('data-sym'), 'click', e.detail === 0);
  });

  // Press feedback as a class (iOS only applies :active with a touch listener, and a scroll must cancel it): at once
  // for a mouse, after 50 ms for a finger, so a scroll that starts on a card does not flash it. The press's states:
  //   idle     no card is pressed;
  //   armed    a finger is down on a card (press.li) and the card does not show it yet: it will 50 ms on (the state's
  //            own timer), unless the press ends first;
  //   pressed  the card shows the press (.pressed).
  // A release or a cancel anywhere, a new press, or the pointer leaving the card ends it (idle). The class and the
  // timer are set and let go of on the moves.
  const press = machine('idle', { idle: ['armed', 'pressed'], armed: ['pressed', 'idle'], pressed: ['idle'] });
  press.li = null;
  let armTimer = 0;
  press.on((to) => {
    clearTimeout(armTimer);
    if (to === 'armed') armTimer = setTimeout(() => press.go('pressed'), 50);
    press.li.classList.toggle('pressed', to === 'pressed');
    if (to === 'idle') press.li = null;
  });
  const unpress = () => { press.go('idle'); };
  onCards('pointerdown', (e) => {
    const li = e.target.closest?.('.card');
    if (!li || e.button !== 0 || REDUCED.matches) return;
    unpress();
    press.li = li;
    press.go(e.pointerType === 'mouse' ? 'pressed' : 'armed');
    // A finger has no hover: the chart is asked for as it touches down, a tenth of a second before the tap opens it.
    const s = li.getAttribute('data-sym');
    if (e.pointerType !== 'mouse' && nodes.has(s)) prefetchHist(s);
    guard.sample();
  });
  for (const t of ['pointerup', 'pointercancel']) addEventListener(t, unpress, true);

  // Hover: the coin turns toward the pointer and a glint crosses it once; the chart for the remembered candle size is
  // fetched after 80 ms, so the panel usually opens with its data already here (and the hourly candles the stats row's
  // high and low come from, when another size is remembered).
  let prefetchTimer = 0;
  const prefetch = (li) => {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => { const s = li.getAttribute('data-sym'); if (nodes.has(s)) prefetchHist(s); }, 80);
  };
  // The mouse over the cards. Its states:
  //   off   over no card;
  //   over  over a card (hover.li; hover.rect is that card's box as the pointer came onto it).
  // Coming onto a card asks for its chart, measures the display's beat (once) and plays the coin's glint; leaving it
  // brings the coin back to rest, ends a press on it and drops the chart's request if it has not gone out.
  const hover = machine('off', { off: ['over'], over: ['off'] });
  hover.li = null;
  hover.rect = null;
  hover.on((to) => {
    const li = hover.li;
    const n = nodes.get(li.getAttribute('data-sym'));
    if (to === 'over') {
      hover.rect = li.getBoundingClientRect();
      prefetch(li);
      guard.sample();
      if (n && FINE.matches && !REDUCED.matches && panel.is('closed')) glintPlay(n.refs.band, 820);
      return;
    }
    if (n) unaim(n.refs.coin);
    if (press.li === li) unpress();
    hover.li = null;
    clearTimeout(prefetchTimer);
  });
  onCards('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const li = e.target.closest?.('.card');
    if (li === hover.li) return;
    hover.go('off');
    if (!li || !li.hasAttribute('data-sym')) return;
    hover.li = li;
    hover.go('over');
  });
  onCards('pointerout', (e) => {
    if (hover.is('over') && !hover.li.contains(e.relatedTarget)) hover.go('off');
  });
  onCards('pointermove', (e) => {
    if (!hover.is('over') || e.pointerType !== 'mouse' || !FINE.matches || REDUCED.matches || !panel.is('closed')) return;
    const n = nodes.get(hover.li.getAttribute('data-sym'));
    if (!n) return;
    const r = hover.rect;
    const nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
    const ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
    aim(n.refs.coin, -ny * 12, nx * 12, 180, 0.28);
    // The card's own light (dark only, the stylesheet's --hover-light) lies where the pointer is.
    hover.li.style.setProperty('--c-mx', `${Math.round(e.clientX - r.left)}px`);
    hover.li.style.setProperty('--c-my', `${Math.round(e.clientY - r.top)}px`);
  });
  onCards('focusin', (e) => {
    const li = e.target.closest?.('.card');
    if (!li) return;
    prefetch(li);
    guard.sample();
  });

  // Closing: the cross, a click on the glass, Esc and Android's back gesture (both arrive as cancel).
  P.x.addEventListener('click', () => closePanel());
  // Sharing: the card is drawn ahead on a phone (share.js), so its share sheet opens inside the tap, as iOS asks; on a
  // desktop it is drawn as the pointer or the focus comes to the button, then saved by the press.
  // Not the second click of a double-click: one press, one picture. Not the focus the dialog itself gives the button as
  // it opens (the dialog takes it straight back): only a pointer or a focus once the panel is open.
  P.share?.addEventListener('click', (e) => {
    if (e.detail > 1) return;
    if (S) S.tap();
    else loadShare().then((s) => s?.tap());
  });
  for (const t of ['pointerenter', 'focus']) P.share?.addEventListener(t, () => { if (panel.is('open')) S?.warm(); });
  P.copy?.addEventListener('click', () => S?.copy());
  // Not the second click of a double-click on a card: it lands on the glass the first one just opened.
  P.veil.addEventListener('click', (e) => { if (e.detail <= 1) closePanel(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closePanel(); });
  // Something else closed the dialog (an unpreventable close request): play the close anyway. The event comes a task
  // late, so a dialog already open again (another card, opened from the address bar) is left alone.
  dlg.addEventListener('close', () => {
    if (!dlg.open && panel.is('opening', 'open')) closePanel();
  });
  // A belt-and-braces scroll block for iOS 15 (the dialog makes the page inert everywhere else).
  P.veil.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  P.segS.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSize(b.getAttribute('data-i')); });
  P.segT.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setType(b.getAttribute('data-t')); });

  // The coin follows the pointer while the panel is open (desktop): a few degrees, eased. Any move on the panel keeps
  // its stars twinkling a while.
  dlg.addEventListener('pointermove', (e) => {
    if (!panel.is('open')) return;
    starsAwake();
    if (REDUCED.matches || e.pointerType !== 'mouse' || !FINE.matches) return;
    if (!coinCentre) measureCoin();
    const nx = clamp((e.clientX - coinCentre.x) / 480, -1, 1);
    const ny = clamp((e.clientY - coinCentre.y) / 360, -1, 1);
    aim(P.tilt, -ny * 9, nx * 9, 420, 0.45);
  }, { passive: true });
  dlg.addEventListener('pointerdown', () => {
    if (!panel.is('open')) return;
    starsAwake();
  }, { passive: true });
  dlg.addEventListener('pointerleave', () => { unaim(P.tilt); });
  dlg.addEventListener('keydown', starsAwake);
  // The panel's body scrolled (a short window): the coin is somewhere else now.
  P.body.addEventListener('scroll', () => { coinCentre = null; }, { passive: true });

  // Scrub: hover on a desktop. On touch the finger first says what it means: a sideways move starts the scrub, and so
  // does a finger that rests (90 ms), so a touch and hold reads its candle at once to the eye; a mostly vertical move in
  // the first 10px is the sheet's drag (or its scroll) instead, and the header never shows a candle on the way.
  const chartX = (e) => {
    if (!ch.scrub.rect) ch.scrub.rect = P.chart.getBoundingClientRect();
    return e.clientX - ch.scrub.rect.left;
  };
  const HOLD_MS = 90;
  P.chart.addEventListener('pointerenter', () => { ch.scrub.rect = P.chart.getBoundingClientRect(); });
  P.chart.addEventListener('pointermove', (e) => {
    if (!ch.geo || !panel.is('open')) return;
    const sc = ch.scrub;
    if (e.pointerType === 'mouse') { scrubTo(scrubIndex(chartX(e)), false); return; }
    if (finger.is('none') || sc.touch.id !== e.pointerId) return;
    const touch = sc.touch;
    touch.cx = e.clientX;
    if (touch.axis === null) {
      const dx = e.clientX - touch.x;
      const dy = e.clientY - touch.y;
      const vertical = Math.abs(dy) > 1.2 * Math.abs(dx);
      if (Math.hypot(dx, dy) >= 10) touch.axis = vertical ? 'y' : 'x';
      else if (vertical && Math.abs(dy) > 4) touch.axis = 'y';
      // Mostly vertical in the first 10px: the scrub (if the finger rested first) lets go and the sheet's drag takes
      // over (the panel's own move handler follows the finger from here, the events bubbling up to it). A sheet taller
      // than the screen scrolls instead (style.css lets the browser pan it from the chart).
      if (touch.axis === 'y') {
        finger.go('none');
        scrubEnd();
        if (PHONE.matches && panel.is('open') && sheetFit.is('fits')) dragBegin(e, touch.y, touch.t);
        return;
      }
    }
    // Undecided and not yet rested: nothing shows.
    if (finger.is('undecided') && touch.axis === null) return;
    const i = scrubIndex(chartX(e));
    // Sideways: the scrub starts here, under the finger.
    if (finger.go('scrubbing')) { scrubTo(i, true); return; }
    scrubTo(i, false);
  });
  P.chart.addEventListener('pointerdown', (e) => {
    if (!ch.geo || !panel.is('open') || e.pointerType === 'mouse') return;
    ch.scrub.rect = P.chart.getBoundingClientRect();
    try { P.chart.setPointerCapture(e.pointerId); } catch {
      // Capture is a nicety here.
    }
    // A new finger is a new decision: whatever the last one was doing is over (its crosshair stays until a move or a
    // lift says otherwise).
    finger.go('none');
    ch.scrub.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null, cx: e.clientX, hold: 0 };
    finger.go('undecided');
    const touch = ch.scrub.touch;
    const run = finger.epoch;
    touch.hold = setTimeout(() => {
      if (finger.epoch !== run || !ch.geo || !panel.is('open')) return;
      finger.go('scrubbing');
      scrubTo(scrubIndex(touch.cx - (ch.scrub.rect ?? P.chart.getBoundingClientRect()).left), true);
    }, HOLD_MS);
  });
  const touchEnd = (e) => {
    if (finger.is('none') || ch.scrub.touch.id !== e.pointerId) return;
    finger.go('none');
    scrubEnd();
  };
  P.chart.addEventListener('pointerup', touchEnd);
  P.chart.addEventListener('pointercancel', touchEnd);
  P.chart.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { scrubEnd(); ch.scrub.rect = null; } });
  // The keyboard: the chart is a slider (arrows step a candle, Shift ten, Home and End jump), read out by screen readers.
  P.chart.addEventListener('keydown', (e) => {
    if (!ch.geo || !panel.is('open')) return;
    const last = ch.geo.n - 1;
    const i = xhair.is('on') ? ch.scrub.idx : last;
    const stepBy = e.shiftKey ? 10 : 1;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = i - stepBy;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = i + stepBy;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    scrubTo(clamp(next, 0, last), false);
  });
  P.chart.addEventListener('blur', () => scrubEnd());

  // The sheet's drag: from the grabber and the header always; from anywhere else outside the chart and the controls when
  // the content fits (or is scrolled to the top).
  P.panel.addEventListener('pointerdown', (e) => {
    if (!PHONE.matches || !panel.is('open') || e.button !== 0) return;
    if (e.target.closest('.cd-chart, .cd-ctrl')) return;
    const top = e.target.closest('.cd-grab, .cd-coin, .cd-main, .cd-tr');
    if (!top && P.body.scrollTop > 0) return;
    dragBegin(e, e.clientY);
  });
  P.panel.addEventListener('pointermove', dragMove);
  // The press ends wherever it is let go: the window hears every release and cancel (an armed press has no capture yet,
  // and a mouse may let go off the sheet), before anything under it does.
  addEventListener('pointerup', (e) => dragEnd(e, false), true);
  addEventListener('pointercancel', (e) => dragEnd(e, true), true);
  // A drag must not also click what it started on.
  P.panel.addEventListener('click', (e) => { if (drag.justDragged) { e.stopPropagation(); e.preventDefault(); drag.justDragged = false; } }, true);

  // The chart follows its box: redrawn at rest on any resize (and the controls' pill re-placed), with as many candles as
  // the new width holds (the source line's "since" comes and goes with the first one).
  // Layout sizes, not the on-screen rect: an entrance in progress (a scale) must not shrink the drawing.
  new ResizeObserver(() => {
    if (panel.is('closed')) return;
    if (dlg.scrollTop) dlg.scrollTop = 0;
    const w = P.chart.clientWidth;
    const h = P.chart.clientHeight;
    const segs = segRead();
    segPlace(segs, false);
    if (w === ch.w && h === ch.h && ch.px === (devicePixelRatio || 1)) return;
    chartRedraw(w, h);
    if (panel.is('open')) { snapPanel(); measureCoin(); sheetFits(); fitMove(); }
  }).observe(P.chart);
  // A window that only grows taller or shorter moves the panel without resizing its chart.
  addEventListener('resize', () => { if (panel.is('open')) snapPanel(); }, { passive: true });

  // Back, Forward or an edited address: the panel follows the hash (another symbol closes this one and opens that).
  addEventListener('popstate', () => {
    // The step back a close asked for has landed: the panel's entry is gone. A card clicked meanwhile gets its own entry
    // now, so the address follows the panel on show.
    if (addr.is('leaving')) { addr.go('bare'); return; }
    if (addr.is('waiting')) { addr.go('pushed'); return; }
    const s = hashSym();
    if (panel.is('opening', 'open') && s === cd.sym) return;
    if (panel.is('opening', 'open')) closePanel({ fromPop: true });
    if (s) openPanel(s, 'pop');
  });
  // A window that crosses the phone breakpoint while open changes the panel's layout, so it leaves the way the new
  // layout does: a sheet slides down (a morph into the card would shrink the sheet's layout into it). What that means
  // for the card under it is the move's (mode.on).
  PHONE.addEventListener?.('change', () => {
    if (!panel.is('opening', 'open')) return;
    mode.go(PHONE.matches ? 'sheet' : 'fade');
  });
  for (const mq of [REDUCED, PHONE]) mq.addEventListener?.('change', () => { if (panel.is('open')) { stars(true); paintAll(); } });
}

// ---- the theme ----
// Dark unless the visitor chose light. theme-boot.js has already set html[data-theme] and the browser's bar colour
// before the first paint; from here the switch left of the X link changes it, remembers it on this device (a
// convenience: blocked storage keeps it for the visit) and every other open tab follows.
const THEME_KEY = 'printerino-theme';
// The ground each theme paints, for the browser's own bars (meta theme-color).
const THEME_BAR = { light: '#f1f2f6', dark: '#0a0b0f' };
const rootEl = document.documentElement;
const themeSwitch = document.querySelector('.top .theme-switch');
// The side of the theme switch a point is on: 'light' (the sun's half), 'dark' (the moon's), or '' at its very
// middle and anywhere off it.
function themeSide(x, y) {
  const r = themeSwitch?.getBoundingClientRect();
  if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return '';
  const mid = r.left + r.width / 2;
  return x < mid ? 'light' : x > mid ? 'dark' : '';
}
// The side a mouse rests over, so that side's glyph lights as a hovered button's does (the stylesheet, by data-aim)
// and the tip names it:
//   off    no mouse on the switch;
//   light  over the sun's half;
//   dark   over the moon's half.
const themeAim = machine('off', { off: ['light', 'dark'], light: ['off', 'dark'], dark: ['off', 'light'] });
// The switch's tip: the side under the mouse by name, as the switches beside it name theirs; from the keyboard,
// which turns it whole, what a key will do.
function themeTip() {
  const to = themeAim.state;
  themeSwitch?.setAttribute('data-tip', to === 'light' ? 'Light' : to === 'dark' ? 'Dark' : rootEl.dataset.theme === 'dark' ? 'Switch to light' : 'Switch to dark');
}
themeAim.on((to) => {
  if (!themeSwitch) return;
  if (to === 'off') delete themeSwitch.dataset.aim;
  else themeSwitch.dataset.aim = to;
  themeTip();
});
function storedTheme() {
  const v = recall(THEME_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}
// The chosen theme. The page draws it at once (the ground follows), except while a panel flies open (themeSettle).
let theme = storedTheme() ?? ground.state;
// On paper the top bar draws both lockups on top of each other (the white one shows inside the logo's glass island):
// only the ink one is named there, so the name is read once.
function logoNamed() {
  const white = document.querySelector('.top .lockup-white');
  if (!white) return;
  if (ground.is('dark')) white.removeAttribute('aria-hidden');
  else white.setAttribute('aria-hidden', 'true');
}
// What follows from the ground, written on its every move and once as the page starts: the stylesheet's tokens follow
// html[data-theme], the browser's bars follow the meta, the logo is named once, and every coin on the page (each
// card's, and an open panel's) takes that ground's picture of it.
function groundShow(to) {
  rootEl.dataset.theme = to;
  themeTip();
  logoNamed();
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = THEME_BAR[to];
  for (const n of nodes.values()) coinShow(n.refs.icon, n.refs.coin, n.refs.glint, coinUrl(n.item));
  if (PANEL && cd.item && !panel.is('closed')) coinShow(P.icon, P.tilt, P.glint, coinUrl(cd.item));
}
ground.on(groundShow);
groundShow(ground.state);
// Draws a theme: the ground moves to it (a theme it is already on changes nothing).
function applyTheme(next) {
  ground.go(next);
  // A panel open across the change (another tab's): a painted veil is painted again on the new ground. The panel itself
  // is the same solid card in either theme, only its tokens change.
  if (PANEL && !panel.is('closed') && G?.veilPainted()) G.veilPaint();
  if (PANEL) shareSoon();
}
// The change lands in one frame: .swap turns every transition it sets off into a jump, and goes two frames after the
// last swap that asked for it. Counted, so two swaps a frame apart (app.js's and glass.js's: api.swap) never take each
// other's away early.
let swaps = 0;
function swapBegin() {
  swaps += 1;
  rootEl.classList.add('swap');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    swaps -= 1;
    if (!swaps) rootEl.classList.remove('swap');
  }));
}
function swapTheme(next) {
  swapBegin();
  applyTheme(next);
}
// The page against the chosen theme. Its states:
//   settled  the page draws the chosen theme (or glass.js's ink drop is on its way to it);
//   waiting  a theme was chosen while a panel flew open (only another tab can choose then: the open dialog makes the
//            switch inert). The page catches up once the panel has landed or closed (themeSettle), and glass.js hears
//            of it then as of any instant change, so the switch's pill moves to the side aria-checked already says
//            (left on the old side, the next toggle back would jump instead of slide).
const look = machine('settled', { settled: ['waiting'], waiting: ['settled'] });
look.on((to, from) => {
  if (to !== 'settled' || from !== 'waiting') return;
  if (!G?.themeChange(theme, applyTheme, true) && !ground.is(theme)) swapTheme(theme);
});
// The page catches up with the chosen theme at once. A panel flying open lands first; panel.on (open, closed) calls
// this again.
function themeSettle() {
  if (panel.is('opening') || look.go('settled')) return;
  if (!ground.is(theme)) swapTheme(theme);
}
// The switch (or a drag of its droplet), another tab (instant) or a page back from history (instant). The choice is
// the switch's at once and remembered at once; the page follows through glass.js's ink drop when it is in, else in one
// frame.
function setTheme(next, { instant = false } = {}) {
  if (next !== 'dark' && next !== 'light') return;
  // A close hands the page its clicks at once, so the switch is live while the panel flies home: that close ends now,
  // as for a card clicked mid-close, so nothing lands across the change.
  if (panel.is('closing')) finishClose(false);
  const was = theme;
  if (next !== theme) {
    theme = next;
    remember(THEME_KEY, next);
  }
  themeSwitch?.setAttribute('aria-checked', String(next === 'dark'));
  if (panel.is('opening')) { look.go('waiting'); return; }
  if (G?.themeChange(next, applyTheme, instant || next === was)) return;
  themeSettle();
}
themeSettle();
// The other ground's coin pictures are fetched as soon as a pointer reaches the theme switch (or a finger or a key
// lands on it), so that by the time the theme has changed each coin's picture is already in the browser's cache and
// swaps with the ground. Before that the other set is never asked for. Their states:
//   cold  not asked for;
//   warm  asked for once: the cache holds them, or soon will.
const otherArt = machine('cold', { cold: ['warm'], warm: [] });
otherArt.on(() => {
  for (const n of nodes.values()) {
    const url = coinUrl(n.item, !onPaper());
    if (ICON_URL.test(url)) new Image().src = url;
  }
});
if (themeSwitch) {
  for (const type of ['pointerenter', 'pointerdown', 'focus']) themeSwitch.addEventListener(type, () => otherArt.go('warm'), { passive: true });
  themeSwitch.setAttribute('aria-checked', String(theme === 'dark'));
  // The switch is one control drawn as two sides, the sun and the moon, beside switches that are two buttons: a
  // click chooses the side it lands on, as theirs does, so a click on the side already chosen changes nothing (the
  // pill's press answers it). A click with no place of its own still turns the switch: a key's (detail 0), and one
  // an assistive tool sends, which arrives at the control's middle or at no point of it.
  themeSwitch.addEventListener('click', (e) => {
    const side = e.detail > 0 ? themeSide(e.clientX, e.clientY) : '';
    if (side !== theme) setTheme(theme === 'dark' ? 'light' : 'dark');
  });
  for (const type of ['pointerenter', 'pointermove']) themeSwitch.addEventListener(type, (e) => { if (e.pointerType === 'mouse') themeAim.go(themeSide(e.clientX, e.clientY) || 'off'); }, { passive: true });
  themeSwitch.addEventListener('pointerleave', () => themeAim.go('off'), { passive: true });
  // From here aria-checked draws the switch, not the theme the boot script set.
  themeSwitch.classList.add('ready');
}
// Another tab changed it: follow at once.
addEventListener('storage', (e) => {
  if (e.key === THEME_KEY && (e.newValue === 'dark' || e.newValue === 'light')) setTheme(e.newValue, { instant: true });
});
// A page restored from the back-forward cache missed what other tabs changed while it was away.
addEventListener('pageshow', (e) => {
  const v = e.persisted ? storedTheme() : null;
  if (v) setTheme(v, { instant: true });
});

// ---- the glass in motion (glass.js) ----
// Everything the glass does when touched lives in a module of its own, loaded once the page has painted, so none of it
// is parsed on load: when the browser is next idle after the load (or
// 1.2 s after it, where there is no idle callback), or at the first pointer, finger or focus on the top bar, the cards
// or the notice once the entrance has played (a press on the top bar or on a card, and a chart opened from the address,
// load it at once: a press on a card is an open on its way, with its droplets). It gets one object, the api below, and
// hands back its hooks (G); until then, and wherever it never arrives, every G?.x() above is nothing and the page works
// without it.
const GLASS_API = 9;
function glassApi() {
  return {
    version: GLASS_API,
    root: rootEl, sw: themeSwitch, P, dlg,
    wake,
    springFn, clamp,
    REDUCED, FINE, ENGINE, ASSETS,
    // theme: the theme chosen; ground: the one the page draws now (the ground machine's state), which applyTheme moves.
    // lite: whether the open panel keeps the light veil (no live blur), decided as it opens.
    theme: () => theme, ground: () => ground.state, lite: () => cd.lite, applyTheme,
    setSize, setType, setTheme,
    dock: dockSeg, setShow, toTop,
    glassSeg: document.querySelector('.top .seg-glass'), setGlass: (choice) => setGlass(choice),
    viewSeg, setView: (choice) => setView(choice),
    // The list's switch in the top bar: the twin, where its machine stands, and the word that it has landed.
    viewTwin, viewAt: () => viewJoin.state, viewLanded,
    // html.swap for a theme change glass.js lands itself, counted with app.js's own (swapBegin).
    swap: swapBegin,
  };
}
// Its states are lazyModule's. A failed import (offline for a moment) is asked for again by the next trigger (a press,
// a pointer or a focus on the page's glass, a chart opened from the address), at most every 3 s: the early triggers
// stay on until it is in (one failure never loses the glass for the whole visit).
const glassModule = lazyModule(() => {
  const url = typeof ASSETS.glass === 'string' && /^\/glass\.js\?v=[0-9a-f]+$/.test(ASSETS.glass) ? ASSETS.glass : null;
  return !url ? null : import(url).then((m) => {
    try {
      G = typeof m.install === 'function' ? m.install(glassApi()) || null : null;
    } catch (e) {
      G = null;
      setTimeout(() => { throw e; });
    }
    // In while a panel is open (a chart opened from the address as the page loads): a veil that wants painting is
    // painted now.
    if (G && PANEL && panel.is('opening', 'open') && !G.veilPainted() && veilWantsPaint()) G.veilPaint();
    return G;
  });
}, 3000);
glassModule.on((to) => {
  if (to !== 'ready') return;
  for (const t of GLASS_SOON) document.removeEventListener(t, glassSoon, true);
  // The list's switch may have waited for it (viewJoin: due).
  viewAgain();
});
const loadGlass = () => glassModule.get();
const GLASS_SOON = ['pointerover', 'pointerdown', 'focusin', 'touchstart'];
function glassSoon(e) {
  const t = e.target;
  if (!t?.closest || !glassModule.is('idle', 'failed')) return;
  if (!t.closest('.top, .stage, .listbar, .grid, #nfa-more, .dock')) return;
  if (!entrance.is('done') && !(e.type === 'pointerdown' && t.closest('.top, .card, .listbar'))) return;
  loadGlass();
}
for (const t of GLASS_SOON) document.addEventListener(t, glassSoon, { capture: true, passive: true });
function glassIdle() {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => loadGlass(), { timeout: 3000 });
  else setTimeout(loadGlass, 1200);
}
if (document.readyState === 'complete') glassIdle();
else addEventListener('load', glassIdle, { once: true });

// ---- the floating top bar ----
// The stylesheet slims the bar and brings in its strip from the page's own scroll (a scroll timeline). A browser
// without scroll timelines gets html.scrolled from 4px down instead, and the stylesheet's transitions do the rest: a
// class that flips only when that line is crossed, no work per frame. Checked at once (a page reloaded part way down)
// and when a page comes back from history.
function barScroll() {
  rootEl.classList.toggle('scrolled', scrollY > 4);
}
if (!(typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: scroll()'))) {
  addEventListener('scroll', barScroll, { passive: true });
  addEventListener('pageshow', barScroll);
  barScroll();
}

// The notice's fine print folds behind a toggle. The page ships the toggle hidden and the blocks open, so with
// JavaScript off, or if this never runs, everything shows. The stylesheet folds the blocks only on a screen,
// and only while the toggle is drawn and says aria-expanded="false" (every screen; print shows them all).
// The toggle shows only once the stylesheet has laid the blocks out (a grid), so a page whose CSS failed to load keeps
// its plain open notice rather than gaining a button that does nothing. The click handler goes on before the toggle
// shows, so the blocks can never fold without a working way to open them.
const moreEl = document.getElementById('nfa-more');
const fineEl = document.getElementById('nfa-fine');
if (moreEl && fineEl && getComputedStyle(fineEl).display === 'grid') {
  // 7: the blocks unfold and fold (their height, their fade and the gap above them), never just appear. Their states:
  //   closed   folded away (the stylesheet hides them: aria-expanded="false", not .folding);
  //   opening  unfolding (.folding clips them to the animated height);
  //   open     unfolded, at rest;
  //   closing  folding (.folding, and still drawn: the stylesheet hides them only once it is over).
  // aria-expanded says where they are going (true from the moment they start to open, false from the moment they start
  // to close). A click mid-move turns them round from where they are, over what is left of the move's time; only the
  // move under way may end it (a cancelled one never takes .folding off the next, which would let the blocks spill
  // out).
  const fold = machine('closed', { closed: ['opening'], opening: ['open', 'closing'], open: ['closing'], closing: ['closed', 'opening'] });
  const foldShow = (to) => {
    moreEl.setAttribute('aria-expanded', String(to === 'opening' || to === 'open'));
    fineEl.classList.toggle('folding', to === 'opening' || to === 'closing');
  };
  fold.on(foldShow);
  let folding = null;
  moreEl.addEventListener('click', () => {
    const opening = fold.is('closed', 'closing');
    // Where the blocks are drawn now (mid-move: the animated height, gap and fade), read before the move is cut.
    const moving = fold.is('opening', 'closing') && folding;
    const cs = moving ? getComputedStyle(fineEl) : null;
    const now = cs && { height: parseFloat(cs.height) || 0, marginTop: cs.marginTop, opacity: Number(cs.opacity) };
    folding?.cancel();
    folding = null;
    fold.go(opening ? 'opening' : 'closing');
    if (REDUCED.matches) { fold.go(opening ? 'open' : 'closed'); return; }
    // The blocks at rest (drawn: opening or closing, they are), and where they start from.
    const h = fineEl.offsetHeight;
    const gap = getComputedStyle(fineEl).marginTop;
    const shut = { height: '0px', marginTop: '0px', opacity: 0 };
    const full = { height: `${h}px`, marginTop: gap, opacity: 1 };
    const from = now ? { height: `${now.height}px`, marginTop: now.marginTop, opacity: now.opacity } : opening ? shut : full;
    // The share of the way still to go, of the move's whole time (380 ms to open, 280 to close).
    const left = now && h > 0 ? clamp(opening ? 1 - now.height / h : now.height / h, 0, 1) : 1;
    const a = fineEl.animate([from, opening ? full : shut], { duration: Math.round((opening ? 380 : 280) * left), easing: EASE });
    folding = a;
    const run = fold.epoch;
    a.finished.then(() => {
      if (fold.epoch !== run) return;
      folding = null;
      fold.go(opening ? 'open' : 'closed');
    }, () => {});
  });
  foldShow(fold.state);
  moreEl.hidden = false;
}

// The hero's Price Watchlist capsule glides down so the picks row and the cards start just under the top bar. The
// address keeps no #grid (it would read as a coin's deep link).
const toList = document.querySelector('[data-scroll="watchlist"]');
toList?.addEventListener('click', (e) => {
  const bar = document.querySelector('.bar');
  if (!bar) return;
  e.preventDefault();
  const topBar = document.querySelector('.top')?.offsetHeight || 56;
  const y = bar.getBoundingClientRect().top + scrollY - topBar - 6;
  // A focus the capsule holds would be left behind above the window: it goes on to the first card drawn, where the
  // page is going, its ring as the capsule's was (none after a pointer's press).
  const first = document.activeElement === toList && cardBoxes.map((box) => box.querySelector('.card:not(.out) .card-open')).find(Boolean);
  const ring = ringed(toList);
  scrollTo({ top: Math.max(0, y), behavior: REDUCED.matches ? 'auto' : 'smooth' });
  if (first) focusTo(first, ring);
});

// 5: the hero's strip rests while the hero is out of sight.
if (tapeEl && typeof IntersectionObserver === 'function') {
  new IntersectionObserver(([e]) => tapeEl.classList.toggle('paused', !e.isIntersecting)).observe(tapeEl.parentElement);
}

const startedAt = Date.now();
try { data = JSON.parse(document.getElementById('initial').textContent); } catch { data = null; }
render();
// Always load: the embedded data may come from a cached page (back button, restored tab).
load();
// Hidden tabs skip polling and catch up on visibilitychange (the status line's clock stops and starts with them).
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
  statusClock();
});

// ---- the glass: frosted or clear ----
// The visitor's choice of what the glass does to what is behind it (one switch flips every body of glass at once; the
// stylesheet's .glass block is the one place that reads it). Frosted
// is the default; clear is html.glass-clear, which theme-boot.js has already set before the first paint. The switch is
// the two-segment picker left of the theme switch; the choice is remembered on this device like the theme, and every
// other open tab follows.
const GLASS_KEY = 'printerino-glass';
const glassSeg = document.querySelector('.top .seg-glass');
function glassPlace(animate, byUser = false) {
  const b = glassSeg?.querySelector(`button[data-g="${glassLook.state}"]`);
  if (b) segPlace([[glassSeg, b.offsetLeft, b.offsetWidth, glassLook.state]], animate, byUser);
}
// The glass. Its states:
//   frosted  the default: every body of glass blurs what is behind it;
//   clear    html.glass-clear: the glass only bends what is behind it.
// What follows from it (the class, the pressed segment) is applied on the move; the pill is placed by every press, as a
// press on the segment already chosen still answers.
const glassLook = machine(recall(GLASS_KEY) === 'clear' ? 'clear' : 'frosted', { frosted: ['clear'], clear: ['frosted'] });
function glassShow(to) {
  rootEl.classList.toggle('glass-clear', to === 'clear');
  if (glassSeg) segSet(glassSeg, 'data-g', to);
}
glassLook.on(glassShow);
function setGlass(choice, { byUser = true, keep = true } = {}) {
  const next = choice === 'clear' ? 'clear' : 'frosted';
  // A click on the side already chosen chooses nothing (see setView).
  if (byUser && !glassLook.can(next)) return;
  glassLook.go(next);
  if (keep) remember(GLASS_KEY, next);
  glassPlace(byUser && !REDUCED.matches, byUser);
}
// The page starts on the stored choice (theme-boot.js drew it before the first paint), the pill under it, placed without
// motion.
glassShow(glassLook.state);
glassPlace(false, false);
glassSeg?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setGlass(b.getAttribute('data-g')); });
addEventListener('storage', (e) => {
  if (e.key === GLASS_KEY && (e.newValue === 'clear' || e.newValue === 'frosted')) setGlass(e.newValue, { byUser: false, keep: false });
});
// A page restored from the back-forward cache missed what other tabs chose while it was away: the glass too, as the
// theme (both are kept, so both are read again).
addEventListener('pageshow', (e) => {
  const v = e.persisted ? recall(GLASS_KEY) : null;
  if (v === 'clear' || v === 'frosted') setGlass(v, { byUser: false, keep: false });
});

// ---- the tip: the name of a control drawn as a glyph alone ----
// A control that carries data-tip says its name in a small capsule of glass beside it (.tip) while a mouse rests on it
// or the keyboard's focus is on it; never for touch, which has no resting. Its states:
//   off  not shown;
//   due  a mouse is resting on a control: shown TIP_WAIT ms later;
//   on   shown.
// A tip that went away under TIP_WARM ms ago makes the next one come at once (moving along a row of controls), as does
// the keyboard. A press, a scroll, a resize, Escape and the pointer or the focus leaving put it away. The machine's
// data: the control it is for, the control the mouse is in (kept through a press, so the tip a press put away does not
// come back until the mouse has left and returned), the control a press landed on (no tip for it until the mouse has
// really moved off it: a theme change sends pointer events of its own to a mouse that has not moved), when Tab last
// moved the focus (a focus a script hands on shows no tip) and its two timers.
const tipEl = document.getElementById('tip');
const TIP_WAIT = 400, TIP_WARM = 300, TIP_GAP = 8, TIP_OUT = 180;
const tip = machine('off', { off: ['due', 'on'], due: ['on', 'off'], on: ['off'] });
Object.assign(tip, { for: null, over: null, quiet: null, tabAt: -Infinity, timer: 0, gone: 0, wentAt: -Infinity });
// A control's words: its own, and none for the X link while its word is drawn (then it needs no naming).
function tipText(a) {
  if (a.matches('.xlink') && a.querySelector('span')?.getClientRects().length) return '';
  return a.getAttribute('data-tip') || '';
}
// Under a control of the top bar or one of the chart's pickers (the chart's figures stand right over those, and the
// room under them is empty), and under any control with no room over it clear of the top bar; over any other: TIP_GAP from the
// capsule the control is drawn in (a segment's is its whole switch), centred on the control itself, whole pixels,
// TIP_GAP inside the window's sides.
function tipPlace() {
  const r = tip.for.getBoundingClientRect(), box = (tip.for.closest('.seg') || tip.for).getBoundingClientRect();
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const bar = tip.for.closest('dialog') ? 0 : document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0;
  const under = Boolean(tip.for.closest('.top, .cd-ctrl')) || box.top - TIP_GAP - h < Math.max(bar, 0) + TIP_GAP;
  const x = Math.max(TIP_GAP, Math.min(rootEl.clientWidth - w - TIP_GAP, r.left + r.width / 2 - w / 2));
  tipEl.setAttribute('data-side', under ? 'under' : 'over');
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(under ? box.bottom + TIP_GAP : box.top - TIP_GAP - h)}px)`;
}
tip.on((to) => {
  clearTimeout(tip.timer);
  clearTimeout(tip.gone);
  if (to === 'due') tip.timer = setTimeout(() => tip.go('on'), TIP_WAIT);
  else if (to === 'on') {
    tipEl.textContent = tipText(tip.for);
    tipEl.hidden = false;
    // The top layer, over a dialog that is open; a browser without popovers shows it in the page (under the dialog).
    try { if (!tipEl.matches(':popover-open')) tipEl.showPopover(); } catch { /* no popovers here */ }
    tipPlace();   // reads its box, so the frame it comes in from is drawn first
    tipEl.classList.add('on');
  } else {
    if (tipEl.classList.contains('on')) tip.wentAt = performance.now();
    tipEl.classList.remove('on');
    tip.gone = setTimeout(() => {
      try { tipEl.hidePopover(); } catch { /* no popovers here, or already out */ }
      tipEl.hidden = true;
    }, TIP_OUT);
  }
});
// The tip is for this control from now (none: put away). atOnce: no wait (the keyboard).
function tipAim(a, atOnce = false) {
  const next = a && tipText(a) ? a : null;
  if (next === tip.for && !tip.is('off')) return;
  tip.go('off');
  tip.for = next;
  if (next) tip.go(atOnce || performance.now() - tip.wentAt < TIP_WARM ? 'on' : 'due');
}
if (tipEl) {
  const tipOf = (t) => (t instanceof Element ? t.closest('[data-tip]') : null);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const a = tipOf(e.target);
    if (a === tip.over) return;
    tip.over = a;
    // None while a button is down (a drag along a switch) and none for the control a press landed on.
    tipAim(e.buttons || a === tip.quiet ? null : a);
  });
  // The pressed control is free again once the mouse has really moved off it.
  document.addEventListener('pointermove', (e) => {
    if (!tip.quiet || e.pointerType !== 'mouse') return;
    const r = tip.quiet.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) tip.quiet = null;
  }, { passive: true });
  rootEl.addEventListener('pointerleave', () => { tip.over = null; tip.quiet = null; tipAim(null); });
  document.addEventListener('pointerdown', (e) => { tip.quiet = tipOf(e.target); tipAim(null); }, true);
  // The keyboard's tip is for a control Tab has just reached, not for one a script handed the focus to.
  document.addEventListener('focusin', (e) => { const a = tipOf(e.target); if (a && performance.now() - tip.tabAt < 250 && ringed(a)) tipAim(a, true); });
  document.addEventListener('focusout', (e) => { if (tipOf(e.target) === tip.for) tipAim(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tip.tabAt = performance.now(); else if (e.key === 'Escape') tipAim(null); }, true);
  // A control whose words change while its tip is up (the theme switch, toggled by a key) says the new ones; the top
  // bar regrouping (the list's switch coming in or leaving) moves its controls, so a tip there is put away.
  for (const m of [ground, themeAim]) m.on(() => { if (tip.is('on') && tip.for === themeSwitch) { tipEl.textContent = tipText(tip.for); tipPlace(); } });
  viewJoin.on(() => { if (tip.for?.closest('.top')) tipAim(null); });
  // A scroll puts a mouse's tip away (the control has moved from under the pointer); the keyboard's follows its control.
  addEventListener('scroll', () => { if (tip.is('on') && tip.for === document.activeElement && ringed(tip.for)) tipPlace(); else tipAim(null); }, { capture: true, passive: true });
  addEventListener('resize', () => tipAim(null));
}
