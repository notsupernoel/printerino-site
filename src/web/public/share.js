// The share card (app.js, "the share card"): the open chart panel as a picture, drawn on a canvas in the current theme,
// then handed to a phone's share sheet, or saved by a desktop with an offer to copy it. app.js imports this module once
// a panel has settled and calls install() with what it needs; the hooks it hands back are all it is ever asked for.
// Every comment in this file sits on a line of its own: the server strips comment lines before serving it.
//
// The picture is the panel, card alone, edge to edge: 960 x 540 CSS pixels (16:9) drawn at 2x, 1920 x 1080, with square
// corners and no ground round it (apps round a picture's corners themselves, and a transparent corner turns black in a
// JPEG). It keeps the panel's own layout, type and colours: the coin top left (its art scaled and cut round as the page
// does both), the symbol and name, the price, the chip row; top right the time of
// its prices on the symbol's baseline; under it, on the chip row's baseline and in the "24h" key's type, the candle
// size and the view ("4H · Candles"), where the panel has its controls; the chart as it is drawn; and the lockup,
// small, bottom left. Nothing you press is in it (you cannot press a picture).
//
// Type: the canvas sets Inter as the page does through the font's private code points for the page's character
// variants and tabular figures (tools/share/font.mjs); the font's optical size is pinned at the text cut the page uses.
// Strict CSP: nothing is ever shown from a data: or blob: URL. The PNG is made with toBlob and leaves the page as a file
// (the share sheet), a download (an anchor with a blob: URL, which displays nothing) or the clipboard.
// Zero work at rest: a card is drawn only when asked for (a press, a pointer or the focus on the share button), or on a
// phone when the panel's view changes while it is open (once, when the browser is next idle), so the share sheet opens
// inside the tap, as iOS asks. A card drawn ahead is never drawn while anything moves (a scrub, the sheet under a
// finger, a morph, the panel's open or close: busy, from app.js) or while a finger is down on the panel: it would cost
// those frames. Whatever moved asks again when it ends.
//
// Its states are explicit machines (machine() below, the same as the server's src/web/machine.js, copied because this
// file is served on its own): the panel's run, the cards being made, drawing ahead, the share sheet and the copy offer.

// An explicit state machine, declared rather than implied: its states are the keys of `moves`, each listing the
// states it may move to. go() refuses any other move (false, nothing changes); epoch counts the moves, so a callback
// that started in one state can tell it has been overtaken; on() hears every move as (to, from), which is where what
// follows from a state is applied.
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

