// The Printerino colour law (one identity, two grounds): every light colour is derived by a written rule from its dark
// master, never picked by hand. Dark is never touched.
//   node tools/colour/law.mjs [params.json] [tokens.json]   prints the table (dark -> light, and each one's contrast on
//                                                            the surfaces it sits on); with a second path, also writes
//                                                            every role as JSON
//   node tools/colour/law.mjs --check                        compares the law with style.css's light block
//                                                            (:root:not([data-theme="dark"])), token by token, and the
//                                                            grounds' copies in theme-boot.js, app.js and index.html
// The light values live in style.css's light block, under the token names in CSSVAR below. To change a light colour,
// change its rule or its dial here, run it, and copy the new value there; --check then says the two agree.
// Zero dependencies (color.mjs, camtwin.mjs).
import * as C from './color.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { camOf, vcD, vcL } from './camtwin.mjs';

// ---- the dark master (style.css :root) ------------------------------------------------------------------------------
export const DARK = {
  green: '#85BB65', gain: '#00C278', loss: '#FD4B4E', amber: '#EFA411',
  white: '#F4F4F6', dim: '#C7C7CA', muted: '#969FAF', faint: '#777B8C',
  ink: '#0B0B0D', ground: '#0A0B0F', card: '#17181E', raised: '#25262D',
};
// ---- the ladder the light theme is derived from (a shallower dark ladder) -------------------------------------------
// The live dark ladder above is deeper (ground #0A0B0F, card #17181E, raised #25262D, a 0.06 OKLCH step, and Faint a
// touch up to keep its 4.21:1 on the card). Every light colour is derived from SOURCE, and DARK above is the live dark
// the ground copies are checked against.
export const SOURCE = { ...DARK, faint: '#75798A', ground: '#0E0F14', card: '#14151B', raised: '#202127' };

// ---- the light grounds: cool paper and white cards ------------------------------------------------------------------
const W = '#FFFFFF', PAPER = '#F1F2F6', INK = '#0E0F14';
const TRACK = C.over('#121626', 0.065, W);   // the segmented controls' track on the white panel
const GLASS = C.over('#FFFFFF', 0.5, PAPER);  // the bottom of a raised glass capsule (the X link) over the paper

// ---- the dials (the defaults are the law; a params file may override them for a test) -------------------------------
const DEF = {
  aa: 4.5, nonText: 3.0, margin: 0.02,  // WCAG 2 floors, with a small margin so the 8-bit hex never rounds under them
  dimPlace: null,                       // null: Dim's own place on dark's ladder, in OKLab lightness (computed below)
  chipK: 0.65,                          // chips: this share of dark's presence (CAM16-UCS step off the card), both chips
  areaK: 0.7,                           // the chart's wash: a big field on paper shouts sooner
  noticeK: 0.6,                         // the notice's tint: the biggest solid field of colour on the page
  redRate: 0.25, amberRate: 0.4,        // degrees (CAM16) toward orange per 0.01 of OKLab L darkened
  pairKeep: 0.9,                        // a related pair (Green Ink, Gain Ink) keeps at least this share of dark's distance
  lossShare: 1,                         // the most of the gamut's chroma Loss Ink may take (1: the twin, uncapped)
  tapeRatio: null,                      // null: the tape's WCAG ratio in dark
  wmK: 0.65,                            // the chart's watermark: this share of dark's presence (set by eye, side by side)
};
const argv = process.argv.slice(2);
const P = { ...DEF, ...(argv[0] && existsSync(argv[0]) ? JSON.parse(readFileSync(argv[0], 'utf8')) : {}) };

