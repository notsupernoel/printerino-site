// Renders the price grid from /api/prices and refreshes it, and opens a chart panel for any card. The first render uses
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
const grid = document.getElementById('grid');
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
// Beside it on wide screens, row for row: the stock trio, MU and SPCX.
const TAPE_STOCKS = ['COIN', 'HOOD', 'CRCL', 'MU', 'SPCX'];
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
  const fixed = n.toFixed(Math.max(2, -Math.floor(Math.log10(n)) + 2));
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
// A module fetched when first wanted (glass.js, share.js, the coins' lens maps). Its states:
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
const FORCED = matchMedia('(forced-colors: active)');
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
// The coins' tilt and the light on their glass below, and glass.js's controls, droplets and theme change: each is a job,
// called once a frame with the frame's step (in seconds) and its time, that returns false once it is still. The loop
// runs only while a job does, so a page at rest draws nothing.
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

// ---- the coins sealed in glass: the light on each dome, and the glint that crosses it ----
// Every coin's dome (style.css, index.html's svg.fx-defs) reflects one light. At rest it hangs up and to the left, on
// the art's own baked highlight crescent (the art is lit from there), and every coin shares one static reflection
// (#coin-spec). The coin under the pointer or a finger (one of two lights, so one can ease home while the next comes
// on) and the panel's coin (#coin-spec-p) have a light of their own while it moves: the pointer only leans it round
// the lit side, it swings across the face as the panel's coin flips, and as the art's pixel glint crosses the coin a
// bar of light crosses the glass with it. With the glass on, this loop draws the glint too: a composited animation
// inside the lens's filter would have Chromium draw the tilting coin at a lower resolution. Each light is a job in the
// frame loop and leaves it as soon as it is still; the panel's runs on for 1.6 s from an open or a close (the flip).
// Whether the coins are sealed in glass: a read of their maps' machine (mapsModule, below), never a flag of its own.
const coinGlassOn = () => mapsModule.is('ready');
// The light's direction in the reflection's normal space: (0, 0) faces the viewer, length 1 grazes the rim. Its
// pictures (e-env.png, e-bar.png) are 1.6 of the coin's box wide, centred on that direction.
const LIGHT_REST = { x: -0.469, y: -0.469 };
const LIGHT_REST_A = Math.atan2(LIGHT_REST.y, LIGHT_REST.x);
const LIGHT_SWING = (50 * Math.PI) / 180;
// Where the glint's bar of light waits: off the glass, within reach of the filter's region (WebKit drops the whole
// reflection for a picture wholly outside it).
const BAR_OFF = -2.2;
// The light follows critically damped: 0.32 s after the pointer, 0.22 s after a finger.
const LIGHT_FOLLOW = (2 * Math.PI) / 0.32;
const LIGHT_FINGER = (2 * Math.PI) / 0.22;
// The glint's curve (SWEEP, the one the animation would use), solved for its progress.
const sweepAt = (() => {
  const [x1, y1, x2, y2] = SWEEP.match(/-?[\d.]+/g).map(Number);
  const B = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0 || x >= 1) return clamp(x, 0, 1);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (B(m, x1, x2) < x) lo = m; else hi = m; }
    return B((lo + hi) / 2, y1, y2);
  };
})();
const lightsOn = () => coinGlassOn() && !REDUCED.matches && !FORCED.matches;
function coinLight(id) {
  const f = document.getElementById(id);
  return {
    id, lamp: f?.querySelector('feImage[result="lamp"]'), bar: f?.querySelector('feImage[result="bar"]'),
    x: { x: LIGHT_REST.x, v: 0 }, y: { x: LIGHT_REST.y, v: 0 }, tx: LIGHT_REST.x, ty: LIGHT_REST.y, w: LIGHT_FOLLOW,
    spec: null, c: null, held: false, keep: 0, glint: null, last: '',
  };
}
let lightPool = null;
let panelLight = null;
const lit = new Set();
// A coin's middle and radius, where it is drawn now.
function centreOf(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
}
// One of the light's pictures, centred on the direction (hx, hy).
function placeLight(img, hx, hy) {
  img?.setAttribute('x', (0.5 + 0.5 * hx - 0.8).toFixed(4));
  img?.setAttribute('y', (0.5 + 0.5 * hy - 0.8).toFixed(4));
}
function lightOn(L) {
  lit.add(L);
  wake(lightJob);
}
// Where the light goes for a pointer at (px, py) over its coin. It stays in the world, where the art says it is: the
// pointer leans it a third of the way toward where a lamp at the pointer would be, and never off the lit side (within
// 50 degrees of its rest, between 0.45 and 0.85 out): it may slide round the upper left, never across to the lower
// right, against the art's own shading.
function lightAim(L, px, py) {
  const c = L.c;
  if (!c || !(c.r > 0)) return;
  const vx = (px - c.x) / (2 * c.r);
  const vy = (py - c.y) / (2 * c.r);
  const k = 0.85 / Math.sqrt(1 + vx * vx + vy * vy);
  const x = LIGHT_REST.x + (vx * k - LIGHT_REST.x) * 0.35;
  const y = LIGHT_REST.y + (vy * k - LIGHT_REST.y) * 0.35;
  let da = Math.atan2(y, x) - LIGHT_REST_A;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const a = LIGHT_REST_A + clamp(da, -LIGHT_SWING, LIGHT_SWING);
  const len = clamp(Math.hypot(x, y), 0.45, 0.85);
  L.tx = Math.cos(a) * len;
  L.ty = Math.sin(a) * len;
  lightOn(L);
}
function lightHome(L) {
  L.tx = LIGHT_REST.x;
  L.ty = LIGHT_REST.y;
  lightOn(L);
}
// The glint's eased progress at time now (null before it starts and once it is over), with the art's pixel band drawn
// there (as its animation would: from -130% to 130% of its width).
function glintAt(L, now) {
  const g = L.glint;
  if (!g) return null;
  const p = (now - g.t0) / g.dur;
  if (p < 0) return null;
  if (p >= 1) { g.band.style.transform = ''; L.glint = null; return null; }
  const e = sweepAt(p);
  g.band.style.transform = `translateX(${(-130 + 260 * e).toFixed(2)}%)`;
  return e;
}
// The panel coin's turn now in degrees (null when it is not flying), read from its flight at the flight's own time.
function coinTurn() {
  const a = cd.coinAnim;
  const rot = cd.coinRot;
  if (!a || !rot || rot.length < 2 || a.playState !== 'running') return null;
  const p = a.effect?.getComputedTiming().progress;
  if (typeof p !== 'number') return null;
  const u = p * (rot.length - 1);
  const i = Math.min(rot.length - 2, Math.floor(u));
  return rot[i] + (rot[i + 1] - rot[i]) * (u - i);
}
function lightJob(dt, now) {
  for (const L of lit) {
    follow(L.x, L.tx, dt, L.w);
    follow(L.y, L.ty, dt, L.w);
    let hx = L.x.x;
    const hy = L.y.x;
    const g = glintAt(L, now);
    // The coin turns under a light that stays put, so the light swings across its face the other way, reaching a
    // little past the rim when the coin is edge on (and exactly where it was at each end of the turn).
    const turn = L === panelLight ? coinTurn() : null;
    // From the moment it is edge on, a coin flying from or to its card shows its back as the card's coin (style.css,
    // .as-card): it leaves the card and lands in it as the card draws it, whatever the two screens' lenses.
    if (turn !== null) P.coin.classList.toggle('as-card', turn < -90);
    if (turn) {
      const t = (turn * Math.PI) / 180;
      hx = Math.sin(Math.asin(clamp(hx, -1, 1)) - t) * (1 + 0.1 * Math.abs(Math.sin(t / 2)));
    }
    const key = `${hx.toFixed(3)} ${hy.toFixed(3)} ${g === null ? '-' : g.toFixed(3)}`;
    if (key !== L.last) {
      L.last = key;
      placeLight(L.lamp, hx, hy);
      // The bar rides on the pixel band's broad stripe: the band (140% of the coin wide, its stripe 41% along it) moves
      // from -130% to 130%, so the stripe's middle crosses the dome at -3.89 + 7.28 g (in dome radii).
      placeLight(L.bar, g === null ? BAR_OFF : clamp(-3.89 + 7.28 * g, BAR_OFF, -BAR_OFF), -0.1);
    }
    const still = Math.abs(L.x.x - L.tx) < 0.002 && Math.abs(L.y.x - L.ty) < 0.002 && Math.abs(L.x.v) + Math.abs(L.y.v) < 0.01;
    if (still && !L.glint && turn === null && now >= L.keep) {
      lit.delete(L);
      // A card's light home at rest goes back to the pool, and its coin to the shared reflection (the same picture).
      if (L !== panelLight && !L.held && L.tx === LIGHT_REST.x && L.ty === LIGHT_REST.y) lightFree(L);
    }
  }
  return lit.size > 0;
}
function lightFree(L) {
  if (L.glint) { L.glint.band.style.transform = ''; L.glint = null; }
  if (L.spec) L.spec.style.filter = '';
  L.spec = null;
  L.c = null;
  L.held = false;
  lit.delete(L);
}
// The light for a card's coin: its own if it has one, else a free one (or the one not held, or the oldest), which
// starts from the resting light the coin was showing.
function lightFor(spec) {
  lightPool ??= [coinLight('coin-spec-a'), coinLight('coin-spec-b')];
  let L = lightPool.find((p) => p.spec === spec);
  if (L) return L;
  L = lightPool.find((p) => !p.spec) || lightPool.find((p) => !p.held) || lightPool[0];
  if (L.spec) lightFree(L);
  L.spec = spec;
  L.x = { x: LIGHT_REST.x, v: 0 };
  L.y = { x: LIGHT_REST.y, v: 0 };
  L.tx = LIGHT_REST.x;
  L.ty = LIGHT_REST.y;
  L.last = '';
  placeLight(L.lamp, LIGHT_REST.x, LIGHT_REST.y);
  placeLight(L.bar, BAR_OFF, -0.1);
  spec.style.filter = `url(#${L.id})`;
  return L;
}
const cardLight = (n) => lightPool?.find((p) => p.spec === n.refs.spec) ?? null;
// A coin's art is drawn a moment after its image arrives (decoded off the main thread). Until then its glass shows no
// contact shadow and no reflection (style.css, .wait-art): on paper the shadow's ink disc would show as a black coin. An
// image that never comes keeps them off.
function artWait(coin, icon) {
  coin.classList.add('wait-art');
  icon.decode().then(() => { if (icon.complete && icon.naturalWidth) coin.classList.remove('wait-art'); }, () => {});
}
// The glint as an animation (the glass is off: before it switches on, in Firefox, under forced colours).
function glintPlay(band, dur, delay = 0) {
  for (const a of band.getAnimations()) a.cancel();
  band.animate([{ transform: 'translateX(-130%)' }, { transform: 'translateX(130%)' }], { duration: dur, delay, easing: SWEEP });
}
// The pointer comes onto a card: its coin's light comes on, leaning toward it, and the glint crosses the coin once.
function coinHover(n, x, y) {
  if (!lightsOn()) { glintPlay(n.refs.band, 820); return; }
  for (const a of n.refs.band.getAnimations()) a.cancel();
  const L = lightFor(n.refs.spec);
  L.held = true;
  L.w = LIGHT_FOLLOW;
  L.c = centreOf(n.refs.coin);
  L.glint = { band: n.refs.band, t0: performance.now(), dur: 820 };
  lightAim(L, x, y);
}
function coinPoint(n, x, y) {
  const L = cardLight(n);
  if (L && lightsOn()) lightAim(L, x, y);
}
function coinLeave(n) {
  const L = cardLight(n);
  if (!L) return;
  L.held = false;
  lightHome(L);
}
// A finger on a card: the light leans toward it, a little quicker, while it presses (a tap then opens the panel). As
// with the card's press, only after 50 ms: a finger that starts a scroll on a card has been taken by the scroll by
// then (pointercancel), and the coin never lights up under a fling.
let touchLight = null;
let touchTimer = 0;
function coinTouch(n, x, y) {
  if (!lightsOn()) return;
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    const L = lightFor(n.refs.spec);
    L.held = true;
    L.w = LIGHT_FINGER;
    L.c = centreOf(n.refs.coin);
    lightAim(L, x, y);
    touchLight = L;
  }, 50);
}
function coinUntouch() {
  clearTimeout(touchTimer);
  const L = touchLight;
  touchLight = null;
  if (!L?.spec) return;
  L.w = LIGHT_FOLLOW;
  L.held = false;
  lightHome(L);
}
function panelLightOf() {
  if (!panelLight && PANEL) { panelLight = coinLight('coin-spec-p'); panelLight.spec = P.spec; }
  return panelLight;
}
// The panel opens or starts to close (home: the light eases back to rest on the way, so the coin lands in its card with
// the card's own light): the coin flips and the glint crosses it, so its light runs a while.
function panelLightKeep(home = false) {
  if (!lightsOn()) return;
  const L = panelLightOf();
  if (home) { L.tx = LIGHT_REST.x; L.ty = LIGHT_REST.y; }
  L.keep = performance.now() + 1600;
  lightOn(L);
}
function panelLightAim(x, y, finger) {
  if (!lightsOn() || !panel.is('open')) return;
  const L = panelLightOf();
  if (!coinCentre || finger) measureCoin();
  L.c = coinCentre;
  lightAim(L, x, y);
}
function panelLightHome() {
  if (panelLight && panel.is('open')) lightHome(panelLight);
}
// The panel has closed: its light is back at rest at once, ready for the next coin.
function panelLightRest() {
  const L = panelLight;
  if (!L) return;
  if (L.glint) { L.glint.band.style.transform = ''; L.glint = null; }
  L.x = { x: LIGHT_REST.x, v: 0 };
  L.y = { x: LIGHT_REST.y, v: 0 };
  L.tx = LIGHT_REST.x;
  L.ty = LIGHT_REST.y;
  L.keep = 0;
  L.c = null;
  L.last = '';
  lit.delete(L);
  placeLight(L.lamp, LIGHT_REST.x, LIGHT_REST.y);
  placeLight(L.bar, BAR_OFF, -0.1);
}

