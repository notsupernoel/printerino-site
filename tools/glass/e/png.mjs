// A small PNG encoder for every glass map (the droplet's, the theme drop's, the top bar's, the dock's), Node and zlib
// only. It hands the pixels to tools/png/squeeze.mjs, which tries every exact colour type (a palette where the map has
// 256 colours or fewer), every filter and three deflate strategies, and keeps the smallest: the maps come out 12%
// smaller, the top bar's merge mask 44%, than with the per-row least-residual filter at deflate level 9 in the leanest
// of grey with alpha, RGB or RGBA. The same pixels always give the same bytes (on the same Node).
import { encodeBest } from '../../png/squeeze.mjs';

export function encodeSmall(w, h, rgba) {
  return encodeBest(w, h, Buffer.from(rgba));
}