// ---- tools ----------------------------------------------------------------------------------------------------------
const Y = (hex) => C.relY(C.hex2rgb(hex));
const darkest = (list) => list.reduce((a, b) => (Y(a) <= Y(b) ? a : b));
const okl = (hex) => C.hex2oklch(hex);
const share = (hex) => { const [L, c, h] = okl(hex); return c / C.maxC(L, h); };
const stepD = (a, b) => C.dEcam(a, b, vcD), stepL = (a, b) => C.dEcam(a, b, vcL);
// Ship a target colour as the 8-bit hex nearest to it in OKLab that still meets test().
function ship(lin, test = () => true, wab = 1) {
  const t = C.lin2oklab(lin);
  const base = C.lin2rgb(lin.map((v) => C.clamp(v, 0, 1))).map(Math.round);
  let best = null, bd = Infinity;
  for (let dr = -2; dr <= 2; dr++) for (let dg = -2; dg <= 2; dg++) for (let db = -2; db <= 2; db++) {
    const rgb = [base[0] + dr, base[1] + dg, base[2] + db];
    if (rgb.some((v) => v < 0 || v > 255)) continue;
    const hex = C.rgb2hex(rgb);
    if (!test(hex)) continue;
    const o = C.lin2oklab(C.rgb2lin(rgb)), d = Math.hypot(o[0] - t[0], wab * (o[1] - t[1]), wab * (o[2] - t[2]));
    if (d < bd) { bd = d; best = hex; }
  }
  return best;
}
// The lightest colour on a line whose WCAG ratio on bg reaches ratio. line(x) gives linear sRGB for a darkness x in 0..1.
function lightest(line, ratio, bg, wab = 1) {
  const ok = (hex) => C.wcag(hex, bg) >= ratio + 1e-9;
  let lo = 0, hi = 1;   // x = 0 lightest, 1 darkest
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (ok(C.rgb2hex(C.lin2rgb(line(m).map((v) => C.clamp(v, 0, 1)))))) hi = m; else lo = m; }
  let x = hi, hex = ship(line(x), ok, wab);
  while (!hex) { x = Math.min(1, x + 0.002); hex = ship(line(x), ok, wab); }
  return hex;
}
// A grey line: dark's own OKLCH hue and chroma, OKLCH lightness moving.
const greyLine = (darkHex) => { const [, c, h] = okl(darkHex); return (x) => C.oklchLin([0.98 - 0.9 * x, c, h]); };
// The perceptual twin of a dark colour: its CAM16 hue (turned toward orange by `rate` per 0.01 of OKLab L darkened) and
// its CAM16 colourfulness M, the dark page seen in a dim room, the light page in daylight; only lightness J moves.
// Where the screen cannot show that colourfulness at that lightness, it takes the most it can (chroma cut at constant
// J and h).
const ORANGE = 50;   // CAM16 hue of orange: red turns up to it, amber turns down to it
// turn: a fixed extra hue turn (degrees CAM16), used only to keep a related pair apart (rule 3b).
// cap: the most of the gamut's chroma (OKLCH, at the colour's own L and h) the twin may take.
function twinLine(darkHex, rate = 0, { turn = 0, cap = 1 } = {}) {
  const d = camOf(darkHex, vcD), Ld = okl(darkHex)[0];
  return (x) => {
    const J = 95 - 90 * x;
    let h = d.h + turn;
    for (let k = 0; k < 4; k++) {   // the turn depends on the OKLab L the colour lands on
      const lin = at(J, h);
      const L = C.lin2oklab(lin)[0];
      h = d.h + turn + Math.sign(ORANGE - d.h) * rate * Math.max(0, (Ld - L) * 100);   // toward orange, from either side
    }
    return at(J, h);
    function at(J, h) {
      const cMax = d.M / vcL.FL ** 0.25;
      const inG = (c) => C.inGamut(C.xyz2lin(C.cam16inv({ J, C: c, h }, vcL).map((v) => v / 100)));
      let c = cMax;
      if (!inG(c)) { let lo = 0, hi = cMax; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (inG(m)) lo = m; else hi = m; } c = lo; }
      let lin = C.xyz2lin(C.cam16inv({ J, C: c, h }, vcL).map((v) => v / 100));
      if (cap < 1) {   // hold OKLab L and h, cut chroma to cap x the gamut's most there
        const [L0, c0, h0] = C.oklab2lch(C.lin2oklab(lin));
        lin = C.oklchLin([L0, Math.min(c0, cap * C.maxC(L0, h0)), h0]);
      }
      return lin;
    }
  };
}
// Tint: a brand colour mixed into white in OKLab (it keeps its own hue). Its step off the surface it really sits on
// (the card for a chip, the paper for the notice) = k x dark's step off the surface dark's tint sits on.
function mixOk(x, bg, f) {
  const a = C.lin2oklab(C.rgb2lin(C.hex2rgb(x))), b = C.lin2oklab(C.rgb2lin(C.hex2rgb(bg)));
  return C.oklab2lin(a.map((v, i) => b[i] + (v - b[i]) * f));
}
function tint(brand, darkTint, darkGround, k, on = W) {
  const target = stepD(darkTint, darkGround) * k;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (stepL(C.rgb2hex(C.lin2rgb(mixOk(brand, W, m))), on) < target) lo = m; else hi = m; }
  const f = (lo + hi) / 2;
  return { hex: ship(mixOk(brand, W, f)), f, target, k: stepL(ship(mixOk(brand, W, f)), on) / stepD(darkTint, darkGround) };
}
// Alpha of a brand colour over white (how an SVG stop paints) whose step off white = k x dark's step.
function alphaStep(brand, darkTop, k) {
  const target = stepD(darkTop, SOURCE.card) * k;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (stepL(C.over(brand, m, W), W) < target) lo = m; else hi = m; }
  return +(((lo + hi) / 2).toFixed(3));
}
const apca = (fg, bg = W) => C.apca(fg, bg);