export function install(api) {
  if (api?.version !== 1 || !api.P?.share) return null;
  const { P, dlg, REDUCED, EASE, scene, say } = api;
  const busy = typeof api.busy === 'function' ? api.busy : () => false;
  const W = 960;
  const H = 540;
  const K = 2;
  const PAD = 28;
  const RIGHT = W - PAD;
  // The panel's header, as it lays it out at 960px: the coin with its two names beside it (16px on, centred on the
  // coin), the price under them from the left margin, then the chip row (its parts centred in it, 8px apart).
  const COIN = { x: PAD, y: PAD, size: 64 };
  // A coin's art is a grid of this many cells a side.
  const CELLS = 96;
  const COL = PAD + 64 + 16;
  const SYM = { top: PAD + 9, lh: 28 };
  const NAME = { top: SYM.top + 28, lh: 18 };
  const PRICE = { top: PAD + 64 + 22, lh: 56 };
  const MOVE = { top: PRICE.top + 56 + 14, h: 23, gap: 8 };
  // The day's four figures on the header's right, two by two, ending on the chip row's bottom: each a label over its
  // figure, 14px between the rows and 36px between the columns, every word ending on its column's right edge.
  const FIG = { lab: 18, val: 20, row: 14, col: 36 };
  FIG.top = MOVE.top + MOVE.h - 2 * (FIG.lab + FIG.val) - FIG.row;
  // The lockup, 18px tall, on the bottom margin; the chart's box 24px under the chip row and 16px over the lockup, the
  // full width between the margins. (The panel's chart runs to its edges; a card is a picture on its own, and a line
  // that reached its edge would read as cut off, so here the line starts on the left margin, under the price.)
  const LOCKUP = 18;
  const LINE_LEAD = 10;
  const CHART = { x: PAD, y: MOVE.top + MOVE.h + 24, w: W - 2 * PAD };
  CHART.h = H - PAD - LOCKUP - 16 - CHART.y;
  // Each word's type, as the stylesheet sets it: weight, size, letter-spacing (em) and whether its figures line up.
  const TYPE = {
    sym: { w: 600, size: 22, ls: -0.025 },
    name: { w: 400, size: 13, ls: 0 },
    price: { w: 800, size: 56, ls: -0.04, tab: true },
    figKey: { w: 400, size: 12, ls: -0.005 },
    figVal: { w: 500, size: 15, ls: -0.01, tab: true },
    chip: { w: 700, size: 12, ls: 0.02, tab: true },
    key: { w: 400, size: 12, ls: -0.005 },
    abs: { w: 600, size: 13, ls: -0.01, tab: true },
    sess: { w: 400, size: 12, ls: 0 },
    stamp: { w: 400, size: 11, ls: 0 },
    axis: { w: 500, size: 10, ls: 0, tab: true },
    tz: { w: 500, size: 10, ls: 0.04 },
  };
  // The font's private code points (tools/share/font.mjs): figures with the page's variants, the raised signs, and the
  // tabular set. Chrome's canvas shapes a private code point in a run of its own (no kerning or contextual alternate
  // across its edges), so a word asks for one only where the glyph differs: of the proportional figures only 1, 3, 6
  // and 9 have variants (0, 2, 4, 5, 7 and 8 are drawn as they are); every tabular figure differs.
  const PROP = '0123456789';
  const VARIANT = '1369';
  const TAB = '0123456789,.:+−-';
  const RAISED_PLUS = '\ue00a';
  const RAISED_MINUS = '\ue00b';
  const SHEET = matchMedia('(hover: none) and (pointer: coarse)');
  const MON = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const HM = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  // ---- what a card is made of ----
  const picture = (src) => new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('picture'));
    img.src = src;
  });
  // The page's own files only (the lockups in the page, the coins' art: a light card is handed each coin's twin for
  // paper, under /icons/light/).
  const LOCKUP_URL = /^\/lockup(-ink)?\.svg(\?v=[0-9a-f]+)?$/;
  const ICON = /^\/icons\/(light\/)?[a-z0-9]+\.(png|webp)(\?v=[0-9a-f]+)?$/;
  const lockups = new Map();
  // A coin's art, decoded once per visit (its outline colour is read from it once too).
  const arts = new Map();
  function artFor(src) {
    if (!arts.has(src)) arts.set(src, picture(src).catch(() => { arts.delete(src); return null; }));
    return arts.get(src);
  }
  function lockupFor(theme) {
    const src = document.querySelector(`.foot-line .lockup-${theme === 'dark' ? 'white' : 'ink'}`)?.getAttribute('src') ?? '';
    if (!LOCKUP_URL.test(src)) return Promise.resolve(null);
    if (!lockups.has(src)) lockups.set(src, picture(src).catch(() => { lockups.delete(src); return null; }));
    return lockups.get(src);
  }
  // Inter, once the page's font is in (one file holds every weight); without it the card is set in the system's sans
  // serif, with plain figures (the private code points are the font's own).
  async function interIn() {
    try {
      await document.fonts?.load('800 44px Inter', '0\ue010');
      return [...(document.fonts ?? [])].some((f) => f.family.replace(/["']/g, '') === 'Inter' && f.status === 'loaded');
    } catch {
      return false;
    }
  }

  // A coin's outline colour: its art's outermost pixels, read round the circle (the median, so a sparkle or a gap on the
  // edge does not count).
  const rims = new WeakMap();
  function rimOf(art) {
    if (rims.has(art)) return rims.get(art);
    let rim = 'rgba(0, 0, 0, 0)';
    try {
      const n = art.naturalWidth;
      const cv = document.createElement('canvas');
      cv.width = n;
      cv.height = n;
      const x = cv.getContext('2d');
      x.drawImage(art, 0, 0);
      const d = x.getImageData(0, 0, n, n).data;
      const found = [];
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        for (let r = n / 2 - 0.5; r > n / 4; r -= 0.5) {
          const px = Math.round(n / 2 - 0.5 + Math.cos(a) * r);
          const py = Math.round(n / 2 - 0.5 + Math.sin(a) * r);
          const i = (py * n + px) * 4;
          if (d[i + 3] > 200) { found.push([d[i], d[i + 1], d[i + 2]]); break; }
        }
      }
      if (found.length) {
        found.sort((p, q) => p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722 - (q[0] * 0.2126 + q[1] * 0.7152 + q[2] * 0.0722));
        const [r, g, b] = found[found.length >> 1];
        rim = `rgba(${r}, ${g}, ${b}, 1)`;
      }
    } catch {
      rim = 'rgba(0, 0, 0, 0)';
    }
    rims.set(art, rim);
    return rim;
  }

  // ---- drawing ----
  // The theme's colours, from the stylesheet's own tokens (rgb() written the old way, which every canvas reads).
  function colours() {
    const css = getComputedStyle(document.documentElement);
    const tok = (n) => css.getPropertyValue(n).trim();
    const legacy = (v) => {
      const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?)\s*)?\)$/.exec(v);
      if (!m) return v;
      const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
      return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
    };
    const rgb = (n, a = 1) => `rgba(${tok(n).split(/\s+/).join(', ')}, ${a})`;
    // A colour's red, green and blue ("r, g, b"), for a wash that fades it out.
    const triplet = (v) => {
      const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(v);
      if (hex) return hex.slice(1).map((h) => parseInt(h, 16)).join(', ');
      const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
      return m ? `${m[1]}, ${m[2]}, ${m[3]}` : v.split(/\s+/).join(', ');
    };
    return {
      card: legacy(tok('--surface-1')), tag: legacy(tok('--surface-2')),
      text: rgb('--text-rgb'), dim: legacy(tok('--dim-c')), muted: legacy(tok('--muted-c')), faint: legacy(tok('--faint-c')),
      gain: rgb('--gain-rgb'), loss: rgb('--loss-rgb'), gainChip: legacy(tok('--gain-chip')), lossChip: legacy(tok('--loss-chip')),
      gainLine: legacy(tok('--gain-line')), lossLine: legacy(tok('--loss-line')),
      wash: { up: [triplet(tok('--gain-fill-rgb')), Number(tok('--wash-up'))], down: [triplet(tok('--loss-fill-rgb')), Number(tok('--wash-down'))], flat: [triplet(tok('--muted-c')), Number(tok('--wash-flat'))] },
      wm: legacy(tok('--wm-ink')), shade: tok('--shade-rgb').split(/\s+/).join(', '),
    };
  }
  function card(s, chart, art, lockup, inter) {
    const cv = document.createElement('canvas');
    cv.width = W * K;
    cv.height = H * K;
    const ctx = cv.getContext('2d');
    ctx.scale(K, K);
    const c = colours();
    const light = s.theme !== 'dark';
    const family = inter ? 'Inter, ui-sans-serif, system-ui, sans-serif' : 'ui-sans-serif, system-ui, sans-serif';
    const fontOf = (t) => `${t.w} ${t.size}px ${family}`;
    // A word in the font's code points: the page's figures (tabular where the page lines them up), or plain ones.
    const glyphs = (raw, tab) => {
      if (!inter) return raw.replace(/\ue00a/g, '+').replace(/\ue00b/g, '−');
      let out = '';
      for (const ch of raw) {
        const i = tab ? TAB.indexOf(ch) : VARIANT.includes(ch) ? PROP.indexOf(ch) : -1;
        out += i < 0 ? ch : String.fromCharCode((tab ? 0xe010 : 0xe000) + i);
      }
      return out;
    };
    const lsOf = (t) => t.ls * t.size;
    const LS = 'letterSpacing' in ctx;
    const widthOf = (t, g) => {
      ctx.font = fontOf(t);
      if (LS) ctx.letterSpacing = '0px';
      return ctx.measureText(g).width + [...g].length * lsOf(t);
    };
    // The baseline of a line box (top, height) for a type, as a browser lays it out: half the leading above the font's
    // ascent.
    const baseline = (t, top, lh) => {
      ctx.font = fontOf(t);
      const m = ctx.measureText('0');
      const a = m.fontBoundingBoxAscent ?? t.size * 0.96875;
      const d = m.fontBoundingBoxDescent ?? t.size * 0.2412;
      return top + (lh - (a + d)) / 2 + a;
    };
    // Draws a word on a baseline, from its left (or its right, or its middle), and gives its width. Letter-spacing as
    // CSS adds it (after every character); where a canvas has none, each character is set at its place (kerning kept:
    // the place is the width of the word before it).
    const word = (t, raw, x, y, colour, align = 'left') => {
      const g = glyphs(raw, t.tab);
      const w = widthOf(t, g);
      const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      ctx.font = fontOf(t);
      ctx.fillStyle = colour;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const ls = lsOf(t);
      if (!ls) ctx.fillText(g, left, y);
      else if (LS) {
        ctx.letterSpacing = `${ls}px`;
        ctx.fillText(g, left, y);
        ctx.letterSpacing = '0px';
      } else {
        const chars = [...g];
        chars.forEach((ch, i) => ctx.fillText(ch, left + ctx.measureText(chars.slice(0, i).join('')).width + i * ls, y));
      }
      return w;
    };
    const rounded = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    // The card: the panel's surface, square cornered.
    ctx.fillStyle = c.card;
    ctx.fillRect(0, 0, W, H);

    // The coin, as the page draws it: the art cut round by the page's own circle (48.1% of its box, just inside the
    // art's pixel staircase), and scaled by the stylesheet's rule for the panel's coin: pixel for pixel only where
    // every cell of the art gets a whole number of the picture's pixels, smoothly at any other size (64px at 2x is
    // 128 pixels for 96 cells: unsmoothed, some cells would be drawn one pixel wide and others two). Under it a disc
    // of the coin's own outline colour, a quarter pixel smaller: on paper it casts the panel coin's contact shadow
    // (two soft shadows; in the dark none), and the cut's soft edge blends into the outline's colour, never into the
    // card's.
    const cx = COIN.x + COIN.size / 2;
    const cy = COIN.y + COIN.size / 2;
    const R = COIN.size * 0.481;
    if (art) {
      const rim = rimOf(art);
      ctx.save();
      ctx.fillStyle = rim;
      const shadows = light ? [[2, 2, 0.14], [8, 16, 0.12]] : [[0, 0, 0]];
      for (const [dy, blur, a] of shadows) {
        ctx.shadowColor = `rgba(${c.shade}, ${a})`;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = dy * K;
        ctx.shadowBlur = blur * K;
        ctx.beginPath();
        ctx.arc(cx, cy, R - 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.imageSmoothingEnabled = (COIN.size * K) % CELLS !== 0;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(art, COIN.x, COIN.y, COIN.size, COIN.size);
      ctx.restore();
    }

    // The header's words.
    const symBase = baseline(TYPE.sym, SYM.top, SYM.lh);
    word(TYPE.sym, s.sym, COL, symBase, c.text);
    word(TYPE.name, s.exchange ? `${s.name} · ${s.exchange}` : s.name, COL, baseline(TYPE.name, NAME.top, NAME.lh), c.muted);
    word(TYPE.price, s.price, PAD, baseline(TYPE.price, PRICE.top, PRICE.lh), s.known ? c.text : c.muted);
    // The chip row: the chip (its figure 12px on a tag 4px and 9px larger all round), the key, the dollar move, the
    // session note, each centred on the row.
    const mid = MOVE.top + MOVE.h / 2;
    let x = PAD;
    const chipH = TYPE.chip.size * 1.2 + 8;
    const chipW = widthOf(TYPE.chip, glyphs(s.chg, true)) + 18;
    ctx.fillStyle = s.tone === 'gain' ? c.gainChip : s.tone === 'loss' ? c.lossChip : c.tag;
    rounded(x, mid - chipH / 2, chipW, chipH, 7);
    ctx.fill();
    word(TYPE.chip, s.chg, x + 9, baseline(TYPE.chip, mid - chipH / 2 + 4, TYPE.chip.size * 1.2), s.tone === 'gain' ? c.gain : s.tone === 'loss' ? c.loss : c.muted);
    x += chipW + MOVE.gap;
    const keyBase = baseline(TYPE.key, mid - 9, 18);
    x += word(TYPE.key, s.key, x, keyBase, c.muted) + MOVE.gap;
    if (s.abs) x += word(TYPE.abs, s.abs, x, baseline(TYPE.abs, mid - 9.75, 19.5), s.tone === 'gain' ? c.gain : s.tone === 'loss' ? c.loss : c.muted) + MOVE.gap;
    if (s.sess) word(TYPE.sess, s.sess, x, baseline(TYPE.sess, mid - 9, 18), c.faint);
    // Top right: when the prices are from. Its capitals' tops are level with the coin's top, so the card's two top
    // corners are set in by the same amount down as across (on the symbol's baseline it sat 22px lower than it is in
    // from the right).
    ctx.font = fontOf(TYPE.stamp);
    const stampCap = ctx.measureText('N').actualBoundingBoxAscent || TYPE.stamp.size * 0.727;
    word(TYPE.stamp, stampOf(s.at).text, RIGHT, cy - R + stampCap, c.faint, 'right');
    // The day's four figures: the second column ends on the right margin, the first 36px left of the second's widest
    // word. A figure still on its way is an empty word, as in the panel: its label stands alone.
    const figs = s.figures ?? [];
    const wide = (i) => Math.max(widthOf(TYPE.figKey, glyphs(figs[i][0], false)), widthOf(TYPE.figVal, glyphs(figs[i][1], true)));
    if (figs.length === 4) {
      const ends = [RIGHT - Math.max(wide(1), wide(3)) - FIG.col, RIGHT];
      figs.forEach(([key, value], i) => {
        const top = FIG.top + (i >> 1) * (FIG.lab + FIG.val + FIG.row);
        word(TYPE.figKey, key, ends[i & 1], baseline(TYPE.figKey, top, FIG.lab), c.muted, 'right');
        word(TYPE.figVal, value, ends[i & 1], baseline(TYPE.figVal, top + FIG.lab, FIG.val), value === 'n/a' ? c.muted : c.dim, 'right');
      });
    }

    // The chart, in its box (the geometry make() took with the scene).
    const ch = chart;
    if (ch) {
      const g = ch.g;
      ctx.save();
      ctx.translate(CHART.x, CHART.y);
      // The watermark: the lockup as a ghost in one colour, centred on the plot (22% of it plus 92px wide, at most 280px).
      if (lockup?.naturalWidth) {
        const pw = g.x1 - g.x0;
        const ww = Math.min(0.22 * pw + 92, 280);
        const wh = (ww * lockup.naturalHeight) / lockup.naturalWidth;
        const ghost = document.createElement('canvas');
        ghost.width = Math.ceil(ww * K);
        ghost.height = Math.ceil(wh * K);
        const gx = ghost.getContext('2d');
        gx.drawImage(lockup, 0, 0, ghost.width, ghost.height);
        gx.globalCompositeOperation = 'source-in';
        gx.fillStyle = c.wm;
        gx.fillRect(0, 0, ghost.width, ghost.height);
        ctx.drawImage(ghost, g.x0 + (pw - ww) / 2, g.padT + (g.H - wh) / 2, ghost.width / K, ghost.height / K);
      }
      const tone = g.tone === 'gain' ? 'up' : g.tone === 'loss' ? 'down' : 'flat';
      const lineColour = tone === 'up' ? c.gainLine : tone === 'down' ? c.lossLine : c.muted;
      if (s.type === 'line') {
        // The wash under the line, the brand colour at the theme's strength at its top, fading to nothing at the floor;
        // the line, 2px, round; the live end dot, ringed in the card's colour.
        const floor = g.padT + g.H;
        let top = floor;
        for (let i = 0; i < g.n; i++) top = Math.min(top, g.ys[i]);
        const [wash, washA] = c.wash[tone];
        const grad = ctx.createLinearGradient(0, top, 0, floor);
        grad.addColorStop(0, `rgba(${wash}, ${Number.isFinite(washA) ? washA : 0.24})`);
        grad.addColorStop(1, `rgba(${wash}, 0)`);
        // As in the panel, a line whose first point is the plot's first slot starts on the plot's left edge itself (here
        // the card's left margin), level with the first close.
        const start = g.xs[0] > 0 && g.xs[0] <= LINE_LEAD ? 0 : g.xs[0];
        ctx.beginPath();
        ctx.moveTo(start, g.ys[0]);
        for (let i = 0; i < g.n; i++) ctx.lineTo(g.xs[i], g.ys[i]);
        ctx.lineTo(g.xs[g.n - 1], floor);
        ctx.lineTo(start, floor);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(start, g.ys[0]);
        for (let i = 0; i < g.n; i++) ctx.lineTo(g.xs[i], g.ys[i]);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = lineColour;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(g.xs[g.n - 1], g.ys[g.n - 1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = lineColour;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = c.card;
        ctx.stroke();
      } else {
        // The candles: wicks (a cut one ends in a dotted tail at the chart's edge), then the bodies over them.
        ctx.lineWidth = g.ww;
        ctx.lineCap = 'butt';
        for (const up of [true, false]) {
          ctx.strokeStyle = up ? c.gainLine : c.lossLine;
          ctx.beginPath();
          const cut = [];
          for (const cd of g.candles) {
            if (cd.up !== up) continue;
            if (cd.cutH) { ctx.moveTo(cd.x, cd.yh + 7); cut.push([cd.x, cd.yh, cd.yh + 7]); } else ctx.moveTo(cd.x, cd.yh);
            ctx.lineTo(cd.x, cd.top);
            ctx.moveTo(cd.x, cd.bot);
            if (cd.cutL) { ctx.lineTo(cd.x, cd.yl - 7); cut.push([cd.x, cd.yl - 7, cd.yl]); } else ctx.lineTo(cd.x, cd.yl);
          }
          ctx.stroke();
          if (cut.length) {
            ctx.setLineDash([1, 2]);
            ctx.beginPath();
            for (const [cx2, a, b] of cut) { ctx.moveTo(cx2, a); ctx.lineTo(cx2, b); }
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        for (const up of [true, false]) {
          ctx.fillStyle = up ? c.gainLine : c.lossLine;
          ctx.beginPath();
          for (const cd of g.candles) if (cd.up === up) ctx.rect(cd.x - cd.bw / 2, cd.top, cd.bw, Math.max(cd.bot - cd.top, g.ww));
          ctx.fill();
        }
      }
      // The axis words: prices right-aligned in the gutter, times under the plot, a stock's ET under the prices.
      const right = Math.round(g.w - g.edge);
      for (const p of ch.prices) word(TYPE.axis, p.text, right, baseline(TYPE.axis, p.top, 12), c.muted, 'right');
      const timesTop = Math.round(g.padT + g.H + 8);
      for (const t of ch.times) word(TYPE.axis, t.text, t.x, baseline(TYPE.axis, timesTop, 12), c.muted, 'center');
      if (ch.tz) word(TYPE.tz, 'ET', right, baseline(TYPE.tz, timesTop, 12), c.faint, 'right');
      ctx.restore();
    }

    // The lockup, small, bottom left; on its line at the right margin, in the key's type, the candle size and the view.
    if (lockup?.naturalWidth) ctx.drawImage(lockup, PAD, H - PAD - LOCKUP, (LOCKUP * lockup.naturalWidth) / lockup.naturalHeight, LOCKUP);
    word(TYPE.key, `${s.size} · ${s.type === 'candles' ? 'Candles' : 'Line'}`, RIGHT, baseline(TYPE.key, H - PAD - LOCKUP, LOCKUP), c.muted, 'right');
    return cv;
  }
  // When the prices are from, in the viewer's own zone: "Oct 9, 2026 · 08:30 GMT-4", and the day for the file's name.
  // Inter raises the sign between a capital and a figure; an offset with a variant figure ("GMT+9") is a private code
  // point after the sign, which Chrome's canvas shapes apart, so there the sign asks for its raised form itself.
  function stampOf(at) {
    const d = new Date(at);
    const off = -d.getTimezoneOffset();
    const h = Math.floor(Math.abs(off) / 60);
    const m = Math.abs(off) % 60;
    const hm = `${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
    const raised = [...hm].some((ch) => VARIANT.includes(ch));
    const sign = off > 0 ? (raised ? RAISED_PLUS : '+') : raised ? RAISED_MINUS : '\u2212';
    const zone = off ? `GMT${sign}${hm}` : 'GMT';
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { text: `${MON.format(d)} · ${HM.format(d)} ${zone}`, day };
  }

  // ---- one card at a time: the last one made, kept while it still shows what the panel shows ----
  const keyOf = (s) => JSON.stringify([s.sym, s.name, s.exchange, s.price, s.chg, s.tone, s.key, s.abs, s.sess, s.size, s.type, s.theme, stampOf(s.at).text, s.candles, s.figures]);
  // What a phone's card drawn ahead is for: the same without the time's minute (its day stays: the file's name carries
  // it). A poll that moved no price moves the time alone, once a minute, and a card a minute behind still shows the
  // panel: a press shares it, with the time of its own prices on it, rather than a phone redrawing it every minute.
  const needOf = (s) => JSON.stringify([s.sym, s.name, s.exchange, s.price, s.chg, s.tone, s.key, s.abs, s.sess, s.size, s.type, s.theme, stampOf(s.at).day, s.candles, s.figures]);
  // How far behind the panel's time such a card may fall before it is drawn again, so a flat price never shares a very
  // old time.
  const BEHIND = 10 * 60_000;
  // The view a copy offer belongs to: the same chart in the same theme (a new price keeps it: it copies what was saved).
  const viewOf = (s) => `${s.sym}|${s.size}|${s.type}|${s.theme}`;
  // The day's high and low as the scene words them (hilo; empty while the hourly candles they are read from are on
  // their way). They come in after the panel has opened, not with a price: a card that lacks the panel's is not a
  // price update behind it, and is never shared in its place (tap).
  const hiloOf = (s) => s.hilo ?? '';

  // The panel's run, a machine in one of two states:
  //   shut: no panel this module has heard from (at install, and after every close()).
  //   open: a panel is open and has asked for something (a press, a warm, a change of view).
  // Its epoch names the run, and close() ends it: whatever a panel asked for that lands later (a picture, a share
  // sheet's refusal) can tell the panel it was for is gone, though the next one may be open by then.
  const panel = machine('shut', { shut: ['open'], open: ['shut'] });
  // The scene now, its run begun if it had not been.
  const live = () => {
    const s = scene();
    if (s && panel.is('shut')) panel.go('open');
    return s;
  };
  // Whether run is still the panel open.
  const still = (run) => panel.is('open') && panel.epoch === run;

  // The cards being made, a machine in one of four states:
  //   empty:    none in hand, none being made.
  //   making:   one or more being made, none in hand.
  //   made:     the newest one made is in hand (made), none being made.
  //   remaking: one in hand and a newer one being made.
  // made is the card in hand, making the newest ask out (an ask for another picture takes its place), out how many are
  // out. Each is numbered (drawn), so a slower older card never replaces a newer one in hand.
  const slot = machine('empty', {
    empty: ['making'],
    making: ['made', 'empty', 'remaking'],
    made: ['remaking'],
    remaking: ['made'],
  });
  let made = null;
  let making = null;
  let out = 0;
  let drawn = 0;
  // Where a card's end leaves the slot: a card in hand or not, more out or not.
  const settle = () => slot.go(out ? (made ? 'remaking' : 'making') : made ? 'made' : 'empty');
  async function make(s, key) {
    // The chart's geometry and words are taken now, in the run that made the key, so the picture never puts a chart the
    // panel swapped in during the waits below under this scene's header.
    const chart = s.chart(CHART.w, CHART.h);
    const [art, lockup, inter] = await Promise.all([
      ICON.test(s.icon) ? artFor(s.icon) : null,
      lockupFor(s.theme),
      interIn(),
    ]);
    const cv = card(s, chart, art, lockup, inter);
    const blob = await new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error('toBlob'))), 'image/png'));
    const name = `printerino-${s.sym}-${s.size}-${stampOf(s.at).day}.png`;
    const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png', lastModified: s.at }) : null;
    return { key, need: needOf(s), at: s.at, view: viewOf(s), hilo: hiloOf(s), sym: s.sym, blob, name, file };
  }
  function ready() {
    const s = scene();
    if (!s) return Promise.resolve(null);
    const key = keyOf(s);
    if (made?.key === key) return Promise.resolve(made);
    if (slot.is('making', 'remaking') && making?.key === key) return making.promise;
    // Numbered, so a slower older card never replaces a newer one.
    const job = { key, n: ++drawn, promise: null };
    making = job;
    out += 1;
    settle();
    job.promise = make(s, key).then((m) => {
      out -= 1;
      if (making === job) making = null;
      if (!made || job.n > made.n) made = { ...m, n: job.n };
      settle();
      return m;
    }, (e) => {
      out -= 1;
      if (making === job) making = null;
      settle();
      throw e;
    });
    return job.promise;
  }
  // Whatever the panel is still playing (its open, the chart's draw-in, a glint): a card made in the middle of it would
  // cost a slow phone its frames, so the card waits for it (never for an endless one, nor for the coin's twinkling
  // stars, which come and go for seconds on the compositor).
  const playing = () => (dlg?.getAnimations?.({ subtree: true }) ?? []).filter((a) => a.playState === 'running' && a.id !== 'twinkle' && a.effect?.getTiming?.().iterations !== Infinity);
  function afterMotion() {
    const now = playing();
    return now.length ? Promise.allSettled(now.map((a) => a.finished)) : Promise.resolve();
  }
  // Drawn ahead when the browser is next idle (within 1.5 s), once per change of view; where the browser cannot say when
  // it is idle (Safari), 300 ms on (each new ask starts that wait again: fresh), so an iPhone has its card soon after the
  // panel lands and its share sheet opens inside the tap. Whatever moves or presses meanwhile puts it off: still busy
  // when its moment comes, nothing is drawn and the card is owed (the motion's end, or the finger's release, asks
  // again); still playing, it waits for the motion; a finger or a button that comes down on the panel cancels it, and
  // its release arms it afresh. Drawing ahead is a machine in one of five states:
  //   quiet:   nothing waits to be drawn.
  //   waiting: an idle callback (or Safari's timer) is armed to draw the card; idle is its handle.
  //   motion:  its moment came while the panel still played: it waits for the motion's end, then for idle again.
  //   held:    a finger or a button came down on the panel while it waited: the release arms it afresh.
  //   owed:    its moment came while something moved (busy): the motion's end, or the finger's release, asks again.
  // Any way out of waiting cancels the callback; close() takes it from any state to quiet.
  const draw = machine('quiet', {
    quiet: ['waiting'],
    waiting: ['quiet', 'motion', 'held', 'owed'],
    motion: ['waiting', 'quiet'],
    held: ['waiting', 'quiet'],
    owed: ['waiting', 'quiet'],
  });
  let idle = 0;
  let aheadMs = 0;
  draw.on((to, from) => {
    if (from === 'waiting' && idle) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
      else clearTimeout(idle);
      idle = 0;
    }
    if (to !== 'waiting') return;
    const epoch = draw.epoch;
    const run = () => {
      idle = 0;
      if (draw.epoch === epoch) moment();
    };
    idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: aheadMs }) : setTimeout(run, Math.min(aheadMs, 300));
  });
  // The armed wait's moment: still busy, the card is owed; still playing, it waits for the motion (and only while
  // nothing has moved the machine since); else it is drawn.
  function moment() {
    if (busy()) { draw.go('owed'); return; }
    if (playing().length) {
      const ms = aheadMs;
      draw.go('motion');
      const epoch = draw.epoch;
      afterMotion().then(() => { if (draw.epoch === epoch) ahead(ms); });
      return;
    }
    draw.go('quiet');
    ready().catch(() => {});
  }
  // Arms the wait (within ms at most); one already armed is kept, unless fresh asks for the wait to start again.
  function ahead(within, fresh = false) {
    if (draw.is('waiting')) {
      if (!fresh) return;
      draw.go('quiet');
    }
    aheadMs = within;
    draw.go('waiting');
  }
  const sheetLikely = () => SHEET.matches && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  // A phone wants a card drawn ahead when the one it has no longer shows the panel's figures, chart or theme, or tells a
  // time too far behind the panel's.
  const wanted = (s) => Boolean(s && sheetLikely() && (made?.need !== needOf(s) || s.at - made.at > BEHIND));
  dlg?.addEventListener('pointerdown', () => {
    if (draw.is('waiting')) draw.go('held');
  }, { passive: true });
  for (const t of ['pointerup', 'pointercancel']) {
    dlg?.addEventListener(t, () => {
      if (!draw.is('held', 'owed')) return;
      draw.go('quiet');
      if (wanted(scene())) ahead(1500, true);
    }, { passive: true });
  }

  // ---- the copy offer a download leaves ----
  // The copy button, a machine in one of three states:
  //   none:    hidden.
  //   offered: "Copy image", for the picture last saved (offered).
  //   copied:  "Copied", and a press is nothing (aria-disabled) until another picture is saved.
  // A picture saved while one is offered takes its place in the same state: the button already says what it should.
  const copyBtn = machine('none', {
    none: ['offered'],
    offered: ['copied', 'none'],
    copied: ['offered', 'none'],
  });
  let offered = null;
  copyBtn.on((to) => {
    const C = P.copy;
    if (to === 'none') {
      offered = null;
      if (!C.hidden) {
        C.hidden = true;
        C.removeAttribute('aria-disabled');
      }
      return;
    }
    if (to === 'copied') {
      C.textContent = 'Copied';
      C.setAttribute('aria-disabled', 'true');
      return;
    }
    C.textContent = 'Copy image';
    C.removeAttribute('aria-disabled');
    if (!C.hidden) return;
    C.hidden = false;
    C.animate(REDUCED.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
  });
  function offer(m) {
    if (!P.copy || typeof ClipboardItem !== 'function' || typeof navigator.clipboard?.write !== 'function') return;
    offered = m;
    copyBtn.go('offered');
  }
  function unoffer() {
    copyBtn.go('none');
  }
  // The last picture saved (its key: the same picture, whichever object holds it) and when: a second press on it within
  // a second (a double-click, a quick double tap) saves nothing more.
  let lastSave = null;
  function save(m) {
    const now = performance.now();
    if (lastSave?.key === m.key && now - lastSave.at < 1000) return;
    lastSave = { key: m.key, at: now };
    const url = URL.createObjectURL(m.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = m.name;
    a.rel = 'noopener';
    a.hidden = true;
    // In the dialog: the page behind a modal dialog takes no clicks.
    (dlg ?? document.body).append(a);
    a.click();
    a.remove();
    // The download has its own copy by then; the URL goes once it has surely started.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say(`Saving ${m.name}`);
    offer(m);
  }
  // One share sheet at a time, a machine in one of two states:
  //   down: none is up: a press may open one.
  //   up:   one is up, or on its way up: a second tap is nothing.
  // Its answer brings it down only if it is still the sheet up (the epoch it went up in), so an old sheet that answers
  // late never frees a newer one.
  const sheet = machine('down', { down: ['up'], up: ['down'] });
  // m is sent for panel run `run`: a refusal that lands after that panel closed saves nothing over the next one.
  function send(m, run) {
    if (!m) { say('The chart is still loading'); return; }
    if (sheetLikely() && m.file && navigator.canShare({ files: [m.file] })) {
      if (!sheet.go('up')) return;
      const mine = sheet.epoch;
      // The share sheet. Closed without sharing: nothing more. Refused (the tap's moment had passed, or the browser
      // would not share the file): saved instead. A sheet already up (another page's) refuses too: nothing more.
      navigator.share({ files: [m.file], title: `${m.sym} on Printerino`, text: `${m.sym} on Printerino · https://printerino.com/#${m.sym.toLowerCase()}` }).catch((e) => {
        if (e?.name !== 'AbortError' && e?.name !== 'InvalidStateError' && still(run)) save(m);
      }).finally(() => { if (sheet.epoch === mine) sheet.go('down'); });
      return;
    }
    save(m);
  }

  return {
    // A press on the share button: the card made ahead is used inside the press; else it is made first.
    tap() {
      const s = live();
      if (!s) { say('The chart is still loading'); return; }
      const run = panel.epoch;
      const key = keyOf(s);
      if (made?.key === key) { send(made, run); return; }
      // A share sheet must open inside the tap: a card of this same chart made moments ago (a price update behind, with
      // the time of its own prices on it) goes now, rather than a fresh one too late; the fresh one is made for next time.
      // Not a card whose day's high and low are not the panel's (drawn before they came in): that one is made first.
      if (sheetLikely() && made?.view === viewOf(s) && made.hilo === hiloOf(s)) { send(made, run); ahead(1500); return; }
      // Made first: the press carries the picture it asked for and the panel run it was made in, and the picture goes
      // only while that run is the panel open (a close and another coin's panel meanwhile: nothing is shared or saved).
      ready().then((m) => { if (m?.key === key && still(run)) send(m, run); }, () => { if (still(run)) say('The image could not be made'); });
    },
    // The pointer or the focus came to the share button (a desktop): made now, on the next idle moment.
    warm() {
      live();
      ahead(200);
    },
    // The panel's view changed, or what moved in it has stopped: a copy offer for an older picture goes; a phone makes
    // the new card ahead, once the motion is over, if this panel is still the one open.
    soon() {
      const s = live();
      if (offered && (!s || offered.view !== viewOf(s))) unoffer();
      if (!wanted(s)) return;
      const run = panel.epoch;
      afterMotion().then(() => { if (still(run)) ahead(1500, true); });
    },
    copy() {
      const m = offered;
      if (!copyBtn.is('offered')) return;
      const mine = copyBtn.epoch;
      navigator.clipboard.write([new ClipboardItem({ 'image/png': m.blob })]).then(() => {
        if (copyBtn.epoch !== mine || offered !== m) return;
        copyBtn.go('copied');
        say('Image copied');
      }, () => say('The image could not be copied'));
    },
    // The panel closed: its run ends, nothing is made ahead for it, and its offer goes. A share sheet that never
    // answered (a web view may not) no longer holds the next panel's button.
    close() {
      draw.go('quiet');
      sheet.go('down');
      unoffer();
      panel.go('shut');
    },
  };
}
