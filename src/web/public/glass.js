// Liquid glass in motion: the parts of the glass that only move when something is
// touched. app.js imports this module once the page has painted (or at the first touch of the top bar, the cards or the
// notice) and calls install(api) once. Until then, and wherever it never arrives, the page works without it: the glass
// at rest is the stylesheet's, the theme switch swaps at once and the segmented controls slide on their CSS spring.
// - The controls (the X link, the theme switch, the panel's cross, the notice's toggle): a pointer over one lifts it a
//   pixel on a longer shadow, lights it where the pointer is and turns its rim of light toward it; a press swells the
//   glass evenly, as UIKit's does, and blooms the light, a held press leans after the finger, and a release springs
//   back past rest and settles, on UIKit's own two springs.
// - The droplets (the chosen pill of the candle size and type controls, and the switch's): the leading edge leaves
//   first and the tail lets go late, so a droplet stretches as it travels, thins with speed, splats softly on the
//   track's end and rings once as it lands; a finger can drag it to another segment. Lifted, it clears to a lens (in
//   Chromium the lens magnifies the words under it).
// - The phone sheet's grabber widens as it is taken and stretches with the drag.
// - The painted veil: where the panel's backdrop cannot be blurred live (a lite view, a browser without backdrop
//   filters), the same material painted once into a small canvas.
// - The theme change: the new theme spreads out of the switch as a drop of liquid glass (a view transition).
// - The top bar: its controls flow into one body of glass with the scroll, and once the list's own bar is above the
//   window the list's switch joins them: the X link gives up its word, a gap springs open and the switch rises in.
// Everything moves in app.js's one frame loop (api.wake), and only while it moves: at rest this module writes nothing
// and the page is the stylesheet's again. No colour lives here; every one is a token in style.css.
// Every comment in this file sits on a line of its own: the server strips comment lines before serving it.

// The contract with app.js. A page from another deploy (an older app.js that imported this newer file) gets null and
// keeps working without the motion. 9: app.js hands over the list's switch's twin in the top bar and where its machine
// stands (api.viewTwin, api.viewAt), this module moves it in and out (viewJoin), says when the bar has room for it
// (viewRoom) and when it has landed (api.viewLanded); and what app.js's own machines hold is asked of them, never read
// off the page: the theme chosen and the one drawn now (api.theme, api.ground), whether the open panel keeps the
// light veil (api.lite), and the choice a placed pill stands for (dropPlace's value).
const API = 9;

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
// A part made ready only when first wanted (a lens, whose map must be fetched and decoded first):
// idle: not asked for yet; wait: asked for, its map on the way; ready: built and in use; none: never here (no real
// GPU, no map, a map that would not decode).
const READY = { idle: ['wait', 'none'], wait: ['ready', 'none'] };