// ---- the law ----------------------------------------------------------------------------------------------------------
const T = {};
const put = (key, o) => (T[key] = o);

// 1. Surfaces. Ground and card are kept (cool paper, white card). Raised is one step down from the card by dark's own
//    step up (the luminance ratio, 1.13:1), on the paper's hue: that lands on the paper itself, Apple's inset box.
const dkRaisedRatio = C.wcag(SOURCE.raised, SOURCE.card);
const RAISED = (() => {
  const [, c, h] = okl(PAPER);
  const line = (x) => C.oklchLin([1 - 0.2 * x, c, h]);
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (C.wcag(C.rgb2hex(C.lin2rgb(line(m))), W) >= dkRaisedRatio) hi = m; else lo = m; }
  const hex = ship(line(hi), () => true, 6);
  return C.dEok(hex, PAPER) < 0.01 ? PAPER : hex;   // within a hair of the paper: it is the paper
})();

// 2. Tints (chips, notice): before the words, because words are floored on them.
const dkChipGain = C.over(DARK.gain, 0.14, SOURCE.card), dkChipLoss = C.over(DARK.loss, 0.14, SOURCE.card);
const dkNotice = C.over(DARK.amber, 0.1, SOURCE.ground);
const chipGain = tint(DARK.gain, dkChipGain, SOURCE.card, P.chipK, W);
const chipLoss = tint(DARK.loss, dkChipLoss, SOURCE.card, P.chipK, W);
const notice = tint(DARK.amber, dkNotice, SOURCE.ground, P.noticeK, PAPER);

// 3. Greys: dark's own hue and chroma. Muted and Faint as light as the class dark already meets allows, on the darkest
//    surface each sits on; Dim keeps its place on dark's ladder between Text and Muted, in OKLab lightness (dark's
//    greys step down in equal lightness steps, so Dim sits about halfway).
const mutedOn = darkest([PAPER, TRACK, RAISED, notice.hex]);
const muted = lightest(greyLine(DARK.muted), P.aa + P.margin, mutedOn, 6);
const faint = lightest(greyLine(SOURCE.faint), P.nonText + P.margin, W, 6);
const Lok = (hex) => okl(hex)[0];
const place = P.dimPlace ?? (Lok(DARK.white) - Lok(DARK.dim)) / (Lok(DARK.white) - Lok(DARK.muted));
const dimTargetL = Lok(INK) + place * (Lok(muted) - Lok(INK));
const dim = (() => { const line = greyLine(DARK.dim); const x = (0.98 - dimTargetL) / 0.9; return ship(line(x), () => true, 6); })();