// ---- WebKit: every coin under glass on whole pixels ----
// WebKit registers a filter's maps against the element's own content only as well as the element sits on the pixel
// grid: off it, the glass edge is drawn off centre on the art, a dark crescent on one side. Measured in WebKit (2x and
// 3x), a coin on a whole CSS pixel has its glass within 0.1 of a device pixel of centre; on a whole device pixel that
// is half a CSS pixel, up to 0.4. So each coin is nudged (left and top, under half a CSS pixel: nothing visibly moves)
// onto whole CSS pixels, and again whenever the layout may have moved it: the glass coming on, a new order or a new
// card, a resize, the font arriving, the page changing height (the notice folding), the panel's coin landing, the
// sheet settling after a drag. A coin is read where it rests: its tilt is lifted for the read (in the same task, so it
// is never drawn), and a card still moving (rising in with the entrance, re-ranking, lifting, pressed) is read once it
// stops (an ancestor's transform counts in what the browser reports). All nudges are cleared, then every coin read,
// then all written: one layout.
const snapNudge = (v) => { const q = Math.round(v * 64) / 64; return `${q ? q + Math.sign(q) / 1024 : 0}px`; };
let snapRaf = 0;
function snapSoon() {
  if (!coinGlassOn() || !ENGINE.webkit || snapRaf) return;
  snapRaf = requestAnimationFrame(() => { snapRaf = 0; snapCoins(); });
}
function snapCoins() {
  if (!coinGlassOn() || !ENGINE.webkit) return;
  const coins = [];
  const moving = [];
  for (const n of nodes.values()) {
    if (!n.li.isConnected || n.li.classList.contains('pressed')) continue;
    const anims = n.li.getAnimations().filter((a) => a.playState === 'running');
    if (anims.length) moving.push(...anims);
    else coins.push(n.refs.coin);
  }
  if (moving.length) Promise.allSettled(moving.map((a) => a.finished)).then(snapSoon);
  if (coins.length) {
    for (const c of coins) { c.style.left = ''; c.style.top = ''; }
    const tilted = coins.filter((c) => c.style.transform).map((c) => [c, c.style.transform]);
    for (const [c] of tilted) c.style.transform = 'none';
    const X = scrollX;
    const Y = scrollY;
    const at = coins.map((c) => c.getBoundingClientRect());
    for (const [c, tf] of tilted) c.style.transform = tf;
    coins.forEach((c, i) => {
      const x = stepOrNone(Math.round(at[i].left + X) - (at[i].left + X));
      const y = stepOrNone(Math.round(at[i].top + Y) - (at[i].top + Y));
      if (x) c.style.left = snapNudge(x);
      if (y) c.style.top = snapNudge(y);
    });
  }
  snapPanelCoin();
}
// The panel's coin, once it rests (its flight, the sheet's slide or the panel's fade over, no finger on the sheet). A
// close takes the nudge back before it reads the panel (closePanel), and its flight sets off from where the coin was
// seen (cd.coinSnap, closeMorph).
function snapPanelCoin() {
  if (!coinGlassOn() || !ENGINE.webkit || !PANEL || !panel.is('open') || sheet.is('dragging')) return;
  const moving = [P.panel, P.coin].flatMap((node) => node.getAnimations()).filter((a) => a.playState === 'running');
  if (moving.length) { Promise.allSettled(moving.map((a) => a.finished)).then(snapPanelCoin); return; }
  P.coin.style.left = '';
  P.coin.style.top = '';
  const r = P.coin.getBoundingClientRect();
  const x = Math.round((Math.round(r.left) - r.left) * 64) / 64;
  const y = Math.round((Math.round(r.top) - r.top) * 64) / 64;
  if (x) P.coin.style.left = snapNudge(x);
  if (y) P.coin.style.top = snapNudge(y);
  cd.coinSnap = { x, y };
}

