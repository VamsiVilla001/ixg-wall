// Exercise the page's actual playback controller with a fake clock and players. No
// YouTube requests, real wall data, or DOM are needed to test correction lifecycles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing controller section: ${start}`);
  return source.slice(from, to);
};

function wall() {
  let now = 1791191400000; // epoch ms: YouTube's frame stamps are real time
  let timerId = 0;
  const timers = new Map();
  const context = vm.createContext({
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    logEvent() {}, syncWallAlerts() {}, pumpQueue() {}, updateSummary() {},
  });
  vm.runInContext(`
    ${between('  const STORAGE_KEY', '  // State + persistence')}
    const settings = { ...DEFAULT_SETTINGS };
    const tiles = new Map();
    const sync = { target: null, setBy: null, members: new Set(), excluded: new Map(), spread: null };
    const wall = { autoJumpsLeft: 2, stallLog: [] };
    const timeline = { delay: null, paused: null, liveDelay: null };
    ${between('  function median(', '  function uid(')}
    ${between('  function fmtClock(', '  // Time of day for an ISO')}
    ${between('  class Tile {', '  function addTile(')}
    ${between('  function updateSync()', '  function updateCongestion(')}
    ${between('  function applySetting(', '  function syncSettingInputs(')}
    globalThis.controller = { Tile, settings, tiles, sync, timeline, wall, updateSync, applySetting, PS };
  `, context);
  const controller = context.controller;
  const feed = (id, baseline = 30, dvr = true) => {
    const rates = [];
    const seeks = [];
    const tile = Object.assign(Object.create(controller.Tile.prototype), {
      stream: { id, label: id }, mounted: true, ready: true, isLive: true,
      baseline, latency: baseline, drift: 0, samples: [baseline, baseline, baseline],
      ps: controller.PS.PLAYING, error: null, nudge: null, catchUp: null,
      lastSyncActAt: 0, stats: { syncs: 0, stalls: 0, stallMs: 0 },
      recentResyncs: [], playedOnce: true,
      player: {
        setPlaybackRate: (rate) => rates.push(rate),
        getAvailablePlaybackRates: () => [0.75, 1, 1.25],
        getVideoData: () => ({ allowLiveDvr: dvr }),
        getCurrentTime: () => 100,
        seekTo: (position) => seeks.push(position),
        // The frame on screen is `showing` seconds behind real time (YouTube's stamp).
        getMediaReferenceTime: () => now / 1000 - (tile.showing ?? baseline),
      },
      render() {}, pulse() {}, hideCaptions() {},
    });
    controller.tiles.set(id, tile);
    return { tile, rates, seeks };
  };
  return {
    ...controller, feed, now: () => now, timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}

test('a small sync offset uses a timed nudge and restores normal playback', () => {
  const w = wall();
  const { tile, rates } = w.feed('one');
  w.feed('two');
  w.updateSync();
  tile.latency = 33;
  tile.keepInSync(w.now());
  assert.equal(tile.nudge.rate, 1.25);
  w.advance(7999);
  assert.equal(tile.nudge.rate, 1.25);
  w.advance(1);
  assert.equal(tile.nudge, null);
  assert.deepEqual(rates, [1.25, 1]);
});

test('a changed sync target cancels a correction calculated for the earlier target', () => {
  const w = wall();
  const { tile, rates } = w.feed('one');
  const { tile: slow } = w.feed('two');
  w.updateSync();
  tile.startNudge(3, 1.25, w.now());
  slow.baseline = 35;
  w.updateSync();
  assert.equal(w.sync.target, 36);
  assert.equal(tile.nudge, null);
  assert.equal(w.timers.size, 0);
  assert.deepEqual(rates, [1.25, 1]);
});

test('turning off automatic correction immediately stops sync and live-edge speed changes', () => {
  const w = wall();
  const { tile, rates } = w.feed('one');
  const { tile: other, rates: otherRates } = w.feed('two');
  w.updateSync();
  tile.startNudge(3, 1.25, w.now());
  other.catchUp = { since: w.now() };
  w.settings.autoResync = false;
  w.applySetting('autoResync');
  assert.equal(tile.nudge, null);
  assert.equal(other.catchUp, null);
  assert.deepEqual(rates, [1.25, 1]);
  assert.deepEqual(otherRates, [1]);
  assert.equal(w.timers.size, 0);
});

test('changing the sync margin ends the old nudge before recalculating the group', () => {
  const w = wall();
  const { tile } = w.feed('one');
  w.feed('two');
  w.updateSync();
  tile.startNudge(-2, 0.75, w.now());
  w.settings.syncMarginSec = 5;
  w.applySetting('syncMarginSec');
  assert.equal(w.sync.target, 35);
  assert.equal(tile.nudge, null);
  assert.equal(w.timers.size, 0);
});

test('a no-DVR feed is excluded when even the margin requires holding it behind live', () => {
  const w = wall();
  const { tile } = w.feed('no-dvr', 30, false);
  w.feed('one');
  w.feed('two');
  w.updateSync();
  assert.equal(w.sync.members.size, 2);
  assert.equal(w.sync.members.has(tile), false);
  assert.match(w.sync.excluded.get(tile), /rewind/);
});

test('no-DVR feeds can sync at their edge when the margin is zero', () => {
  const w = wall();
  w.settings.syncMarginSec = 0;
  w.feed('one', 30, false);
  w.feed('two', 30, false);
  w.updateSync();
  assert.equal(w.sync.target, 30);
  assert.equal(w.sync.members.size, 2);
});

test('turning sync off or losing the second live feed restores normal speed', () => {
  for (const disable of [true, false]) {
    const w = wall();
    const { tile, rates } = w.feed('one');
    const { tile: other } = w.feed('two');
    w.updateSync();
    tile.startNudge(-2, 0.75, w.now());
    if (disable) {
      w.settings.syncFeeds = false;
      w.applySetting('syncFeeds');
    } else {
      other.mounted = false;
      w.updateSync();
    }
    assert.equal(w.sync.target, null);
    assert.equal(tile.nudge, null);
    assert.deepEqual(rates, [0.75, 1]);
    assert.equal(w.timers.size, 0);
  }
});

test('pausing, ending, buffering, or failing a feed cancels its timed sync correction', () => {
  for (const state of [2, 0, 3, 'error']) {
    const w = wall();
    const { tile, rates } = w.feed('one');
    tile.startNudge(2, 1.25, w.now());
    if (state === 'error') tile.onError(100);
    else tile.onState(state);
    assert.equal(tile.nudge, null, `state ${state}`);
    assert.equal(w.timers.size, state === 'error' ? 1 : 0); // onError also schedules the load queue
    assert.deepEqual(rates, [1.25, 1]);
  }
});

test('sync seeks preserve measured delay and cannot be used to rebaseline the live edge', () => {
  const w = wall();
  const { tile, seeks, rates } = w.feed('one');
  w.feed('two');
  w.updateSync();
  tile.latency = 40;
  tile.drift = 10;
  tile.catchUp = { since: w.now() };
  tile.preJumpLag = 50;
  tile.syncSeek(9, w.now());
  assert.deepEqual(seeks, [109]);
  assert.deepEqual(rates, [1]);
  assert.equal(tile.catchUp, null);
  assert.equal(tile.preJumpLag, null);
  assert.equal(tile.latency, 40, 'requested landing position must not masquerade as a measurement');
  assert.equal(tile.drift, 10);
});

// A feed back at live after a refresh, measured for the first time.
const measureFresh = (w, tile, showing) => {
  tile.showing = showing;
  tile.samples = [];
  tile.playingSince = w.now() - 10000;
  tile.measure(w.now());
};

test('the wall timeline holds feeds far past the sane-lag limit instead of jumping them to live', () => {
  const w = wall();
  const { tile, seeks } = w.feed('one');
  w.feed('two');
  w.timeline.delay = 400;
  w.updateSync();
  assert.equal(w.sync.target, 400);
  assert.equal(w.sync.members.size, 2);
  // Refreshed at live (30 s): one sample is enough to send it straight back to the wall's moment.
  measureFresh(w, tile, 30);
  assert.deepEqual(seeks, [100 - 370]);
  // Held there: 400 s behind is where it belongs, so nothing pulls it to live.
  seeks.length = 0;
  w.advance(10000);
  tile.lastSyncActAt = 0;
  tile.samples = [400, 400];
  tile.showing = 400;
  tile.measure(w.now());
  assert.deepEqual(seeks, []);
  assert.equal(tile.held(), true);
});

test('a feed moved on its own seek bar leaves the wall and is held at its own delay', () => {
  const w = wall();
  const { tile, seeks } = w.feed('one');
  w.feed('two');
  w.feed('three');
  tile.own = { delay: 200 };
  w.updateSync();
  assert.equal(w.sync.members.has(tile), false);
  assert.match(w.sync.excluded.get(tile), /own seek bar/);
  assert.equal(w.sync.members.size, 2);
  measureFresh(w, tile, 30);
  assert.deepEqual(seeks, [100 - 170]);
  assert.equal(tile.syncOffset(), 30 - 200);
});

test('feeds that cannot rewind, or not that far, stay live when the wall timeline moves back', () => {
  const w = wall();
  const { tile: noDvr } = w.feed('no-dvr', 30, false);
  const { tile: short } = w.feed('short');
  w.feed('one');
  // YouTube keeps only the last 120 s of this one.
  short.span = { start: 0, end: 120, at: 120, k: w.now() / 1000 - 120, t: w.now() };
  w.timeline.delay = 400;
  w.updateSync();
  assert.deepEqual([...w.sync.members].map((t) => t.stream.id), ['one']);
  assert.match(w.sync.excluded.get(noDvr), /rewind/);
  assert.match(w.sync.excluded.get(short), /keeps only the last 2:00/);
});

test('live on the wall timeline is the delay sync holds feeds at, and survives sync being off', () => {
  const w = wall();
  w.feed('one', 30);
  w.feed('two', 34);
  w.updateSync();
  assert.equal(w.timeline.liveDelay, 35);
  w.settings.syncFeeds = false;
  w.updateSync();
  assert.equal(w.timeline.liveDelay, 32);
});

test('a feed paused from the wall timeline counts as held, and leaves the pause when refreshed', () => {
  const w = wall();
  const { tile } = w.feed('one');
  w.feed('two');
  w.timeline.paused = { stamp: w.now() / 1000 - 60, tiles: new Set([tile]) };
  w.updateSync();
  assert.equal(tile.heldPaused(), true);
  assert.equal(w.sync.members.has(tile), true);
  assert.match(w.sync.excluded.get(w.tiles.get('two')), /after the wall was paused/);
});
