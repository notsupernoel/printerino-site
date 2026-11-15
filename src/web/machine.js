// An explicit state machine, declared rather than implied: its states are the keys of `moves`, each listing the
// states it may move to. go() refuses any other move (false, nothing changes); epoch counts the moves, so a callback
// that started in one state can tell it has been overtaken; on() hears every move as (to, from), which is where what
// follows from a state is applied.
// The server's files import it from here; share.js, which is served to browsers on its own, carries an identical copy.
export function machine(initial, moves) {
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
