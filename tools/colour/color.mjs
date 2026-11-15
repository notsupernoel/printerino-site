// Colour science for printerino's light theme. No dependencies.
// sRGB <-> linear <-> XYZ(D65) <-> OKLab/OKLCH, CIELAB, CAM16 (+UCS), APCA-W3 0.1.9, WCAG 2, sRGB compositing,
// OKLCH gamut boundary (the largest chroma a hue holds at a lightness). Only what law.mjs and camtwin.mjs use.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const cbrt = Math.cbrt;
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
export const normH = (h) => ((h % 360) + 360) % 360;

// ---- hex / rgb (0..255 ints, gamma-encoded) ----
export function hex2rgb(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
export const rgb2hex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();

// ---- sRGB transfer ----
export const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const fromLin = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055);
export const rgb2lin = (rgb) => rgb.map(toLin);
export const lin2rgb = (lin) => lin.map(fromLin);

// ---- XYZ D65 ----
export function lin2xyz([r, g, b]) {
  return [
    0.4123907992659595 * r + 0.357584339383878 * g + 0.1804807884018343 * b,
    0.21263900587151036 * r + 0.715168678767756 * g + 0.07219231536073371 * b,
    0.01933081871559185 * r + 0.11919477979462598 * g + 0.9505321522496606 * b,
  ];
}
export function xyz2lin([x, y, z]) {
  return [
    3.2409699419045213 * x - 1.5373831775700935 * y - 0.4986107602930033 * z,
    -0.9692436362808798 * x + 1.8759675015077206 * y + 0.04155505740717561 * z,
    0.05563007969699361 * x - 0.20397695888897657 * y + 1.0569715142428786 * z,
  ];
}
export const relY = (rgb) => lin2xyz(rgb2lin(rgb))[1];

// ---- OKLab (Ottosson) ----
export function lin2oklab([r, g, b]) {
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function oklab2lin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
export const oklab2lch = ([L, a, b]) => [L, Math.hypot(a, b), normH(deg(Math.atan2(b, a)))];
export const lch2oklab = ([L, C, h]) => [L, C * Math.cos(rad(h)), C * Math.sin(rad(h))];
export const hex2oklch = (hex) => oklab2lch(lin2oklab(rgb2lin(hex2rgb(hex))));
export const oklchLin = (lch) => oklab2lin(lch2oklab(lch));
const EPS = 1e-7;
export const inGamut = (lin) => lin.every((v) => v >= -EPS && v <= 1 + EPS);
// The largest chroma sRGB holds at this OKLCH lightness and hue.
export function maxC(L, h) {
  if (L <= 0 || L >= 1) return 0;
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (inGamut(oklchLin([L, m, h]))) lo = m; else hi = m; }
  return lo;
}