// ---- the glass comes on ----
// After the first paint, when the browser is next idle (sooner at the first pointer on a card, or for a chart opened
// from the address): the maps the domes' filters read are fetched and decoded, and only then does html.coin-glass put
// the glass on, so no coin is ever drawn through a map that is not there yet (an empty lens map draws no coin at all).
// index.html names them in data-href, not href: a browser fetches an feImage's picture as soon as it reads the tag, and
// the maps would then load before the first paint, beside the page's own script. They get their href here, once
// decoded (the filters read them from the cache the decodes filled), and the glass comes on two frames later. Until
// then, and if a map fails, every coin is its plain art. Chromium and WebKit only: Firefox keeps the plain art (and
// fetches no map) until the glass has been tried there. The decoded maps are kept for the filters. A map that failed
// (offline for a moment) is asked for again at the next trigger, at most every 3 s (lazyModule's failed state), never
// lost for the whole visit.
let coinMaps = null;
const coinMapLinks = () => [...document.querySelectorAll('svg.fx-defs feImage[data-href]')];
const coinMapUrls = (maps) => [...new Set(maps.map((f) => f.getAttribute('data-href')))].filter((u) => /^\/glass\/[\w.-]+\.(png|webp)(\?v=[0-9a-f]+)?$/.test(u));
const mapsModule = lazyModule(() => {
  const maps = coinMapLinks();
  coinMaps = coinMapUrls(maps).map((u) => { const img = new Image(); img.src = u; return img; });
  return Promise.all(coinMaps.map((img) => img.decode())).then(() => {
    for (const f of maps) f.setAttribute('href', f.getAttribute('data-href'));
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}, 3000);
// In: the glass comes on, once.
mapsModule.on((to) => {
  if (to !== 'ready') return;
  document.documentElement.classList.add('coin-glass', ...(ENGINE.webkit ? ['wk'] : []));
  if (!ENGINE.webkit) return;
  snapCoins();
  addEventListener('resize', snapSoon, { passive: true });
  document.fonts?.ready.then(snapSoon);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => snapSoon()).observe(document.body);
});
function coinGlass() {
  if (!(ENGINE.chromium || ENGINE.webkit) || mapsModule.is('loading', 'ready')) return;
  if (!coinMapUrls(coinMapLinks()).length || !document.getElementById('coin-lens')) return;
  mapsModule.get();
}

// ---- the dock: what the grid shows (All, Coins, Stocks, Commods) ----
// A stock is the item with an exchange, a commodity the one the server marks so (it names a unit instead: per oz, per
// bbl). The choice lasts for this visit only: every arrival starts on All.
function isCommodity(c) { return c?.kind === 'commodity'; }
const kindOf = (c) => (c.exchange ? 'stock' : isCommodity(c) ? 'commod' : 'coin');
// What stands after a card's name: a stock's exchange, a commodity's unit.
const tailOf = (c) => (c.exchange ? c.exchange : isCommodity(c) && c.unit ? `per ${c.unit}` : '');
const dock = document.querySelector('.dock');
const dockSeg = dock?.querySelector('.seg-show') ?? null;
// What the grid shows, the dock's choice. Its states:
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
  const b = dockSeg?.querySelector('button[aria-pressed="true"]');
  if (b) segPlace([[dockSeg, b.offsetLeft, b.offsetWidth]], animate, byUser);
}
function setShow(kind, byUser = true) {
  if (!dockSeg || !filter.go(kind)) return;
  segSet(dockSeg, 'data-k', kind);
  dockPlace(!REDUCED.matches, byUser);
  sortGrid();
}
// The grid takes the dock's choice: the cards sorted out go at once, the ones that stay glide to their new places on
// the re-rank's spring, and the ones that come back rise in. A page scrolled into the list goes back to the list's top
// first (where the hero's Price Watchlist capsule lands), so the answer is in view. Nothing moves under reduced motion.
function sortGrid() {
  revealAll();
  const list = [...nodes.values()];
  const animate = rendered && !document.hidden && !REDUCED.matches && panel.is('closed');
  const before = new Map();
  if (animate) for (const n of list) if (!n.li.classList.contains('out')) before.set(n.li, n.li.getBoundingClientRect());
  for (const n of list) for (const a of n.li.getAnimations()) if (a.id === 'rerank' || a.id === 'show') a.cancel();
  for (const n of list) n.li.classList.toggle('out', !shown(n.item));
  const topBar = document.querySelector('.top')?.offsetHeight || 56;
  const bar = document.querySelector('.bar');
  if (bar && grid.getBoundingClientRect().top < topBar) scrollTo(0, Math.max(0, bar.getBoundingClientRect().top + scrollY - topBar - 6));
  snapSoon();
  if (!animate) return;
  const vh = innerHeight;
  let k = 0;
  for (const n of list) {
    const li = n.li;
    if (li.classList.contains('out')) continue;
    const b = li.getBoundingClientRect();
    if (b.bottom < 0 || b.top > vh) continue;
    const a = before.get(li);
    if (a && a.bottom > 0 && a.top < vh) {
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      springAnim(li, SPRING.gentle, (p) => ({ transform: `translate(${lerp(dx, 0, p)}px, ${lerp(dy, 0, p)}px)` }), { id: 'rerank' });
    } else {
      const delay = Math.min(k++, 8) * 20;
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, easing: EASE, fill: 'backwards', id: 'show' });
      springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(12, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'show' });
    }
  }
}
// The dock comes up once the grid has reached it and stays over the rest of the page (the grid above the window still
// counts); it goes back under the window when the grid is below it again. An observer says so: no scroll listener.
// The dock's states:
//   under  below the window, inert (no card yet, or the grid not reached);
//   up     over the page (.on), taking clicks.
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
  }, { rootMargin: '0px 0px -96px 0px' }).observe(grid);
}
dockSeg?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setShow(b.getAttribute('data-k')); });
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
  toTop.addEventListener('click', () => scrollTo({ top: 0, behavior: REDUCED.matches ? 'auto' : 'smooth' }));
}

// ---- the grid: patched in place, so a hovered card or an open one survives every refresh ----
// symbol -> { li, refs, item }
const nodes = new Map();
let rendered = false;
const ICON_URL = /^\/icons\/[a-z0-9]+\.(png|webp)(\?v=[0-9a-f]+)?$/;

function buildCard(c) {
  const icon = el('img', { class: 'icon', src: c.icon, alt: '', width: '48', height: '48', decoding: 'async' });
  const band = el('span', { class: 'glint-band' });
  const glint = el('span', { class: 'glint', 'aria-hidden': 'true' }, band);
  // The light is cut to the coin's own pixels: the icon is the glint's mask.
  if (ICON_URL.test(c.icon)) { glint.style.webkitMaskImage = `url("${c.icon}")`; glint.style.maskImage = `url("${c.icon}")`; }
  // Sealed in glass (style.css): the art and its glint under the lens, the reflection over them (the dome, the same in
  // either theme), the contact shadow under them. The tilt turns all of it together.
  const spec = el('span', { class: 'coin-spec', 'aria-hidden': 'true' });
  const dome = el('span', { class: 'coin-dome' }, el('span', { class: 'coin-lens' }, icon, glint), spec);
  const coin = el('span', { class: 'coin' }, el('span', { class: 'coin-shade', 'aria-hidden': 'true' }), dome);
  artWait(coin, icon);
  const sym = el('span', { class: 'sym' }, c.symbol);
  const open = el('button', { class: 'card-open', type: 'button', 'aria-haspopup': 'dialog' }, sym);
  const name = el('span', { class: 'name' });
  const price = el('div', { class: 'price' });
  const chg = el('span', { class: 'chg' });
  const key = el('span', { class: 'chg-key' });
  const mcap = el('dd');
  const vol = el('dd');
  const volKey = el('dt');
  const mcapBox = el('div', {}, el('dt', {}, 'Mcap'), mcap);
  const volBox = el('div', {}, volKey, vol);
  // Its role said outright: WebKit reads a list without markers (list-style: none) as a plain group unless it does.
  const li = el('li', { class: 'card', 'data-sym': c.symbol, role: 'listitem' },
    el('div', { class: 'head' }, coin, el('div', { class: 'id' }, open, name)),
    price,
    el('div', { class: 'move' }, chg, key),
    el('dl', { class: 'stats' }, mcapBox, volBox));
  return { li, item: c, names: '', reveal: revealMachine(li), refs: { icon, coin, band, glint, spec, open, sym, name, price, chg, key, mcap, vol, volKey, mcapBox, volBox } };
}