// 4. Colour words (inks): the perceptual twin, AA on the darkest surface each sits on.
const accentInkOn = darkest([PAPER, TRACK, GLASS, W]);
const accentInk = lightest(twinLine(DARK.green), P.aa + P.margin, accentInkOn);
const gainInkOn = darkest([chipGain.hex, W]);   // its chip, and the panel's figure on white
// 3b. A related pair keeps its distance. Where the gamut takes Gain's colourfulness on paper, it takes the distance to
//     Green Ink with it; Gain (the colour with more room: Green Ink's hue is the brand's) turns away from Green Ink, toward
//     emerald, by the least that gives back pairKeep of dark's distance. Its line turns with it: Gain keeps one hue.
const pairDark = stepD(DARK.green, DARK.gain);
const gainInkAt = (turn) => lightest(twinLine(DARK.gain, 0, { turn }), P.aa + P.margin, gainInkOn);
const gainTurn = (() => {
  if (stepL(accentInk, gainInkAt(0)) >= P.pairKeep * pairDark) return 0;
  let lo = 0, hi = 20;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (stepL(accentInk, gainInkAt(m)) >= pairDark) hi = m; else lo = m; }
  return Math.ceil(hi * 10) / 10;
})();
const gainInk = gainInkAt(gainTurn);
const lossInkOn = darkest([chipLoss.hex, PAPER, GLASS, W]);   // its chip, the panel's figure, #updated.down on the paper
const lossInk = lightest(twinLine(DARK.loss, P.redRate, { cap: P.lossShare }), P.aa + P.margin, lossInkOn);
const amberInkOn = darkest([PAPER, GLASS, W]);
const amberInk = lightest(twinLine(DARK.amber, P.amberRate), P.aa + P.margin, amberInkOn);

// 5. Marks and the one display word: 3:1 (the large-text and non-text floor).
const accentDisplay = lightest(twinLine(DARK.green), P.nonText + P.margin, W);
const lossLine = C.wcag(DARK.loss, W) >= P.nonText ? DARK.loss : lightest(twinLine(DARK.loss, P.redRate), P.nonText + P.margin, W);
const gainLine = lightest(twinLine(DARK.gain, 0, { turn: gainTurn }), C.wcag(lossLine, W), W);   // weighs what the Loss line weighs
const amberMark = lightest(twinLine(DARK.amber, P.amberRate), P.nonText + P.margin, notice.hex);

// 6. Washes, selection, tape.
const washGain = alphaStep(DARK.gain, C.over(DARK.gain, 0.24, SOURCE.card), P.areaK);
const washLoss = alphaStep(DARK.loss, C.over(DARK.loss, 0.24, SOURCE.card), P.areaK);
const washFlat = alphaStep(muted, C.over(DARK.muted, 0.24, SOURCE.card), P.areaK);   // a flat chart: the wash is Muted, as in dark
const selection = 0.35;   // dark's own share of the brand green
const dkTape = C.over(DARK.white, 0.07, SOURCE.card);
const tapeRatio = P.tapeRatio ?? C.wcag(dkTape, SOURCE.card);
let tapeA = 0; while (C.wcag(C.over(INK, tapeA, W), W) < tapeRatio) tapeA += 0.005;
tapeA = +tapeA.toFixed(3);
// The chart's watermark: dark's white at 5% on the card; on white, ink at wmK of that presence (a ghost behind the data
// reads stronger on paper than the same step on dark: 0.65 matched it by eye, under the wash and on the bare panel).
const dkWm = C.over(DARK.white, 0.05, SOURCE.card);
const wmA = alphaStep(INK, dkWm, P.wmK);

