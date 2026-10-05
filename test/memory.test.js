// Memory offload in public/app.js, run with a fake clock, fake feeds and a fake backend
// reading: the order feeds move between the two YouTube sites, the waits that let an
// emptied browser process end, and when an offload starts.   npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
  return source.slice(from, to);
};
const constants = source.match(/^ {2}const (OFFLOAD|MEM)_[A-Z_]+ = .*$/gm).join('\n');
const [A, B] = ['https://www.youtube.com', 'https://www.youtube-nocookie.com'];
const MIN = 60000;

function wall({ managed = false, limit = 500, every = 60 } = {}) {
  const events = [];
  const context = vm.createContext({
    Date,
    HOSTS: [A, B],
    managedWindow: managed,
    server: { hosted: false },
    settings: { memLimitMB: limit, offloadEveryMin: every },
    backend: { latest: { wallMem: null } },
    backendFresh: () => true,
    tiles: new Map(),
    solo: null,
    $: () => null,
    logEvent: (tile, text, level = 'info') => events.push({ text, level }),
    fmtInt: (v) => Number(v).toLocaleString('en-US'),
    fmtDuration: (ms) => `${Math.round(ms / 1000)}s`,
    fmtCountdown: (ms) => `${Math.round(ms / 1000)}s`,
    feedCount: (n) => `${n} feed${n === 1 ? '' : 's'}`,
  });
  vm.runInContext(`
    ${constants}
    const offload = { run: null, lastAt: 0 };
    const memGuard = { release: null, floorMB: null, retryAt: 0 };
    ${between('  function wallTabMemory()', "  $('#offload-now')")}
    globalThis.api = { startOffload, updateOffload, updateOffloadTimer, updateMemoryGuard, offload, memGuard, setSolo: (t) => { solo = t; } };
  `, context);
  const log = []; // [time, id, host] for every restart
  let clock = 0;
  const feed = (id, host) => {
    const t = {
      stream: { id }, host, mounted: true, queued: false, playedOnce: true, error: null, loadedAt: 0,
      reload() { log.push([clock, id, this.host]); this.playedOnce = false; this.loadedAt = clock; this.startsAt = clock + 4000; },
    };
    context.tiles.set(id, t);
    return t;
  };
  // Runs the wall's loop every 2 s until `ms`, letting moved players start after 4 s.
  const run = (ms, step = (now) => { api.updateMemoryGuard(now); api.updateOffloadTimer(now); api.updateOffload(now); }) => {
    const end = clock + ms;
    for (; clock <= end; clock += 2000) {
      for (const t of context.tiles.values()) if (!t.playedOnce && clock >= t.startsAt) t.playedOnce = true;
      step(clock);
    }
    clock -= 2000;
  };
  const api = context.api;
  return {
    ...api, feed, log, events, tiles: context.tiles,
    now: () => clock,
    advance: (ms) => run(ms),
    measure(mb) { context.backend.latest.wallMem = { tabMB: mb }; },
  };
}

test('an offload moves one feed at a time, lets each emptied process end, and ends balanced', () => {
  const w = wall({ every: 0 });
  const feeds = [w.feed('hindi', A), w.feed('english', B), w.feed('map', A), w.feed('backup', B)];
  assert.equal(w.startOffload('test', 0), true);
  w.advance(5 * MIN);
  assert.equal(w.offload.run, null, 'finished');
  assert.deepEqual(feeds.map((t) => t.host), [A, B, A, B], 'back to the same balance');
  // Every feed restarted exactly twice, never two at the same moment.
  for (const t of feeds) assert.equal(w.log.filter(([, id]) => id === t.stream.id).length, 2, t.stream.id);
  const times = w.log.map(([time]) => time);
  assert.equal(new Set(times).size, times.length, 'one restart at a time');
  // Nothing reopens on a site until its last player has been gone 20 s.
  const lastLeft = (host, before) => Math.max(...w.log.filter(([time, , to]) => time < before && to !== host).map(([time]) => time));
  const firstBackOnA = w.log.find(([time, , to]) => to === A && time > 0)[0];
  assert.ok(firstBackOnA - lastLeft(A, firstBackOnA) >= 20000, 'waited for site A\'s process to end');
  assert.match(w.events.at(-1).text, /Memory offloaded: every feed now plays in a fresh browser process \(8 restarts/);
});

test('the feed being listened to moves last; feeds not loaded just switch site', () => {
  const w = wall({ every: 0 });
  const heard = w.feed('heard', A);
  w.feed('other', A);
  const idle = w.feed('idle', B);
  idle.mounted = false;
  idle.queued = true;
  w.setSolo(heard);
  w.startOffload('test', 0);
  w.advance(5 * MIN);
  assert.deepEqual(w.log.slice(0, 2).map(([, id]) => id), ['other', 'heard']);
  assert.equal(w.log.filter(([, id]) => id === 'idle').length, 0, 'a queued feed starts on its new site when it loads');
  assert.equal(idle.host, B);
});

test('a second offload doesn\'t start while one is running', () => {
  const w = wall({ every: 0 });
  w.feed('a', A);
  assert.equal(w.startOffload('one', 0), true);
  assert.equal(w.startOffload('two', 0), false);
});

test('an ordinary tab offloads on the timer; the measured wall window uses its limit instead', () => {
  const tab = wall({ every: 60 });
  tab.feed('a', A);
  tab.advance(59 * MIN);
  assert.equal(tab.log.length, 0);
  tab.advance(2 * MIN);
  assert.ok(tab.log.length > 0, 'offloaded after 60 min');
  assert.match(tab.events[0].text, /every 60 min/);

  const managed = wall({ managed: true, every: 60 });
  managed.feed('a', A);
  managed.measure(300);
  managed.advance(90 * MIN);
  assert.equal(managed.log.length, 0, 'under the limit: no timer offload where memory is measured');
});

test('the wall window offloads over the limit, then reports whether that was enough', () => {
  const w = wall({ managed: true });
  w.feed('a', A);
  w.feed('b', B);
  w.measure(838);
  w.advance(MIN);
  assert.match(w.events[0].text, /wall tab at 838 MB, over the 500 MB limit/);
  w.measure(310); // what the fresh processes measure once the offload is done
  w.advance(3 * MIN);
  assert.match(w.events.at(-1).text, /Memory released: wall tab at 310 MB, down from 838 MB/);

  // Feeds that need more than the limit even when fresh: one offload, then a wait.
  const big = wall({ managed: true });
  big.feed('a', A);
  big.measure(900);
  big.advance(4 * MIN);
  assert.equal(big.events.at(-1).level, 'warn');
  assert.match(big.events.at(-1).text, /still at 900 MB after offloading/);
  const restarts = big.log.length;
  big.advance(20 * MIN);
  assert.equal(big.log.length, restarts, 'no offloading in a loop');
  big.measure(1010);
  big.advance(MIN);
  assert.ok(big.log.length > restarts, 'growing 100 MB past where it ended tries again');
});
