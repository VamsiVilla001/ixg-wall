const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Check the real alert tracker without loading players or touching saved walls.
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('  function syncWallAlerts()');
const end = source.indexOf('  function renderActiveAlerts()', start);
assert.ok(start >= 0 && end > start);

function monitor() {
  const activeAlerts = new Map();
  const tiles = new Map();
  const messages = [];
  const context = vm.createContext({
    activeAlerts, tiles, PS: { PLAYING: 1, BUFFERING: 3, PAUSED: 2 },
    logEvent: (tile, text, level = 'info') => messages.push({ who: tile.stream.label, text, level }),
    renderActiveAlerts() {},
    clockTime: (t) => new Date(t).toISOString().slice(11, 16),
    ingestStoppedAt: () => null,
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.update = syncWallAlerts;`, context);
  const tile = {
    stream: { id: 'one', label: 'Hindi main', source: { kind: 'video', id: 'aaaaaaaaaaa' } }, ps: 1, error: null, pausedByWall: false,
    heldPaused() { return this.pausedByWall; },
    broadcastEnded() { return this.over || null; },
    status() {
      if (this.error) return ['Error', 'bad', `Player error (code ${this.error})`];
      return this.ps === 3 ? ['Rebuffering', 'bad', 'Rebuffering: the player ran out of downloaded video.']
        : ['Paused', 'warn', 'Paused - resuming automatically'];
    },
  };
  tiles.set(tile.stream.id, tile);
  return { activeAlerts, tiles, tile, messages, update: context.update, context };
}

test('alerts identify the feed, log each interruption once, and record recovery', () => {
  const m = monitor();
  m.tile.ps = 3;
  m.update();
  m.update();
  assert.equal(m.messages.length, 1);
  assert.equal(m.messages[0].who, 'Hindi main');
  assert.equal(m.messages[0].level, 'bad');
  assert.match(m.messages[0].text, /ran out/);
  assert.equal(m.activeAlerts.size, 1);
  m.tile.ps = 1;
  m.update();
  m.update();
  assert.equal(m.messages.length, 2);
  assert.match(m.messages[1].text, /playback resumed/);
  assert.equal(m.activeAlerts.size, 0);
});

test('a new error is logged and clearing history does not dismiss an active fault', () => {
  const m = monitor();
  m.tile.ps = 2;
  m.update();
  assert.equal(m.messages[0].level, 'warn');
  m.tile.error = 100;
  m.update();
  assert.match(m.messages[1].text, /code 100/);
  assert.equal(m.messages[1].level, 'bad');
  m.messages.length = 0;
  m.update();
  assert.equal(m.messages.length, 0, 'the active error must not refill cleared history every tick');
  assert.equal(m.activeAlerts.size, 1);
});

test('removing a feed clears its active alert without claiming playback recovered', () => {
  const m = monitor();
  m.tile.ps = 3;
  m.update();
  m.tiles.clear();
  m.update();
  assert.equal(m.activeAlerts.size, 0);
  assert.equal(m.messages[1].who, 'Hindi main');
  assert.match(m.messages[1].text, /feed removed/);
  assert.doesNotMatch(m.messages[1].text, /resumed/);
});

test('a feed paused from the wall timeline is not an alert', () => {
  const m = monitor();
  m.tile.ps = 2;
  m.tile.pausedByWall = true;
  m.update();
  assert.equal(m.activeAlerts.size, 0);
  assert.equal(m.messages.length, 0);
});

test('a feed YouTube says has ended is logged once as ended, and is not a buffering alert', () => {
  const m = monitor();
  m.tile.ps = 3;
  m.update();
  assert.equal(m.activeAlerts.size, 1);
  // The encoder stopped and YouTube ended the broadcast while the player waits for video.
  m.tile.over = { at: Date.parse('2026-10-05T12:54:13Z') };
  m.update();
  m.update();
  assert.equal(m.activeAlerts.size, 0);
  assert.equal(m.messages.length, 3);
  assert.match(m.messages[1].text, /Stream ended at 12:54/);
  assert.equal(m.messages[1].level, 'warn');
  assert.match(m.messages[2].text, /YouTube ended the broadcast/);
  assert.doesNotMatch(m.messages[2].text, /resumed/);
});

test('an encoder that stopped sending is one alert, however the held player changes state', () => {
  const m = monitor();
  m.context.ingestStoppedAt = () => Date.parse('2026-10-05T14:10:00Z');
  m.tile.status = () => ['No ingest', 'bad', 'The encoder stopped sending to YouTube at 14:10'];
  m.tile.ps = 3;
  m.update();
  m.tile.ps = 1; // the held player is tried again and briefly plays old buffer
  m.update();
  m.tile.ps = 3;
  m.update();
  assert.equal(m.activeAlerts.size, 1);
  assert.equal(m.messages.length, 1, 'logged once');
  assert.match(m.messages[0].text, /encoder stopped/);
  m.context.ingestStoppedAt = () => null;
  m.tile.ps = 1;
  m.update();
  assert.equal(m.activeAlerts.size, 0);
  assert.match(m.messages[1].text, /playback resumed/);
});