// ---- the table (also tokens.json) -------------------------------------------------------------------------------------
const f2 = (x) => +x.toFixed(2), f1 = (x) => +x.toFixed(1);
const oklchStr = (hex) => { const [L, c, h] = okl(hex); return `oklch(${(L * 100).toFixed(1)}% ${c.toFixed(3)} ${c < 0.002 ? 0 : h.toFixed(1)})`; };
function role(key, name, dark, darkOn, light, lightOn, rule, extra = {}) {
  const o = { role: name, dark, light, dark_on: darkOn, light_on: lightOn, oklch_dark: oklchStr(dark), oklch_light: oklchStr(light), rule, ...extra };
  if (darkOn) { o.apca_dark = f1(C.apca(dark, darkOn)); o.wcag_dark = f2(C.wcag(dark, darkOn)); }
  if (lightOn) { o.apca_light = f1(C.apca(light, lightOn)); o.wcag_light = f2(C.wcag(light, lightOn)); }
  o.wcag_light_white = f2(C.wcag(light, W)); o.apca_light_white = f1(C.apca(light, W));
  put(key, o);
}
role('text', 'Text (White to Ink)', DARK.white, DARK.card, INK, W, "Dark's ground becomes light's ink.");
role('dim', 'Dim', DARK.dim, DARK.card, dim, W, `Keeps its place on dark's ladder in OKLab lightness: ${(place * 100).toFixed(0)}% of the way from Text down to Muted, as on dark. Dark's hue and chroma.`);
role('muted', 'Muted', DARK.muted, DARK.card, muted, mutedOn, 'AA (4.5:1), as dark Muted is, on the darkest surface it sits on, and no darker. Dark\'s hue and chroma.', { also: { white: f2(C.wcag(muted, W)), paper: f2(C.wcag(muted, PAPER)), track: f2(C.wcag(muted, TRACK)), raised: f2(C.wcag(muted, RAISED)), notice: f2(C.wcag(muted, notice.hex)) } });
role('faint', 'Faint', DARK.faint, DARK.card, faint, W, '3:1, the class dark Faint meets (4.2:1, under AA), on the panel where it is used. Dark\'s hue and chroma.', { also: { paper: f2(C.wcag(faint, PAPER)), track: f2(C.wcag(faint, TRACK)) } });
role('ground', 'Ground', DARK.ground, null, PAPER, null, 'Kept: the cool paper.');
role('card', 'Card', DARK.card, null, W, null, 'Kept: the white card.');
role('raised', 'Raised', DARK.raised, DARK.card, RAISED, W, `One step down from the card by dark's step up (${f2(dkRaisedRatio)}:1 against ${f2(C.wcag(RAISED, W))}:1): the paper, Apple's inset box.`);
role('accentInk', 'Green Ink (link, chosen segment)', DARK.green, SOURCE.ground, accentInk, accentInkOn, 'Twin: dark green\'s CAM16 hue and colourfulness, as light as AA on the paper allows.', { also: { white: f2(C.wcag(accentInk, W)), thumb: f2(C.wcag(accentInk, W)), notice: f2(C.wcag(accentInk, notice.hex)) } });
role('accentDisplay', 'Green Display (the headline word)', DARK.green, SOURCE.card, accentDisplay, W, 'Twin, as light as 3:1 (large text) on the hero card allows.');
role('gainInk', 'Gain Ink (a figure going up)', DARK.gain, dkChipGain, gainInk, chipGain.hex, `Twin (the screen's most colourful green there), AA on its chip, turned ${gainTurn} deg toward emerald so it stays as far from Green Ink as on dark.`, { also: { white: f2(C.wcag(gainInk, W)) } });
role('lossInk', 'Loss Ink (a figure going down)', DARK.loss, dkChipLoss, lossInk, chipLoss.hex, `Twin, turned ${P.redRate} deg toward orange per 0.01 L so it stays red, not crimson, AA on its chip and on the paper.`, { also: { white: f2(C.wcag(lossInk, W)), paper: f2(C.wcag(lossInk, PAPER)), glass: f2(C.wcag(lossInk, GLASS)) } });
role('amberInk', 'Amber Ink (a late or stale word)', DARK.amber, SOURCE.card, amberInk, amberInkOn, `Twin, turned ${P.amberRate} deg toward orange per 0.01 L so it stays amber, not mustard, AA on the paper.`, { also: { white: f2(C.wcag(amberInk, W)), glass: f2(C.wcag(amberInk, GLASS)) } });
role('gainLine', 'Gain Line (line, candles, end dot)', DARK.gain, SOURCE.card, gainLine, W, `Twin on Gain Ink's hue (turned ${gainTurn} deg with it), weighing what the Loss line weighs (both lines at the brand red's ratio on white).`);
role('lossLine', 'Loss Line (line, candles, end dot)', DARK.loss, SOURCE.card, lossLine, W, 'The brand red itself: it already clears 3:1 on white.');
role('amberMark', 'Amber Mark (the notice\'s glyph)', DARK.amber, dkNotice, amberMark, notice.hex, 'Twin, turned like the ink, 3:1 on the notice.', { also: { white: f2(C.wcag(amberMark, W)) } });
role('gainChip', 'Gain chip', dkChipGain, SOURCE.card, chipGain.hex, W, `Brand Gain mixed into white in OKLab (${(chipGain.f * 100).toFixed(1)}%), ${P.chipK} of dark's step off the card.`);
role('lossChip', 'Loss chip', dkChipLoss, SOURCE.card, chipLoss.hex, W, `Brand Loss mixed into white in OKLab (${(chipLoss.f * 100).toFixed(1)}%), ${P.chipK} of dark's step off the card.`);
role('notice', 'Notice tint', dkNotice, SOURCE.ground, notice.hex, PAPER, `Brand Amber mixed into white in OKLab (${(notice.f * 100).toFixed(1)}%), ${P.noticeK} of dark's step off the ground, measured on the paper it sits on (the biggest solid field of colour).`);
role('washGain', 'Gain wash (top of the fade)', C.over(DARK.gain, 0.24, SOURCE.card), SOURCE.card, C.over(DARK.gain, washGain, W), W, `Brand Gain at ${(washGain * 100).toFixed(1)}% fading to 0 (dark: 24%), ${P.areaK} of dark's step (a large field).`, { alpha: washGain });
role('washLoss', 'Loss wash (top of the fade)', C.over(DARK.loss, 0.24, SOURCE.card), SOURCE.card, C.over(DARK.loss, washLoss, W), W, `Brand Loss at ${(washLoss * 100).toFixed(1)}% fading to 0 (dark: 24%), ${P.areaK} of dark's step (a large field).`, { alpha: washLoss });
role('washFlat', 'Flat wash (top of the fade)', C.over(DARK.muted, 0.24, SOURCE.card), SOURCE.card, C.over(muted, washFlat, W), W, `Muted at ${(washFlat * 100).toFixed(1)}% fading to 0 (dark: 24%), ${P.areaK} of dark's step (a large field).`, { alpha: washFlat });
role('selection', 'Text selection', C.over(DARK.green, 0.35, SOURCE.card), SOURCE.card, C.over(DARK.green, selection, W), W, 'Brand green at dark\'s own 35%.', { alpha: selection });
role('wm', 'Chart watermark', dkWm, SOURCE.card, C.over(INK, wmA, W), W, `Ink at ${(wmA * 100).toFixed(1)}%, ${P.wmK} of the presence dark's white at 5% has.`, { alpha: wmA });
role('tape', 'Hero ghost tape', dkTape, SOURCE.card, C.over(INK, tapeA, W), W, `Ink at ${(tapeA * 100).toFixed(1)}%, the ratio dark's white at 7% makes (${f2(tapeRatio)}:1).`, { alpha: tapeA });
for (const [k, name, hex, why] of [['green', 'Green (mark, logo full stop, live dot)', DARK.green, 'Never changes: the brand fill in both modes.'], ['gainFill', 'Gain fill (chip and wash source)', DARK.gain, 'Never changes.'], ['lossFill', 'Loss fill (wash source, the down dot)', DARK.loss, 'Never changes.'], ['amberFill', 'Amber fill (notice edge, late dot, tint source)', DARK.amber, 'Never changes.']]) role(k, name, hex, SOURCE.card, hex, W, why);

