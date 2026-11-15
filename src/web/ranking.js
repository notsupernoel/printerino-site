// Market-cap ranking for the cards. It keeps a rank stable when two market caps are nearly equal, so cards do not
// swap places back and forth from one minute to the next.
const SWAP_MARGIN = 1.01; // a lower-ranked coin must lead by more than 1% before the two swap places

/**
 * @param {string[]} previous current order of symbols (rank 1 first)
 * @param {Map<string, number>} mcaps symbol -> market cap in USD
 * @returns {string[]} the new order; unchanged unless every coin has a market cap
 */
export function rerank(previous, mcaps) {
  if (!previous.every((s) => Number.isFinite(mcaps.get(s)) && mcaps.get(s) > 0)) return previous;
  const order = [...previous];
  for (let pass = 0; pass < order.length; pass++) {
    let swapped = false;
    for (let i = 0; i < order.length - 1; i++) {
      if (mcaps.get(order[i + 1]) > mcaps.get(order[i]) * SWAP_MARGIN) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return order;
}

/**
 * Like rerank, but coins without a market cap no longer freeze the whole order: the coins that have one
 * are ranked among themselves (same 1% hysteresis), and the rest follow in their previous relative order.
 */
export function rerankPartial(previous, mcaps) {
  const has = (s) => Number.isFinite(mcaps.get(s)) && mcaps.get(s) > 0;
  const known = previous.filter(has);
  return [...rerank(known, mcaps), ...previous.filter((s) => !has(s))];
}