// ---- the page's motions, numbered 1 to 8 (each stands alone) ----
// 2 and 8: a figure that changes rolls. Only the characters that changed move: the new one comes in from below when the
// figure rose (from above when it fell) while the old one leaves the other way. The node keeps its exact text (the old
// characters are drawn by the stylesheet from data-o), and is one text node again once the roll is over. Nothing rolls
// off screen, in a hidden tab, before the first render or under reduced motion.
const ROLL_MS = 440;
function roll(node, prev, next, dir) {
  if (REDUCED.matches || document.hidden || !rendered || !prev || prev === NA || next === NA || prev === next) return;
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
  if (REDUCED.matches || document.hidden || !rendered) return;
  const box = node.getBoundingClientRect();
  if (!box.width || box.bottom < 0 || box.top > innerHeight) return;
  node.animate([{ filter: 'brightness(1.5) saturate(1.3)', scale: '1.07' }, { filter: 'brightness(1) saturate(1)', scale: '1' }], { duration: 560, easing: EASE, id: 'flash' });
}
// 4: a card below the fold waits unseen (.wait) and rises in the first time it scrolls into view. Each card's states:
//   shown    drawn (every card at first, and for good once it has been seen);
//   waiting  held back unseen (.wait) by the entrance until it first scrolls into view, watched for that.
// A card only ever waits once: the entrance sends it there, its scroll into view (or the dock's re-sort) brings it out.
function revealMachine(li) {
  return machine('shown', { shown: ['waiting'], waiting: ['shown'] }).on((to) => {
    li.classList.toggle('wait', to === 'waiting');
    if (to === 'waiting') revealIO?.observe(li);
    else revealIO?.unobserve(li);
  });
}
const revealIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  let k = 0;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const li = e.target;
    const n = nodes.get(li.getAttribute('data-sym'));
    revealIO.unobserve(li);
    if (!n || n.li !== li || !n.reveal.go('shown')) continue;
    if (REDUCED.matches || document.hidden || !panel.is('closed')) continue;
    const delay = Math.min(k++ * 60, 180);
    li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 460, delay, easing: EASE, fill: 'backwards', id: 'reveal' });
    springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(22, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'reveal' });
  }
}, { rootMargin: '0px 0px -4% 0px' }) : null;
function revealAll() {
  for (const n of nodes.values()) n.reveal.go('shown');
}

// A stock card names its exchange and labels its change and volume "1d" (the trading session's); a coin's are "24h".
// A commodity card names its unit there and is "1d" too: its change is against the last settlement.
// Only what changed is written, so an unchanged card costs no DOM write and no style recalculation.
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
  if (r.icon.getAttribute('src') !== c.icon) r.icon.setAttribute('src', c.icon);
  const price = fmtPrice(c.price);
  const priceWas = r.price.textContent;
  setText(r.price, price);
  if (priceWas !== price) roll(r.price, priceWas, price, c.price >= (n.item?.price ?? c.price) ? 1 : -1);
  setClass(r.price, `price${price === NA ? ' unknown' : ''}`);
  const chg = fmtChange(c.change24h);
  const chgWas = r.chg.textContent;
  setText(r.chg, chg.text);
  if (chgWas && chgWas !== chg.text) flash(r.chg);
  setClass(r.chg, `chg${chg.tone && !stale ? ` ${chg.tone}` : ''}`);
  setText(r.key, stale ? 'stale' : stock ? '1d' : '24h');
  const mcap = fmtCompact(c.mcap);
  const vol = fmtCompact(c.vol24h);
  setText(r.mcap, mcap);
  setClass(r.mcap, mcap === NA ? 'unknown' : '');
  setText(r.vol, vol);
  setClass(r.vol, vol === NA ? 'unknown' : '');
  setText(r.volKey, stock ? 'Vol 1d' : 'Vol 24h');
  n.item = c;
}

function renderGrid(list, fetched) {
  if (!list.length) {
    nodes.clear();
    grid.replaceChildren(el('li', { class: 'empty', role: 'listitem' }, el('p', { class: 'empty-title' }, 'No prices yet'), el('p', { class: 'empty-body' }, 'They will show here as soon as they load.')));
    return;
  }
  // Figures first: they swap at once (a card's rank is its place in the grid, which no number on it repeats). Except on
  // the card the panel is flying home into: new figures there would move its words (a wider chip pushes "24h" along) out
  // from under their twins in flight, so they wait until it has landed (finishClose), and swap then.
  const want = [];
  const landing = panel.is('closing') && cd.flight ? cd.li : null;
  for (const c of list) {
    let n = nodes.get(c.symbol);
    if (!n) { n = buildCard(c); nodes.set(c.symbol, n); }
    if (n.li === landing) cd.held = true;
    else patchCard(n, c, fetched);
    // A card the dock has sorted out stays in the grid, undrawn (a new coin or stock arrives already sorted).
    n.li.classList.toggle('out', !shown(c));
    want.push(n.li);
  }
  const kids = grid.children;
  if (kids.length === want.length && want.every((li, i) => kids[i] === li)) return;
  // The panel is flying home into its card: a new order waits until it has landed (finishClose), or the card would move
  // out from under it.
  if (panel.is('closing') && cd.flight) { cd.reorder = true; return; }
  // The order changed: FLIP. Read every card where it is now (mid-move if a re-rank is still playing), move the nodes
  // with as few moves as possible, read again, and play each card from its old place to its new one, all together.
  // Not under an open panel: nobody sees it through the glass, and each of its frames would have the whole window
  // blurred again. The cards move at once there; a close lands on the card's new place.
  const under = panel.is('opening', 'open');
  const animate = rendered && !document.hidden && !REDUCED.matches && !under && !(cd.lite && !panel.is('closed'));
  const before = new Map();
  if (animate) for (const n of nodes.values()) if (n.li.isConnected) before.set(n.li, n.li.getBoundingClientRect());
  for (const n of nodes.values()) for (const a of n.li.getAnimations()) if (a.id === 'rerank') a.cancel();
  const keep = new Set(list.map((c) => c.symbol));
  for (const [sym, n] of nodes) if (!keep.has(sym)) { n.li.remove(); nodes.delete(sym); }
  for (const child of [...grid.children]) if (!child.hasAttribute('data-sym')) child.remove();
  for (let i = 0; i < want.length; i++) if (grid.children[i] !== want[i]) grid.insertBefore(want[i], grid.children[i] ?? null);
  // WebKit: every coin in its new place is set on whole pixels again (once its card has stopped moving).
  snapSoon();
  // A painted veil is a still picture of the page: painted again in the new order.
  if (under && P.veil.classList.contains('painted')) G?.veilPaint();
  if (!animate) return;
  const vh = innerHeight;
  const far = (r) => r.bottom < -vh || r.top > 2 * vh;
  const moves = [];
  for (const li of want) {
    const a = before.get(li);
    if (!a) continue;
    const b = li.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || (far(a) && far(b))) continue;
    moves.push([li, dx, dy]);
  }
  for (const [li, dx, dy] of moves) springAnim(li, SPRING.gentle, (p) => ({ transform: `translate(${lerp(dx, 0, p)}px, ${lerp(dy, 0, p)}px)` }), { id: 'rerank' });
}

function render() {
  if (!Array.isArray(data?.coins)) return;
  // The stocks follow the last coin in the same grid, in their own market-cap order (never ranked against the coins).
  // The commodities follow the last stock the same way (coins, stocks, commodities).
  const stocks = Array.isArray(data.stocks) ? data.stocks : [];
  const commodities = Array.isArray(data.commodities) ? data.commodities : [];
  renderGrid(data.coins.length ? [...data.coins, ...stocks, ...commodities] : [], Boolean(data.updatedAt));
  rendered = true;
  dockSync();
  enter();
  // Every element is optional: a page cached from an older deploy may lack some of them.
  if (countEl) setText(countEl, String(data.coins.length));
  if (stockCountEl) setText(stockCountEl, String(stocks.length));
  if (commodCountEl) setText(commodCountEl, String(commodities.length));
  // The hero's ghost tape, drawn faintly and never animated: BTC, ETH, SOL, MET and ZEC with their 24h change, and on wide
  // screens COIN, HOOD, CRCL, MU and SPCX beside them (the .stk cells, hidden by the stylesheet until there is room). Written
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
// cards on screen follow as a wave from the top left, each rising with the smooth spring. The rest of the grid is just
// there. Nothing waits for it: every figure is written before it starts, and a card takes a click mid-rise. It never
// plays on a refresh, on a page brought back from history (the back-forward cache runs no script; a reload from history
// is a return, not an arrival) or when the address opens a chart at once; reduced motion gets a short plain fade.
// Its states:
//   due      not played yet (no card drawn yet);
//   playing  the cards' wave and the stylesheet's entrance are running;
//   done     played, or skipped: glass.js is not loaded in the middle of it (glassSoon).
const entrance = machine('due', { due: ['playing', 'done'], playing: ['done'], done: [] });
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
  const seen = [];
  for (const n of nodes.values()) {
    const r = n.li.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh) seen.push([n.li, Math.round(r.top), Math.round(r.left)]);
  }
  // 4: every card not on screen now waits for its own scroll into view.
  if (!calm && revealIO) {
    const first = new Set(seen.map((s) => s[0]));
    for (const n of nodes.values()) if (!first.has(n.li) && !n.li.classList.contains('out')) n.reveal.go('waiting');
  }
  const played = [...lead];
  const over = () => Promise.allSettled(played.map((a) => a.finished)).then(() => { entrance.go('done'); });
  if (calm) {
    for (const [li] of seen) played.push(li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear', id: 'enter' }));
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
    played.push(li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, delay, easing: EASE, fill: 'backwards', id: 'enter' }));
    // Added to whatever the card's own translate is (a hover's lift), never in place of it.
    played.push(springAnim(li, SPRING.smooth, (p) => ({ translate: `0 ${lerp(16, 0, p).toFixed(2)}px` }), { delay, fill: 'backwards', composite: 'add', id: 'enter' }));
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
      if (upd?.hidden) upd.hidden = false;
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
  if (candles.length < 2) return null;
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
  coin: q('.cd-coin'), tilt: q('.cd-tilt'), icon: q('.cd-icon'), glint: q('.cd-glint'), band: q('.cd-glint .glint-band'), spec: q('.cd-coin .coin-spec'),
  starA: q('.cd-star-a'), starB: q('.cd-star-b'),
  main: q('.cd-main'), sym: q('#cd-sym'), name: q('#cd-name'), price: q('.cd-price'), chg: q('.cd-chg'),
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
//            .grid.cd-open) and the chart is on its way;
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
  // coinRot: the turn (degrees) of the coin's flight at each of its keyframes, for the light on its glass; coinSnap: the
  // panel coin's nudge onto whole pixels (WebKit's glass), while it rests. fly: the open's morph (its pose, its target,
  // its clock); flight: the close's morph. queued: live figures owed to a panel that could not take them yet (it was
  // flying in or its chart moving); held and reorder: figures for the card it flies home into, and a new grid order,
  // owed until it lands.
  anims: new Set(), coinAnim: null, coinRot: null, coinSnap: null, fly: null, flight: null, t0: 0, timer: 0, queued: false, reorder: false, held: false,
  hashDone: false,
  // The corner radii a morph runs between, the card's and the panel's, as the stylesheet draws them (read at each open).
  r: { card: 20, panel: 32 },
  // Lite glass for this view: no live blur on a device that could not keep up (the guard), or with 2 GB of memory or
  // less. Settled at each open.
  lite: LOW_MEMORY || guard.notch.is('flat'),
};
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
// Parts of the card that fly to their twins in the panel. Each twin has the same text at the same size, so it only ever
// translates; the price is laid out at 44px and starts shrunk to the card's 32px (scaling down stays sharp).
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