export function install(api) {
  if (!api || api.version !== API || !api.root || typeof api.wake !== 'function') return null;
  const { root, sw, P, dlg, wake, clamp, REDUCED, FINE, ENGINE } = api;
  const FORCED = matchMedia('(forced-colors: active)');
  const CLEAR = matchMedia('(prefers-reduced-transparency: reduce)');
  const NS = 'http://www.w3.org/2000/svg';
  // Only this deploy's own lens maps, as server.js hands them over in the page's #assets.
  const asset = (u) => (typeof u === 'string' && /^\/glass\/[\w.-]+\.(png|webp)\?v=[0-9a-f]+$/.test(u) ? u : null);
  const K_LENS = asset(api.ASSETS?.kLens);
  const P_LENS = asset(api.ASSETS?.pLens);
  // The dock pill's lens, rebuilt on UIKit's own numbers (two maps, tools/glass/p/gen-pill.mjs). A page from before
  // them keeps the pickers' lens.
  const APPLE = [asset(api.ASSETS?.pApple), asset(api.ASSETS?.pAppleSplit)];
  const T_LENS = asset(api.ASSETS?.tLens);
  root.classList.add('glass-on');

  // ---- helpers ----
  const smooth = (t) => t * t * (3 - 2 * t);
  const f2 = (v) => v.toFixed(2);
  const f4 = (v) => v.toFixed(4);
  function mk(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.setAttribute('aria-hidden', 'true');
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }
  // Takes the motion's own properties off an element (and its style attribute, once that is empty).
  function unstyle(el, props) {
    for (const p of props) el.style.removeProperty(p);
    if (!el.getAttribute('style')) el.removeAttribute('style');
  }
  // SwiftUI's springs (response in s, damping fraction) as stiffness and damping for a unit mass, and one semi-implicit
  // Euler step of a value o[x] (its speed o[v]) toward a target.
  const spring = (response, damping) => ({ k: ((2 * Math.PI) / response) ** 2, c: (4 * Math.PI * damping) / response });
  function pull(o, x, v, target, s, h) {
    o[v] += (s.k * (target - o[x]) - s.c * o[v]) * h;
    o[x] += o[v] * h;
  }
  // A rubber band: it follows d at first, then gives less and less, never past max.
  const band = (d, max) => Math.sign(d) * max * (1 - Math.exp(-Math.abs(d) / max));

  // A spring object in app.js's frame loop: stepped 240 times a second (stable for the stiffest of these springs), drawn
  // once a frame and let go of (settled) once it is at rest, when the loop stops if nothing else moves. Whether it is in
  // the loop is a machine of its own, o.run: still (out of the loop, drawn where it settled) or moving (a job in the
  // loop, stepped every frame).
  const RUN_MOVES = { still: ['moving'], moving: ['still'] };
  const running = (o) => Boolean(o?.run?.is('moving'));
  function move(o) {
    if (!o.job) {
      o.run = machine('still', RUN_MOVES);
      o.job = (dt) => {
        if (!o.run.is('moving')) return false;
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let i = 0; i < n; i++) o.step(h);
        o.draw();
        if (!o.rest()) return true;
        o.run.go('still');
        o.settle();
        return false;
      };
    }
    o.run.go('moving');
    wake(o.job);
  }

  // ---- lenses: Chromium only, on a real GPU, and never before their map is decoded ----
  // One WebGL context, made and dropped once and only when a lens is first wanted, says whether this browser draws SVG
  // filters on a real GPU (a software renderer would draw a lens at a few frames a second). Every lens on the page asks
  // this one question.
  const WEAK = /SwiftShader|llvmpipe|Basic Render|Mali-G5|Adreno \(TM\) [1-5]/;
  let gpuOk = null;
  function gpu() {
    if (gpuOk !== null) return gpuOk;
    gpuOk = false;
    try {
      const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true, powerPreference: 'low-power' });
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpuOk = !WEAK.test(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || ''));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      gpuOk = false;
    }
    return gpuOk;
  }
  // A lens map is fetched and decoded before any filter is built on it: a lens over a map not yet there would shift
  // everything it covers by half its strength.
  const maps = new Map();
  function map(url) {
    let p = maps.get(url);
    if (!p) {
      const img = new Image();
      img.src = url;
      p = img.decode().then(() => url);
      maps.set(url, p);
    }
    return p;
  }
  // The glass's look, as app.js writes it on the page (html.glass-clear): frosted, an even blur that bends nothing, or
  // clear, which bends what is behind it through the rim lenses (the dock's, its round button's, the top bar's merged
  // body's). The stylesheet uses those lenses under html.glass-clear only, so their maps are not asked for under
  // frosted glass: whenClear(f) runs f at once under clear glass, or the first time the glass turns clear.
  const glassLook = machine(root.classList.contains('glass-clear') ? 'clear' : 'frosted', { frosted: ['clear'], clear: ['frosted'] });
  const clearWaits = [];
  glassLook.on((to) => { if (to === 'clear') for (const f of clearWaits.splice(0)) f(); });
  const whenClear = (f) => {
    if (glassLook.is('clear')) f();
    else clearWaits.push(f);
  };
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { glassLook.go(root.classList.contains('glass-clear') ? 'clear' : 'frosted'); }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }
  // The page's one SVG of filter definitions, made here when the page has none yet. Off screen, never display: none
  // (a filter inside an undisplayed SVG is not drawn).
  let defsEl = null;
  function defs() {
    defsEl ??= document.querySelector('svg.fx-defs');
    if (!defsEl) {
      defsEl = svgEl('svg', { class: 'fx-defs', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
      document.body.append(defsEl);
    }
    return defsEl;
  }

  // ==================================================================================================================
  // The glass of a control: press swell, finger follow, release wobble, hover lift and light, a rim that turns to the
  // light. The words move with the control's own transform; its glass body (::before and ::after) moves on top of that
  // with --g-bt, so it can swell more than the words and lean further after the finger.
  // ==================================================================================================================
  // UIKit's flex interaction (iOS 26.5, read off the system): glass up to 110pt long lifts by 16pt; longer glass by 16
  // down to 4 as its short side goes from 44 to 160pt. The glass and its content scale evenly by (long side + lift) /
  // long side.
  const flexLift = (w, h) => (Math.max(w, h) <= 110 ? 16 : 16 - 12 * clamp((Math.min(w, h) - 44) / 116, 0, 1));
  const GS = {
    // The press and the release are UIKit's own two springs (the numbers read off iOS 26.5): the rise is stiffness 541.54 with damping 29.09 (8% over at 0.17s), the release 246.74 with 11.78
    // (it dips 28% of the swell past rest at 0.22s, then settles). The others keep a damping of 0.7 or more.
    PRESS: spring(0.27, 0.625),
    LET: spring(0.4, 0.375),
    // the sheet's grabber easing back to its resting width
    EASE: spring(0.36, 0.72),
    // leaning after the finger
    FOLLOW: spring(0.26, 0.72),
    // the hover light and lift coming up and going
    LIGHT: spring(0.22, 1),
  };
  const GLASS_PROPS = ['transform', '--g-bt', '--g-h', '--g-l', '--g-mx', '--g-my', '--g-la'];
  // A control's glass, one machine per control (C.phase):
  // rest: nothing on it and still: the control is the stylesheet's alone;
  // over: a mouse pointer over it: lifted a pixel and lit where the pointer is (on its way there, or still);
  // down: held by a finger, a key, or a mouse that has left it: swelling to its pressed pose, or parked in it;
  // downOver: held with the mouse over it (let go, it stays lifted and lit);
  // back: let go, or left, with no pointer over it: springing back to rest.
  const GLASS_MOVES = {
    rest: ['over', 'down'],
    over: ['back', 'downOver'],
    down: ['back', 'downOver'],
    downOver: ['over', 'down', 'back'],
    back: ['rest', 'over', 'down'],
  };
  const glasses = [];
  // The controls in one of the two held states (kept by their machines, never by hand).
  const presses = new Set();
  // The light's strength, read from the control's own tokens once per theme (a read every frame would cost a style
  // pass). The control's own, not the page's: the smoke glass keeps dark's faint light on paper too, where the page's
  // token is the strong one white glass needs to show any light at all.
  const glowSeen = new WeakMap();
  function glow(el, which) {
    let seen = glowSeen.get(el);
    if (!seen || seen.theme !== api.ground()) {
      const cs = getComputedStyle(el);
      seen = { theme: api.ground(), hover: parseFloat(cs.getPropertyValue('--g-glow-hover')) || 0, press: parseFloat(cs.getPropertyValue('--g-glow-press')) || 0 };
      glowSeen.set(el, seen);
    }
    return seen[which];
  }
  // lens: a function the control's press strength (0 to 1) is handed every frame (the dock's round button turns into a
  // magnifier under a press).
  // The press swell is UIKit's (flexLift above): the glass and its words grow evenly. ratio: for the dock's bar alone,
  // the swell as a share of its own size (a tab bar on an iPhone grows by about 3%), its words left still.
  function glass(el, { press = true, lift = true, ratio = 0, leanX = 5, leanY = 3.5, lens = null } = {}) {
    const C = {
      el, press, lift, ratio, leanX, leanY, lens,
      p: 0, vp: 0, ox: 0, vox: 0, oy: 0, voy: 0, l: 0, vl: 0, ax: -0.5, ay: 0.866,
      px: 0, py: 0, w: 1, h: 1, cx: 0, cy: 0, mx: 50, my: 30, keyT: 0, keyRun: 0, tx: 0, ty: 0,
      phase: machine('rest', GLASS_MOVES),
      // Held (by any means), and with a mouse pointer over it.
      down: () => C.phase.is('down', 'downOver'),
      over: () => C.phase.is('over', 'downOver'),
      // Where a press leans it (after the finger, a few px at most), and where the rim's light turns: toward the pointer
      // while there is one, back to the top left after.
      aim() {
        const calm = REDUCED.matches;
        const down = C.down();
        const fx = down && !calm ? band((C.px - C.cx) * 0.22, C.leanX) : 0;
        const fy = down && !calm ? band((C.py - C.cy) * 0.22, C.leanY) : 0;
        let ax = -0.5;
        let ay = 0.866;
        if (!C.phase.is('rest', 'back') && FINE.matches) {
          const dx = C.px - C.cx;
          const dy = C.py - C.cy;
          const d = Math.hypot(dx, dy) || 1;
          ax = -dx / d;
          ay = -dy / d;
        }
        return { fx, fy, ax, ay };
      },
      step(h) {
        const a = C.aim();
        const down = C.down();
        pull(C, 'p', 'vp', down ? 1 : 0, down ? GS.PRESS : GS.LET, h);
        pull(C, 'ox', 'vox', a.fx, GS.FOLLOW, h);
        pull(C, 'oy', 'voy', a.fy, GS.FOLLOW, h);
        pull(C, 'l', 'vl', down ? 1 : C.over() ? 0.5 : 0, GS.LIGHT, h);
        C.ax += (a.ax - C.ax) * Math.min(1, h * 14);
        C.ay += (a.ay - C.ay) * Math.min(1, h * 14);
      },
      draw() {
        const calm = REDUCED.matches;
        const st = C.el.style;
        const p = calm ? 0 : C.p;
        // A hover lifts the glass whole (a pixel up, a longer shadow); a press keeps it lifted and swells it.
        const lifted = clamp(C.l * 2, 0, 1);
        if (C.press || C.lift) {
          // The glass and its words grow evenly, by UIKit's lift over the long side (a 36px circle to 52, a 143px
          // capsule to 159); the dock's bar by its own measured share, under words that stay still.
          const even = C.press && !C.ratio ? (flexLift(C.w, C.h) / Math.max(C.w, C.h)) * p : 0;
          const cs = 1 + even;
          const sx = cs + C.ratio * p + (Math.abs(C.ox) * 0.7) / C.w;
          const sy = cs + C.ratio * p + (Math.abs(C.oy) * 0.7) / C.h;
          C.tx = 0.3 * C.ox;
          C.ty = 0.3 * C.oy - (C.lift && !calm ? lifted : 0);
          st.transform = `translate(${f2(C.tx)}px, ${f2(C.ty)}px) scale(${f4(cs)})`;
          st.setProperty('--g-bt', `translate(${f2((0.25 * C.ox) / cs)}px, ${f2((0.25 * C.oy) / cs)}px) scale(${f4(sx / cs)}, ${f4(sy / cs)})`);
          st.setProperty('--g-h', lifted.toFixed(3));
        }
        const hover = glow(C.el, 'hover');
        const bloom = glow(C.el, 'press');
        const l = clamp(C.l, 0, 1.2);
        // On glass up to 110px long UIKit's press light is full strength: about 0.44 at the finger (0.39 at the glow's
        // peak once blurred, over a 0.05 wash) against 0.17 on longer glass, which is the token's 0.16. So small glass
        // takes 2.75 times the token, never past 1 (paper's token is already 0.9).
        const lit = Math.max(C.w, C.h) <= 110 ? Math.min(1, bloom * 2.75) : bloom;
        st.setProperty('--g-l', (l <= 0.5 ? hover * (l / 0.5) : hover + (lit - hover) * Math.min(1, (l - 0.5) / 0.5)).toFixed(3));
        if (C.lens) C.lens(clamp(p, 0, 1.15));
        st.setProperty('--g-mx', `${C.mx.toFixed(1)}%`);
        st.setProperty('--g-my', `${C.my.toFixed(1)}%`);
        st.setProperty('--g-la', `${((Math.atan2(-C.ax, C.ay) * 180) / Math.PI + 180).toFixed(1)}deg`);
      },
      // Still: at rest, or held still in its pressed pose (swollen, lit, leaning where the finger is), which the finger's
      // next move or its release wakes again.
      rest() {
        const a = C.aim();
        const down = C.down();
        const pose = down ? 1 : 0;
        return Math.abs(C.p - pose) < 0.002 && Math.abs(C.vp) < 0.02 && Math.abs(C.ox - a.fx) < 0.02 && Math.abs(C.oy - a.fy) < 0.02
          && Math.abs(C.vox) < 0.1 && Math.abs(C.voy) < 0.1
          && Math.abs(C.l - (down ? 1 : C.over() ? 0.5 : 0)) < 0.004 && Math.abs(C.vl) < 0.02
          && Math.abs(C.ax - a.ax) + Math.abs(C.ay - a.ay) < (C.phase.is('over') ? 9 : 0.004);
      },
      settle() {
        // Held: it keeps its pressed pose, drawn once more where it settled.
        if (C.down()) {
          C.vp = C.vox = C.voy = C.vl = 0;
          C.draw();
          return;
        }
        C.p = C.vp = C.ox = C.vox = C.oy = C.voy = 0;
        // Still under the pointer: it stays lifted and lit. Otherwise it is at rest: the stylesheet's alone again.
        if (C.over()) {
          C.l = 0.5;
          C.vl = 0;
          C.draw();
          return;
        }
        C.l = C.vl = 0;
        C.ax = -0.5;
        C.ay = 0.866;
        C.tx = C.ty = 0;
        C.phase.go('rest');
      },
    };
    // What follows from the state: a held control is in presses (the window's moves and releases reach it); a key's
    // own release timer lives only while it is held; at rest the motion's own properties come off.
    C.phase.on((to, from) => {
      const held = to === 'down' || to === 'downOver';
      if (held) presses.add(C);
      else presses.delete(C);
      if (!held && (from === 'down' || from === 'downOver')) clearTimeout(C.keyT);
      if (held && !(from === 'down' || from === 'downOver')) C.keyRun += 1;
      if (to === 'rest') {
        if (C.lens) C.lens(0);
        unstyle(C.el, GLASS_PROPS);
      }
    });
    // A pointer came over it, left it, pressed it (the moves the table allows from where it is; any other is no
    // change: a press on a held control, say).
    const enter = () => C.phase.go(C.down() ? 'downOver' : 'over');
    const leave = () => C.phase.go(C.down() ? 'down' : 'back');
    const hold = () => C.phase.go(C.over() ? 'downOver' : 'down');
    // Where the control is without the motion's own transform (which only translates it and scales it about its middle),
    // so the lean never chases itself.
    const measure = () => {
      const r = el.getBoundingClientRect();
      C.w = Math.max(1, el.offsetWidth);
      C.h = Math.max(1, el.offsetHeight);
      C.cx = r.left + r.width / 2 - C.tx;
      C.cy = r.top + r.height / 2 - C.ty;
    };
    const aimAt = (e) => {
      measure();
      C.px = e.clientX;
      C.py = e.clientY;
      C.mx = clamp(((e.clientX - (C.cx - C.w / 2)) / C.w) * 100, -20, 120);
      C.my = clamp(((e.clientY - (C.cy - C.h / 2)) / C.h) * 100, -20, 120);
    };
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || !FINE.matches) return;
      enter();
      aimAt(e);
      move(C);
    });
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse' || !C.over()) return;
      leave();
      move(C);
    });
    el.addEventListener('pointermove', (e) => {
      if (C.phase.is('rest', 'back')) return;
      aimAt(e);
      move(C);
    });
    if (press) {
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || FORCED.matches) return;
        aimAt(e);
        hold();
        move(C);
      });
      // The keyboard gets the same swell: a press while the key is down, a release when it comes up. A link takes Enter
      // only: Space on a link scrolls the page and activates nothing, so it must not swell the glass.
      el.addEventListener('keydown', (e) => {
        if (e.key === ' ' && el.tagName === 'A') return;
        if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || C.down() || FORCED.matches) return;
        measure();
        C.px = C.cx;
        C.py = C.cy;
        C.mx = 50;
        C.my = 50;
        hold();
        move(C);
        clearTimeout(C.keyT);
        // This press's own release: it gives up if the press it was set for has ended (or another has begun).
        const run = C.keyRun;
        C.keyT = setTimeout(() => { if (C.keyRun === run) letGo(C); }, e.key === 'Enter' ? 110 : 600);
      });
      el.addEventListener('keyup', () => letGo(C));
    }
    glasses.push(C);
    return C;
  }
  // The release: the body springs back past rest and settles (UIKit's release spring).
  function letGo(C) {
    if (!C.down()) return;
    C.phase.go(C.phase.is('downOver') ? 'over' : 'back');
    move(C);
  }
  const letAllGo = () => { for (const C of [...presses]) letGo(C); };
  addEventListener('pointerup', letAllGo, true);
  addEventListener('pointercancel', letAllGo, true);
  addEventListener('blur', letAllGo);
  // While held, the glass leans after the finger wherever it goes.
  addEventListener('pointermove', (e) => {
    for (const C of presses) {
      C.px = e.clientX;
      C.py = e.clientY;
      move(C);
    }
  }, { passive: true });

  // ==================================================================================================================
  // The droplets: one in each segmented control and one in the theme switch. A droplet is the element the stylesheet
  // draws at rest (.seg-ind, .theme-switch .drop, with its three layers: i the lifted shadow, b the resting glass, u the
  // clear lens); here only its place, size and shape move, and --g-e (how lifted it is) and --g-k (how held).
  // ==================================================================================================================
  const S = {
    // the edge that travels first
    LEAD: spring(0.24, 0.78),
    // the edge that lets go late
    TRAIL: spring(0.38, 0.8),
    // the tail once it has landed: the drop grabs its place
    LAND: spring(0.16, 0.85),
    // under a finger: close behind it
    DRAG: spring(0.12, 0.9),
    // thickness: thins with speed, bulges once on arrival
    HEIGHT: spring(0.22, 0.7),
    // a tap's swell
    SWELL: spring(0.2, 0.7),
    // a held press (or a drag) lifting it out of the track
    LIFT: spring(0.28, 0.72),
    // the shape's own give on arrival: one soft overshoot
    JELLY: spring(0.18, 0.7),
    // a capsule (the pickers' pill): its slide to a tapped segment and its snap after a drag, UIKit's two springs
    CAP_SLIDE: spring(0.41, 0.85),
    CAP_SNAP: spring(0.254, 0.983),
    // a switch's thumb, a capsule too: UIKit's travel spring (stiffness 452, damping 44.8: no overshoot, about 0.3s)
    CAP_SWITCH: spring(0.2955, 1.054),
  };
  const DK = {
    KICK: 0.1, SQUASH: 0.16, VREF: 1000,
    // px a tap adds to each side (inside the track, never past it), and more once held (lifted out of the track)
    TAP_X: 2, TAP_Y: 1, HOLD_X: 2, HOLD_Y: 2,
    // s a press must last to lift
    HOLD: 0.12,
    // px the near edge reaches toward a pressed segment before the click lands
    LEAN: 5,
    // how far the trailing end draws out into a tail when stretched
    TAIL: 0.55,
    // px an edge may sink into the track's end, and the height gained per px held back
    WALL: 1.2, SPLAT: 0.7,
    // the stretch (in resting widths) that counts as fully lifted
    LIFT_W: 0.6,
    // the lens on a tap or in flight, as a share of the held lens
    LENS_TAP: 0.4,
    // px of sideways travel that turns a press into a drag
    DRAG_AT: 4,
    // a capsule's soft body: how much longer and flatter at full flex, and the speed (px/s) that counts as full
    CAP_LONG: 0.14, CAP_FLAT: 0.23, CAP_VREF: 600,
  };
  // k-lens.png is a dome: 1.16x across and 1.10x up in its middle at full strength (0.035 of the box), easing to a gentle
  // squeeze at the rim. A droplet uses three quarters of it (about 1.12x and 1.075x), 3px inside its edge, so the seam
  // where the bending stops falls under the rim, never across a letter.
  const LENS_FULL = 0.035 * 0.75;
  const LENS_INSET = 3;
  const DROP_LENS = ENGINE.chromium && Boolean(K_LENS) && CSS.supports('backdrop-filter', 'url(#x)');
  const drops = [];
  // The droplets' lens is made ready at the first sign of use (a pointer over a droplet's control, a press, a panel
  // with them opening), and in use only once its map is decoded (READY's states); ready, every droplet gets its own.
  const dropLens = machine(DROP_LENS ? 'idle' : 'none', READY).on((to) => {
    if (to === 'ready') for (const D of drops) buildLens(D);
  });
  let lensN = 0;
  function wantDropLens() {
    if (!dropLens.go('wait')) return;
    if (!gpu()) {
      dropLens.go('none');
      return;
    }
    const ep = dropLens.epoch;
    Promise.all([map(K_LENS), ...(P_LENS ? [map(P_LENS)] : []), ...(APPLE.every(Boolean) ? APPLE.map(map) : [])]).then(() => {
      if (dropLens.epoch === ep) dropLens.go('ready');
    }, () => {
      if (dropLens.epoch === ep) dropLens.go('none');
    });
  }
  // The dock pill's lens: the pill's box in px (so the bends are exact), one bend for where the lens looks (both axes at
  // once), then red a step one way and blue the other along the dispersion map, green as it is; the three laid
  // together. Its sizes and strengths are set every frame (D.appleFx): the pill's box changes as it lifts.
  function buildApple(D) {
    const id = `drop-lens-${++lensN}`;
    const f = svgEl('filter', { id, x: 0, y: 0, width: 100, height: 60, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    const img = (href, result) => svgEl('feImage', { href, x: 0, y: 0, width: 100, height: 60, preserveAspectRatio: 'none', result });
    const m = img(APPLE[0], 'm');
    const a = img(APPLE[1], 'a');
    // Each bent picture is laid over the one before it, so a ray that would start outside the lens shows what is
    // there instead of nothing (a missing colour drew a hard cyan or magenta line on the rim).
    const bend = svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'm', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'b0' });
    // The dispersion as UIKit does it: the bent picture read at seven steps along the split map's reach, red taking
    // the three steps toward one end (weighted 1:2:3), blue the mirror, green the middle five (1:2:3:2:1), all
    // added up. So an edge fans out into a smooth run of colour, not into a red, a green and a blue copy (the two
    // steps give exactly those hard copies). Each step is one weighted picture, opaque, summed in turn.
    f.append(m, a, bend, svgEl('feComposite', { in: 'b0', in2: 'SourceGraphic', operator: 'over', result: 'b' }));
    const taps = [];
    const W6 = [0, 1 / 6, 2 / 6, 3 / 6];
    const W9 = [3 / 9, 2 / 9, 1 / 9, 0];
    let sum = '';
    for (let i = -3; i <= 3; i++) {
      const src = i === 0 ? 'b' : `t${i + 3}`;
      if (i !== 0) {
        const d = svgEl('feDisplacementMap', { in: 'b', in2: 'a', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: `u${i + 3}` });
        taps.push([d, i / 3]);
        f.append(d, svgEl('feComposite', { in: `u${i + 3}`, in2: 'b', operator: 'over', result: src }));
      }
      const wr = i > 0 ? W6[i] : 0;
      const wb = i < 0 ? W6[-i] : 0;
      const wg = W9[Math.abs(i)];
      f.append(svgEl('feColorMatrix', { in: src, type: 'matrix', values: `${wr} 0 0 0 0  0 ${wg} 0 0 0  0 0 ${wb} 0 0  0 0 0 0 1`, result: `w${i + 3}` }));
      if (sum) f.append(svgEl('feComposite', { in: sum, in2: `w${i + 3}`, operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: `s${i + 3}` }));
      sum = sum ? `s${i + 3}` : `w${i + 3}`;
    }
    f.append(svgEl('feColorMatrix', { in: sum, type: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1', result: 'mix' }),
      // The outer ring squeezes about 10px of the picture into 2, which comes out as speckle. The bent picture is
      // softened along the ring's straight top and bottom only (the map's blue channel says where): that is what
      // lets the two bands read as bands (with no blur at all the shorter base is lost). Never
      // the middle (a blur of the whole lens took the edge off the words inside it) and never the two round ends,
      // where the colour is.
      svgEl('feColorMatrix', { in: 'm', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0', result: 'ring' }),
      svgEl('feGaussianBlur', { in: 'mix', stdDeviation: 0.8, result: 'soft' }),
      svgEl('feComposite', { in: 'soft', in2: 'ring', operator: 'in', result: 'softRing' }),
      svgEl('feComposite', { in: 'softRing', in2: 'mix', operator: 'over' }));
    defs().append(f);
    D.fdm = [];
    // The maps were drawn for a lens 68px tall: a pill of another height bends in proportion. 40 and 26 are the
    // maps' full steps in px (gen-pill.mjs: AS and SS).
    D.appleFx = (w, h, lift) => {
      for (const n of [f, m, a]) { n.setAttribute('width', f2(w)); n.setAttribute('height', f2(h)); }
      const k = (h / 68) * lift;
      bend.setAttribute('scale', f2(40 * k));
      for (const [d, t] of taps) d.setAttribute('scale', f2(26 * k * t));
    };
    D.lens = mk('span', 'drop-lens');
    D.lens.style.backdropFilter = `url(#${id})`;
    D.host.append(D.lens);
  }
  function buildLens(D) {
    if (D.lens) return;
    if (D.opt.apple) { buildApple(D); return; }
    const id = `drop-lens-${++lensN}`;
    const f = svgEl('filter', { id, x: 0, y: 0, width: 1, height: 1, primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' });
    f.append(svgEl('feImage', { href: D.opt.map || K_LENS, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'map' }));
    // D.fdm: every bending step as [element, is it the upright one, its share of the strength].
    D.fdm = [];
    const split = D.opt.split || 0;
    if (!split) {
      const across = svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'B', result: 'across' });
      const up = svgEl('feDisplacementMap', { in: 'across', in2: 'map', scale: 0, xChannelSelector: 'B', yChannelSelector: 'G' });
      D.fdm.push([across, false, 1], [up, true, 1]);
      f.append(across, up);
    } else {
      // The dock's lens splits the light as thick glass does (the Photos bar on an iPhone): red is bent a little more
      // than green and blue a little less, each colour on its own pass, then the three are laid together again.
      const keep = { r: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', g: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', b: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' };
      for (const [c, share] of [['r', 1 + split], ['g', 1], ['b', 1 - split]]) {
        const across = svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'B', result: `a${c}` });
        const up = svgEl('feDisplacementMap', { in: `a${c}`, in2: 'map', scale: 0, xChannelSelector: 'B', yChannelSelector: 'G', result: `u${c}` });
        D.fdm.push([across, false, share], [up, true, share]);
        f.append(across, up, svgEl('feColorMatrix', { in: `u${c}`, type: 'matrix', values: keep[c], result: `c${c}` }));
      }
      f.append(svgEl('feBlend', { in: 'cr', in2: 'cg', mode: 'screen', result: 'rg' }), svgEl('feBlend', { in: 'rg', in2: 'cb', mode: 'screen' }));
    }
    defs().append(f);
    D.lens = mk('span', 'drop-lens');
    D.lens.style.backdropFilter = `url(#${id})`;
    D.host.append(D.lens);
  }
  function lensOff(D) {
    if (D.lens) D.lensUse.go('off');
  }
  // What a finger is doing to a droplet, one machine per droplet (D.hand):
  // free: nothing holds it;
  // pressed: a finger or a mouse is down on its control: it swells (a droplet also leans toward a pressed segment);
  // held: pressed for DK.HOLD: it lifts out of the track into its lens;
  // dragging: the finger has taken it DK.DRAG_AT sideways: it follows the finger, lifted.
  const HAND_MOVES = {
    free: ['pressed'],
    pressed: ['free', 'held', 'dragging'],
    held: ['free', 'pressed', 'dragging'],
    dragging: ['free', 'pressed'],
  };
  // Where a droplet is going, one machine per droplet (D.trip):
  // asleep: not run yet: the stylesheet draws it (a segmented control's pill perhaps part way through its own slide);
  // still: at its place (drawn there by app.js and the stylesheet, or parked in a pose under a finger);
  // sliding: on its way to a place it was given (a tap, a key, another tab), its tail on the trailing spring;
  // snapping: let go after a drag, on its way to the segment it was dropped over (a capsule on UIKit's snap spring);
  // landing: a droplet whose tail has caught up with its front and rung once: the tail grabs its place.
  const TRIP_MOVES = {
    asleep: ['still'],
    still: ['sliding', 'snapping'],
    sliding: ['still', 'landing', 'snapping'],
    snapping: ['still', 'landing', 'sliding'],
    landing: ['still', 'sliding', 'snapping'],
  };
  // How it is drawn, two machines per droplet, each set from a strength the springs reach (with the lens's own two
  // thresholds, so it never flickers on its edge): D.look flat or lifted (.lifted, and the dock's shorter base under
  // it), D.lensUse off or on (its lens shown, .on, bending).
  const LOOK_MOVES = { flat: ['lifted'], lifted: ['flat'] };
  const LENS_MOVES = { off: ['on'], on: ['off'] };
  function droplet(host, drop, opt) {
    const D = {
      host, drop, opt, seg: Boolean(opt.seg), lens: null, fdm: null,
      L: 0, R: 0, vL: 0, vR: 0, H: 26, vH: 0, s: 0, vs: 0, k: 0, vk: 0, held: 0, J: 0, vJ: 0, m: 0, vmax: 0,
      tL: 0, tR: 0, dir: 1, lean: 0, drag: null, swallowUntil: 0,
      x0: 0, y0: 0, top: 2, H0: 26, wallL: 2, wallR: 162, cells: [], ti: -1, prevTi: -1,
      hand: machine('free', HAND_MOVES),
      trip: machine('asleep', TRIP_MOVES),
      look: machine('flat', LOOK_MOVES),
      lensUse: machine('off', LENS_MOVES),
      step(h) { advance(D, h); },
      draw() { render(D); },
      rest() { return atRest(D); },
      settle() { settle(D, true); },
    };
    D.look.on((to) => {
      D.drop.classList.toggle('lifted', to === 'lifted');
      if (to === 'flat' && D.opt.pinch) {
        for (const v of ['--pinch', '--pinch-b', '--base-clip']) D.drop.style.removeProperty(v);
        D.host.style.removeProperty('--dock-cut');
      }
    });
    D.lensUse.on((to) => {
      if (to === 'on') {
        D.lens.classList.add('on');
        return;
      }
      D.lens.classList.remove('on');
      for (const [f] of D.fdm) f.setAttribute('scale', '0');
      unstyle(D.lens, ['transform', 'width', 'height', 'border-radius']);
    });
    drops.push(D);
    if (dropLens.is('ready')) buildLens(D);
    for (const t of ['pointerenter', 'focusin']) host.addEventListener(t, wantDropLens, { passive: true });
    return D;
  }
  // A finger is on it (pressed, held or dragging).
  const touched = (D) => !D.hand.is('free');
  // The track's own measures: its padding (or 2px) is the droplet's inset, the droplet as tall as the track's inside.
  // x0, y0: where the droplet's own box sits in the track (a segmented control's pill is placed at its padding, the
  // switch's droplet at the corner, moved by its transform).
  function geom(D) {
    const host = D.host;
    const cs = getComputedStyle(host);
    const pad = parseFloat(cs.paddingTop) || 2;
    D.top = pad;
    D.H0 = Math.max(1, host.clientHeight - 2 * pad);
    D.wallL = parseFloat(cs.paddingLeft) || pad;
    D.wallR = host.clientWidth - (parseFloat(cs.paddingRight) || pad);
    D.x0 = D.seg ? D.wallL : 0;
    D.y0 = D.seg ? D.top : 0;
  }
  // A droplet that is not running yet starts from wherever it is drawn: at rest, or part way through the stylesheet's
  // own slide (a segmented control's pill, the module having arrived in the middle of one). The switch's droplet never
  // gets here: install places it still (placeSw), and its stylesheet has no slide to be in the middle of.
  function adopt(D) {
    geom(D);
    D.cells = D.opt.cells();
    const cs = getComputedStyle(D.drop);
    let x = D.x0;
    if (D.seg) {
      const t = parseFloat(cs.translate);
      x = D.x0 + (Number.isFinite(t) ? t : 0);
    }
    const w = parseFloat(cs.width);
    D.L = D.tL = x;
    D.R = D.tR = x + (Number.isFinite(w) && w > 0 ? w : 40);
    D.H = D.H0;
    D.ti = cellAt(D, D.L, D.R);
    D.trip.go('still');
  }
  // Where the droplet should be: L and R in the track's px. still = no motion (a panel opening, a resize, reduced motion,
  // another tab's theme).
  // A place it already has (or is on its way to) is no move. That is judged against where the droplet is: in flight
  // the springs say so, and at rest its stored place is the drawn one (the switch's is kept so by syncSw below, since
  // at rest the stylesheet draws it wherever aria-checked puts it).
  function placeDrop(D, L, R, { still = false, byUser = false } = {}) {
    if (D.trip.is('asleep') && !still) adopt(D);
    geom(D);
    D.cells = D.opt.cells();
    const same = Math.abs(L - D.tL) < 0.01 && Math.abs(R - D.tR) < 0.01;
    if (same && !D.trip.is('asleep') && !still) return;
    const c0 = (D.L + D.R) / 2;
    const c1 = (L + R) / 2;
    D.prevTi = D.ti;
    D.tL = L;
    D.tR = R;
    D.ti = cellAt(D, L, R);
    if (still || D.trip.is('asleep') || document.hidden || FORCED.matches || REDUCED.matches) {
      D.run?.go('still');
      settle(D);
      return;
    }
    if (Math.abs(c1 - c0) > 0.5) D.dir = Math.sign(c1 - c0);
    D.lean = 0;
    // A new place is a slide, unless this is the place a drag just let go over (dropUp picks it inside the snap, and a
    // place given while the snap flies keeps it on the snap's spring, as before).
    if (!D.trip.is('snapping')) D.trip.go('sliding');
    D.vmax = 0;
    if (D.seg) retint(D, byUser);
    move(D);
    render(D);
  }
  function cellAt(D, L, R) {
    let best = -1;
    let d = Infinity;
    D.cells.forEach(([x, w], i) => {
      const e = Math.abs(x + w / 2 - (L + R) / 2);
      if (e < d) { d = e; best = i; }
    });
    return best;
  }
  // parked: the frame loop found it still. A droplet held still under a finger (swollen, lifted, leaning or where the
  // drag has it) keeps that pose, drawn once more; the finger's next move or its release wakes it again.
  function settle(D, parked = false) {
    if (parked && touched(D)) {
      Object.assign(D, { vL: 0, vR: 0, vH: 0, vs: 0, vk: 0, vJ: 0 });
      render(D);
      return;
    }
    Object.assign(D, { L: D.tL, R: D.tR, vL: 0, vR: 0, H: D.H0, vH: 0, m: 0, J: 0, vJ: 0 });
    D.trip.go('still');
    if (!touched(D)) Object.assign(D, { s: 0, vs: 0, k: 0, vk: 0 });
    clearTint(D);
    // Settled under a finger (a still placement while it is pressed): it stays swollen until the finger lets go.
    if (touched(D)) {
      render(D);
      return;
    }
    lensOff(D);
    D.look.go('flat');
    overAt(D, -1);
    D.opt.rest(D);
  }
  // The segment under a dragged droplet's middle (-1: none), told to the control (opt.over: its glyph shows as the
  // chosen one does) only when it changes.
  function overAt(D, i) {
    if (i === (D.oi ?? -1)) return;
    D.oi = i;
    D.opt.over?.(i);
  }
  function atRest(D) {
    // Held: still once it has lifted (nothing else would wake it to lift) and every spring has reached its held pose.
    if (touched(D)) {
      const a = aimOf(D);
      return a.lift === 1 && Math.abs(D.L - a.TLe) < 0.03 && Math.abs(D.R - a.TRe) < 0.03 && Math.abs(D.vL) < 1 && Math.abs(D.vR) < 1
        && Math.abs(D.H - D.H0) < 0.03 && Math.abs(D.vH) < 1 && Math.abs(D.s - 1) < 0.002 && Math.abs(D.vs) < 0.02
        && Math.abs(D.k - 1) < 0.002 && Math.abs(D.vk) < 0.02 && D.m > 0.99 && Math.abs(D.J) < 0.02 && Math.abs(D.vJ) < 0.5;
    }
    return Math.abs(D.L - D.tL) < 0.03 && Math.abs(D.R - D.tR) < 0.03 && Math.abs(D.vL) < 1 && Math.abs(D.vR) < 1
      && Math.abs(D.H - D.H0) < 0.03 && Math.abs(D.vH) < 1 && Math.abs(D.s) < 0.002 && Math.abs(D.vs) < 0.02
      && Math.abs(D.k) < 0.002 && Math.abs(D.vk) < 0.02 && D.m < 0.01 && Math.abs(D.J) < 0.02 && Math.abs(D.vJ) < 0.5 && !D.lean;
  }
  // ---- the physics (h is one substep) ----
  // Where the droplet's edges are going (leaning toward a pressed segment, or under a dragging finger), on which
  // springs, and how lifted it is (held long enough, or dragged).
  function aimOf(D) {
    const lift = D.hand.is('held', 'dragging') ? 1 : 0;
    if (D.hand.is('dragging')) {
      // Under the finger: the droplet's middle follows it, held back by a rubber band past the track's ends.
      const w = D.tR - D.tL;
      const lo = D.wallL + w / 2;
      const hi = D.wallR - w / 2;
      let c = D.drag.c0 + D.drag.dx;
      // reach: how far past the track's end the finger can pull it (6px; the dock's pill 24, as a tab bar's on iOS
      // follows the finger past the bar's end).
      const reach = D.opt.reach || 6;
      if (c < lo) c = lo - band(lo - c, reach);
      else if (c > hi) c = hi + band(c - hi, reach);
      if (D.opt.capsule) return { TLe: c - w / 2, TRe: c + w / 2, sL: S.DRAG, sR: S.DRAG, lift };
      const trail = D.opt.trail || S.TRAIL;
      return { TLe: c - w / 2, TRe: c + w / 2, sL: D.drag.v >= 0 ? trail : S.DRAG, sR: D.drag.v >= 0 ? S.DRAG : trail, lift };
    }
    // A capsule snaps to the segment a drag let go over and slides to any other place (the snap is that landing's
    // alone: left on until the next press, it would snap a key's move after a drag too).
    if (D.opt.capsule) { const sp = D.opt.travel || (D.trip.is('snapping') ? S.CAP_SNAP : S.CAP_SLIDE); return { TLe: D.tL, TRe: D.tR, sL: sp, sR: sp, lift }; }
    const tail = D.trip.is('sliding', 'snapping') ? D.opt.trail || S.TRAIL : S.LAND;
    return { TLe: D.tL + Math.min(D.lean, 0), TRe: D.tR + Math.max(D.lean, 0), sL: D.dir > 0 ? tail : S.LEAD, sR: D.dir > 0 ? S.LEAD : tail, lift };
  }
  function advance(D, h) {
    if (touched(D)) D.held += h;
    if (D.held >= DK.HOLD && D.hand.is('pressed')) D.hand.go('held');
    const { TLe, TRe, sL, sR, lift } = aimOf(D);
    const leadR = D.dir > 0;
    const gap0 = leadR ? D.L - TLe : TRe - D.R;
    pull(D, 'L', 'vL', TLe, sL, h);
    pull(D, 'R', 'vR', TRe, sR, h);
    // The tail catches up with the front: the liquid's momentum piles into the drop and it rings once.
    D.vmax = Math.max(D.vmax, Math.abs(leadR ? D.vL : D.vR));
    if (!D.drag && D.trip.is('sliding', 'snapping') && !D.opt.capsule && gap0 < 0 && (leadR ? D.L - TLe : TRe - D.R) >= 0) {
      D.vJ -= DK.KICK * D.vmax;
      D.trip.go('landing');
    }
    pull(D, 'J', 'vJ', 0, S.JELLY, h);
    const speed = Math.abs(D.vL + D.vR) / 2;
    // A capsule's soft body: longer and flatter with its speed, whole (D.flex is read when it is drawn).
    D.flex = D.opt.capsule ? Math.min(1, speed / DK.CAP_VREF) : 0;
    pull(D, 'H', 'vH', D.H0 * (1 - (D.opt.capsule ? DK.CAP_FLAT * D.flex : DK.SQUASH * Math.min(1, speed / DK.VREF))), S.HEIGHT, h);
    pull(D, 's', 'vs', touched(D) ? 1 : 0, S.SWELL, h);
    pull(D, 'k', 'vk', lift, S.LIFT, h);
    const stretch = Math.max(0, D.R - D.L - (D.tR - D.tL));
    const mT = clamp(Math.max(speed / 260, stretch / 10, D.s, D.k), 0, 1);
    D.m += (mT - D.m) * (1 - Math.exp(-h / (mT > D.m ? 0.02 : 0.045)));
  }
  // ---- drawing ----
  const wall = (d) => DK.WALL * (1 - Math.exp(-d / DK.WALL));
  function render(D) {
    const s = clamp(D.s, 0, 1);
    const k = Math.max(0, D.k);
    let eL = D.L;
    let eR = D.R;
    let squeeze = 0;
    // (A pill that may be pulled well past the end, the dock's, is not flattened against it while dragged.)
    const free = D.hand.is('dragging') && D.opt.reach > 6;
    if (!free && eL < D.wallL) { const d = D.wallL - eL; eL = D.wallL - wall(d); squeeze += d - wall(d); }
    if (!free && eR > D.wallR) { const d = eR - D.wallR; eR = D.wallR + wall(d); squeeze += d - wall(d); }
    // How much it grows: the house's few pixels, or the control's own (the dock's pill lifts well past its bar, held or
    // in flight, as the Photos bar's does).
    const G0 = D.opt.grow;
    const fly = G0 ? G0.fly * smooth(clamp(D.m, 0, 1)) : 0;
    const sx = (G0 ? G0.tx : DK.TAP_X) * s + (G0 ? G0.hx : DK.HOLD_X) * Math.max(k, fly);
    const sy = (G0 ? G0.ty : DK.TAP_Y) * s + (G0 ? G0.hy : DK.HOLD_Y) * Math.max(k, fly);
    // A capsule in motion is a little longer, about its middle.
    const long = D.opt.capsule ? (DK.CAP_LONG / 2) * (eR - eL) * (D.flex || 0) : 0;
    const L = eL - sx - D.J / 2 - long;
    const w = Math.max(1, eR + sx + D.J / 2 + long - L);
    const h = Math.max(1, D.H + Math.min(3, DK.SPLAT * squeeze) + 2 * sy - 0.7 * D.J);
    const y = D.top + (D.H0 - h) / 2;
    const w0 = Math.max(1, D.tR - D.tL);
    const speed = Math.abs(D.vL + D.vR) / 2;
    const stretch = Math.max(0, D.R - D.L - w0);
    const m = smooth(clamp(D.m, 0, 1));
    // A capsule always; stretched, the trailing end draws out into a tail.
    const ry = h / 2;
    const tail = ry * (1 + (D.opt.capsule ? 0 : DK.TAIL) * clamp(stretch / w0, 0, 1) * m);
    const [lx, rx] = D.dir > 0 ? [tail, ry] : [ry, tail];
    const st = D.drop.style;
    D.opt.at(st, L - D.x0, y - D.y0);
    st.width = `${f2(w)}px`;
    st.height = `${f2(h)}px`;
    st.borderRadius = `${f2(lx)}px ${f2(rx)}px ${f2(rx)}px ${f2(lx)}px / ${f2(ry)}px`;
    const e = smooth(clamp(Math.max(s, speed / 700, stretch / (DK.LIFT_W * w0), k, fly), 0, 1));
    st.setProperty('--g-e', e.toFixed(3));
    st.setProperty('--g-k', clamp(k, 0, 1).toFixed(3));
    D.look.go(e > 0.004 ? 'lifted' : 'flat');
    if (D.lens) {
      const le = clamp(Math.max(k, fly, DK.LENS_TAP * Math.max(s, Math.min(1, speed / 700))), 0, 1);
      const on = !CLEAR.matches && (D.lensUse.is('on') ? le > 0.015 : le > 0.03);
      if (on) {
        const I = D.opt.lensInset ?? LENS_INSET;
        const lw = Math.max(1, w - 2 * I);
        const lh = Math.max(1, h - 2 * I);
        const r = (v) => f2(Math.max(0, v - I));
        const ls = D.lens.style;
        ls.transform = `translate(${f2(L + I)}px, ${f2(y + I)}px)`;
        ls.width = `${f2(lw)}px`;
        ls.height = `${f2(lh)}px`;
        ls.borderRadius = `${r(lx)}px ${r(rx)}px ${r(rx)}px ${r(lx)}px / ${r(ry)}px`;
        const full = LENS_FULL * (D.opt.lens || 1) * le;
        // The dome's upright push is in proportion to the pill's height; a rim lens (opt.even) pushes as far up as across.
        if (D.appleFx) D.appleFx(lw, lh, le);
        for (const [f, upright, share] of D.fdm) f.setAttribute('scale', (upright && !D.opt.even ? (full * share * lh) / lw : full * share).toFixed(4));
        D.lensUse.go('on');
      } else lensOff(D);
    }
    if (D.seg) tint(D);
    // The dock's base is shorter under its lifted pill (style.css, "The base is shorter"): the bar's glass is cut away
    // under the whole pill (--dock-cut, a clip path on the bar's body and rim), and the pill draws that stretch of
    // base itself, 4px shorter at the top and the bottom (--pinch: how far below the pill's top it begins), so the
    // page shows in a band above and below it.
    if (D.opt.pinch) {
      // Under the dock's lens (where the browser can bend at all) the cut is shallower: the lens itself draws the base's edges about 3px further in, and
      // on its own that was too faint to see on this page (the bar is nearly the page's tone), so the drawn base and
      // its shaded bands stay, as on the kept pill.
      const PINCH = D.opt.apple && D.lens ? 2.5 : 6;
      if (e > 0.004) {
        const from = Math.max(0, PINCH * e - y);
        st.setProperty('--pinch', `${f2(from)}px`);
        st.setProperty('--pinch-b', `${f2(h - from)}px`);
        // The bar's body may be swollen by a press (--g-bt scales it about its middle): the cut is given in its own
        // space, so it lands on the pill whatever the swell.
        const sc = /scale\(([\d.]+)(?:,\s*([\d.]+))?\)/.exec(D.host.style.getPropertyValue('--g-bt') || '');
        const kx = sc ? Number(sc[1]) || 1 : 1;
        const ky = sc ? Number(sc[2] ?? sc[1]) || 1 : 1;
        const bw = D.host.clientWidth;
        const bh = D.host.clientHeight;
        const pt = (x, yy) => `${f2(bw / 2 + (x - bw / 2) / kx)}px ${f2(bh / 2 + (yy - bh / 2) / ky)}px`;
        const cy = y + h / 2;
        const pts = [];
        for (let i = 0; i <= 10; i++) { const a = Math.PI / 2 + (Math.PI * i) / 10; pts.push(pt(L + lx + lx * Math.cos(a), cy - ry * Math.sin(a))); }
        for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 10; pts.push(pt(L + w - rx + rx * Math.cos(a), cy - ry * Math.sin(a))); }
        // The stretch of base the pill draws stops where the bar does: it is cut to the bar's own capsule (as swollen
        // by a press), given in the pill's box. Past the bar's end the pill is only its lens over the page, so the
        // bar's round end shows inside it, as on iOS (a base run across the pill's whole width makes a pill pulled
        // past the end look as if the bar stretched with it).
        const hx2 = (bw / 2) * kx;
        const hy2 = (bh / 2) * ky;
        st.setProperty('--base-clip', `inset(${f2(bh / 2 - hy2 - y)}px ${f2(L + w - (bw / 2 + hx2))}px ${f2(y + h - (bh / 2 + hy2))}px ${f2(bw / 2 - hx2 - L)}px round ${f2(hy2)}px)`);
        const box = ['-80px -80px', `${bw + 80}px -80px`, `${bw + 80}px ${bh + 80}px`, `-80px ${bh + 80}px`, '-80px -80px'];
        D.host.style.setProperty('--dock-cut', `polygon(evenodd, ${[...box, ...pts, pts[0]].join(',')})`);
      }
      // (Flat again, the base is whole: D.look takes the cut away.)
    }
    // While it is dragged, the segment under its middle is told.
    overAt(D, D.hand.is('dragging') ? cellAt(D, D.L, D.R) : -1);
  }
  // A press on the control: the droplet swells (and leans toward the pressed segment), lifts if held, and may be dragged.
  function dropPress(D, e, cell) {
    if (e.button !== 0 || FORCED.matches) return;
    if (D.trip.is('asleep')) adopt(D);
    wantDropLens();
    D.cells = D.opt.cells();
    if (D.seg) {
      // The labels' colours as they are drawn now (the pressed one in its hover grey), for the colour crossing.
      D.cap = D.opt.btns().map((b) => rgbOf(getComputedStyle(b).color));
      D.capAt = performance.now();
    }
    if (!REDUCED.matches) {
      D.hand.go('pressed');
      D.held = 0;
      const [bx, bw] = D.cells[cell] || [0, 0];
      const bc = bx + bw / 2;
      const tc = (D.tL + D.tR) / 2;
      D.lean = !D.opt.capsule && Math.abs(bc - tc) > 1 ? Math.sign(bc - tc) * DK.LEAN : 0;
      if (D.lean) D.dir = Math.sign(D.lean);
      // A press takes over a snap in flight: the rest of the way is a slide.
      if (D.trip.is('snapping')) D.trip.go('sliding');
    }
    // A new pointer's record (a drag it may become starts from here; a drag another pointer had is over).
    D.drag = { id: e.pointerId, x0: e.clientX, dx: 0, v: 0, c0: (D.tL + D.tR) / 2, ok: D.opt.canDrag(cell), lastX: e.clientX, lastT: e.timeStamp };
    if (D.hand.is('dragging')) D.hand.go('pressed');
    move(D);
  }
  function dropMove(D, e) {
    const g = D.drag;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.v = 0.7 * g.v + 0.3 * ((e.clientX - g.lastX) / dt) * 1000;
    g.lastX = e.clientX;
    g.lastT = e.timeStamp;
    if (!D.hand.is('dragging') && g.ok && Math.abs(dx) > DK.DRAG_AT && !REDUCED.matches && D.hand.go('dragging')) {
      D.lean = 0;
      try {
        D.host.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety: the window still hears the finger.
      }
    }
    if (D.hand.is('dragging')) {
      g.dx = dx;
      if (Math.abs(g.v) > 30) D.dir = Math.sign(g.v);
      move(D);
    }
  }
  function dropUp(D, e, cancelled) {
    const g = D.drag;
    if (!g || g.id !== e.pointerId) return;
    const dragged = D.hand.is('dragging');
    D.drag = null;
    D.hand.go('free');
    D.lean = 0;
    if (dragged && !cancelled) {
      // Dropped: the segment under its middle (a flick carries it one further) is picked.
      const c = (D.L + D.R) / 2 + clamp(g.v * 0.06, -24, 24);
      let best = 0;
      let d = Infinity;
      D.cells.forEach(([x, w], i) => {
        const q = Math.abs(x + w / 2 - c);
        if (q < d) { d = q; best = i; }
      });
      D.trip.go('snapping');
      D.vmax = 0;
      if (best !== D.ti) D.opt.pick(best);
      else D.dir = Math.sign((D.tL + D.tR) / 2 - (D.L + D.R) / 2) || D.dir;
      // The pointer's own click, which follows this release (on a phone a moment later), must not pick again.
      D.swallowUntil = performance.now() + 350;
    }
    move(D);
  }
  addEventListener('pointermove', (e) => { for (const D of drops) dropMove(D, e); }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) {
    addEventListener(type, (e) => {
      for (const D of drops) {
        dropUp(D, e, type === 'pointercancel');
        if (touched(D) && !D.drag) {
          D.hand.go('free');
          D.lean = 0;
          move(D);
        }
      }
    }, true);
  }
  // A click the droplet's own drag ends with goes no further: the drag already picked.
  const swallowClick = (D) => (e) => {
    if (performance.now() > D.swallowUntil) return;
    D.swallowUntil = 0;
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  // ---- the segmented controls: only the label the droplet leaves and the one it reaches change colour ----
  const segDrops = new Map();
  const rgbOf = (s) => (String(s).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  let probe = null;
  function colour(host, value) {
    if (!probe) {
      probe = mk('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
    }
    probe.style.color = value;
    host.append(probe);
    const c = rgbOf(getComputedStyle(probe).color);
    probe.remove();
    return c;
  }
  // The two labels cross at half the travel; labels it passes keep their grey (the accent is scarce).
  function retint(D, byUser) {
    const bs = D.opt.btns();
    const on = colour(D.host, 'var(--g-on)');
    const off = colour(D.host, 'var(--g-off, var(--muted-c))');
    const o = D.prevTi;
    const n = D.ti;
    const cap = byUser && D.cap && performance.now() - D.capAt < 2000 ? D.cap : null;
    D.c0 = (D.L + D.R) / 2;
    D.c1 = (D.tL + D.tR) / 2;
    D.col ||= [];
    D.cFrom = [];
    D.cTo = [];
    bs.forEach((b, i) => {
      if (!D.col[i] && i !== o && i !== n) return;
      D.cFrom[i] = D.col[i] || (cap ? cap[i] : i === o ? on : off);
      D.cTo[i] = i === n ? on : off;
    });
  }
  function tint(D) {
    if (!D.cFrom || !running(D)) { clearTint(D); return; }
    const span = D.c1 - D.c0;
    const p = Math.abs(span) > 4 ? clamp(((D.L + D.R) / 2 - D.c0) / span, 0, 1) : 1;
    const x = smooth(clamp((p - 0.25) / 0.5, 0, 1));
    D.opt.btns().forEach((b, i) => {
      if (!D.cFrom[i]) return;
      const c = D.cFrom[i].map((v, j) => v + (D.cTo[i][j] - v) * x);
      D.col[i] = c;
      b.style.color = `rgb(${c.map(Math.round).join(' ')})`;
    });
  }
  function clearTint(D) {
    D.cFrom = null;
    if (!D.col) return;
    D.opt.btns().forEach((b, i) => {
      if (!D.col[i]) return;
      D.col[i] = null;
      unstyle(b, ['color']);
    });
  }
  // The panel's two controls, the dock, the top bar's glass switch, the list's board-or-tiles switch and that switch's
  // twin in the top bar (a page from before any of them has none).
  const twoCell = (seg) => seg === api.glassSeg || seg === api.viewSeg || seg === api.viewTwin;
  for (const seg of [P?.segS, P?.segT, api.dock, api.glassSeg, api.viewSeg, api.viewTwin]) {
    const ind = seg?.querySelector('.seg-ind');
    if (!ind) continue;
    const btns = () => [...seg.querySelectorAll('button')];
    const picker = seg === P?.segS || seg === P?.segT;
    const D = droplet(seg, ind, {
      seg: true,
      // The dock's pill is the showpiece: held or in flight it lifts about 10px past itself all round (so it stands proud
      // of its bar, about 1.25 times its height). Its lens is its own (p-lens.png), read off a recording of the real bar
      // frame by frame: flat in the middle, so the word inside it stays crisp and steady, and bending only at its rim, where
      // each colour is bent a touch differently, so the letters the rim crosses go wavy with a little colour, as on the
      // real bar. (The droplets' dome, doubled, with a colour split over the whole word, makes "All Coins Stocks"
      // wobble and go soft while the pill is held, which the real bar never does.)
      // The panel's two pickers move the same way, in proportion (on iOS the Health app's D W M 6M Y looks plain at
      // rest and, moved, behaves as a tab bar's pill does, which is how the dock's moves):
      // held or in flight the pill stands about a quarter of its height proud of the track all round and bends the
      // labels at its rim. Its look while it moves stays the picker's own (the light pill going clear).
      // (The dock's pill stands 4px proud of its bar, held or in flight: on the iOS tab bar it follows, the pill is
      // 72pt on a 64pt bar. Its lens is gentler than the pickers' for the same reason: the bands the shorter base
      // leaves are about 10px, and a rim that throws further than that fills them in.)
      // (The panel's two pickers are UIKit's segmented control, whose lens is the tab bar's but moves as a capsule, not
      // as a droplet. See capsule below. Lifted, their pill stands 12px past itself across and 8 up and down, as
      // UIKit's does: 78 by 44 from a 54 by 28 pill.)
      ...(seg === api.dock ? { grow: { tx: 3, ty: 2, hx: 12, hy: 6, fly: 0.85 } } : picker ? { grow: { tx: 2, ty: 1.5, hx: 10, hy: 6.5, fly: 0.85 } } : { grow: { tx: 2, ty: 1.5, hx: 8.5, hy: 5.7, fly: 0.85 } }),
      ...(P_LENS ? { map: P_LENS, even: true, lens: seg === api.dock ? 3.5 : 8, split: seg === api.dock ? 0.34 : 0.12 } : { lens: 0.9 }),
      btns,
      cells: () => btns().map((b) => [b.offsetLeft, b.offsetWidth]),
      canDrag: (i) => i === D.ti,
      pinch: seg === api.dock,
      // Every pill that can be moved lifts into the same lens (on iOS 26 the segmented control's selection, the
      // switch's thumb and the tab bar's selection are one liquid lens). The maps bend in proportion
      // to the pill's height, so a 43px picker pill bends about two thirds as far as the dock's 70px one.
      apple: Boolean(APPLE.every(Boolean)),
      // The dock's lens reaches the pill's very edge: 3px in (the others' inset, which keeps their rim unbent) left a
      // ring between the pill's outline and where the bending began, which read as a second outline.
      lensInset: 0,
      ...(seg === api.dock ? { reach: 24 } : {}),
      // capsule: the pill keeps its capsule shape as it moves (UIKit's segmented control, read off iOS 26.5): both ends
      // travel together, so it never draws out into a tail or leans toward a pressed segment; it only stretches a
      // little with its speed (up to 14% longer and 23% flatter on a tapped slide), slides to a tapped segment on
      // stiffness 235 with damping 26 (3% over, 0.41s), follows a dragging finger one to one and snaps to the segment
      // it is let go over without overshoot (613 with 48.7, 0.25s).
      // (The top bar's glass switch is a capsule too, on a switch's travel spring: a 60px track gives a droplet no room,
      // and on iOS a switch's thumb is a solid capsule. Only the dock's pill stays the fluid droplet. Lifted, a switch's thumb stands 10.5px past itself across and 7.2 up
      // and down, as UIKit's 37 by 24 thumb lifts to 58 by 38.)
      // (The list's board-or-tiles switch and its twin in the top bar are the same two-cell switch: the same capsule on
      // the same travel spring.)
      capsule: picker || twoCell(seg),
      ...(twoCell(seg) ? { travel: S.CAP_SWITCH } : {}),
      // Dragged over a segment, its glyph is the filled one before the finger lets go (as on an iOS tab bar); the
      // stylesheet draws it from these two classes.
      over: (i) => {
        seg.classList.toggle('tracking', i >= 0);
        btns().forEach((b, j) => b.classList.toggle('over', j === i));
      },
      pick: (i) => {
        const b = btns()[i];
        if (b?.dataset.i) api.setSize(b.dataset.i);
        else if (b?.dataset.t) api.setType(b.dataset.t);
        else if (b?.dataset.k) api.setShow?.(b.dataset.k);
        else if (b?.dataset.g) api.setGlass?.(b.dataset.g);
        else if (b?.dataset.v) api.setView?.(b.dataset.v);
        move(D);
      },
      // The stylesheet's own slide is off while the droplet moves here (its translate is written every frame).
      at: (st, x, y) => {
        if (st.transition !== 'none') st.transition = 'none';
        st.translate = `${f2(x)}px ${f2(y)}px`;
      },
      // At rest the droplet keeps exactly what app.js writes there, its place and its width, and the stylesheet's
      // slide comes back (after a style pass, so it does not slide the last fraction of a pixel itself).
      rest: (d) => {
        const st = ind.style;
        st.transition = 'none';
        st.translate = `${d.tL - d.x0}px 0`;
        st.width = `${d.tR - d.tL}px`;
        for (const p of ['height', 'border-radius', '--g-e', '--g-k']) st.removeProperty(p);
        void getComputedStyle(ind).translate;
        st.transition = '';
      },
    });
    segDrops.set(seg, D);
    seg.addEventListener('pointerdown', (e) => {
      const b = e.target.closest?.('button');
      if (!b) return;
      dropPress(D, e, btns().indexOf(b));
    });
    seg.addEventListener('click', swallowClick(D), true);
  }
  // app.js placed a segmented control's pill (segPlace): the droplet goes there. x and w are the chosen segment's, and
  // value is what that segment stands for, as app.js's own machine for the choice says it (the glass switch, the dock
  // and the list's board-or-tiles switch; the panel's two controls pass none): a choice made by the viewer is answered
  // on that value's glyph.
  function dropPlace(seg, x, w, { still = false, byUser = false, value = '' } = {}) {
    const D = segDrops.get(seg);
    if (!D || !Number.isFinite(x) || !Number.isFinite(w)) return false;
    placeDrop(D, x, x + w, { still, byUser });
    if (!byUser || still || !value) return true;
    if (seg === api.glassSeg) glyphPop(value);
    else if (seg === api.dock) glyphPop(`dock:${value}`);
    else if (seg === api.viewSeg || seg === api.viewTwin) glyphPop(`view:${value}`, seg);
    return true;
  }

  // ---- the theme switch: its droplet over the sun (light) or the moon (dark), and the chosen glyph answering ----
  const swDropEl = sw?.querySelector('.drop');
  let swD = null;
  if (sw && swDropEl) {
    // The droplet's width at rest, the stylesheet's (nothing has moved it yet).
    const W = parseFloat(getComputedStyle(swDropEl).width) || 32;
    swD = droplet(sw, swDropEl, {
      // A capsule, as the glass switch beside it and the pickers are (see the segmented controls below): both ends
      // travel together on a switch's travel spring; no tail, no lean.
      capsule: true,
      travel: S.CAP_SWITCH,
      // The switch is a slider too: held or in flight its pill behaves as the dock's and the
      // pickers' do, in proportion: it stands proud of its track all round and bends the sun and the moon at its rim.
      grow: { tx: 2, ty: 1.5, hx: 8.5, hy: 5.7, fly: 0.85 },
      ...(P_LENS ? { map: P_LENS, even: true, lens: 8, split: 0.12 } : { lens: 0.9 }),
      // The switch's thumb lifts into the same lens as the dock's pill (see the segmented controls below).
      apple: Boolean(APPLE.every(Boolean)),
      lensInset: 0,
      cells: () => [[swD.wallL, W], [swD.wallR - W, W]],
      canDrag: () => true,
      over: (i) => {
        sw.classList.toggle('tracking', i >= 0);
        if (i >= 0) sw.dataset.over = i === 1 ? 'dark' : 'light';
        else delete sw.dataset.over;
      },
      pick: (i) => api.setTheme(i === 1 ? 'dark' : 'light'),
      at: (st, x, y) => { st.transform = `translate(${f2(x)}px, ${f2(y)}px)`; },
      // At rest the stylesheet draws it, by aria-checked.
      rest: () => unstyle(swDropEl, ['transform', 'width', 'height', 'border-radius', '--g-e', '--g-k']),
    });
    geom(swD);
    sw.addEventListener('pointerdown', (e) => dropPress(swD, e, e.clientX - sw.getBoundingClientRect().left > sw.clientWidth / 2 ? 1 : 0));
    sw.addEventListener('click', swallowClick(swD), true);
    glass(sw, { press: false, lift: false });
  }
  function placeSw(still) {
    if (!swD) return;
    geom(swD);
    const [[x0, w], [x1]] = swD.opt.cells();
    const x = api.theme() === 'dark' ? x1 : x0;
    placeDrop(swD, x, x + w, { still, byUser: !still });
  }
  placeSw(true);
  // At rest the switch's droplet is the stylesheet's, drawn wherever aria-checked puts it, and app.js may turn the
  // switch without telling this module (a theme change it defers while a panel flies open). Its stored place follows
  // what is drawn, so the next change starts from where the droplet shows (started from the side it was last sent to,
  // a press would jump it across and the change that followed would not travel). Only at rest: in
  // flight, or under a finger, the springs draw it and placeSw has already sent it on.
  function syncSw() {
    if (!swD || running(swD) || touched(swD) || !swD.trip.is('still')) return;
    const [[x0, w], [x1]] = swD.opt.cells();
    const x = api.theme() === 'dark' ? x1 : x0;
    if (Math.abs(x - swD.tL) > 0.01 || Math.abs(x + w - swD.tR) > 0.01) placeDrop(swD, x, x + w, { still: true });
  }
  if (swD && typeof MutationObserver === 'function') new MutationObserver(syncSw).observe(sw, { attributes: true, attributeFilter: ['aria-checked'] });
  // The newly chosen glyph answers, as SF Symbols do: the sun's rays turn in and spring out, the moon rocks and settles.
  // The glass switch's two rings answer the same way, beside a sun and a moon that do: the frosted ring turns in and springs out as the sun's rays do, the clear one rocks as the moon does.
  function glyphPop(next, seg = api.viewSeg) {
    if (REDUCED.matches || FORCED.matches) return;
    const dur = 700;
    const N = 42;
    const keys = (response, damping, frame) => {
      const f = api.springFn({ response, damping });
      const out = [];
      for (let i = 0; i <= N; i++) out.push(frame(i === N ? 1 : f(((i / N) * dur) / 1000)));
      return out;
    };
    const opts = { duration: dur, easing: 'linear' };
    if (next.startsWith('dock:')) {
      // Each in its own way: the globe pops and makes a half turn; the coins rock and settle; the bars fill one after
      // another, short to tall; the ingots drop and stack one by one, the two below first and the third on top. The
      // parts are the filled glyph's own shapes (the stylesheet gives each its own box to turn in), a step of 80 ms
      // apart, inside the same 700 ms as every other answer.
      const kind = next.slice(5);
      const glyph = api.dock?.querySelector(`button[data-k="${kind}"] svg`);
      const parts = glyph ? [...glyph.querySelectorAll('.ic-f > *')] : [];
      const later = (i) => ({ ...opts, delay: i * 80, fill: 'backwards' });
      if (kind === 'all') {
        // The half turn is the meridians': each closes to a line and swings open past its place, about its own middle
        // (.mer: the outline's ellipse, and the one cut out of the filled disc, inside its mask).
        glyph?.animate(keys(0.42, 0.55, (v) => ({ transform: `scale(${f4(0.72 + 0.28 * v)})` })), opts);
        for (const mer of glyph?.querySelectorAll('.mer') ?? []) mer.animate(keys(0.55, 0.5, (v) => ({ transform: `scaleX(${f4(-1 + 2 * v)})` })), opts);
      } else if (kind === 'coin') glyph?.animate(keys(0.5, 0.42, (v) => ({ transform: `rotate(${f2(-38 * (1 - v))}deg) scale(${f4(0.78 + 0.22 * v)})` })), opts);
      else if (kind === 'stock') {
        parts.forEach((bar, i) => bar.animate(keys(0.3, 0.62, (v) => ({ transformOrigin: '50% 100%', transform: `scaleY(${f4(Math.max(0, v))})` })), later(i)));
      } else {
        // parts: the top ingot, then the lower left and the lower right; they land in the order they would be stacked
        [parts[1], parts[2], parts[0]].forEach((bar, i) => bar?.animate(keys(0.3, 0.6, (v) => ({ transform: `translateY(${f2(-9 * (1 - v))}px)`, opacity: f4(Math.min(1, Math.max(0, v) * 2)) })), later(i)));
      }
      return;
    }
    // The board-or-tiles switch's glyphs ('view:board', 'view:tiles'). Tiles: the grid turns in. Board: the glyph pops
    // whole while its three bars settle from the bottom one up, 60 ms apart; each travels less than the gap to its
    // neighbour and lands without a bounce, so no bar ever crosses another's place. seg: the switch that answers, the
    // list's own or its twin in the top bar.
    if (next.startsWith('view:')) {
      const kind = next.slice(5);
      const glyph = seg?.querySelector(`button[data-v="${kind}"] svg`);
      if (kind === 'tiles') glyph?.animate(keys(0.42, 0.55, (v) => ({ transform: `rotate(${f2(-90 * (1 - v))}deg) scale(${f4(0.6 + 0.4 * v)})` })), opts);
      else if (kind === 'board') {
        const bars = glyph ? [...glyph.querySelectorAll('.ic-f > *')] : [];
        glyph?.animate(keys(0.42, 0.55, (v) => ({ transform: `scale(${f4(0.8 + 0.2 * v)})` })), opts);
        [bars[2], bars[1], bars[0]].forEach((bar, i) => bar?.animate(keys(0.32, 0.9, (v) => ({ transform: `translateY(${f2(-2.4 * (1 - v))}px)`, opacity: f4(Math.min(1, 0.35 + Math.max(0, v) * 1.3)) })), { ...opts, delay: i * 60, fill: 'backwards' }));
      }
      return;
    }
    if (next === 'frosted' || next === 'clear') {
      const ring = api.glassSeg?.querySelector(`button[data-g="${next}"] svg`);
      if (next === 'frosted') ring?.animate(keys(0.42, 0.55, (v) => ({ transform: `rotate(${f2(-60 * (1 - v))}deg) scale(${f4(0.6 + 0.4 * v)})` })), opts);
      else ring?.animate(keys(0.5, 0.42, (v) => ({ transform: `rotate(${f2(-38 * (1 - v))}deg) scale(${f4(0.78 + 0.22 * v)})` })), opts);
      return;
    }
    if (!sw) return;
    if (next === 'light') {
      sw.querySelector('.sun-rays')?.animate(keys(0.42, 0.55, (v) => ({ transform: `rotate(${f2(-60 * (1 - v))}deg) scale(${f4(0.4 + 0.6 * v)})` })), opts);
      sw.querySelector('.sun-core')?.animate(keys(0.34, 0.5, (v) => ({ transform: `scale(${f4(0.7 + 0.3 * v)})` })), opts);
    } else {
      sw.querySelector('.moon-crescent')?.animate(keys(0.5, 0.42, (v) => ({ transform: `rotate(${f2(-38 * (1 - v))}deg) scale(${f4(0.78 + 0.22 * v)})` })), opts);
    }
  }

  // ---- the other controls ----
  // The X link leans at most 2px sideways: its swell is 8px a side now, and the switch is 10px away.
  const xlink = document.querySelector('.top .xlink');
  if (xlink) glass(xlink, { leanX: 2 });
  // The hero's links to the tools move as the X link does.
  for (const h of document.querySelectorAll('.hero-links .hlink')) glass(h);
  if (P?.x) glass(P.x);
  // Its twin, the share button, moves as it does; the copy offer a download leaves is a capsule like the notice's toggle.
  if (P?.share) glass(P.share);
  if (P?.copy) glass(P.copy);
  // The dock, after the Photos bar on an iPhone: the bar gives a little under a press and leans after the finger; its
  // round button swells to about a quarter larger and lights up, and in Chromium on a real GPU it turns into a
  // magnifier while it is pressed (the droplets' dome map, its strength following the press); and the bar's own rim
  // bends what passes under it (d-lens.png).
  const LENSES = ENGINE.chromium && FINE.matches && !CLEAR.matches && CSS.supports('backdrop-filter', 'url(#x)');
  // Its words never move or scale under a press (no lean, no inner swell): text held at a fraction of a pixel goes soft.
  // Held, the bar grows evenly by about 3% (measured on screenshots of a tab bar on an iPhone: 1196 by 186 px at rest,
  // 1236 by 192 held). A fixed 3px a side across and 2px up and down would be, on a 344px bar, under 2% across and
  // nearly 7% up.
  if (api.dock) glass(api.dock, { lift: false, ratio: 0.033, leanX: 0.01, leanY: 0.01 });
  // The glass switch in the top bar: lit under the pointer like the theme switch beside it, never pressed in or lifted.
  if (api.glassSeg) glass(api.glassSeg, { press: false, lift: false });
  // The list's board-or-tiles switch, the same kind of switch standing on the page: lit the same way.
  if (api.viewSeg) glass(api.viewSeg, { press: false, lift: false });
  // Its twin in the top bar: lit as the glass switch beside it is.
  if (api.viewTwin) glass(api.viewTwin, { press: false, lift: false });
  if (api.toTop) {
    const el = api.toTop;
    // Its magnifier is made ready at the first sign of use (READY's states; lensing: its filter's steps, once ready),
    // and shown (.lensing) only while a press is on it.
    const LENSABLE = LENSES && Boolean(K_LENS);
    const lensReady = machine(LENSABLE ? 'idle' : 'none', READY);
    let lensing = null;
    const lensShow = machine('off', { off: ['on'], on: ['off'] }).on((to) => el.classList.toggle('lensing', to === 'on'));
    const pressLens = (p) => {
      if (!lensReady.is('ready')) return;
      lensShow.go(p > 0.01 ? 'on' : 'off');
      if (!lensShow.is('on')) return;
      const w = Math.max(1, el.offsetWidth);
      lensing.blur.setAttribute('stdDeviation', ((5 - 3.4 * Math.min(1, p)) / w).toFixed(4));
      lensing.across.setAttribute('scale', (LENS_FULL * 2.6 * p).toFixed(4));
      lensing.up.setAttribute('scale', (LENS_FULL * 2.6 * p).toFixed(4));
      lensing.lit.setAttribute('slope', (1 + 0.3 * Math.min(1, p)).toFixed(3));
    };
    glass(el, { lens: pressLens });
    if (LENSABLE) {
      const arm = () => {
        el.removeEventListener('pointerenter', arm);
        el.removeEventListener('focusin', arm);
        if (!lensReady.go('wait')) return;
        if (!gpu()) {
          lensReady.go('none');
          return;
        }
        const ep = lensReady.epoch;
        map(K_LENS).then(() => {
          if (lensReady.epoch !== ep) return;
          const f = svgEl('filter', { id: 'press-lens', x: 0, y: 0, width: 1, height: 1, primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' });
          const blur = svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.096, result: 'soft' });
          const across = svgEl('feDisplacementMap', { in: 'soft', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'B', result: 'across' });
          const up = svgEl('feDisplacementMap', { in: 'across', in2: 'map', scale: 0, xChannelSelector: 'B', yChannelSelector: 'G', result: 'bent' });
          const sat = svgEl('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.3, result: 'rich' });
          const tr = svgEl('feComponentTransfer', { in: 'rich' });
          const lit = [svgEl('feFuncR', { type: 'linear', slope: 1 }), svgEl('feFuncG', { type: 'linear', slope: 1 }), svgEl('feFuncB', { type: 'linear', slope: 1 })];
          tr.append(...lit);
          f.append(svgEl('feImage', { href: K_LENS, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'map' }), blur, across, up, sat, tr);
          defs().append(f);
          el.style.setProperty('--press-lens', 'url(#press-lens)');
          lensing = { blur, across, up, lit: { setAttribute: (k, v) => { for (const fn of lit) fn.setAttribute(k, v); } } };
          lensReady.go('ready');
        }, () => {
          if (lensReady.epoch === ep) lensReady.go('none');
        });
      };
      el.addEventListener('pointerenter', arm, { passive: true });
      el.addEventListener('focusin', arm, { passive: true });
    }
  }
  if (api.dock && LENSES) {
    const D_LENS = asset(api.ASSETS?.dLens);
    // The round button beside the bar is the same glass: the same lens on its own map (a whole face frosted evenly
    // would not match the bar, which bends at its rim and frosts only its middle).
    const D_ROUND = asset(api.ASSETS?.dRound);
    // The clear glass's lens (the stylesheet uses it only under html.glass-clear; frosted glass is an even blur and
    // bends nothing): bent once for each colour, red a touch more and blue a touch less (the published kits put the real
    // material's dispersion at about a fifth), then laid together. Nothing is softened: clear glass has no frost.
    const DOCK_H = 62;
    // Four 84px cells and the bar's padding (a narrower window's dock gets no rim lens).
    const DOCK_W = 436;
    const dockLens = (id, href, w) => {
      const f = svgEl('filter', { id, x: 0, y: 0, width: w, height: DOCK_H, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
      f.append(svgEl('feImage', { href, x: 0, y: 0, width: w, height: DOCK_H, preserveAspectRatio: 'none', result: 'map' }), svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.6, result: 'pre' }));
      const keep = { r: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', g: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', b: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' };
      for (const [c, share] of [['r', 1.035], ['g', 1], ['b', 0.965]]) {
        f.append(
          svgEl('feDisplacementMap', { in: 'pre', in2: 'map', scale: 34 * share, xChannelSelector: 'R', yChannelSelector: 'G', result: `d${c}` }),
          svgEl('feColorMatrix', { in: `d${c}`, type: 'matrix', values: keep[c], result: `c${c}` }),
        );
      }
      f.append(
        svgEl('feBlend', { in: 'cr', in2: 'cg', mode: 'screen', result: 'rg' }),
        svgEl('feBlend', { in: 'rg', in2: 'cb', mode: 'screen', result: 'bent' }),
        svgEl('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.3 }),
      );
      defs().append(f);
    };
    // The bar's rim lens, one machine: idle, wait and none as READY's; on: built, and the bar exactly the size its map
    // was drawn for (html.dock-lens); off: built, and the bar another size (a narrower window), where the map would
    // bend the wrong places. The size is judged again whenever the bar's changes (judged only once, a window
    // narrowed after the lens came in would keep a lens that no longer fits, and one widened would never get it).
    const dockRim = machine('idle', { idle: ['wait', 'none'], wait: ['on', 'off', 'none'], on: ['off'], off: ['on'] })
      .on((to) => root.classList.toggle('dock-lens', to === 'on'));
    const fits = () => api.dock.offsetWidth === DOCK_W && api.dock.offsetHeight === DOCK_H;
    const refit = () => { if (dockRim.is('on', 'off')) dockRim.go(fits() ? 'on' : 'off'); };
    // The round button's lens (READY's states; html.dock-round-lens once ready). The button is always 62px round, the
    // size its map was drawn for, so it is never judged again.
    const roundRim = machine('idle', READY).on((to) => { if (to === 'ready') root.classList.add('dock-round-lens'); });
    const wantDock = () => {
      if (!dockRim.is('idle')) return;
      if (!D_LENS || !gpu()) {
        dockRim.go('none');
        return;
      }
      dockRim.go('wait');
      const ep = dockRim.epoch;
      map(D_LENS).then(() => {
        if (dockRim.epoch !== ep) return;
        dockLens('dock-lens', D_LENS, DOCK_W);
        dockRim.go(fits() ? 'on' : 'off');
        if (typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(api.dock);
        // The button's lens follows once its own map is in.
        if (!D_ROUND || !roundRim.go('wait')) return;
        const rp = roundRim.epoch;
        map(D_ROUND).then(() => {
          if (roundRim.epoch !== rp) return;
          dockLens('dock-round-lens', D_ROUND, DOCK_H);
          roundRim.go('ready');
        }, () => { if (roundRim.epoch === rp) roundRim.go('none'); });
      }, () => { if (dockRim.epoch === ep) dockRim.go('none'); });
    };
    // Wanted at the first sign of use (a pointer over the dock, the first scroll), and then only under clear glass.
    const armDock = () => {
      api.dock.removeEventListener('pointerenter', armDock);
      removeEventListener('scroll', armDock);
      whenClear(wantDock);
    };
    api.dock.addEventListener('pointerenter', armDock, { passive: true });
    addEventListener('scroll', armDock, { passive: true, once: true });
  }

  // ---- the top bar's merge: the glass switch, the theme switch and the X link flowing into one body (style.css,
  // tools/glass/m) ----
  // The stylesheet steps its 24 frames with the page's scroll. From here on a spring follows the scroll instead, so the
  // body lags a little and settles, as liquid does; and in Chromium on a real GPU its rim bends what passes under it,
  // through one map a frame (m-lens.png, shown a frame at a time by sliding it under the filter's window).
  const blob = document.querySelector('.top-blob');
  const blobGlass = blob?.querySelector('i');
  // The stylesheet's own conditions for drawing the merge (asked here, not read off the element: in WebKit the element
  // stays undrawn until this module has taken over).
  const TIMELINES = CSS.supports('animation-timeline: scroll()');
  const MERGE_MQ = matchMedia('(prefers-reduced-motion: no-preference) and (min-width: 360px)');
  // Those conditions as they stand now (a window can be resized across them, a preference changed).
  const merges = () => TIMELINES && MERGE_MQ.matches && !FORCED.matches;
  // The merged body's side of the twin's join (set below, once this module draws the merge).
  let body = null;
  // This module takes the merge over from the stylesheet once, the first time the bar merges: as it arrives, or later
  // (a phone turned, a window widened past 360px, reduced motion switched off). Left to the stylesheet from then on,
  // the body could never hold the twin: its frames are cut for three controls.
  function mergeTake() {
    if (body || !merges()) return;
    for (const mq of [MERGE_MQ, FORCED]) mq.removeEventListener?.('change', mergeTake);
    const bar = blob.parentElement;
    const FRAMES = 24;
    const REACH = 120;
    const BW = 268;
    // The three controls at rest, left to right: [x, width] in the body's box (gen-merge.mjs's P0).
    const PARTS = [[6, 60], [76, 60], [146, 116]];
    const BH = 40;
    const M_LENS = asset(api.ASSETS?.mLens);
    // The merge has no phases of its own: it is one spring following the scroll (B below), drawn a frame of 24 at a
    // time. Only its rim lens is made ready (READY's states; img: the lens's map, slid a frame at a time, once ready).
    const mergeLens = machine('idle', READY).on((to) => {
      if (to !== 'ready') return;
      root.classList.add('blob-lens');
      lensHeld();
    });
    let img = null;
    // The body's outline at each frame, as a clip path (a mask does not cut a backdrop blur in WebKit, a clip path does
    // everywhere). It is the shape tools/glass/m/gen-merge.mjs draws for the rim's light: the numbers below are that
    // generator's and must stay the same. The shape mirrors about its middle line, so each column needs only how far
    // the edge is from that line, found by halving.
    const shade = blob.querySelector('u > s');
    const edge = blob.querySelector('em');
    const cap = (x, y, x0, y0, w, h) => {
      const r = h / 2;
      return Math.hypot(x - clamp(x, x0 + r, x0 + w - r), y - (y0 + r)) - r;
    };
    const smin = (a, b, k) => {
      if (k <= 0) return Math.min(a, b);
      const t = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
      return b + (a - b) * t - k * t * (1 - t);
    };
    const outlines = [];
    const rings = [];
    // A shape (sd: the distance to its edge, negative inside) in a box w wide, as how far it reaches from its middle
    // line in each half-pixel column: the body's own edge, and the two edges of the half-pixel ring just outside it
    // (the stylesheet's edge layer, 1px larger than the box all round).
    const mid = BH / 2;
    const edgesOf = (sd, w) => {
      // For the edge at distance lvl outside the shape.
      const reach = (lvl, x0, x1) => {
        const out = [];
        for (let x = x0; x <= x1; x += 0.5) {
          let lo = 0;
          if (sd(x, mid) < lvl) {
            let hi = mid + 2;
            for (let i = 0; i < 12; i++) {
              const m = (lo + hi) / 2;
              if (sd(x, mid - m) < lvl) lo = m;
              else hi = m;
            }
          }
          out.push([x, lo]);
        }
        return out;
      };
      return [reach(0, 0, w), reach(0.5, -1, w + 1), reach(0, -1, w + 1)];
    };
    // Those edges as the body's clip path and as the edge layer's ring: the ring's outer edge, then the body's own as a
    // hole (even-odd), both starting on the middle line at the far left. at: where a column is drawn (its own x, or
    // moved: the body holding the list's switch, below).
    const drawn = ([cols, outer, inner], at = (x) => x) => {
      const loop = (cs) => [...cs.map(([x, d]) => `${at(x) + 1}px ${f2(mid + 1 - d)}px`), ...cs.slice().reverse().map(([x, d]) => `${at(x) + 1}px ${f2(mid + 1 + d)}px`)];
      const hole = loop(inner);
      const ring = `polygon(evenodd, ${[...loop(outer), ...hole, hole[0]].join(',')})`;
      const pts = cols.map(([x, d]) => `${at(x)}px ${f2(mid - d)}px`);
      for (let i = cols.length - 1; i >= 0; i--) pts.push(`${at(cols[i][0])}px ${f2(mid + cols[i][1])}px`);
      return [`polygon(${pts.join(',')})`, ring];
    };
    const trace = (sd, w) => drawn(edgesOf(sd, w));
    const outline = (f) => {
      if (outlines[f]) return outlines[f];
      const q = f / (FRAMES - 1);
      const e = q * q * (3 - 2 * q);
      const ex = e ** 2.1;
      const L = (a, b, k) => a + (b - a) * k;
      const y0 = L(6, 0, e);
      const h = L(28, BH, e);
      const k = 16 * Math.sin(Math.PI * q);
      const caps = PARTS.map(([px, pw], j) => {
        const l = j ? L(px, PARTS[j - 1][0] + PARTS[j - 1][1] * 0.45, ex) : L(px, 0, e);
        const r = j < PARTS.length - 1 ? L(px + pw, PARTS[j + 1][0] + PARTS[j + 1][1] * 0.55, ex) : L(px + pw, BW, e);
        return [l, r - l];
      });
      [outlines[f], rings[f]] = trace((x, y) => caps.map(([l, w]) => cap(x, y, l, y0, w, h)).reduce((d, c) => smin(d, c, k)), BW);
      return outlines[f];
    };
    const B = {
      t: 0, v: 0, target: 0, f: -1, o: -1,
      step(h) { pull(B, 't', 'v', B.target, BLOB, h); },
      draw() {
        const t = clamp(B.t, 0, 1);
        const f = Math.round(t * (FRAMES - 1));
        const o = Math.round(smooth(clamp(t / 0.16, 0, 1)) * 100) / 100;
        if (f !== B.f) {
          B.f = f;
          bar.style.setProperty('--blob-f', String(f));
          const cut = outline(f);
          blobGlass.style.clipPath = cut;
          if (shade) shade.style.clipPath = cut;
          if (edge) edge.style.clipPath = rings[f];
          if (mergeLens.is('ready')) img.setAttribute('y', String(-f * BH));
        }
        if (o !== B.o) {
          B.o = o;
          bar.style.setProperty('--blob-o', String(o));
        }
      },
      rest() { return Math.abs(B.t - B.target) < 0.002 && Math.abs(B.v) < 0.02; },
      settle() {
        B.t = B.target;
        B.v = 0;
        B.draw();
        // Whoever waited for the one whole body (room, below) hears that it is.
        if (whole()) for (const heard of wholeWaits.splice(0)) heard();
      },
    };
    const BLOB = spring(0.46, 0.84);
    // The body is whole: every control in the one capsule, the spring at rest there.
    const whole = () => !running(B) && B.t > 0.99;
    const wholeWaits = [];

    // ---- the body holding the list's switch (its twin, api.viewTwin) as a fourth control ----
    // The twin only ever joins the whole body, one capsule, and the X link gives up its word for it: the body with
    // the twin in is that capsule 250px wide, where the three controls took 268, and every width between while the
    // twin comes or goes. Its outline is cut here at each width, in the box it has at rest with the twin in (its
    // right end never moves). The rim's light is the stylesheet's, the four-part map in two parts; the lens is the
    // same two parts of that set's lens map, the left one kept up to LENS_CUT and the right one from there, where
    // both are flat. gen-merge.mjs draws the set.
    const SET = { w: 250, rim: asset(api.ASSETS?.m4Rim), lens: asset(api.ASSETS?.m4Lens) };
    const LENS_CUT = 130;
    // The room the cut layers have past the box's left end while the twin moves (the stylesheet gives them the same),
    // for a body wider than its box.
    const PAD = 24;
    // The resting capsule's edges in that wider box, for the body on its way (body.shape).
    let moving = null;
    // What the body holds, its form:
    //   three  the three controls it merges from the scroll (the frames above);
    //   four   those and the twin, or the twin on its way in or out (J below).
    // While it holds the twin the merge stays whole whatever the scroll says (aim): the twin leaves first, and only
    // then does the body part into its three controls.
    const hold = machine('three', { three: ['four'], four: ['three'] }).on((to) => {
      // .view-fused: the stylesheet moves the twin and its neighbours inside the body (no layout), not as capsules.
      bar.classList.toggle('view-fused', to === 'four');
      lensHeld();
      if (to === 'four') return;
      // Back to the three controls' own outline.
      B.f = -1;
      B.draw();
      aim();
    });
    const cutTo = ([cut, ring]) => {
      blobGlass.style.clipPath = cut;
      if (shade) shade.style.clipPath = cut;
      if (edge) edge.style.clipPath = ring;
    };
    // The lens of the body holding the twin: one filter (l4), built when the twin is first taken in where the
    // three-part body has its lens, and in use (html.blob-lens4) while the body holds the twin. lensLay places its
    // two parts: pad, the layer's room past the box's left end (none at rest); left, the body's left end in the box.
    let l4 = null;
    // The set's lens map: READY's states, but a map that would not load is asked for again (wait back to idle). It is
    // asked for with the set's rim under clear glass (room), or as the glass turns clear once that rim has been asked
    // for, and never where the three-part body has no lens.
    const setLens = machine(SET.lens ? 'idle' : 'none', { idle: ['wait'], wait: ['ready', 'idle'] }).on((to) => { if (to === 'ready') lensHeld(); });
    const wantSetLens = () => {
      if (mergeLens.is('none') || !setLens.go('wait')) return;
      map(SET.lens).then(() => { setLens.go('ready'); }, () => {
        maps.delete(SET.lens);
        setLens.go('idle');
      });
    };
    glassLook.on((to) => { if (to === 'clear' && maps.has(SET.rim)) wantSetLens(); });
    const lensable = () => setLens.is('ready') && mergeLens.is('ready');
    const lensLay = (pad, left) => {
      if (!lensable()) return;
      if (!l4) {
        const at = { y: 0, height: BH };
        const f = svgEl('filter', { id: 'm4-lens-f', x: 0, ...at, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
        const part = (result) => svgEl('feImage', { href: SET.lens, ...at, width: SET.w, preserveAspectRatio: 'none', result });
        const cut = svgEl('feFlood', { ...at, width: LENS_CUT, 'flood-color': '#000', result: 'cut' });
        const both = svgEl('feMerge', { result: 'map' });
        both.append(svgEl('feMergeNode', { in: 'right' }), svgEl('feMergeNode', { in: 'kept' }));
        l4 = { f, left: part('left'), cut, right: part('right') };
        f.append(
          l4.left,
          cut,
          svgEl('feComposite', { in: 'left', in2: 'cut', operator: 'in', result: 'kept' }),
          l4.right,
          both,
          svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.5, result: 'pre' }),
          svgEl('feDisplacementMap', { in: 'pre', in2: 'map', scale: 22, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
          svgEl('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.3 }),
        );
        defs().append(f);
      }
      l4.f.setAttribute('width', String(pad + SET.w));
      l4.left.setAttribute('x', f2(pad + left));
      l4.cut.setAttribute('x', f2(pad + left));
      l4.right.setAttribute('x', String(pad));
    };
    // The body took the twin or let it go, or either lens came in while it held it.
    function lensHeld() {
      const on = hold.is('four') && lensable();
      root.classList.toggle('blob-lens4', on);
      if (on) lensLay(0, 0);
    }
    body = {
      // Resolves true once the body can take the twin: the set's rim decoded and the merge whole, and under clear
      // glass the set's lens in too, or given up for now (the body then keeps clear glass's plain blur until a later
      // ask brings it). Frosted glass bends nothing: there the rim alone is enough. False where the page has no such
      // rim, or it would not load (asked for again next time).
      room() {
        // Separate capsules now (a window narrowed under 360px since this module took the merge): nothing to wait for.
        if (!merges()) return Promise.resolve(true);
        if (!SET.rim) return Promise.resolve(false);
        if (glassLook.is('clear')) wantSetLens();
        const lens = setLens.is('wait') ? map(SET.lens).catch(() => {}) : null;
        return Promise.all([map(SET.rim), lens, whole() ? null : new Promise((heard) => { wholeWaits.push(heard); })]).then(() => true, () => {
          maps.delete(SET.rim);
          return false;
        });
      },
      // A join or a leave sets off (a leave finds the body holding the twin already).
      begin() {
        if (merges() && whole()) hold.go('four');
      },
      // Whether the twin moves inside this body (false: the bar's controls are separate capsules).
      holds: () => hold.is('four'),
      // The body with its left end at left (px in its resting box: 18 to the left of it with the twin out, none with
      // the twin in): its outline, cut in the layers' wider box, and its lens. The outline is the resting capsule's
      // (traced once, its flat runs left out), the columns of its left half carried to where the end is.
      shape(left) {
        moving ??= edgesOf((x, y) => cap(x, y, PAD, 0, SET.w, BH), PAD + SET.w).map((cs) => cs.filter(([, d], i) => d !== cs[i - 1]?.[1] || d !== cs[i + 1]?.[1]));
        cutTo(drawn(moving, (x) => (x < PAD + SET.w / 2 ? Math.round((x + left) * 100) / 100 : x)));
        lensLay(PAD, left);
      },
      // Landed: with the twin in, the set's own outline; with it out, the three controls' body.
      rest(inBar) {
        if (!inBar) {
          hold.go('three');
          return;
        }
        if (merges()) hold.go('four');
        if (!hold.is('four')) return;
        cutTo(trace((x, y) => cap(x, y, 0, 0, SET.w, BH), SET.w));
        lensLay(0, 0);
      },
    };
    const aim = () => {
      B.target = hold.is('three') ? clamp(scrollY / REACH, 0, 1) : 1;
      if (REDUCED.matches || document.hidden) B.settle();
      else move(B);
    };
    B.target = clamp(scrollY / REACH, 0, 1);
    B.settle();
    root.classList.add('blob-js');
    addEventListener('scroll', aim, { passive: true });
    // The rim lens: where there can be one, and only under clear glass (its map is by far the page's largest).
    if (!(ENGINE.chromium && M_LENS && FINE.matches && !CLEAR.matches && CSS.supports('backdrop-filter', 'url(#x)'))) mergeLens.go('none');
    else whenClear(() => {
      if (!mergeLens.go('wait')) return;
      if (!gpu()) {
        mergeLens.go('none');
        return;
      }
      const ep = mergeLens.epoch;
      map(M_LENS).then(() => {
        if (mergeLens.epoch !== ep) return;
        const f = svgEl('filter', { id: 'm-lens-f', x: 0, y: 0, width: BW, height: BH, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
        img = svgEl('feImage', { href: M_LENS, x: 0, y: -Math.max(0, B.f) * BH, width: BW, height: BH * FRAMES, preserveAspectRatio: 'none', result: 'map' });
        f.append(
          img,
          svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.5, result: 'pre' }),
          svgEl('feDisplacementMap', { in: 'pre', in2: 'map', scale: 22, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
          svgEl('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.3 }),
        );
        defs().append(f);
        mergeLens.go('ready');
      }, () => { if (mergeLens.epoch === ep) mergeLens.go('none'); });
    });
  }
  if (blob && blobGlass) {
    mergeTake();
    if (!body) for (const mq of [MERGE_MQ, FORCED]) mq.addEventListener?.('change', mergeTake);
  }

  // ---- the list's switch joining the top bar (app.js's viewJoin machine says when; style.css lays it out) ----
  // One motion, wherever the bar's controls are separate capsules or one body. Two springs (J): g, the gap between
  // the theme switch and the X link (0 closed, 1 open: the link gives up its word and the two switches make room),
  // and d, the twin settling into that gap (it rises 14px, grows from 0.8 and clears). On the way in the gap leads
  // and the twin follows once the gap is seven tenths open, so it never shows over the theme switch; on the way out
  // the twin sinks first and the gap closes once the twin is all but clear. Each spring is always aimed from where
  // app.js's machine stands, so a join turned into a leave (or back) turns round from where it is, at the speed it
  // has. The gap slides on the pickers' slide spring; the twin settles on the spring the phone sheet's coin lands on
  // (app.js's bounceSheet: 0.36 s, damping 0.75) and sinks on the hover light's (0.22 s). At rest nothing is written:
  // the stylesheet's own.
  const twin = api.viewTwin;
  const twinBar = twin?.parentElement;
  const xWord = twinBar?.querySelector('.xlink > span');
  const SETTLE = spring(0.36, 0.75);
  const viewIn = () => ['joining', 'bar'].includes(api.viewAt?.());
  const J = {
    g: 0, vg: 0, d: 0, vd: 0,
    // The names of the variables written on the bar while the twin moves (put), all taken off as it lands.
    vars: new Set(),
    step(h) {
      const inBar = viewIn();
      pull(J, 'g', 'vg', inBar || J.d > 0.2 ? 1 : 0, S.CAP_SLIDE, h);
      pull(J, 'd', 'vd', inBar && J.g > 0.7 ? 1 : 0, inBar ? SETTLE : GS.LIGHT, h);
    },
    draw() {
      const gx = clamp(J.g, 0, 1);
      J.put('--vjx', f4(gx));
      J.put('--tw-y', `${f2(14 * (1 - J.d))}px`);
      J.put('--tw-s', f4(0.8 + 0.2 * J.d));
      J.put('--vo', f2(smooth(clamp((J.d - 0.08) / 0.62, 0, 1))));
      if (!body?.holds()) {
        // Separate capsules: the stylesheet lays the gap out.
        J.put('--vj', f4(J.g));
        return;
      }
      // One body: nothing is laid out. Its left end, and the two switches with it, stand where the gap's 70px less
      // the 88 the X link's word gives up put them.
      const left = 70 * (1 - J.g) - 88 * (1 - gx);
      J.put('--tw-left', `${f2(left)}px`);
      body.shape(left);
    },
    // One of the stylesheet's variables for the motion, written on the bar and remembered, to be taken off at rest.
    put(name, value) {
      J.vars.add(name);
      twinBar.style.setProperty(name, value);
    },
    rest() {
      const to = viewIn() ? 1 : 0;
      return Math.abs(J.g - to) < 0.003 && Math.abs(J.d - to) < 0.01 && Math.abs(J.vg) < 0.04 && Math.abs(J.vd) < 0.1;
    },
    settle() {
      const inBar = viewIn();
      J.land(inBar);
      api.viewLanded?.(inBar ? 'bar' : 'list');
    },
    // At rest, in the bar or out of it: the springs there, nothing of the motion's left written.
    land(inBar) {
      J.g = J.d = inBar ? 1 : 0;
      J.vg = J.vd = 0;
      unstyle(twinBar, [...J.vars]);
      body?.rest(inBar);
    },
  };
  // app.js's machine has moved: joining and leaving are the two motions, every other state a place to be at once.
  function viewJoin(state) {
    if (!twin) return;
    if (state !== 'joining' && state !== 'leaving') {
      J.run?.go('still');
      J.land(state === 'bar');
      return;
    }
    // The X link's word at its own width (its text's, as its box may be narrowed already), and how far left of its
    // place as a 28px circle the link's mark stands beside that word: centred with it in the link's 116px inside the
    // body, on the 64th of a pixel the layout puts it on there (half the room left, rounded down), so the first
    // frame draws every letter exactly where it stood.
    if (xWord && !running(J)) {
      const text = document.createRange();
      text.selectNodeContents(xWord);
      const word = text.getBoundingClientRect().width;
      J.put('--vx-word', `${word}px`);
      J.put('--vx-from', `${96 - Math.floor((98 - word) * 32) / 64}px`);
    }
    body?.begin();
    move(J);
    J.draw();
  }
  // Whether the bar has room for the twin: at once where its controls are separate capsules, once the merged body can
  // hold it where this module draws the merge (mergeTake), and never where the stylesheet alone steps the merge (a
  // page without the body's layers: its frames are cut for three controls). WebKit draws no merge without this module.
  const viewRoom = () => (body ? body.room() : Promise.resolve(!merges() || ENGINE.webkit));
  // A twin already in the bar when this module arrives (separate capsules): the springs stand there too.
  if (twin && api.viewAt?.() === 'bar') J.land(true);
  const more = document.getElementById('nfa-more');
  if (more) glass(more);
  // The panel's cross goes with its dialog: a close leaves no light or lift on it for the next open.
  dlg?.addEventListener('close', () => {
    for (const C of glasses) {
      if (!dlg.contains(C.el) || C.phase.is('rest')) continue;
      C.phase.go('back');
      move(C);
    }
  });

  // ---- the sheet's grabber: it widens as it is taken, stretches with the drag's speed, springs back with a wobble ----
  const grabEl = P?.grab;
  // The grabber's states (GB.phase): rest, the stylesheet's alone; held, a finger has the sheet (wider, more with the
  // drag's speed, leaning after it); back, let go: springing back to its resting width with a wobble.
  const GB = {
    dx: 0, vy: 0, w: 0, vw: 0, x: 0, vx: 0,
    phase: machine('rest', { rest: ['held'], held: ['back'], back: ['rest', 'held'] }),
    // Its width (held: wider, and more with the drag's speed) and its sideways lean after the finger.
    aim() {
      const calm = REDUCED.matches;
      const down = GB.phase.is('held');
      return {
        w: down && !calm ? 8 + Math.min(14, Math.abs(GB.vy) / 140) : 0,
        x: down && !calm ? band(GB.dx * 0.08, 5) : 0,
      };
    },
    step(h) {
      // The speed fades when the finger rests, so a held grabber eases back to its held width.
      GB.vy *= Math.exp(-h / 0.12);
      const a = GB.aim();
      pull(GB, 'w', 'vw', a.w, GB.phase.is('held') ? S.SWELL : GS.EASE, h);
      pull(GB, 'x', 'vx', a.x, GS.FOLLOW, h);
    },
    draw() {
      grabEl.style.transform = `translateX(${f2(GB.x)}px) scale(${f4(1 + GB.w / 36)}, ${f4(1 - 0.12 * clamp(GB.w / 22, -1, 1))})`;
    },
    // Still: at rest, or held still at its held width (the drag's speed faded), which the finger's next move or its
    // release wakes again.
    rest() {
      const a = GB.aim();
      return (!GB.phase.is('held') || Math.abs(GB.vy) < 1) && Math.abs(GB.w - a.w) < 0.02 && Math.abs(GB.vw) < 0.2 && Math.abs(GB.x - a.x) < 0.02
        && Math.abs(GB.vx) < 0.2;
    },
    settle() {
      // Held: it keeps its held stretch, drawn once more where it settled.
      if (GB.phase.is('held')) {
        GB.vw = GB.vx = GB.vy = 0;
        GB.draw();
        return;
      }
      GB.w = GB.vw = GB.x = GB.vx = GB.vy = 0;
      GB.phase.go('rest');
    },
  };
  // At rest the grabber is the stylesheet's again.
  GB.phase.on((to) => { if (to === 'rest') unstyle(grabEl, ['transform']); });
  function releaseGrab() {
    if (!GB.phase.go('back')) return;
    if (!REDUCED.matches) GB.vw -= 40;
    move(GB);
  }
  // app.js's sheet drag: grab(dx, vy) as the finger takes the sheet and moves it (dx sideways from where it took it, vy
  // its speed in px/s), grab(null) as it lets go.
  function grab(dx, vy = 0) {
    if (!grabEl) return;
    if (dx === null) { releaseGrab(); return; }
    GB.phase.go('held');
    GB.dx = Number(dx) || 0;
    if (Number.isFinite(vy)) GB.vy = 0.6 * GB.vy + 0.4 * vy;
    move(GB);
  }
  // A finger that lifts where the sheet does not hear it still lets go of the grabber.
  for (const type of ['pointerup', 'pointercancel']) addEventListener(type, releaseGrab, true);

  // ==================================================================================================================
  // The painted veil: the panel's Control Center backdrop (style.css, .cd-veil) painted once into a small canvas,
  // instead of filtered live by the compositor on every frame. app.js asks for it only where the live filter cannot or
  // should not run: a view the frame guard (or a small memory) made lite, or a browser without backdrop-filter. Under a
  // blur this deep the page has no detail left, only where its colours and its light and dark masses sit, so the page is
  // not copied: it is read once (where each box, picture and line of text is, and its colour), painted as those masses
  // into a canvas about 180px wide, blurred and graded there with the stylesheet's own recipe (--veil-f, --veil-tint),
  // and laid over the window, scaled up. The panel's fades then move a still picture: no blur is worked out on any
  // frame. It is painted again only when a picture still loading arrives, after a resize, on a new theme or a new order
  // of the cards (app.js), and when plain glass is asked for or let go while it is open. Nothing runs at rest.
  // ==================================================================================================================
  const veil = P?.veil;
  const PLAIN = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
  const LIVE = typeof CSS !== 'undefined' && Boolean(CSS.supports?.('backdrop-filter', 'blur(1px)') || CSS.supports?.('-webkit-backdrop-filter', 'blur(1px)'));
  const canvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  // A canvas filter (Chromium, Firefox) blurs and grades in one native draw; elsewhere the same maths runs in script on
  // the few thousand pixels of the small canvas. Whether it works is seen, not read: some WebKit builds keep the filter
  // a script sets and draw without it, so a line one pixel wide is drawn through a blur and must have spread.
  let nativeFilter = null;
  function native() {
    if (nativeFilter === null) {
      try {
        const line = canvas(9, 3);
        const l = line.getContext('2d');
        l.fillStyle = '#fff';
        l.fillRect(4, 0, 1, 3);
        const x = canvas(9, 3).getContext('2d');
        x.filter = 'blur(1px)';
        x.drawImage(line, 0, 0);
        nativeFilter = x.getImageData(2, 1, 1, 1).data[3] > 0;
      } catch {
        nativeFilter = false;
      }
    }
    return nativeFilter;
  }
  // The recipe, read from the veil as it is drawn now (per theme and screen): one source for both materials.
  function recipe() {
    const cs = getComputedStyle(veil);
    const f = cs.getPropertyValue('--veil-f').trim();
    const b = /blur\(\s*([\d.]+)px\s*\)/.exec(f);
    const steps = [];
    for (const [, k, v, pc] of f.matchAll(/(brightness|contrast|saturate)\(\s*([\d.]+)(%?)\s*\)/g)) steps.push([k[0], pc ? v / 100 : Number(v)]);
    return { sigma: b ? Number(b[1]) : 28, grade: f.replace(/blur\([^)]*\)/, '').trim(), steps, tint: cs.getPropertyValue('--veil-tint').trim() };
  }

  // ---- reading the page ----
  // Any computed colour as [r, g, b, a]: rgb() parsed, anything else (a wide-gamut colour) through a 1px canvas.
  let scratch = null;
  const memo = new Map();
  function rgba(s) {
    if (!s || s === 'transparent' || s === 'none') return null;
    let c = memo.get(s);
    if (c !== undefined) return c;
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      c = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    } else {
      try {
        scratch ??= canvas(1, 1).getContext('2d', { willReadFrequently: true });
        scratch.clearRect(0, 0, 1, 1);
        scratch.fillStyle = '#0000';
        scratch.fillStyle = s;
        scratch.fillRect(0, 0, 1, 1);
        const d = scratch.getImageData(0, 0, 1, 1).data;
        c = [d[0], d[1], d[2], d[3] / 255];
      } catch {
        c = null;
      }
    }
    if (c && c[3] <= 0) c = null;
    memo.set(s, c);
    return c;
  }
  // A gradient is painted as the mean of its colour stops: under this blur a gradient is its average.
  function meanStops(s) {
    const all = s.match(/(rgba?|color|oklch|oklab|lab|lch|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b/gi);
    if (!all) return null;
    const c = all.map((x) => rgba(x) || [0, 0, 0, 0]);
    const a = c.reduce((x, k) => x + k[3], 0);
    if (a <= 0) return null;
    return [0, 1, 2].map((i) => c.reduce((x, k) => x + k[i] * k[3], 0) / a).concat(a / c.length);
  }
  function radius(cs, r) {
    const v = cs.borderTopLeftRadius;
    const n = parseFloat(v) || 0;
    return Math.min(r.width / 2, r.height / 2, v.endsWith('%') ? (Math.min(r.width, r.height) * n) / 100 : n);
  }
  const inter = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  // A TreeWalker cannot skip a subtree once a node is accepted: it is parked on the subtree's last node, so the next step
  // goes on after it.
  function skip(walker, el) {
    let last = el;
    while (last.lastChild) last = last.lastChild;
    walker.currentNode = last;
  }
  // Paints the page's masses in CSS pixels (the context is scaled) and returns the pictures that had not loaded yet.
  function draw(ctx, view) {
    const range = document.createRange();
    // element: { alpha, clip, cs }
    const info = new Map();
    const pending = [];
    const fill = (rect, col, alpha, rad, clip) => {
      if (!col) return;
      const a = col[3] * alpha;
      if (a <= 0.003) return;
      const c = inter({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, clip);
      if (c.r <= c.l || c.b <= c.t) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.l, clip.t, clip.r - clip.l, clip.b - clip.t);
      ctx.clip();
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
      ctx.beginPath();
      if (rad > 0.5 && ctx.roundRect) ctx.roundRect(rect.left, rect.top, rect.width, rect.height, rad);
      else ctx.rect(rect.left, rect.top, rect.width, rect.height);
      ctx.fill();
      ctx.restore();
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (n === dlg || n.tagName === 'SCRIPT' || n.tagName === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const top = { alpha: 1, clip: view, cs: getComputedStyle(document.body) };
    info.set(document.body, top);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        // A line of text is painted as the band its ink fills, from a little under the cap height to the baseline:
        // about a third of the band is ink at a regular weight, about half at a heavy one.
        const p = info.get(n.parentElement);
        if (!p || !p.cs || p.alpha <= 0) continue;
        const col = rgba(p.cs.color);
        if (!col) continue;
        const fs = parseFloat(p.cs.fontSize) || 16;
        const cover = 0.3 + 0.24 * clamp(((parseFloat(p.cs.fontWeight) || 400) - 400) / 400, 0, 1);
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.bottom < view.t || r.top > view.b) continue;
          const mid = r.top + r.height / 2;
          fill({ left: r.left, right: r.right, width: r.width, top: mid - 0.36 * fs, bottom: mid + 0.3 * fs, height: 0.66 * fs }, col, p.alpha * cover, 0, p.clip);
        }
        continue;
      }
      const el = n;
      const parent = info.get(el.parentElement) || top;
      const r = el.getBoundingClientRect();
      // Out of the blur's reach: neither it nor anything inside it can show.
      if (r.bottom < view.t || r.top > view.b || r.right < view.l || r.left > view.r) { skip(walker, el); continue; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { skip(walker, el); continue; }
      const alpha = parent.alpha * (parseFloat(cs.opacity) || 0);
      if (alpha <= 0) { skip(walker, el); continue; }
      let clip = parent.clip;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip = inter(clip, { l: r.left, t: r.top, r: r.right, b: r.bottom });
      info.set(el, { alpha, clip, cs });
      if (r.width === 0 || r.height === 0) continue;
      const rad = radius(cs, r);
      fill(r, rgba(cs.backgroundColor), alpha, rad, clip);
      if (cs.backgroundImage !== 'none') fill(r, meanStops(cs.backgroundImage), alpha, rad, clip);
      for (const pe of ['::before', '::after']) {
        const ps = getComputedStyle(el, pe);
        if (ps.content === 'none' || ps.display === 'none') continue;
        const pa = alpha * (parseFloat(ps.opacity) || 0);
        fill(r, rgba(ps.backgroundColor), pa, rad, clip);
        if (ps.backgroundImage !== 'none') fill(r, meanStops(ps.backgroundImage), pa, rad, clip);
      }
      if (el.tagName === 'IMG') {
        if (!el.complete) { pending.push(el); continue; }
        if (!el.naturalWidth) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.l, clip.t, clip.r - clip.l, clip.b - clip.t);
        ctx.clip();
        ctx.globalAlpha = alpha;
        try {
          ctx.drawImage(el, r.left, r.top, r.width, r.height);
        } catch {
          // Not drawable: its box stays empty.
        }
        ctx.restore();
      } else if (el.tagName.toLowerCase() === 'svg') {
        // An icon drawn in strokes: about a quarter of its box is ink.
        fill(r, rgba(cs.color), alpha * 0.25, 0, clip);
        skip(walker, el);
      }
    }
    return pending;
  }

  // ---- the blur and the grade in script (where a canvas has no filter) ----
  // A Gaussian as three box blurs (the classic approximation), each channel, edges clamped; then the stylesheet's steps
  // with the same maths and clamping the browsers use for these filters.
  function boxes(sigma) {
    let wl = Math.floor(Math.sqrt(4 * sigma * sigma + 1));
    if (wl % 2 === 0) wl--;
    const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
    return [0, 1, 2].map((i) => Math.max(1, ((i < m ? wl : wl + 2) - 1) / 2));
  }
  function blurPass(src, dst, w, h, r, horiz) {
    const len = horiz ? w : h;
    const lines = horiz ? h : w;
    const step = horiz ? 4 : 4 * w;
    const lstep = horiz ? 4 * w : 4;
    const inv = 1 / (2 * r + 1);
    for (let L = 0; L < lines; L++) {
      const base = L * lstep;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r - 1; i < r; i++) acc += src[base + Math.min(len - 1, Math.max(0, i)) * step + c];
        for (let i = 0; i < len; i++) {
          acc += src[base + Math.min(len - 1, i + r) * step + c] - src[base + Math.max(0, i - r - 1) * step + c];
          dst[base + i * step + c] = acc * inv;
        }
      }
    }
  }
  const unit = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  function grade(d, steps) {
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255;
      let g = d[i + 1] / 255;
      let b = d[i + 2] / 255;
      for (const [k, v] of steps) {
        if (k === 'b') {
          r = unit(r * v); g = unit(g * v); b = unit(b * v);
        } else if (k === 'c') {
          const o = 0.5 - 0.5 * v;
          r = unit(v * r + o); g = unit(v * g + o); b = unit(v * b + o);
        } else {
          const R = (0.213 + 0.787 * v) * r + (0.715 - 0.715 * v) * g + (0.072 - 0.072 * v) * b;
          const G2 = (0.213 - 0.213 * v) * r + (0.715 + 0.285 * v) * g + (0.072 - 0.072 * v) * b;
          const B = (0.213 - 0.213 * v) * r + (0.715 - 0.715 * v) * g + (0.072 + 0.928 * v) * b;
          r = unit(R); g = unit(G2); b = unit(B);
        }
      }
      d[i] = r * 255;
      d[i + 1] = g * 255;
      d[i + 2] = b * 255;
      d[i + 3] = 255;
    }
  }

  // ---- painting ----
  let paintEl = null;
  // What the veil shows. Its states:
  //   plain    the stylesheet's own veil: the live blur, or the lite tint;
  //   painted  its painted picture (.painted).
  // veilPaint moves it, by how the paint went; app.js sends it back to plain as a panel opens (veilClear: the picture
  // was the last panel's) and asks which it is (veilPainted). The class is written here, on the move, and read by the
  // stylesheet alone.
  const veilLook = machine('plain', { plain: ['painted'], painted: ['plain'] }).on((to) => veil?.classList.toggle('painted', to === 'painted'));
  const painted = () => veilLook.is('painted');
  const veilClear = () => { veilLook.go('plain'); };
  // Pictures the last paint could not draw yet (pics: in, every picture drawn; loading, one or more still on the way,
  // the veil to be painted again as the first of them arrives).
  const pics = machine('in', { in: ['loading'], loading: ['in'] });
  function paint() {
    const W = innerWidth;
    const H = innerHeight;
    const R = recipe();
    // As coarse as the blur allows: it spans about 3.5 of the canvas's pixels, so scaled up it stays smooth. The page
    // around the window is painted too (3 blurs wide), as the blur reaches into it.
    const s = Math.min(0.25, 3.5 / R.sigma);
    const m = Math.ceil(3 * R.sigma);
    const pw = Math.ceil((W + 2 * m) * s);
    const ph = Math.ceil((H + 2 * m) * s);
    const NATIVE = native();
    const work = canvas(pw, ph);
    const ctx = work.getContext('2d', { willReadFrequently: !NATIVE });
    if (!ctx) return false;
    const ground = rgba(getComputedStyle(root).backgroundColor) || rgba(getComputedStyle(document.body).backgroundColor) || [14, 15, 20, 1];
    ctx.fillStyle = `rgb(${ground[0]},${ground[1]},${ground[2]})`;
    ctx.fillRect(0, 0, pw, ph);
    ctx.setTransform(s, 0, 0, s, m * s, m * s);
    const pending = draw(ctx, { l: -m, t: -m, r: W + m, b: H + m });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let src = work;
    if (NATIVE) {
      src = canvas(pw, ph);
      const x = src.getContext('2d');
      x.filter = `blur(${(R.sigma * s).toFixed(3)}px) ${R.grade}`;
      x.drawImage(work, 0, 0);
    } else {
      const img = ctx.getImageData(0, 0, pw, ph);
      const a = img.data;
      const b = new Float32Array(a);
      const c = new Float32Array(a.length);
      for (const r of boxes(R.sigma * s)) {
        const k = Math.round(r);
        blurPass(b, c, pw, ph, k, true);
        blurPass(c, b, pw, ph, k, false);
      }
      a.set(b);
      grade(a, R.steps);
      ctx.putImageData(img, 0, 0);
    }
    if (!paintEl) {
      paintEl = mk('canvas', 'veil-paint');
      veil.prepend(paintEl);
    }
    const cw = Math.max(1, Math.round(W * s));
    const ch = Math.max(1, Math.round(H * s));
    paintEl.width = cw;
    paintEl.height = ch;
    const out = paintEl.getContext('2d');
    out.drawImage(src, m * s, m * s, W * s, H * s, 0, 0, cw, ch);
    if (rgba(R.tint)) {
      out.fillStyle = R.tint;
      out.fillRect(0, 0, cw, ch);
    }
    // Pictures still loading (a chart opened from the address as the page loads): painted once more when they are in.
    // One that fails counts as in, or the wait for it would never end and later paints would stop waiting at all.
    if (pending.length && pics.go('loading')) {
      const ep = pics.epoch;
      const again = () => {
        if (pics.epoch !== ep || !pics.go('in')) return;
        requestAnimationFrame(() => { if (dlg.open && painted()) veilPaint(); });
      };
      for (const im of pending) for (const t of ['load', 'error']) im.addEventListener(t, again, { once: true });
    }
    return true;
  }
  // app.js: paints the veil when the open panel wants it painted (and takes the painted one away when not).
  function veilPaint() {
    if (!veil || !dlg) return;
    const want = dlg.open && !PLAIN.matches && (!LIVE || api.lite());
    let ok = false;
    if (want) {
      try {
        ok = paint();
      } catch {
        // A canvas the browser would not read back: the veil stays the plain lite tint.
        ok = false;
      }
    }
    veilLook.go(ok ? 'painted' : 'plain');
  }
  if (veil && dlg) {
    // A resize while open (a phone turned, a window dragged) paints it again, once, on the next frame.
    let resizing = 0;
    addEventListener('resize', () => {
      if (!painted() || resizing || !dlg.open) return;
      resizing = requestAnimationFrame(() => { resizing = 0; if (dlg.open) veilPaint(); });
    }, { passive: true });
    // Plain glass asked for while open: the solid ground (the stylesheet); let go of: painted again, if it still should be.
    PLAIN.addEventListener?.('change', () => { if (dlg.open) veilPaint(); });
  }

  // ==================================================================================================================
  // The theme change: the new theme spreads out of the switch as a drop of liquid glass, over the old one, which stays
  // still. The drop is a lens: what it holds is magnified while it is small and flattens to 1:1 as it covers the page
  // (in Chromium on a real GPU its rim also bends the picture). Its radius follows a spring; toggled mid-flight it turns
  // round with the momentum it has and is drawn back into the switch, and another toggle sends it out again, all inside
  // one view transition, so nothing ever flashes: the page under the drop changes theme only when the drop that hides
  // it is gone. Reduced motion (and a device too slow for the drop, judged on its first one, and Firefox, where the drop
  // is untested) gets a dissolve: the new picture fades in. Without view transitions (Safari before 18), in forced
  // colours or a hidden tab it simply changes, in one frame: a fade of every colour on the page there restyled and
  // repainted the whole page on each frame, 70 to 145 ms a frame in WebKit.
  // ==================================================================================================================
  const VT = typeof document.startViewTransition === 'function';
  const TS = {
    // spreading over the page: about 400 ms to cover a desktop or a phone
    OUT: spring(0.7, 0.95),
    // drawn back into the switch, with the momentum it had: about 300 ms from mid-spread
    BACK: spring(0.3, 0.95),
  };
  const TK = {
    // the spread aims this far past the farthest corner, so it leaves the screen still moving
    OVER: 1.12,
    // px/s the drop leaves the switch with (a burst, not a slow start)
    KICK: 700,
    // how much the drop magnifies what it holds while small (about 6px at its edge); 1:1 once it covers the page
    LENS: 0.03,
    // keyframes a second (linear between them), and the longest any one leg may run (s)
    FPS: 60,
    MAX: 1.4,
    // px of radius over which the rim comes up
    FADE_IN: 26,
    // Chromium's rim lens: how far it bends the picture, as a share of the radius, and at most (px)
    BEND: 0.012,
    BEND_MAX: 8,
    // ms: a change never holds the page longer than this after its last turn, whatever happens
    KEEP: 4000,
    // ms: the dissolve with reduced motion, and the dissolve on a slow device
    CALM: 200,
    FADE: 260,
    // a drop whose median frame took over 22 ms, or that missed a frame (over 25 ms) more than a third of the time,
    // was too slow: later changes dissolve
    SLOW_P50: 22,
    SLOW_MISS: 0.34,
  };
  let slow = false;
  // The rim lens: Chromium with a fine pointer on a screen up to 2.5x, on a real GPU (asked when the pointer first comes
  // over the switch, or it takes focus), with its map decoded and its filter built.
  const VT_LENS_OK = ENGINE.chromium && Boolean(T_LENS) && matchMedia('(pointer: fine)').matches && (devicePixelRatio || 1) <= 2.5;
  // READY's states; vtLens: the filter's two moving steps, once ready.
  const vtLensReady = machine(VT_LENS_OK ? 'idle' : 'none', READY);
  let vtLens = null;
  // Whether this change of theme bends the page under its droplet (.vt-lens: the stylesheet draws the lens).
  const lensOn = machine('off', { off: ['on'], on: ['off'] });
  lensOn.on((to) => { root.classList.toggle('vt-lens', to === 'on'); });
  function wantVtLens() {
    if (!vtLensReady.go('wait')) return;
    if (!gpu()) {
      vtLensReady.go('none');
      return;
    }
    const ep = vtLensReady.epoch;
    map(T_LENS).then(() => {
      if (vtLensReady.epoch !== ep) return;
      // t-lens.png is the unit disc: R and G bend toward the centre in a band at the rim and not at all inside it, B marks
      // the band. It is fitted to the drop every frame; outside the drop the grey flood bends nothing. The map is blurred
      // so the bend has no steps, and only the band is softened by half a pixel, so the rest stays sharp.
      const f = svgEl('filter', { id: 'vt-lens', x: 0, y: 0, width: 1, height: 1, 'color-interpolation-filters': 'sRGB' });
      const fim = svgEl('feImage', { href: T_LENS, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'disc' });
      const fdm = svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' });
      f.append(
        svgEl('feFlood', { 'flood-color': 'rgb(128,128,128)', result: 'flat' }),
        fim,
        svgEl('feComposite', { in: 'disc', in2: 'flat', operator: 'over', result: 'raw' }),
        svgEl('feGaussianBlur', { in: 'raw', stdDeviation: 2, result: 'map' }),
        fdm,
        svgEl('feGaussianBlur', { in: 'bent', stdDeviation: 0.5, result: 'soft' }),
        svgEl('feColorMatrix', { in: 'disc', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0', result: 'band' }),
        svgEl('feComposite', { in: 'soft', in2: 'band', operator: 'in', result: 'softband' }),
        svgEl('feComposite', { in: 'softband', in2: 'bent', operator: 'over' }),
      );
      defs().append(f);
      vtLens = { fim, fdm };
      vtLensReady.go('ready');
    }, () => {
      if (vtLensReady.epoch === ep) vtLensReady.go('none');
    });
  }
  if (sw) for (const t of ['pointerenter', 'focus']) sw.addEventListener(t, wantVtLens, { passive: true });
  // Chromium draws the rim as a view-transition group of its own above both pictures, outside the lens and free to cast
  // its shadow beyond the drop. Elsewhere it is a top-layer popover inside the drop's own picture, magnified with it.
  const OWN_GROUP = ENGINE.chromium;
  // WebKit draws the new theme's picture afresh on every frame of a change, and every shadow in it:
  // - a card the drop has not reached yet cannot be seen in the new picture, so there it goes without its shadows and
  //   its coin without its contact shadow until just before the drop gets to it (html.vt .card.vt-out); a card off
  //   screen is not drawn into the pictures at all;
  // - a change to paper (light) keeps every card on screen plain for the whole change, inside the drop too: the
  //   paper's card and contact shadows, drawn afresh on every frame, cost a desktop page scrolled into the grid most of
  //   its frames. In the drop the paper's cards lie flat; once the change is over their shadows come in over BACK ms
  //   (.card.vt-back), as if they settled onto the paper. A dissolve to paper does the same.
  const BARE = ENGINE.webkit;
  // ms the drop is looked ahead for that (a slow frame's worth and more), and px of room round each card (the drop's
  // soft edge).
  const BARE_LEAD = 70;
  const BARE_PAD = 8;
  // ms the paper's shadows take to come in after a change (style.css .vt-back).
  const BACK = 320;
  // px a card's shadow reaches beyond its box (style.css --card-shadow, and the lift's while it is hidden).
  const CARD_SHADOW = 44;
  // The lockups are decoded now, so the picture of the new theme never has an empty logo.
  for (const img of document.querySelectorAll('img.lockup')) img.decode?.().catch(() => {});

  // ---- the drop's path: a spring, sampled into keyframes ----
  // From radius r0 at speed v0 toward target; it ends when it passes `end` (outward or inward).
  function path(r0, v0, target, sp, end) {
    const outward = target > r0;
    if (outward ? r0 >= end : r0 <= end) return [{ r: end, v: 0 }, { r: end, v: 0 }];
    const out = [{ r: r0, v: v0 }];
    let r = r0;
    let v = v0;
    const n = 8;
    const h = 1 / TK.FPS / n;
    for (let f = 1; f <= TK.MAX * TK.FPS; f++) {
      for (let i = 0; i < n; i++) {
        v += (sp.k * (target - r) - sp.c * v) * h;
        r += v * h;
      }
      const done = outward ? r >= end : r <= end;
      // Never below zero: a negative radius would void the mask and show the whole new picture for a frame.
      out.push({ r: done ? end : Math.max(0, r), v });
      if (done) break;
    }
    return out;
  }
  // Where a leg is at time ms (linear between samples, like the keyframes). WebKit reports a finished leg's time cut to
  // the microsecond, a hair short of its duration: that close to the end is the end, its last sample exactly.
  function at(p, ms) {
    const f = Math.max(0, (ms / 1000) * TK.FPS);
    if (f >= p.length - 1 - 1e-3) return p[p.length - 1];
    const i = Math.min(p.length - 1, Math.floor(f));
    const j = Math.min(p.length - 1, i + 1);
    const u = f - i;
    return { r: p[i].r + (p[j].r - p[i].r) * u, v: p[i].v + (p[j].v - p[i].v) * u };
  }
  const rimAlpha = (r) => clamp(r / TK.FADE_IN, 0, 1);
  // The drop is a lens: thick (magnifying) while small, flat once it has spread over the page.
  const mag = (r, R) => 1 + TK.LENS * (1 - clamp(r / R, 0, 1)) ** 2;
  // The farthest the page reaches from the switch (on a phone the snapshot can be taller than the window).
  function cover(x, y) {
    const w = Math.max(root.clientWidth, innerWidth);
    const h = Math.max(innerHeight, window.visualViewport?.height || 0) + 80;
    return Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y)) + 24;
  }
  // How far the drop must already be to reach into the window (a switch scrolled away).
  function reach(x, y) {
    const dx = Math.max(0, -x, x - root.clientWidth);
    const dy = Math.max(0, -y, y - innerHeight);
    return Math.max(0, Math.hypot(dx, dy) - 8);
  }

  // ---- one change, and any toggles during it: a chain ----
  // { mode: 'drop' | 'dissolve', ms, vt, x, y, ex, R, target: 'cover' | 'gone', path, anim, rimAnim, keeper, rim,
  //   run, pending, phase, dts, lastTs, cut, out, paper, bare, shade }. A dissolve's path holds the new picture's
  // opacity where a drop's holds its radius ('cover' = 1, 'gone' = 0). run: the change the transition's update callback
  // applies; pending: a change waiting for the drop to be gone. WebKit: out (the cards on screen, each with the radius
  // at which it starts to show), paper (the new picture is light: every card stays plain to the end), bare (the cards
  // that go without their shadows, then get them back) and shade (what those cards show: shadeMachine).
  // A chain's states (c.phase; the drop's target, 'cover' or 'gone', is where its spring is aimed, as a spring's is):
  // capturing: the view transition is asked for and its update callback has not run: the browser is taking the old
  //   picture, so the page must keep the theme it had (a toggle now only changes what the callback will apply);
  // captured: the callback has applied its change and the browser takes the new picture; the drop waits for ready;
  // running: the drop (or the dissolve) is in flight, out to cover the page or back into the switch;
  // ending: over for the screen (it shows what the page holds): the keeper finishes, or the transition is skipped;
  // over: the transition has finished.
  const CHAIN_MOVES = {
    capturing: ['captured', 'ending', 'over'],
    captured: ['running', 'ending', 'over'],
    running: ['ending', 'over'],
    ending: ['over'],
  };
  // The page's side of it (vtState): none, or changing while a chain is current (cur), when the root wears the change's
  // classes and properties; they all come off on the way back to none.
  let cur = null;
  // The chain last begun. It stays here once it is over: its cards' shadows may still be on their way back, and the
  // next chain ends that at once.
  let lastChain = null;
  const vtState = machine('none', { none: ['changing'], changing: ['none'] }).on((to) => { if (to === 'none') cleanup(); });
  // What a chain's cards show of their shadows (c.shade; only WebKit ever leaves whole: BARE). Its states:
  //   whole  every card draws its shadows, as the stylesheet has them;
  //   bare   the cards in c.bare go without theirs (.vt-out) while the change is in flight; the frame takes a card off
  //          the list, and gives it its shadows, as the drop reaches it (tJob);
  //   back   the change ended on paper: the cards still in c.bare get their shadows back over BACK ms (.vt-back), and
  //          the state's own timer ends it (80 ms later, so the stylesheet's transition is over).
  // The classes and the timer are set and taken away on the moves; back at whole the list is empty.
  function shadeMachine(c) {
    let timer = 0;
    return machine('whole', { whole: ['bare'], bare: ['whole', 'back'], back: ['whole'] }).on((to, from) => {
      clearTimeout(timer);
      if (to === 'bare') {
        for (const b of c.bare) b.el.classList.add('vt-out');
        return;
      }
      if (to === 'back') {
        for (const b of c.bare) {
          b.el.classList.add('vt-back');
          b.el.classList.remove('vt-out');
        }
        timer = setTimeout(() => c.shade.go('whole'), BACK + 80);
        return;
      }
      for (const b of c.bare) b.el.classList.remove(from === 'back' ? 'vt-back' : 'vt-out');
      c.bare = [];
    });
  }
  const loose = (c) => {
    if (cur !== c) return;
    cur = null;
    vtState.go('none');
  };
  const now = (c) => (c.path && c.anim ? at(c.path, c.anim.currentTime || 0) : { r: 0, v: c.mode === 'drop' ? TK.KICK : 0 });
  // The theme changes inside one frame in which the colour transitions it sets off end at once (html.swap): the drop
  // shows the new theme whole, never half faded. app.js keeps that class when it can (api.swap: on now, off two frames
  // after the last swap in flight), so the two never take it off each other mid-swap; from an older app.js, this
  // module keeps it as it always did.
  function swap(run) {
    const own = typeof api.swap !== 'function';
    if (own) root.classList.add('swap');
    else api.swap();
    try {
      run();
    } finally {
      if (own) requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('swap')));
    }
  }

  function transition(run) {
    const calm = REDUCED.matches;
    if (!VT) { swap(run); return; }
    const c = cur;
    if (c && c.phase.is('capturing', 'captured', 'running')) {
      // Mid-flight: the drop turns round (or the dissolve fades back). Back into the switch, the page's own change waits
      // until the drop has gone (the page is the drop's picture); out again, the page already holds this theme and the
      // waiting change is dropped. Before the old picture is taken nothing may change on the page: out again then, the
      // change waits for the update callback instead (a third quick toggle that swapped the page here, before the
      // capture, would leave the new theme in the old picture, and the drop would spread over a page changed in a frame).
      if (c.target === 'cover') {
        c.pending = run;
        aim(c, 'gone');
      } else {
        c.pending = null;
        if (c.phase.is('capturing')) c.run = run;
        else swap(run);
        aim(c, 'cover');
      }
      return;
    }
    // A chain whose drop has settled (the screen already shows what the page holds) gives way to a new one at once.
    if (c) end(c, true);
    begin(run, calm || slow || ENGINE.gecko ? 'dissolve' : 'drop', calm ? TK.CALM : TK.FADE);
  }

  function begin(run, mode, ms) {
    const b = sw?.isConnected ? sw.getBoundingClientRect() : null;
    const box = b?.width ? b : { left: innerWidth - 150, top: 14, width: 60, height: 28 };
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const drop = mode === 'drop';
    const c = {
      mode, ms, x, y, ex: Math.max(0, (box.width - box.height) / 2), R: cover(x, y), target: 'cover', path: null, anim: null,
      rimAnim: null, keeper: null, rim: null, run, pending: null, phase: machine('capturing', CHAIN_MOVES), vt: null, dts: [], lastTs: 0,
      cut: false, out: [], paper: false, bare: [],
    };
    c.shade = shadeMachine(c);
    // Every card as the page draws it in the old picture: the chain before this one gives its cards their shadows back
    // at once, whether they were still plain or the shadows were on their way in.
    lastChain?.shade.go('whole');
    lastChain = c;
    cur = c;
    vtState.go('changing');
    wheel = 0;
    // In WebKit, where each card starts to show in the new picture (a theme moves nothing, so it is all measured now).
    if (BARE) cardsOut(c);
    // The first frame, before the animations take over: no drop yet (or nothing of the new picture).
    root.style.setProperty('--vt-x', `${x.toFixed(1)}px`);
    root.style.setProperty('--vt-y', `${y.toFixed(1)}px`);
    root.style.setProperty('--vt-ex', `${c.ex.toFixed(1)}px`);
    root.style.setProperty('--vt-r', '0px');
    root.style.setProperty('--vt-m', String(1 + TK.LENS));
    root.classList.add('vt', drop ? 'vt-drop' : 'vt-dis');
    lensOn.go(vtLensReady.is('ready') && drop ? 'on' : 'off');
    // Only Chromium draws a backdrop filter into a transition's pictures: elsewhere the top bar's strip holds its ground
    // without the blur for the length of the change (style.css).
    root.classList.toggle('vt-flat', !ENGINE.chromium);
    if (vtLensReady.is('ready')) vtLens.fdm.setAttribute('scale', '0');
    try {
      c.vt = document.startViewTransition(() => {
        // The old picture is taken: the page takes the theme last asked for before now (c.run).
        swap(c.run);
        // In the new picture only (not once the change has been cut short: then the page itself shows): the cards the
        // drop's first frames cannot reach (on paper, every card) go without their shadows.
        if (c.phase.go('captured')) {
          const first = reach(x, y) + 40;
          c.paper = api.ground() === 'light';
          c.bare = c.paper ? [...c.out] : c.out.filter((b) => b.at > first);
          if (c.bare.length) c.shade.go('bare');
        }
        if (drop) {
          // The rim belongs to the new state only, lit for the theme it holds.
          c.rim = mk('div', `vt-rim vt-${api.ground()} ${OWN_GROUP ? 'vt-own' : 'vt-pic'}`);
          c.rim.append(mk('i', 'vt-body'), mk('i', 'vt-spec'));
          c.rim.style.opacity = '0';
          if (!OWN_GROUP) c.rim.setAttribute('popover', 'manual');
          document.body.append(c.rim);
          if (!OWN_GROUP && typeof c.rim.showPopover === 'function') {
            try {
              c.rim.showPopover();
            } catch {
              // Drawn in the page instead.
            }
          }
        }
        // The lockup about to show is decoded (it almost always already is), so the new picture never has an empty logo.
        const shown = [...document.querySelectorAll(`img.lockup-${api.ground() === 'dark' ? 'white' : 'ink'}`)];
        return Promise.race([Promise.all(shown.map((i) => i.decode?.().catch(() => {}))), new Promise((ok) => setTimeout(ok, 150))]);
      });
    } catch {
      loose(c);
      swap(run);
      return;
    }
    // Both pictures are in: the drop sets off, unless this chain has been cut short meanwhile (the table refuses a run
    // from ending or over, so a late ready of an overtaken chain changes nothing).
    c.vt.ready.then(() => {
      if (!c.phase.go('running')) return;
      aim(c, c.target, c.target === 'cover');
      wake(tJob);
    }, () => {});
    const over = () => {
      // However it ended (finished, skipped, KEEP), the page holds the last theme asked for.
      if (c.pending) {
        const p = c.pending;
        c.pending = null;
        swap(p);
      }
      c.phase.go('over');
      retire(c);
      judge(c);
      loose(c);
      c.rim?.remove();
      reconcile();
    };
    c.vt.finished.then(over, over);
  }

  // WebKit: lists each card on screen (out) with, for a drop, the radius at which it starts to show: the distance from
  // the switch's capsule to the card's box with its shadow, and the drop's soft edge. The drop is an ellipse inside
  // that capsule-shaped reach, and its picture is magnified about the switch (by at most 3%), so a card has all of
  // itself a little before it shows. In a dissolve the whole new picture shows at once (0).
  function cardsOut(c) {
    const h = innerHeight;
    for (const li of document.querySelectorAll('.stage .card, .grid .card')) {
      const b = li.getBoundingClientRect();
      if (!b.width || b.bottom + CARD_SHADOW <= 0 || b.top >= h) continue;
      let at = 0;
      if (c.mode === 'drop') {
        const dx = Math.max(0, b.left - CARD_SHADOW - c.x, c.x - b.right - CARD_SHADOW);
        const dy = Math.max(0, b.top - CARD_SHADOW - c.y, c.y - b.bottom - CARD_SHADOW);
        at = Math.hypot(Math.max(0, dx - c.ex), dy) - BARE_PAD;
      }
      c.out.push({ el: li, at });
    }
  }

  // A dissolve's leg: the new picture's opacity from p0 to p1, eased in and out (a sine), over its share of ms.
  function fadePath(p0, p1, ms) {
    const n = Math.max(1, Math.round((Math.abs(p1 - p0) * ms * TK.FPS) / 1000));
    const out = [];
    for (let i = 0; i <= n; i++) out.push({ r: p0 + ((p1 - p0) * (1 - Math.cos((Math.PI * i) / n))) / 2, v: 0 });
    return out;
  }

  // Sends the drop toward its target from wherever it is, at the speed it has. A first leg from a switch out of the
  // window starts where the drop first reaches the window, so nothing waits on an empty screen.
  function aim(c, target, first = false) {
    const drop = c.mode === 'drop';
    const { r, v } = !first ? now(c) : drop ? { r: reach(c.x, c.y), v: TK.KICK } : { r: 0, v: 0 };
    c.target = target;
    c.path = !drop ? fadePath(r, target === 'cover' ? 1 : 0, c.ms)
      : target === 'cover' ? path(r, v, c.R * TK.OVER, TS.OUT, c.R) : path(r, v, -8, TS.BACK, 0);
    if (!c.phase.is('running')) return;
    for (const a of [c.keeper, c.anim, c.rimAnim]) a?.cancel();
    try {
      // Holds the transition open until the chain says it is over, KEEP at most from its last turn.
      c.keeper = root.animate([{ opacity: 1 }, { opacity: 1 }], { duration: TK.KEEP, pseudoElement: '::view-transition-group(root)' });
      const o = { duration: Math.max(1, ((c.path.length - 1) / TK.FPS) * 1000), easing: 'linear', fill: 'forwards' };
      if (!drop) {
        c.anim = root.animate(c.path.map(({ r: p }) => ({ opacity: p.toFixed(4) })), { ...o, pseudoElement: '::view-transition-new(root)' });
        return;
      }
      // The drop's picture (the new one) is magnified about the switch; its mask is scaled back so the edge stays put.
      c.anim = root.animate(c.path.map(({ r: rr }) => {
        const m = mag(rr, c.R);
        return { '--vt-r': `${(rr / m).toFixed(2)}px`, transform: `scale(${m.toFixed(5)})` };
      }), { ...o, pseudoElement: '::view-transition-new(root)' });
      // Inside the drop's picture (a popover) the rim is magnified with it, so it is drawn at r / m to land on the edge.
      c.rimAnim = c.rim?.animate(c.path.map(({ r: rr }) => ({ '--vt-r': `${(OWN_GROUP ? rr : rr / mag(rr, c.R)).toFixed(2)}px`, opacity: rimAlpha(rr) })), o) ?? null;
    } catch {
      // A browser that cannot animate the transition's pictures simply changes.
      end(c, true);
    }
  }

  // The chain's frame: fits the Chromium lens to the drop, times the drop's frames, and ends the chain when the drop has
  // covered the page or gone (applying the waiting change while nothing of it can be seen).
  function tJob(dt, ts) {
    const c = cur;
    if (!c || !c.phase.is('running') || !c.anim) return false;
    if (c.lastTs) c.dts.push(ts - c.lastTs);
    c.lastTs = ts;
    const t = c.anim.currentTime || 0;
    const { r } = at(c.path, t);
    const last = t >= c.anim.effect.getComputedTiming().duration;
    // A leg back into the switch ends where its last frame is, like a leg out: never on a radius that only nears zero.
    if (c.target === 'gone' && (r <= 0 || last)) {
      if (c.pending) {
        const p = c.pending;
        c.pending = null;
        swap(p);
      }
      // The drop is gone: the page shows its cards whole again.
      c.shade.go('whole');
      end(c);
      return false;
    }
    if (c.target === 'cover' && last) {
      // The drop covers the page: on paper the cards kept plain get their shadows back over BACK ms, else at once.
      c.shade.go(c.paper ? 'back' : 'whole');
      end(c);
      return false;
    }
    // WebKit: the cards the spreading drop is about to reach get their shadows back (on paper every card, only once the
    // change is over).
    if (c.shade.is('bare') && c.mode === 'drop' && c.target === 'cover' && !c.paper) {
      const ahead = Math.max(r, at(c.path, t + BARE_LEAD).r);
      c.bare = c.bare.filter((b) => {
        if (b.at > ahead) return true;
        b.el.classList.remove('vt-out');
        return false;
      });
    }
    if (vtLensReady.is('ready') && c.mode === 'drop' && lensOn.is('on')) {
      const m = mag(r, c.R);
      const rl = r / m;
      const el = c.ex / m;
      vtLens.fim.setAttribute('x', f2(c.x - rl - el));
      vtLens.fim.setAttribute('y', f2(c.y - rl));
      vtLens.fim.setAttribute('width', f2(Math.max(0.01, 2 * (rl + el))));
      vtLens.fim.setAttribute('height', f2(Math.max(0.01, 2 * rl)));
      vtLens.fdm.setAttribute('scale', f2((2 * Math.min(TK.BEND * r, TK.BEND_MAX)) / m));
    }
    return true;
  }

  // Was that drop drawn at frame rate? A device that missed most of its frames (an older phone painting the mask on the
  // CPU) dissolves from now on, for this visit: a dissolve only fades a picture the GPU already holds. The first two
  // frames of any view transition are long (the old page is captured), so they are not counted; a drop cut short (a tap,
  // a scroll) says nothing, nor does a stall of half a second (the page put away).
  function judge(c) {
    if (c.mode !== 'drop' || c.cut || slow) return;
    const d = c.dts.slice(2);
    if (d.length < 5 || document.hidden || d.some((x) => x > 500)) return;
    const sorted = [...d].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const miss = d.filter((x) => x > 25).length / d.length;
    if (p50 > TK.SLOW_P50 || miss > TK.SLOW_MISS) slow = true;
  }
  // The chain is over: the screen shows exactly what the page holds, so the transition can end.
  function end(c, skip = false) {
    if (skip && !c.phase.is('ending', 'over')) c.cut = true;
    c.phase.go('ending');
    if (skip || !c.keeper) {
      c.vt?.skipTransition();
      retire(c);
    } else c.keeper.finish();
  }
  // A chain's animations name their pseudo-elements, not one transition's: left alive they would act on the next
  // transition's pictures (and its keeper would hold it open), so they go once nothing of them can be seen.
  function retire(c) {
    for (const a of [c.keeper, c.anim, c.rimAnim]) a?.cancel();
    c.keeper = c.anim = c.rimAnim = null;
  }
  // Completes a change in flight at once (the page is wanted for something else).
  function finishNow() {
    const c = cur;
    if (!c) return;
    if (c.pending) {
      const p = c.pending;
      c.pending = null;
      swap(p);
    }
    end(c, true);
    loose(c);
  }
  // What the change put on the root comes off (vtState, on its way back to none).
  function cleanup() {
    // A chain cut short still holds cards plain: they get their shadows back now, over BACK ms where the page ends on
    // paper, else at once. (One that ran to its end has already done so: its frame moved the cards on.)
    const c = lastChain;
    if (c.shade.is('bare')) c.shade.go(api.ground() === 'light' && c.bare.length ? 'back' : 'whole');
    root.classList.remove('vt', 'vt-drop', 'vt-dis', 'vt-flat');
    lensOn.go('off');
    unstyle(root, ['--vt-x', '--vt-y', '--vt-ex', '--vt-r', '--vt-m']);
    if (vtLensReady.is('ready')) vtLens.fdm.setAttribute('scale', '0');
    for (const el of document.querySelectorAll('.vt-rim')) el.remove();
  }
  // Whatever happened in between, the page ends on the theme the switch shows.
  function reconcile() {
    if (cur) return;
    const want = api.theme();
    if (api.ground() !== want) swap(() => api.applyTheme(want));
  }

  // ---- input during the change ----
  // While a view transition runs the browser hit-tests the whole page as <html>, and the click that follows lands there
  // too (iOS may not send it at all). So a press is acted on at its release:
  // - on the switch: the switch gets the press and the release (its droplet swells under the finger as always), then its
  //   click (a toggle mid-flight);
  // - anywhere else: the change completes at once on the press, and a tap is handed to what is under it on release.
  // The stray click that follows is swallowed: on <html>, or on what the press was handed to when the change has ended
  // or started again by the time the browser sends it (WebKit sends a tap's click a moment after the release: it landed
  // on the switch and turned it a second time). Keys never land on <html>: Space on the switch just works.
  let press = null;
  let swallowUntil = 0;
  let swallowOn = null;
  let wheel = 0;
  const inside = (el, e) => {
    if (!el?.isConnected) return false;
    const b = el.getBoundingClientRect();
    return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
  };
  const forward = (el, e) => {
    try {
      el.dispatchEvent(new PointerEvent(e.type, {
        bubbles: true, cancelable: true, composed: true, view: window, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        button: e.button, buttons: e.buttons, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        width: e.width, height: e.height, pressure: e.pressure,
      }));
    } catch {
      // The click still reaches it.
    }
  };
  const activate = (el, e) => {
    const act = el.closest('button, a, [role="switch"], label, summary');
    // The theme switch reads where on it the click fell (its two sides), so its click carries the press's point.
    if (act && act !== sw) act.click();
    else (act || el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, detail: 1, button: 0 }));
  };
  // The press was handed to el: the click the browser sends for it is not another one.
  const handed = (el, e) => {
    swallowUntil = e.timeStamp + 700;
    swallowOn = el.closest('button, a, [role="switch"], label, summary') || el;
    activate(el, e);
  };
  addEventListener('pointerdown', (e) => {
    // Only a real press (the one handed on to the switch is not). A new press owns whatever click comes next.
    if (!e.isTrusted) return;
    swallowUntil = 0;
    swallowOn = null;
    if (!cur || e.target !== root || e.button !== 0) { press = null; return; }
    if (inside(sw, e)) {
      press = { sw, id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
      forward(sw, e);
    } else {
      press = { sw: null, id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
      finishNow();
    }
  }, true);
  for (const type of ['pointerup', 'pointercancel']) {
    addEventListener(type, (e) => {
      const p = press;
      if (!p || !e.isTrusted || e.pointerId !== p.id) return;
      press = null;
      if (p.sw) {
        if (e.target === root && p.sw.isConnected) forward(p.sw, e);
        if (type === 'pointerup' && p.sw.isConnected) handed(p.sw, e);
        return;
      }
      // A tap (not a scroll or a long press) on the page during the change: the change is over, so it reaches its target.
      const tap = type === 'pointerup' && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10 && e.timeStamp - p.t < 600;
      const el = tap ? document.elementFromPoint(e.clientX, e.clientY) : null;
      if (el && el !== root) handed(el, e);
    }, true);
  }
  addEventListener('click', (e) => {
    if (!e.isTrusted || e.timeStamp > swallowUntil) return;
    // A click from a key (detail 0) is never a press's stray one.
    if (e.target !== root && !(e.detail > 0 && swallowOn?.contains(e.target))) return;
    swallowUntil = 0;
    swallowOn = null;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  // A real scroll during the change completes it (the old picture cannot scroll); a trackpad's last flick of momentum
  // does not.
  addEventListener('wheel', (e) => {
    if (!cur) { wheel = 0; return; }
    wheel += Math.abs(e.deltaY) + Math.abs(e.deltaX);
    if (wheel > 48) {
      wheel = 0;
      finishNow();
    }
  }, { capture: true, passive: true });

  // app.js's switch was pressed (or another tab changed the theme, instant): the switch's droplet goes to the chosen
  // glyph, which answers, and the new theme spreads out of the switch. Returns false when the page should simply change
  // now (instant, forced colours, a hidden tab): app.js then swaps it in one frame.
  function themeChange(next, apply, instant = false) {
    if ((next !== 'dark' && next !== 'light') || typeof apply !== 'function') return false;
    if (instant || FORCED.matches || document.hidden) {
      placeSw(true);
      finishNow();
      return false;
    }
    placeSw(false);
    glyphPop(next);
    transition(() => apply(next));
    return true;
  }

  return Object.freeze({ themeChange, dropPlace, grab, veilPaint, veilPainted: painted, veilClear, viewJoin, viewRoom });
}
