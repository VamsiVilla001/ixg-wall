const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = fs.readFileSync(path.join(__dirname, '../extension/meter.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function slice(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

function capture({ suspended = false, mono = false } = {}) {
  const track = { readyState: 'live', muted: false, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ channelCount: mono ? 1 : 2 }) };
  const videoTrack = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [videoTrack], removeTrack() {} };
  const video = { readyState: 4, paused: false, ended: false, muted: true, volume: 0, captureStream: () => stream };
  const calls = [];
  const makeNode = (name) => ({ connect(to, channel) { calls.push([name, to.name, channel]); }, disconnect() { calls.push(['disconnect']); } });
  let lastContext;
  class Audio {
    constructor() { this.state = suspended ? 'suspended' : 'running'; this.destination = { name: 'destination' }; lastContext = this; }
    createMediaStreamSource() { return makeNode('source'); }
    createChannelSplitter() { return makeNode('splitter'); }
    createGain() { this.gain = { ...makeNode('gain'), gain: { value: 1 }, name: 'gain' }; return this.gain; }
    createAnalyser() { return { ...makeNode('analyser'), name: 'analyser', getFloatTimeDomainData: (buffer) => buffer.fill(0.5) }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const context = vm.createContext({ window: { AudioContext: Audio }, document: { querySelector: () => video } });
  vm.runInContext(`${slice(extension, '  let audioGraph', "  for (const event of ['pointerdown'")}; globalThis.api = { sampleAudio, audioLevels, closeAudio };`, context);
  return { ...context.api, video, track, videoTrack, calls, audio: () => lastContext };
}

test('audio RMS and peak use dBFS, distinguish silence from unavailable, and clamp overloads', () => {
  const c = capture();
  assert.equal(c.audioLevels([0, 0]).rmsDb, -60);
  assert.equal(c.audioLevels([0, 0]).peakDb, -60);
  const signal = c.audioLevels([0.5, -0.5]);
  assert.ok(Math.abs(signal.rmsDb + 6.0206) < 0.001);
  assert.equal(signal.rmsDb, signal.peakDb);
  assert.equal(c.audioLevels([2, -2]).peakDb, 0);
});

test('muted playback is measured through captureStream without unmuting or routing audible output', () => {
  const c = capture();
  const reading = c.sampleAudio();
  assert.equal(reading.status, 'ok');
  assert.equal(reading.channels.length, 2);
  assert.ok(reading.channels[0].rmsDb > -7);
  assert.equal(c.video.muted, true);
  assert.equal(c.video.volume, 0);
  assert.equal(c.audio().gain.gain.value, 0);
  assert.equal(c.videoTrack.stopped, true, 'unused video capture is released');
  assert.equal(c.track.stopped, false);
  c.closeAudio();
  assert.equal(c.track.stopped, true);
  assert.equal(c.audio().closed, true);
});

test('mono uses the same input for both meters; suspended, paused and inaccessible captures never claim measured silence', () => {
  const mono = capture({ mono: true });
  mono.sampleAudio();
  assert.deepEqual(mono.calls.filter(([name]) => name === 'splitter').map((v) => v[2]), [0, 0]);
  const c = capture({ suspended: true });
  assert.equal(c.sampleAudio().status, 'suspended');
  assert.equal(c.sampleAudio().channels.length, 0);
  c.video.paused = true;
  assert.equal(c.sampleAudio().status, 'idle');
  c.video.paused = false;
  c.audio().state = 'running';
  c.track.muted = true;
  assert.equal(c.sampleAudio().status, 'unavailable');
});

test('the wall rejects malformed or out-of-range levels from player frames', () => {
  const context = vm.createContext({});
  vm.runInContext(`${slice(app, '  function audioReport(', "  window.addEventListener('message'",)}; globalThis.read = audioReport;`, context);
  const valid = [{ rmsDb: -18, peakDb: -6 }, { rmsDb: -60, peakDb: -60 }];
  assert.equal(context.read({ status: 'ok', channels: valid }).status, 'ok');
  for (const channels of [[valid[0]], [{ rmsDb: 1, peakDb: 2 }, valid[0]], [{ rmsDb: -18, peakDb: NaN }, valid[0]], [{ rmsDb: -6, peakDb: -18 }, valid[0]]]) {
    const reading = context.read({ status: 'ok', channels });
    assert.equal(reading.status, 'unavailable');
    assert.equal(reading.channels.length, 0);
  }
});

test('stale or ended feeds clear the displayed bars instead of keeping the last audio reading', () => {
  let now = 1000;
  const values = [new Map(), new Map()];
  const tile = {
    stream: { label: 'Hindi' }, audio: { at: now, status: 'ok', channels: [{ rmsDb: -18, peakDb: -6 }, { rmsDb: -30, peakDb: -12 }] },
    mounted: true,
    $audio: { dataset: {}, setAttribute() {} }, $audioState: {},
    $audioBars: values.map((v) => ({ style: { setProperty: (k, value) => v.set(k, value) } })),
    broadcastEnded: () => null,
  };
  const context = vm.createContext({ setText: (el, value) => { el.textContent = value; } });
  vm.runInContext(`class Display { ${slice(app, '    renderAudio(', '    renderSide(')} }; globalThis.render = Display.prototype.renderAudio;`, context);
  context.render.call(tile, now);
  assert.equal(tile.$audio.dataset.state, 'ok');
  assert.equal(values[0].get('--audio-level'), '0.7');
  context.render.call(tile, now + 2000);
  assert.equal(tile.$audio.dataset.state, 'unavailable');
  assert.equal(values[0].get('--audio-level'), '0');
  tile.broadcastEnded = () => ({ at: 1 });
  context.render.call(tile, now);
  assert.equal(tile.$audio.dataset.state, 'ok', 'a playing recording keeps its audio readings');
  assert.equal(values[0].get('--audio-level'), '0.7');
  tile.audio = { at: now, status: 'idle', channels: [] };
  context.render.call(tile, now);
  assert.equal(tile.$audio.dataset.state, 'idle', 'a paused recording reports its player state');
  tile.mounted = false;
  context.render.call(tile, now);
  assert.equal(tile.$audioState.textContent, 'End');
  assert.equal(values[1].get('--audio-peak'), '0');
});