// separations and balance
const sep = {
  accent_gain_cam16ucs: { dark: f1(stepD(DARK.green, DARK.gain)), light_ink: f1(stepL(accentInk, gainInk)), light_display_line: f1(stepL(accentDisplay, gainLine)) },
  accent_gain_hue_gap: { dark: f1(camOf(DARK.gain, vcD).h - camOf(DARK.green, vcD).h), light_ink: f1(camOf(gainInk, vcL).h - camOf(accentInk, vcL).h), gain_turn: gainTurn },
  gain_loss_colourfulness_ratio: { dark: f2(camOf(DARK.gain, vcD).M / camOf(DARK.loss, vcD).M), light_ink: f2(camOf(gainInk, vcL).M / camOf(lossInk, vcL).M), note: 'the gamut limit: a darker green cannot be as colourful' },
  gamut_share: Object.fromEntries([['lossInk', DARK.loss, lossInk], ['gainInk', DARK.gain, gainInk], ['amberInk', DARK.amber, amberInk], ['accentInk', DARK.green, accentInk]].map(([k, d, l]) => [k, [f2(share(d)), f2(share(l))]])),
  gain_loss_hk_lightness: { dark: [f1(C.hkLstar(DARK.gain)), f1(C.hkLstar(DARK.loss))], light_ink: [f1(C.hkLstar(gainInk)), f1(C.hkLstar(lossInk))], light_line: [f1(C.hkLstar(gainLine)), f1(C.hkLstar(lossLine))] },
  ladder_apca: { dark: [DARK.white, DARK.dim, DARK.muted, SOURCE.faint].map((x) => f1(-C.apca(x, SOURCE.card))), light: [INK, dim, muted, faint].map((x) => f1(apca(x))) },
  chip_step: { dark: [f1(stepD(dkChipGain, SOURCE.card)), f1(stepD(dkChipLoss, SOURCE.card))], light: [f1(stepL(chipGain.hex, W)), f1(stepL(chipLoss.hex, W))] },
  notice_step: { dark: f1(stepD(dkNotice, SOURCE.ground)), light_on_paper: f1(stepL(notice.hex, PAPER)) },
  ladder_oklab_L: { dark: [DARK.white, DARK.dim, DARK.muted, SOURCE.faint].map((x) => f1(Lok(x) * 100)), light: [INK, dim, muted, faint].map((x) => f1(Lok(x) * 100)) },
  cam16: Object.fromEntries([['accentInk', DARK.green, accentInk], ['accentDisplay', DARK.green, accentDisplay], ['gainInk', DARK.gain, gainInk], ['gainLine', DARK.gain, gainLine], ['lossInk', DARK.loss, lossInk], ['amberInk', DARK.amber, amberInk], ['amberMark', DARK.amber, amberMark]].map(([k, d, l]) => { const a = camOf(d, vcD), b = camOf(l, vcL); return [k, { h: [f1(a.h), f1(b.h)], M: [f1(a.M), f1(b.M)] }]; })),
};
export const TOKENS = T, SEP = sep;
if (!process.env.QUIET && !process.argv.includes('--check')) {
  for (const [k, t] of Object.entries(T)) console.log(`${k.padEnd(13)} ${t.dark} -> ${t.light} ${t.oklch_light.padEnd(24)} share ${share(t.light).toFixed(2)}` + (t.light_on ? `  on ${t.light_on} ${t.wcag_light}:1 Lc ${t.apca_light}` : '') + `  | white ${t.wcag_light_white}:1 Lc ${t.apca_light_white}` + (t.apca_dark != null ? `  | dark ${t.wcag_dark}:1 Lc ${t.apca_dark}` : '') + (t.also ? '  ' + JSON.stringify(t.also) : ''));
  console.log(JSON.stringify(sep));
}