// ---- CIELAB (D65) ----
const WD65 = [0.95047, 1, 1.08883];
const fLab = (t) => (t > 216 / 24389 ? cbrt(t) : (24389 / 27 * t + 16) / 116);
export function xyz2lab([x, y, z]) {
  const fx = fLab(x / WD65[0]), fy = fLab(y / WD65[1]), fz = fLab(z / WD65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const hex2lab = (hex) => xyz2lab(lin2xyz(rgb2lin(hex2rgb(hex))));
export const lab2lch = ([L, a, b]) => [L, Math.hypot(a, b), normH(deg(Math.atan2(b, a)))];

// Helmholtz-Kohlrausch (Fairchild & Pirrotta 1991): the lightness a chromatic colour appears to have.
export function hkLstar(hex) {
  const [L, C, h] = lab2lch(hex2lab(hex));
  return L + (2.5 - 0.025 * L) * (0.116 * Math.abs(Math.sin(rad((h - 90) / 2))) + 0.085) * C;
}

// ---- compositing (browsers blend in gamma-encoded sRGB) ----
export function over(fgHex, alpha, bgHex) {
  const f = hex2rgb(fgHex), b = hex2rgb(bgHex);
  return rgb2hex(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}

// ---- WCAG 2 ----
export function wcag(aHex, bHex) {
  const a = relY(hex2rgb(aHex)), b = relY(hex2rgb(bHex));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---- APCA-W3 0.1.9 (constants 0.0.98G-4g) ----
const A = { mainTRC: 2.4, sR: 0.2126729, sG: 0.7151522, sB: 0.072175, normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414, scale: 1.14, loOff: 0.027, deltaYmin: 0.0005, loClip: 0.1 };
export function apcaY(hex) {
  const [r, g, b] = hex2rgb(hex).map((v) => (v / 255) ** A.mainTRC);
  return A.sR * r + A.sG * g + A.sB * b;
}
const softClamp = (Y) => (Y > A.blkThrs ? Y : Y + (A.blkThrs - Y) ** A.blkClmp);
// Lc of text on bg. raw=true skips the low clip and offset (for small, non-text steps such as surfaces).
export function apcaFromY(txtY, bgY, raw = false) {
  const t = softClamp(txtY), b = softClamp(bgY);
  if (Math.abs(b - t) < A.deltaYmin) return 0;
  if (b > t) {
    const s = (b ** A.normBG - t ** A.normTXT) * A.scale;
    if (raw) return s * 100;
    return s < A.loClip ? 0 : (s - A.loOff) * 100;
  }
  const s = (b ** A.revBG - t ** A.revTXT) * A.scale;
  if (raw) return s * 100;
  return s > -A.loClip ? 0 : (s + A.loOff) * 100;
}
export const apca = (txt, bg, raw = false) => apcaFromY(apcaY(txt), apcaY(bg), raw);
// ---- CAM16 (Li et al. 2017), forward and inverse, with CAM16-UCS ----
const M16 = [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]];
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m, A0 = e * i - f * h, B0 = -(d * i - f * g), C0 = d * h - e * g, det = a * A0 + b * B0 + c * C0;
  return [[A0 / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B0 / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C0 / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const M16i = inv3(M16);
const mul = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
// La: adapting luminance cd/m2; Yb: background relative luminance (0..100); surround: 'dark' | 'dim' | 'average'.
export function cam16VC({ La, Yb, surround = 'average', white = [95.047, 100, 108.883], discount = false }) {
  const S = { dark: [0.8, 0.525, 0.8], dim: [0.9, 0.59, 0.9], average: [1, 0.69, 1] }[surround];
  const [F, c, Nc] = S;
  const RGBw = mul(M16, white);
  const D = discount ? 1 : clamp(F * (1 - (1 / 3.6) * Math.exp((-La - 42) / 92)), 0, 1);
  const Dr = RGBw.map((v) => D * (white[1] / v) + 1 - D);
  const k = 1 / (5 * La + 1);
  const FL = 0.2 * k ** 4 * (5 * La) + 0.1 * (1 - k ** 4) ** 2 * cbrt(5 * La);
  const n = Yb / white[1];
  const z = 1.48 + Math.sqrt(n);
  const Nbb = 0.725 * (1 / n) ** 0.2;
  const RGBwc = RGBw.map((v, i) => v * Dr[i]);
  const RGBaw = RGBwc.map((v) => { const x = (FL * Math.abs(v) / 100) ** 0.42; return (400 * Math.sign(v) * x) / (x + 27.13) + 0.1; });
  const Aw = (2 * RGBaw[0] + RGBaw[1] + RGBaw[2] / 20 - 0.305) * Nbb;
  return { F, c, Nc, D, Dr, FL, n, z, Nbb, Ncb: Nbb, Aw, white, La, Yb, surround };
}
export function cam16(xyz100, vc) {
  const RGB = mul(M16, xyz100).map((v, i) => v * vc.Dr[i]);
  const RGBa = RGB.map((v) => { const x = (vc.FL * Math.abs(v) / 100) ** 0.42; return (400 * Math.sign(v) * x) / (x + 27.13) + 0.1; });
  const a = RGBa[0] - (12 * RGBa[1]) / 11 + RGBa[2] / 11;
  const b = (RGBa[0] + RGBa[1] - 2 * RGBa[2]) / 9;
  const h = normH(deg(Math.atan2(b, a)));
  const hp = h < 20.14 ? h + 360 : h;
  const et = 0.25 * (Math.cos(rad(hp) + 2) + 3.8);
  const A_ = (2 * RGBa[0] + RGBa[1] + RGBa[2] / 20 - 0.305) * vc.Nbb;
  const J = 100 * (A_ / vc.Aw) ** (vc.c * vc.z);
  const t = ((50000 / 13) * vc.Nc * vc.Ncb * et * Math.hypot(a, b)) / (RGBa[0] + RGBa[1] + (21 / 20) * RGBa[2]);
  const C = t ** 0.9 * Math.sqrt(J / 100) * (1.64 - 0.29 ** vc.n) ** 0.73;
  const M = C * vc.FL ** 0.25;
  const Q = (4 / vc.c) * Math.sqrt(J / 100) * (vc.Aw + 4) * vc.FL ** 0.25;
  const s = 100 * Math.sqrt(M / Q);
  // hue quadrature
  const HD = [[20.14, 0.8, 0], [90, 0.7, 100], [164.25, 1, 200], [237.53, 1.2, 300], [380.14, 0.8, 400]];
  let i = 0; while (hp >= HD[i + 1][0]) i++;
  const [h1, e1, H1] = HD[i], [h2, e2] = HD[i + 1];
  const H = H1 + (100 * (hp - h1) / e1) / ((hp - h1) / e1 + (h2 - hp) / e2);
  return { J, C, h, M, Q, s, H };
}
export function cam16inv({ J, C, h }, vc) {
  const t = (C / (Math.sqrt(J / 100) * (1.64 - 0.29 ** vc.n) ** 0.73)) ** (1 / 0.9);
  const et = 0.25 * (Math.cos(rad(h) + 2) + 3.8);
  const A_ = vc.Aw * (J / 100) ** (1 / (vc.c * vc.z));
  const p1 = ((50000 / 13) * vc.Nc * vc.Ncb * et) / (t || 1e-12);
  const p2 = A_ / vc.Nbb + 0.305;
  const hr = rad(h), sh = Math.sin(hr), ch = Math.cos(hr), P3 = 21 / 20;
  let a, b;
  if (t === 0) { a = 0; b = 0; } else if (Math.abs(sh) >= Math.abs(ch)) {
    const p4 = p1 / sh;
    b = (p2 * (2 + P3) * (460 / 1403)) / (p4 + (2 + P3) * (220 / 1403) * (ch / sh) - 27 / 1403 + P3 * (6300 / 1403));
    a = b * (ch / sh);
  } else {
    const p5 = p1 / ch;
    a = (p2 * (2 + P3) * (460 / 1403)) / (p5 + (2 + P3) * (220 / 1403) - (27 / 1403 - P3 * (6300 / 1403)) * (sh / ch));
    b = a * (sh / ch);
  }
  const Ra = (460 * p2 + 451 * a + 288 * b) / 1403;
  const Ga = (460 * p2 - 891 * a - 261 * b) / 1403;
  const Ba = (460 * p2 - 220 * a - 6300 * b) / 1403;
  const RGBc = [Ra, Ga, Ba].map((v) => { const x = v - 0.1; return Math.sign(x) * (100 / vc.FL) * ((27.13 * Math.abs(x)) / (400 - Math.abs(x))) ** (1 / 0.42); });
  const RGB = RGBc.map((v, i) => v / vc.Dr[i]);
  return mul(M16i, RGB);
}
export function camUCS({ J, M, h }) {
  const Jp = (1.7 * J) / (1 + 0.007 * J), Mp = Math.log(1 + 0.0228 * M) / 0.0228;
  return [Jp, Mp * Math.cos(rad(h)), Mp * Math.sin(rad(h))];
}
export const hex2xyz100 = (hex) => lin2xyz(rgb2lin(hex2rgb(hex))).map((v) => v * 100);
export const xyz100hex = (xyz) => rgb2hex(lin2rgb(xyz2lin(xyz.map((v) => v / 100)).map((v) => clamp(v, 0, 1))));
export const xyz100inGamut = (xyz) => inGamut(xyz2lin(xyz.map((v) => v / 100)));

// ---- difference ----
export function dEok(h1, h2) { const a = lin2oklab(rgb2lin(hex2rgb(h1))), b = lin2oklab(rgb2lin(hex2rgb(h2))); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function dEcam(h1, h2, vc) { const a = camUCS(cam16(hex2xyz100(h1), vc)), b = camUCS(cam16(hex2xyz100(h2), vc)); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
