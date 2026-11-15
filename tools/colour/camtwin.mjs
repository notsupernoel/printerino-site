// The perceptual twin: hold the dark colour's CAM16 hue and colourfulness M (dark page, dim room) in the light page's
// viewing conditions, and set lightness J by a WCAG floor on a ground. If sRGB cannot hold M, take the most it can.
import * as C from './color.mjs';
// law.mjs imports only vcD, vcL and camOf; twin() and the command line below are a hand tool for exploring a twin
// outside the law (the law's own twin is twinLine in law.mjs).
export const vcD = C.cam16VC({ La: 4, Yb: 1.5, surround: 'dim' }), vcL = C.cam16VC({ La: 64, Yb: 90, surround: 'average' });
export const camOf = (x, vc) => C.cam16(C.hex2xyz100(x), vc);
export function twin(darkHex, ratio, bg, { mScale = 1, dh = 0 } = {}) {
  const d = camOf(darkHex, vcD);
  const h = d.h + dh, Mt = d.M * mScale;
  const make = (J) => {
    // largest C <= target that is in gamut at this J, h
    let lo = 0, hi = Mt / vcL.FL ** 0.25;
    const ok = (c) => C.xyz100inGamut(C.cam16inv({ J, C: c, h }, vcL));
    if (!ok(hi)) { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; } hi = lo; }
    return C.xyz100hex(C.cam16inv({ J, C: hi, h }, vcL));
  };
  let lo = 5, hi = 99;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (C.wcag(make(m), bg) >= ratio) lo = m; else hi = m; }
  let J = lo, x = make(J); while (C.wcag(x, bg) < ratio) { J -= 0.05; x = make(J); }
  return x;
}
if ((process.argv[1] || '').endsWith('camtwin.mjs')) {
  const [dark, ratio, bg, ms, dh] = process.argv.slice(2);
  const x = twin(dark, +ratio, bg, { mScale: +(ms || 1), dh: +(dh || 0) });
  const a = camOf(x, vcL), d = camOf(dark, vcD), [L, c, h] = C.hex2oklch(x);
  console.log(x, `cam h ${a.h.toFixed(1)} (dark ${d.h.toFixed(1)}) M ${a.M.toFixed(1)} (dark ${d.M.toFixed(1)}) J ${a.J.toFixed(1)} | oklch ${L.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)} share ${(c / C.maxC(L, h)).toFixed(2)} | ${C.wcag(x, bg).toFixed(2)} on ${bg}, white ${C.wcag(x, '#FFFFFF').toFixed(2)}`);
}