function readCard(n) {
  const out = { card: n.li.getBoundingClientRect(), icon: n.refs.coin.getBoundingClientRect() };
  const parts = flyCard(n.refs);
  for (const k of FLY) out[k] = parts[k].getBoundingClientRect();
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
  const out = { bg: P.bg.getBoundingClientRect(), panel: P.panel.getBoundingClientRect(), icon: P.coin.getBoundingClientRect(), chart: P.chart.getBoundingClientRect(), fly: {}, reveals: [], segs: segRead() };
  const parts = flyPanel();
  for (const k of FLY) out.fly[k] = parts[k].getBoundingClientRect();
  for (const node of reveals()) out.reveals.push([node, node.getBoundingClientRect()]);
  return out;
}
// At least half the card on screen, or the panel does not fly back into it.
function onScreen(r) {
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return r.width > 0 && w * h >= 0.5 * r.width * r.height;
}

// The corners a flight runs between, as the stylesheet draws them: read at each open (any panel may close into its
// card). The card and the panel's surface share their corner's shape (a squircle where the browser draws one, round
// elsewhere), in both themes, so a flight only runs between the two radii.
const cornerOf = (node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
function readRadii(li) {
  cd.r = { card: cornerOf(li), panel: cornerOf(P.bg) };
}

// The pose of every flying part when the panel sits at the card, measured against where it rests in the panel.
function cardPose(from, to) {
  const pose = {
    bg: { dx: from.card.left - to.bg.left, dy: from.card.top - to.bg.top, sx: from.card.width / to.bg.width, sy: from.card.height / to.bg.height, r: cd.r.card, edge: 0, lift: 0, hand: 0 },
    icon: {
      dx: from.icon.left + from.icon.width / 2 - (to.icon.left + to.icon.width / 2),
      dy: from.icon.top + from.icon.height / 2 - (to.icon.top + to.icon.height / 2),
      s: from.icon.width / to.icon.width, rot: COIN_TURN,
    },
    parts: {},
  };
  for (const k of FLY) {
    const a = from[k];
    const b = to.fly[k];
    if (!a || !b || !b.width || !a.width) continue;
    pose.parts[k] = { dx: a.left - b.left, dy: a.top - b.top, s: k === 'price' ? a.height / b.height : 1, o: 1 };
  }
  return pose;
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
//   home:     an ordinary card in the grid;
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
function shadeFor(sx, sy, bg) {
  P.shade.style.width = `${bg.width * sx}px`;
  P.shade.style.height = `${bg.height * sy}px`;
  P.shade.style.transform = `scale(${1 / sx}, ${1 / sy})`;
}
function shadeOff() {
  for (const k of ['width', 'height', 'transform']) P.shade.style[k] = '';
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
// drawn as its twin is and lands on its twin's pixels. The price (laid out at 44px, scaled to the card's 32px) rests
// with its left on a whole pixel where it can, is nudged so its baseline sits on the pixel it is drawn on, and lands
// on the card's price, its baseline on the pixel the card's is drawn on; the coin (96px, scaled to 48px) is nudged
// onto a whole pixel of its own and lands on the card's; the surface lands on the pixels the card's box is drawn on.
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
    const a = from[k];
    const b = to.fly[k];
    if (k === 'price') {
      // Its left is already on a whole pixel where it must be (priceOnPixel); it lands on the card's price exactly, as
      // text is drawn there, on its fraction of a pixel.
      const bc = baselineIn(n.refs.price);
      const bp = baselineIn(P.price);
      const y = onPixel(b.top + bp) - (b.top + bp);
      parts[k] = { x: 0, y, dx: t.dx, dy: onPixel(a.top + Y + bc) - Y - t.s * bp - (b.top + y) };
    } else {
      const x = toFraction(b.left, a.left + X);
      const y = toFraction(b.top, a.top + Y);
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
  for (const [k, v] of Object.entries(pose.parts)) out.parts[k] = { dx: lerp(v.dx, 0, p), dy: lerp(v.dy, 0, p), s: lerp(v.s, 1, p), o: 1 };
  return out;
}
const bgFrame = (b) => ({ transform: `translate(${b.dx}px, ${b.dy}px) scale(${b.sx}, ${b.sy})` });
// The corner stays round at every frame: the radius is divided by the scale on each axis.
const radiusFrame = (b) => ({ borderRadius: `${b.r / b.sx}px / ${b.r / b.sy}px` });
const partFrame = (v) => ({ transform: `translate(${v.dx}px, ${v.dy}px) scale(${v.s})` });
const iconFrame = (v) => ({ transform: v.flat ? `translate(${v.dx}px, ${v.dy}px) scale(${v.s})` : `translate(${v.dx}px, ${v.dy}px) perspective(600px) rotateY(${v.rot}deg) scale(${v.s})` });
// The coin's turn on the way home, against the flight's progress c: a quarter faster than the flight, easing to a stop
// nine tenths of the way, so it lies flat for the last stretch (closeMorph).
const turnHome = (c) => (c <= 0.7 ? 1.25 * c : c >= 0.9 ? 1 : 0.875 + 1.25 * (c - 0.7) - 3.125 * (c - 0.7) ** 2);
// The coin's flight, with its turn at each keyframe kept beside it (cd.coinRot): the light on its glass swings across
// its face as it flips (lightJob).
function coinFlight(duration, poseAt, extra) {
  const rot = [];
  const a = sampled(P.coin, duration, (ms, last) => { const v = poseAt(ms, last); rot.push(v.rot); return iconFrame(v); }, extra);
  cd.coinRot = rot;
  return a;
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
  P.panel.classList.add('morphing');
  const D = settleMs(SPRING.gentle);
  const at = (ms) => openPose(pose, ms);
  const surface = track(sampled(P.bg, D, (ms) => bgFrame(at(ms).bg)));
  cd.fly.clock = surface;
  // Its own animation: the radius is painted on the main thread and must not drag the transform off the compositor.
  track(sampled(P.bg, D, (ms) => radiusFrame(at(ms).bg)));
  track(sampled(P.edge, D, (ms) => ({ opacity: at(ms).bg.edge })));
  // It leaves the card with the card's own shadows (its hover lift as far as it was in) and grows into the panel's lift.
  // For its first moments the card keeps them itself, under its neighbours.
  shadeFor(pose.bg.sx, pose.bg.sy, to.bg);
  cardTo('handing', n.li);
  track(sampled(n.li, D, (ms) => ({ opacity: 1 - at(ms).bg.hand }), { id: 'hand' }));
  track(sampled(P.shade, D, (ms) => ({ opacity: at(ms).bg.hand })));
  track(sampled(P.lift, D, (ms) => ({ opacity: at(ms).bg.lift })));
  track(sampled(P.shadeRest, D, (ms) => ({ opacity: 1 - at(ms).bg.lift })));
  if (from.lifted) track(sampled(P.shadeLift, D, (ms) => ({ opacity: from.lifted * (1 - at(ms).bg.lift) })));
  track(sampled(P.body, D, (ms) => clipFrame(at(ms).bg, to.bg)));
  for (const [k, node] of Object.entries(flyPanel())) {
    if (!pose.parts[k]) continue;
    track(sampled(node, D, (ms) => partFrame(at(ms).parts[k])));
  }
  // The name is the card's own words at the card's size, so it simply flies and never blinks out. Only a name the card
  // cut short (or one on two lines in the panel) fades in as it flies, as it has no twin to start from.
  if (from.nameCut || n.refs.name.textContent !== P.name.textContent || Math.abs(from.name.height - to.fly.name.height) > 1) {
    track(P.name.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80, easing: EASE, fill: 'backwards' }));
  }
  for (const [k, node] of Object.entries(followers())) {
    const lead = FOLLOW[k];
    if (!pose.parts[lead]) continue;
    track(sampled(node, D, (ms) => { const v = at(ms).parts[lead]; return partFrame({ dx: v.dx, dy: v.dy, s: 1 }); }));
    track(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: FOLLOW_DELAY[k], easing: EASE, fill: 'backwards' }));
  }
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
      const b = to.fly[k];
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
  if (how === 'morph') { from = readCard(n); if (!onScreen(from.card)) how = 'fade'; }
  // openPanel is the only way into opening, so what opening means is applied here, in the order its reads and writes
  // need (the run's token and the timer are the move's own: panel.on).
  panel.go('opening');
  cd.sym = sym;
  cd.item = n.item;
  cd.li = n.li;
  mode.go(how);
  cd.queued = false;
  // The card's coin comes back to rest under the panel (its tilt and its light), so a close lands on it at rest.
  unaim(n.refs.coin);
  coinLeave(n);
  fillHead(n.item);
  chartPrepare(sym);
  headLive();
  lockScroll(page);
  // The glass this view keeps, whatever the guard decides while it is open.
  cd.lite = LOW_MEMORY || guard.notch.is('flat');
  P.veil.classList.toggle('lite', cd.lite);
  P.veil.classList.remove('painted');
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
  grid.classList.add('cd-open');
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
  // The coin's light on its glass runs while it flips in.
  panelLightKeep();
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
    if (onScreen(from.card)) {
      kind = 'morph';
      if (was === 'opening' && cd.fly) to = cd.fly.to;
      else {
        // The coin's place on whole pixels (WebKit's glass) is taken back first: the flight works out its own landing
        // nudge from where the coin is laid out (landOnPixels), and sets off from where the coin was seen (closeMorph).
        P.coin.style.left = '';
        P.coin.style.top = '';
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
  // The coin's light on its glass eases home as the coin flips back, so it lands in the card with the card's own light.
  panelLightKeep(true);
}

// Reverses the open from wherever it is now into the card's current place, with the return spring (no overshoot).
function closeMorph(n, from, to, now) {
  const veilFrom = Number(getComputedStyle(P.veil).opacity) || 1;
  const revealFrom = reveals().map((node) => [node, Number(getComputedStyle(node).opacity)]);
  const followFrom = Object.fromEntries(Object.entries(followers()).map(([k, node]) => [k, Number(getComputedStyle(node).opacity)]));
  for (const a of [...cd.anims]) a.cancel();
  cd.anims.clear();
  // A panel scrolled on a short window: .morphing stops its body scrolling (a flying word must not be cut by it), so
  // everything in it drops by the scroll. The panel is read again where it now lies, and every part starts from where
  // it was seen.
  const scrolled = P.panel.classList.contains('morphing') ? 0 : P.body.scrollTop;
  // .landing: the card under the pointer lifts as the panel flies home, and the panel lifts with it (the stylesheet).
  cardTo('landing', n.li);
  P.panel.classList.add('morphing');
  if (scrolled) to = readPanel();
  const target = cardPose(from, to);
  const land = landOnPixels(n, from, to, target);
  const cur = now ?? { bg: { ...REST.bg, r: cd.r.panel }, icon: REST.icon, parts: Object.fromEntries(FLY.map((k) => [k, REST.part])) };
  // It lands with the card's shadows, sized for the scale it lands at (its hover lift comes in with the card's own, from
  // the stylesheet, if the pointer is over the card).
  shadeFor(land.bg.sx, land.bg.sy, to.bg);
  const D = settleMs(SPRING.ret);
  // Home 24 ms early, so the last frame or two before the card takes over show every part exactly where the card's is.
  const home = (ms, last) => (last ? 1 : homing(SPRING.ret)(ms));
  // The coin's nudge is taken back in its first frame: turning and scaling, it is drawn afresh as it lands. It sets off
  // from where it was seen (on whole pixels for WebKit's glass, cd.coinSnap, a nudge closePanel has taken off).
  P.coin.style.left = nudge(land.icon.x);
  P.coin.style.top = nudge(land.icon.y);
  const was = cd.coinSnap ?? { x: 0, y: 0 };
  cd.coinSnap = null;
  const i0 = { ...cur.icon, dx: cur.icon.dx - land.icon.x + was.x, dy: cur.icon.dy - land.icon.y + was.y - scrolled };
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
  // draws the 96px coin once, at full size, and only shrinks that picture), so it would land a little blurred and
  // sharpen into the card's coin at the hand-off; drawn still, it is drawn at its real size, as the card's coin is,
  // while it still moves (and a frame the page is late by moves it under half a pixel).
  const home0 = at(D, true).icon;
  const size = P.coin.offsetWidth || 96;
  const near = (v) => v.flat && Math.hypot(v.dx - home0.dx, v.dy - home0.dy) + (size * Math.abs(v.s - home0.s)) / 2 <= 2;
  let stillAt = D;
  for (let ms = 0; ms < D; ms += 2) if (near(at(ms).icon)) { stillAt = ms; break; }
  const coin = cd.coinAnim = track(coinFlight(Math.max(16, stillAt), (ms) => at(ms).icon, hold));
  for (const [k, node] of Object.entries(flyPanel())) {
    const l = land.parts[k];
    if (!l) continue;
    // The nudge moves the part's box onto the pixels it is drawn on; it starts from there, on a whole pixel (from a
    // close cut into an open, under half a pixel from where it was seen, as it is already moving). The price takes no
    // sideways step: its rest on a whole pixel stays.
    if (l.x) node.style.left = nudge(l.x);
    node.style.top = nudge(l.y);
    const p = cur.parts[k] ?? REST.part;
    const a = { dx: onPixel(p.dx - l.x), dy: onPixel(p.dy - l.y - scrolled), s: p.s };
    const b = { dx: l.dx, dy: l.dy, s: target.parts[k].s };
    track(sampled(node, D, (ms, last) => { const c = home(ms, last); return partFrame({ dx: lerp(a.dx, b.dx, c), dy: lerp(a.dy, b.dy, c), s: lerp(a.s, b.s, c) }); }, hold));
  }
  // Everything without a twin fades within 70 ms; until then the clip cuts whatever the shrinking card has left. An open
  // cut short hides them at once: they were only fading in.
  const fade = now ? 0 : 70;
  const seen = scrolled ? `translateY(${-scrolled}px)` : 'none';
  for (const [node, o] of revealFrom) track(node.animate([{ opacity: o, transform: seen }, { opacity: 0, transform: seen }], { duration: fade, easing: EASE_IN, fill: 'forwards' }));
  for (const [k, node] of Object.entries(followers())) {
    const lead = FOLLOW[k];
    const p = cur.parts[lead] ?? REST.part;
    const a = { dx: p.dx, dy: p.dy - scrolled };
    const b = target.parts[lead];
    if (!b) continue;
    const o = followFrom[k];
    track(sampled(node, D, (ms, last) => { const c = home(ms, last); return { transform: `translate(${lerp(a.dx, b.dx, c)}px, ${lerp(a.dy, b.dy, c)}px)`, opacity: fade ? o * clamp(1 - ms / fade, 0, 1) : 0 }; }, hold));
  }
  // The glass clears on the card's own spring, so the blur is gone just as the card lands.
  track(sampled(P.veil, D, (ms, last) => ({ opacity: last ? 0 : veilFrom * clamp(1 - home(ms), 0, 1) }), hold));
  // The card takes over when the flight has really ended, not after D ms of the clock: an animation starts on the next
  // frame, so a timer would hand over a frame early, short of the place. The timer stays as a backstop.
  const flight = cd.flight = track(sampled(P.bg, D, (ms, last) => bgFrame(at(ms, last).bg), hold));
  const move = panel.epoch;
  flight.finished.then(() => landWhenStill(move, n.li), () => {});
  // The page takes the coin over in that frame, on the flight's own clock, and draws it until the flight ends.
  const still = () => {
    if (panel.epoch !== move) return false;
    const ms = Math.min(D, Number(flight.currentTime) || 0);
    if (ms < stillAt) return true;
    if (coin.playState !== 'idle') coin.cancel();
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
  P.panel.classList.remove('morphing');
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
  if (refocus && btn && stray) {
    btn.focus({ preventScroll: true, focusVisible: keyed });
    // A browser that does not know the focusVisible option may still ring it: then the focus is let go instead.
    if (!keyed && ringed(btn)) btn.blur();
  }
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
    P.panel.classList.remove('morphing');
    // At rest the surface is drawn on the same pixels with or without its nudge; a close nudges it afresh. The card's
    // shadows are out (the stylesheet's rest), and the next flight sizes them afresh.
    P.bg.style.left = '';
    P.bg.style.top = '';
    shadeOff();
    if (flightCard.is('handing')) cardTo('source');
    cd.fly = null;
    stars(true);
    measureCoin();
    // WebKit: the coin on whole pixels, once its flight has landed.
    snapPanelCoin();
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
    dlg.classList.add('closing');
  }
  if (to === 'closed') {
    for (const a of dlg.getAnimations({ subtree: true })) a.cancel();
    cd.anims.clear();
    if (dlg.open) dlg.close();
    dlg.classList.remove('closing');
    P.panel.classList.remove('morphing');
    for (const node of [P.bg, P.edge, P.lift, P.shadeRest, P.shadeLift, P.coin, P.panel, P.veil, ...Object.values(flyPanel()), ...Object.values(followers())]) { node.style.transform = ''; node.style.opacity = ''; }
    for (const node of [P.bg, P.coin, ...Object.values(flyPanel())]) { node.style.left = ''; node.style.top = ''; }
    P.bg.style.borderRadius = '';
    shadeOff();
    P.tilt.style.transform = '';
    tilts.delete(P.tilt);
    grid.classList.remove('cd-open');
    for (const a of cd.li?.getAnimations() ?? []) if (a.id === 'hand') a.cancel();
    cardTo('home');
    unlockScroll();
    cd.sym = null;
    cd.item = null;
    cd.li = null;
    cd.fly = null;
    cd.flight = null;
    cd.coinAnim = null;
    cd.coinRot = null;
    cd.coinSnap = null;
    coinCentre = null;
    mode.go('none');
    P.coin.classList.remove('as-card');
    panelLightRest();
    chartHalt();
    // A new order, or new figures for this card, that arrived while the panel flew home into it: the cards move to the
    // order now, from where they are, and the card swaps in its figures.
    if (cd.reorder || cd.held) { cd.reorder = false; cd.held = false; render(); }
    // Likewise a theme change that came while the panel flew in and was closed before it landed.
    themeSettle();
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
  if (P.icon.getAttribute('src') !== item.icon) { P.icon.setAttribute('src', item.icon); artWait(P.coin, P.icon); }
  if (ICON_URL.test(item.icon)) { P.glint.style.webkitMaskImage = `url("${item.icon}")`; P.glint.style.maskImage = `url("${item.icon}")`; }
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
  // Waiting for the hourly candles (not failed): the figures wait empty rather than say "n/a".
  const day = dayRange(item);
  const none = ch.dayFailed || (ch.size === '1H' && ch.failed) || dayStuck(item) ? NA : ' ';
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
// controls are not beside the header (a phone, a narrow window) the row may run on under the cross, where nothing sits;
// what still does not fit gives way whole, the dollar move first, then the session note (never cut to a wrong figure).
// On-screen boxes, to the fraction of a pixel (whole-pixel offsets let a word run a pixel past the gutter): this runs
// with the panel at rest or moving as one (a sheet, a fade), never while the row's words fly on their own.
function fitMove() {
  const beside = P.ctrl.offsetTop < P.main.offsetTop + P.main.offsetHeight;
  const room = (beside ? P.main : P.tr).getBoundingClientRect().right;
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
function segRead() {
  const out = [];
  for (const seg of [P.segS, P.segT]) {
    const btns = [...seg.querySelectorAll('button')];
    const on = btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    const b = btns[Math.max(0, on)];
    out.push([seg, b.offsetLeft, b.offsetWidth]);
  }
  return out;
}
// The pill moves to the pressed segment (a spring, from the stylesheet); placed without motion on open and resize. Once
// glass.js is in, the pill is its droplet, which it moves (and leaves at rest with this same place and width).
function segPlace(list, animate, byUser = false) {
  for (const [seg, x, w] of list) {
    if (G?.dropPlace(seg, x, w, { still: !animate, byUser })) continue;
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
  // On a phone the chart's box runs to the sheet's edges (so a scrub can start anywhere); the plot keeps to the sheet's
  // gutters, the same x as the words above and below it.
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
  const x0 = o.gl;
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
  return { w, h, kind, x0, x1: x0 + A, xL: xL / px, slot: s / px, ww: ww / px, W: (n * s) / px, H, padT, padB, padR, edge, n, first, xs, ys, y, d0, d1, hi, lo, candles, times, data: d, tone };
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
function linePath(xs, ys, n) {
  let d = `M${f1(xs[0])},${f1(ys[0])}`;
  for (let i = 1; i < n; i++) d += `L${f1(xs[i])},${f1(ys[i])}`;
  return d;
}
function paintLine(xs, ys, n, bottom) {
  const line = linePath(xs, ys, n);
  C.ln.setAttribute('d', line);
  const area = `${line}L${f1(xs[n - 1])},${f1(bottom)}L${f1(xs[0])},${f1(bottom)}Z`;
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
      if (x - half < g.x0 + 2 || x + half > g.x1 - 2) continue;
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
  C.ohlc.style.translate = `${Math.round(g.x0 + 2)}px 2px`;
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
// while it is opening or open: one landing as the panel flies home would rewrite its words in flight.
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
  }, () => {
    if (!runLive(run)) return;
    ch.dayFailed = true;
    headLive(true);
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
// The line's length, as the pen's dash wants it.
function lineLength(g) {
  let L = 0;
  for (let i = 1; i < g.n; i++) L += Math.hypot(g.xs[i] - g.xs[i - 1], g.ys[i] - g.ys[i - 1]);
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
  // Back in place after a spring (or a press that let go of it): WebKit's glass coin goes on whole pixels again, and a
  // phone draws the share card it put off while the sheet moved.
  if (to === 'idle' && (from === 'settling' || from === 'armed')) { snapPanelCoin(); shareSoon(); }
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
    snapPanelCoin();
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
  panelLightKeep(true);
}
// The sheet let go of at once (any close).
function dragStop() {
  sheet.go('idle');
}
// A sheet whose content fits drags from anywhere; one that scrolls only from its top (the grabber and the header).
function sheetFits() {
  if (!PHONE.matches) return;
  P.body.classList.toggle('fits', P.body.scrollHeight <= P.body.clientHeight + 1);
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
  for (const a of P.band.getAnimations()) a.cancel();
  if (!lightsOn()) { glintPlay(P.band, 980, delay); return; }
  // Under the glass the glint is drawn by the light's job, with its bar of light on the glass.
  const L = panelLightOf();
  P.band.style.transform = '';
  L.glint = { band: P.band, t0: performance.now() + delay, dur: 980 };
  lightOn(L);
}
// A close puts the glint out as the coin turns to fly home. Left to run, it would sweep over the flying coin and vanish
// in one frame as the card takes over; and anything still moving inside the coin as its flight starts (even a fade)
// has Chromium draw the flying coin from other pixels than the card's, so it lands soft and sharpens with a jump.
function glintOff() {
  for (const a of P.band.getAnimations()) a.cancel();
  if (panelLight?.glint) { P.band.style.transform = ''; panelLight.glint = null; }
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
function shareChart(w, h) {
  if (!ch.data) return null;
  const g = geoFor(ch.data, w, h, SHARE_SCREEN);
  return { g, ...axisWords(g) };
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
  return {
    sym: item.symbol, name: item.name, exchange: tailOf(item), icon: ICON_URL.test(item.icon) ? item.icon : '',
    price, known: price !== NA,
    chg: chg.text, tone: item.stale ? '' : chg.tone, key: item.stale ? 'stale' : m.key,
    abs: Number.isFinite(m.abs) ? fmtMove(m.abs, item.price) : '',
    sess: lastSession(item) ? 'Last session' : '',
    size: ch.size, type: ch.type, theme,
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
  // A chart opened from the address is an interaction: the glass comes in at once, the coins' glass too. The panel is
  // solid in both themes, so it never waits for the glass.
  loadGlass();
  coinGlass();
  // The panel's coin is decoded before the panel fades in (a quarter of a second at most, the time one round trip for
  // its art takes on a phone), so a cold deep link never shows the panel without its coin, then the coin popping in.
  const icon = nodes.get(s)?.item?.icon;
  if (icon && P.icon.getAttribute('src') !== icon) { P.icon.setAttribute('src', icon); artWait(P.coin, P.icon); }
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
  grid.classList.add('js-cards');
  liftOnPixels();
  addEventListener('resize', liftOnPixels, { passive: true });
  chartBuild();
  // Esc is a key a mouse user presses too (to close the panel): it leaves the last way of pointing as it was, so a
  // panel opened by a click and closed by Esc gives its card quiet focus, and one opened from the keyboard its ring.
  addEventListener('keydown', (e) => { if (e.key !== 'Escape') keyed = true; }, true);
  addEventListener('pointerdown', () => { keyed = false; }, true);

  // The whole card opens its chart; selecting text on it with the mouse (to copy a price) does not. Enter and Space on
  // its button (a click with no detail) always open it, whatever is selected elsewhere.
  grid.addEventListener('click', (e) => {
    const li = e.target.closest?.('.card');
    if (!li || !grid.contains(li)) return;
    if (e.detail > 0) {
      const sel = getSelection?.();
      if (sel && !sel.isCollapsed && String(sel).trim() && (li.contains(sel.anchorNode) || li.contains(sel.focusNode))) return;
    }
    openPanel(li.getAttribute('data-sym'), 'click', e.detail === 0);
  });

  // Press feedback as a class (iOS only applies :active with a touch listener, and a scroll must cancel it): at once
  // for a mouse, after 50 ms for a finger, so a scroll that starts on a card does not flash it.
  let pressed = null;
  let pressTimer = 0;
  const unpress = () => { clearTimeout(pressTimer); pressed?.classList.remove('pressed'); pressed = null; };
  grid.addEventListener('pointerdown', (e) => {
    const li = e.target.closest?.('.card');
    if (!li || e.button !== 0 || REDUCED.matches) return;
    unpress();
    pressed = li;
    if (e.pointerType === 'mouse') li.classList.add('pressed');
    else pressTimer = setTimeout(() => li.classList.add('pressed'), 50);
    // A finger has no hover: the chart is asked for as it touches down, a tenth of a second before the tap opens it,
    // and the light on the coin's glass leans toward it while it presses.
    const s = li.getAttribute('data-sym');
    if (e.pointerType !== 'mouse' && nodes.has(s)) {
      prefetchHist(s);
      coinTouch(nodes.get(s), e.clientX, e.clientY);
    }
    guard.sample();
  });
  for (const t of ['pointerup', 'pointercancel']) addEventListener(t, () => { unpress(); coinUntouch(); }, true);

  // Hover: the coin turns toward the pointer, the light on its glass leans toward it, and a glint crosses it once; the
  // chart for the remembered candle size is fetched after 80 ms, so the panel usually opens with its data already here
  // (and the hourly candles the stats row's high and low come from, when another size is remembered).
  let hoverLi = null;
  let hoverRect = null;
  let prefetchTimer = 0;
  const prefetch = (li) => {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => { const s = li.getAttribute('data-sym'); if (nodes.has(s)) prefetchHist(s); }, 80);
  };
  const hoverEnd = () => {
    if (!hoverLi) return;
    const n = nodes.get(hoverLi.getAttribute('data-sym'));
    if (n) { unaim(n.refs.coin); coinLeave(n); }
    if (pressed === hoverLi) unpress();
    hoverLi = null;
    clearTimeout(prefetchTimer);
  };
  grid.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const li = e.target.closest?.('.card');
    if (li === hoverLi) return;
    hoverEnd();
    if (!li || !li.hasAttribute('data-sym')) return;
    hoverLi = li;
    hoverRect = li.getBoundingClientRect();
    prefetch(li);
    // The first card the pointer reaches: the frame guard measures the display's beat (once), and the coins' glass
    // comes on now if it has not yet.
    guard.sample();
    coinGlass();
    const n = nodes.get(li.getAttribute('data-sym'));
    if (n && FINE.matches && !REDUCED.matches && panel.is('closed')) coinHover(n, e.clientX, e.clientY);
  });
  grid.addEventListener('pointerout', (e) => {
    if (hoverLi && !hoverLi.contains(e.relatedTarget)) hoverEnd();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!hoverLi || e.pointerType !== 'mouse' || !FINE.matches || REDUCED.matches || !panel.is('closed')) return;
    const n = nodes.get(hoverLi.getAttribute('data-sym'));
    if (!n) return;
    const r = hoverRect;
    const nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
    const ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
    aim(n.refs.coin, -ny * 12, nx * 12, 180, 0.28);
    coinPoint(n, e.clientX, e.clientY);
    // The card's own light (dark only, the stylesheet's --hover-light) lies where the pointer is.
    hoverLi.style.setProperty('--c-mx', `${Math.round(e.clientX - r.left)}px`);
    hoverLi.style.setProperty('--c-my', `${Math.round(e.clientY - r.top)}px`);
  });
  grid.addEventListener('focusin', (e) => {
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

  // The coin follows the pointer while the panel is open (desktop): a few degrees, eased; and the light on its glass
  // leans toward the pointer, or a finger on the panel. Any move on the panel keeps its stars twinkling a while.
  dlg.addEventListener('pointermove', (e) => {
    if (!panel.is('open')) return;
    starsAwake();
    if (REDUCED.matches) return;
    if (e.pointerType !== 'mouse') {
      if (e.buttons) panelLightAim(e.clientX, e.clientY, false);
      return;
    }
    if (!FINE.matches) return;
    if (!coinCentre) measureCoin();
    const nx = clamp((e.clientX - coinCentre.x) / 480, -1, 1);
    const ny = clamp((e.clientY - coinCentre.y) / 360, -1, 1);
    aim(P.tilt, -ny * 9, nx * 9, 420, 0.45);
    panelLightAim(e.clientX, e.clientY, false);
  }, { passive: true });
  dlg.addEventListener('pointerdown', (e) => {
    if (!panel.is('open')) return;
    starsAwake();
    if (e.pointerType !== 'mouse' && !REDUCED.matches) panelLightAim(e.clientX, e.clientY, true);
  }, { passive: true });
  for (const t of ['pointerup', 'pointercancel']) dlg.addEventListener(t, (e) => { if (e.pointerType !== 'mouse') panelLightHome(); });
  dlg.addEventListener('pointerleave', () => { unaim(P.tilt); panelLightHome(); });
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
        if (PHONE.matches && panel.is('open') && P.body.classList.contains('fits')) dragBegin(e, touch.y, touch.t);
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
    if (panel.is('open')) { snapPanel(); measureCoin(); snapPanelCoin(); sheetFits(); fitMove(); }
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
logoNamed();
function storedTheme() {
  const v = recall(THEME_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}
// The chosen theme. The page draws it at once, except while a panel flies open (themeSettle).
let theme = storedTheme() ?? (rootEl.dataset.theme === 'light' ? 'light' : 'dark');
// Draws a theme: the stylesheet's tokens follow html[data-theme], the bars follow the meta.
// On paper the top bar draws both lockups on top of each other (the white one shows inside the logo's glass island):
// only the ink one is named there, so the name is read once.
function logoNamed() {
  const white = document.querySelector('.top .lockup-white');
  if (!white) return;
  if (rootEl.dataset.theme === 'dark') white.removeAttribute('aria-hidden');
  else white.setAttribute('aria-hidden', 'true');
}
function applyTheme(next) {
  rootEl.dataset.theme = next;
  logoNamed();
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = THEME_BAR[next];
  // A panel open across the change (another tab's): a painted veil is painted again on the new ground. The panel itself
  // is the same solid card in either theme, only its tokens change.
  if (PANEL && !panel.is('closed') && P.veil.classList.contains('painted')) G?.veilPaint();
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
  if (!G?.themeChange(theme, applyTheme, true) && rootEl.dataset.theme !== theme) swapTheme(theme);
});
// The page catches up with the chosen theme at once. A panel flying open lands first; panel.on (open, closed) calls
// this again.
function themeSettle() {
  if (panel.is('opening') || look.go('settled')) return;
  if (rootEl.dataset.theme !== theme) swapTheme(theme);
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
if (themeSwitch) {
  themeSwitch.setAttribute('aria-checked', String(theme === 'dark'));
  themeSwitch.addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
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
const GLASS_API = 4;
function glassApi() {
  return {
    version: GLASS_API,
    root: rootEl, sw: themeSwitch, P, dlg,
    wake,
    springFn, clamp,
    REDUCED, FINE, ENGINE, ASSETS,
    theme: () => theme, applyTheme,
    setSize, setType, setTheme,
    dock: dockSeg, setShow, toTop,
    glassSeg: document.querySelector('.top .seg-glass'), setGlass: (choice) => setGlass(choice),
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
    if (G && PANEL && panel.is('opening', 'open') && !P.veil.classList.contains('painted') && veilWantsPaint()) G.veilPaint();
    return G;
  });
}, 3000);
glassModule.on((to) => {
  if (to === 'ready') for (const t of GLASS_SOON) document.removeEventListener(t, glassSoon, true);
});
const loadGlass = () => glassModule.get();
const GLASS_SOON = ['pointerover', 'pointerdown', 'focusin', 'touchstart'];
function glassSoon(e) {
  const t = e.target;
  if (!t?.closest || !glassModule.is('idle', 'failed')) return;
  if (!t.closest('.top, .grid, #nfa-more, .dock')) return;
  if (!entrance.is('done') && !(e.type === 'pointerdown' && t.closest('.top, .grid .card'))) return;
  loadGlass();
}
for (const t of GLASS_SOON) document.addEventListener(t, glassSoon, { capture: true, passive: true });
function glassIdle() {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => loadGlass(), { timeout: 3000 });
  else setTimeout(loadGlass, 1200);
}
if (document.readyState === 'complete') glassIdle();
else addEventListener('load', glassIdle, { once: true });
// The coins' glass (coinGlass) comes on sooner: when the browser is next idle after the load, or 300 ms after it where
// there is no idle callback.
function coinGlassIdle() {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => coinGlass(), { timeout: 1000 });
  else setTimeout(coinGlass, 300);
}
if (document.readyState === 'complete') coinGlassIdle();
else addEventListener('load', coinGlassIdle, { once: true });

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
  scrollTo({ top: Math.max(0, y), behavior: REDUCED.matches ? 'auto' : 'smooth' });
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
  const b = glassSeg?.querySelector('button[aria-pressed="true"]');
  if (b) segPlace([[glassSeg, b.offsetLeft, b.offsetWidth]], animate, byUser);
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
