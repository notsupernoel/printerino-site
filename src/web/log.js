// What the log says about a feed that fails: one line when it starts failing, one summary an hour while it keeps
// failing, one line once it has answered cleanly for a full hour, and nothing in between.
// The damping is on time, not on failures in a row: CoinGecko's keyless API answers about 60% of Railway's calls with
// 429, so its failures and answers interleave minute by minute, and a logger that reported every change of state
// wrote hundreds of lines a day. The clock is only read inside the calls the once-a-minute fetch already makes, so a
// server at rest does nothing here: no timer.
import { machine } from './machine.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Each source is a machine of its own, in one of two states:
//   clean:   it has not failed, or it has answered cleanly for an hour since it last did; it has no record.
//   failing: its first failure was logged (the onset line) and it has not been clean for an hour since; it has a record.
// A summary being due (an hour since the last line) is not a state: with no timer nothing could move into it, so each
// call reads it off the record's clock. A backup is only called when the primary misses something, so a failing
// record can sit untouched for months; one that no call has touched for a day expires back to clean without a line,
// so the source's next failure, whenever it comes, logs as a new onset rather than as a summary of a stale record.
const MOVES = {
  clean: ['failing'],
  failing: ['clean'],
};
// source -> { m, f }: its machine, and while it is failing its record f = { since, failed, total, lastMsg, lastLine,
// lastFail, touched } (times in ms). The keys name the feed and, for the stocks, its family ('coingecko', 'stocks
// cnbc'), and server.js uses 'coins' and 'stocks' for a side with no source left, so nothing collides.
const sources = new Map();
// The call being handled (log.js is synchronous, so there is exactly one at a time): what a move's line reads.
let call = { msg: '', now: 0 };
const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
// A time with its date when it falls on another UTC day than now: a summary of a failure that began yesterday says so.
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const when = (ms, now) => (dayOf(ms) === dayOf(now) ? clock(ms) : `${dayOf(ms)} ${clock(ms)}`);

function entryOf(source) {
  let e = sources.get(source);
  if (!e) {
    e = { m: machine('clean', MOVES), f: null };
    e.m.on((to) => enter(source, e, to));
    sources.set(source, e);
  }
  return e;
}

// What follows from a move, in one place: the record and the line.
function enter(source, e, to) {
  const { msg, now } = call;
  if (to === 'failing') {
    e.f = { since: now, failed: 1, total: 1, lastMsg: msg, lastLine: now, lastFail: now, touched: now };
    console.warn(`[web] ${source}: ${msg}`);
    return;
  }
  const f = e.f;
  e.f = null;
  // A record no call touched for a day expires without a line; any other way back to clean is a recovery.
  if (now - f.touched >= DAY) return;
  console.log(`[web] ${source}: answering again, last failure ${when(f.lastFail, now)} (${f.failed} of ${f.total} calls failed since ${when(f.since, now)})`);
}

// A failing record left untouched for a day goes back to clean, silently, before the call is counted.
function expire(e) {
  if (e.m.is('failing') && call.now - e.f.touched >= DAY) e.m.go('clean');
}

/** A call that failed: the onset line on the first failure after a clean state, then a summary at most once an hour. */
export function warn(source, msg) {
  call = { msg, now: Date.now() };
  const e = entryOf(source);
  expire(e);
  if (e.m.go('failing')) return;
  const f = e.f;
  f.total++;
  f.failed++;
  f.lastMsg = msg;
  f.lastFail = call.now;
  f.touched = call.now;
  summary(source, f, call.now);
}

/** A call that answered: the recovery line once the source has been clean for an hour, else the summary if one is due. */
export function ok(source) {
  const e = sources.get(source);
  if (!e) return;
  call = { msg: '', now: Date.now() };
  expire(e);
  if (!e.m.is('failing')) return;
  const f = e.f;
  f.total++;
  f.touched = call.now;
  if (call.now - f.lastFail >= HOUR) {
    e.m.go('clean');
    return;
  }
  summary(source, f, call.now);
}

// One line an hour at most while the source has failed inside the hour, whichever call crosses the hour mark.
function summary(source, f, now) {
  if (now - f.lastLine < HOUR) return;
  console.warn(`[web] ${source}: ${f.lastMsg} on ${f.failed} of ${f.total} calls since ${when(f.since, now)}`);
  f.lastLine = now;
}