// ---- the production tokens (style.css) ----------------------------------------------------------------------------
// Where each role lives in style.css: the light block's token and how its value is written there.
const hexOf = (h) => h.toLowerCase();
const rgbOf = (h) => C.hex2rgb(h).join(' ');
const CSSVAR = {
  text: ['--text-rgb', () => rgbOf(T.text.light)],
  dim: ['--dim-c', () => hexOf(T.dim.light)],
  muted: ['--muted-c', () => hexOf(T.muted.light)],
  faint: ['--faint-c', () => hexOf(T.faint.light)],
  ground: ['--surface-0', () => hexOf(T.ground.light)],
  card: ['--surface-1', () => hexOf(T.card.light)],
  raised: ['--surface-2', () => hexOf(T.raised.light)],
  accentInk: ['--accent-word', () => hexOf(T.accentInk.light)],
  accentDisplay: ['--accent-display', () => hexOf(T.accentDisplay.light)],
  gainInk: ['--gain-rgb', () => rgbOf(T.gainInk.light)],
  lossInk: ['--loss-rgb', () => rgbOf(T.lossInk.light)],
  amberInk: ['--warn-word', () => hexOf(T.amberInk.light)],
  gainLine: ['--gain-line', () => hexOf(T.gainLine.light)],
  lossLine: ['--loss-line', () => hexOf(T.lossLine.light)],
  amberMark: ['--warn-mark', () => hexOf(T.amberMark.light)],
  gainChip: ['--gain-chip', () => hexOf(T.gainChip.light)],
  lossChip: ['--loss-chip', () => hexOf(T.lossChip.light)],
  notice: ['--notice-bg', () => hexOf(T.notice.light)],
  washGain: ['--wash-up', () => String(T.washGain.alpha)],
  washLoss: ['--wash-down', () => String(T.washLoss.alpha)],
  washFlat: ['--wash-flat', () => String(T.washFlat.alpha)],
  tape: ['--tape-ink', () => `rgb(${rgbOf(INK)} / ${T.tape.alpha})`],
  wm: ['--wm-ink', () => `rgb(${rgbOf(INK)} / ${T.wm.alpha})`],
  // Kept as they are in both themes (set once, in :root): the brand fills, and the selection at dark's own 35%.
  green: ['--accent-rgb', null],
  gainFill: ['--gain-fill-rgb', null],
  lossFill: ['--loss-fill-rgb', null],
  amberFill: ['--warn-rgb', null],
  selection: ['::selection (rgb(var(--accent-rgb) / 0.35), both themes)', null],
};
if (argv[1]) {
  const out = {};
  for (const [k, t] of Object.entries(T)) { const { role: name, ...rest } = t; out[name] = { css: CSSVAR[k][0], ...rest }; }
  writeFileSync(argv[1], JSON.stringify({ about: 'Printerino colour law: role -> dark (the master) and light (derived). Generated by tools/colour/law.mjs.', roles: out, checks: sep, dials: P }, null, 1));
}
if (process.argv.includes('--check')) {
  const css = readFileSync(new URL('../../src/web/public/style.css', import.meta.url), 'utf8');
  const at = css.indexOf(':root:not([data-theme="dark"]) {');
  const block = at < 0 ? '' : css.slice(at, css.indexOf('\n}', at));
  const declared = (name) => { const m = new RegExp(`\\s${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(block); return m ? m[1].trim().toLowerCase() : null; };
  let bad = 0, n = 0;
  for (const [k, [name, value, also]] of Object.entries(CSSVAR)) {
    if (!value) continue;
    for (const v of [name, also].filter(Boolean)) {
      n++;
      const got = declared(v);
      const ok = got === value();
      if (!ok) bad++;
      console.log(`${ok ? 'same' : 'DIFF'}  ${v.padEnd(18)} ${String(got).padEnd(22)} law: ${value()}  (${k})`);
    }
  }
  console.log(bad ? `${bad} of ${n} light tokens differ from the law` : `all ${n} light tokens in style.css are the law's`);
  // The two grounds also live outside the stylesheet, as the colour of the browser's own bars: theme-boot.js and app.js
  // write them into the theme-color meta, and index.html carries dark's (the default) as the meta's first value. A
  // ground retuned here reaches the page's chrome only through those three hand-kept copies, so they are read and
  // compared as well.
  const PUBLIC = new URL('../../src/web/public/', import.meta.url);
  const ground = { light: hexOf(T.ground.light), dark: hexOf(DARK.ground) };
  const COPIES = [
    ['theme-boot.js', /t === 'dark' \? '(#[0-9a-f]{6})' : '(#[0-9a-f]{6})'/i, { dark: 1, light: 2 }],
    ['app.js', /const THEME_BAR = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \}/i, { light: 1, dark: 2 }],
    ['index.html', /<meta name="theme-color" content="(#[0-9a-f]{6})">/i, { dark: 1 }],
  ];
  let badCopies = 0, copies = 0;
  for (const [file, re, group] of COPIES) {
    const found = re.exec(readFileSync(new URL(file, PUBLIC), 'utf8'));
    for (const [theme, i] of Object.entries(group)) {
      copies++;
      const got = found ? found[i].toLowerCase() : null;
      const ok = got === ground[theme];
      if (!ok) badCopies++;
      console.log(`${ok ? 'same' : 'DIFF'}  ${`${file} ${theme}`.padEnd(20)} ${String(got).padEnd(22)} law: ${ground[theme]}  (ground)`);
    }
  }
  console.log(badCopies ? `${badCopies} of ${copies} ground copies outside style.css differ from the law` : `all ${copies} ground copies outside style.css are the law's`);
  process.exitCode = bad || badCopies ? 1 : 0;
}
