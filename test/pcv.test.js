// Peak concurrent viewers (backend/pcv.js), alone and fed by the YouTube poller
// (backend/youtube.js) against a fake YouTube: the sampled PCV never goes down within a
// broadcast, an unreadable count is never a zero, failures back off and reset nothing, a
// restart resumes, and Studio's official PCV is kept apart from the sampled one.   npm test
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-pcv-'));
process.env.IXG_DATA_DIR = dataDir;
const fake = { answers: [], calls: 0 };
const server = http.createServer((req, res) => {
  fake.calls += 1;
  const answer = fake.answers.shift() || { status: 500, body: { error: { message: 'no answer queued' } } };
  if (answer.drop) return req.socket.destroy(); // a network failure
  res.writeHead(answer.status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(answer.body || { items: [] }));
}).listen(0, '127.0.0.1');
const ready = new Promise((r) => server.once('listening', r)).then(() => {
  process.env.IXG_YOUTUBE_API = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const { PcvTracker } = require('../backend/pcv');

const ID = 'x-qOOPXB_lg';
const live = (viewers) => ({ broadcast: 'live', viewers, startedAt: '2026-10-08T05:31:37Z', endedAt: null });

function track(counts, tracker = new PcvTracker({ file: null })) {
  let t = 1_000_000;
  const peaks = [];
  for (const c of counts) {
    t += 30000;
    tracker.observe(ID, typeof c === 'object' && c !== null ? c : live(c), t);
    peaks.push(tracker.get(ID).peak);
  }
  return { tracker, peaks };
}

test('rising, falling and fluctuating counts: the PCV is the highest read and never goes down', () => {
  assert.deepEqual(track([100, 200, 300]).peaks, [100, 200, 300], 'rising');
  assert.deepEqual(track([300, 200, 100]).peaks, [300, 300, 300], 'falling');
  const { tracker, peaks } = track([100, 250, 180, 260, 90, 255, 400, 399]);
  assert.deepEqual(peaks, [100, 250, 250, 260, 260, 260, 400, 400], 'fluctuating');
  const r = tracker.get(ID);
  assert.equal(r.ccv, 399, 'the current count is the latest');
  assert.equal(r.peakAt, 1_000_000 + 7 * 30000, 'the time it was first read');
  assert.equal(r.samples, 8);
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] >= peaks[i - 1]);
});

test('a hidden or missing count is unknown, never zero, and leaves the PCV alone', () => {
  const { tracker, peaks } = track([500, null, undefined, 450]);
  assert.deepEqual(peaks, [500, 500, 500, 500]);
  tracker.observe(ID, live(null), 2_000_000);
  assert.equal(tracker.get(ID).ccv, null, 'not 0');
  assert.equal(tracker.get(ID).peak, 500);
});

test('junk counts are ignored: negative, fractional, not a number, a string', () => {
  const { peaks } = track([10, -5, 12.5, NaN, Infinity, '9999', 11]);
  assert.deepEqual(peaks, [10, 10, 10, 10, 10, 10, 11]);
});

test('before the broadcast: waiting, and a count is not taken; after it: the PCV is kept and frozen', () => {
  const tracker = new PcvTracker({ file: null });
  tracker.observe(ID, { broadcast: 'upcoming', viewers: 40, startedAt: null, endedAt: null }, 1);
  assert.equal(tracker.get(ID).status, 'waiting');
  assert.equal(tracker.get(ID).peak, null, 'no PCV before it goes live');
  track([700, 900], tracker);
  const ended = { broadcast: 'none', viewers: 5000, startedAt: '2026-10-08T05:31:37Z', endedAt: '2026-10-08T09:00:00Z' };
  tracker.observe(ID, ended, 3_000_000);
  const r = tracker.get(ID);
  assert.equal(r.status, 'ended');
  assert.equal(r.peak, 900, 'a count after the end does not move it');
  assert.equal(r.ccv, null);
  assert.equal(r.endedAt, '2026-10-08T09:00:00Z');
});

test('each broadcast is its own: another video, or the same ID live again from another start', () => {
  const tracker = new PcvTracker({ file: null });
  tracker.observe(ID, live(800), 1);
  tracker.observe('Fc45LqGulQ0', live(50), 1);
  assert.equal(tracker.get(ID).peak, 800);
  assert.equal(tracker.get('Fc45LqGulQ0').peak, 50);
  tracker.observe(ID, { ...live(30), startedAt: '2026-10-09T05:00:00Z' }, 2);
  assert.equal(tracker.get(ID).peak, 30, 'a new start is a new broadcast');
});

test('a broadcast new to the tracker starts from the readings already taken since it went live', () => {
  const tracker = new PcvTracker({ file: null });
  const start = Date.parse('2026-10-08T05:31:37Z');
  const history = [[start - 60000, 9999, null], [start + 60000, 1200], [start + 120000, null], [start + 180000, 218007], [start + 240000, 150000]];
  tracker.seed(ID, history, live(95067));
  assert.equal(tracker.get(ID).peak, 218007, 'not the reading before the broadcast began');
  assert.equal(tracker.get(ID).peakAt, start + 180000);
  tracker.observe(ID, live(95067), start + 300000);
  assert.equal(tracker.get(ID).peak, 218007);
  tracker.seed(ID, [[start + 1, 999999]], live(1));
  assert.equal(tracker.get(ID).peak, 218007, 'only once: a record that exists is never re-seeded');
});

test('a new PCV is announced with the one it beat', () => {
  const tracker = new PcvTracker({ file: null });
  const seen = [];
  tracker.on('peak', (e) => seen.push([e.peak, e.previous]));
  track([100, 90, 150, 150, 151], tracker);
  assert.deepEqual(seen, [[100, null], [150, 100], [151, 150]]);
});

test('Studio\'s official PCV is kept apart: it never replaces the sampled one, and junk is refused', () => {
  const { tracker } = track([1000, 1200]);
  tracker.setOfficial(ID, { peak: 1234, avg: 980.6, at: 5 });
  tracker.setOfficial(ID, { peak: -1 });
  tracker.setOfficial(ID, { peak: 12.5 });
  const v = tracker.view(ID);
  assert.equal(v.peak, 1200, 'sampled');
  assert.deepEqual(v.official, { peak: 1234, avg: 981, at: 5 });
});

test('a restart resumes: the PCV, its time and Studio\'s figure are read back from disk', async () => {
  const file = path.join(dataDir, 'restart-pcv.json');
  const before = new PcvTracker({ file });
  track([300, 650, 400], before);
  before.setOfficial(ID, { peak: 700, at: 9 });
  before.save();
  const after = new PcvTracker({ file });
  assert.deepEqual(after.view(ID), before.view(ID));
  after.observe(ID, live(500), 9_000_000);
  assert.equal(after.get(ID).peak, 650, 'carries on from the saved PCV, not from zero');
});

test('the poller: failures back off and reset nothing; the PCV carries on when YouTube answers again', async () => {
  await ready;
  const { YouTubeStats } = require('../backend/youtube');
  const pcv = new PcvTracker({ file: path.join(dataDir, 'poller-pcv.json') });
  // One live session with the feed; its id can change to stand for a switch of session.
  const current = { id: 's1', name: 'Test', settings: { ytPollSec: 30 }, streams: [{ source: { kind: 'video', id: ID } }] };
  const store = {
    live: () => [current],
    get: (id) => (id === current.id ? current : null),
    feeds: () => current.streams.map((x) => ({ ...x, session: { id: current.id, name: current.name }, settings: current.settings })),
  };
  const credentials = { apiKey: () => 'AIzaTEST', keyInfo: () => ({ set: true }), referer: 'http://localhost/' };
  const yt = new YouTubeStats({ store, credentials, pcv });
  const video = (n) => ({ body: { items: [{ id: ID, snippet: { liveBroadcastContent: 'live', channelId: 'UCx' }, statistics: {}, liveStreamingDetails: { concurrentViewers: n == null ? undefined : String(n), actualStartTime: '2026-10-08T05:31:37Z' } }] } });
  const poll = async () => { await yt.poll(); clearTimeout(yt.timer); };
  try {
    fake.answers.push(video(1500), { body: { items: [] } }); // the video, then the channel's subscribers
    await poll();
    assert.equal(pcv.get(ID).peak, 1500);
    assert.equal(yt.state(current.id).videos[ID].pcv.peak, 1500, 'pages see it');

    fake.answers.push({ drop: true });
    await poll();
    assert.equal(yt.status, 'error');
    assert.equal(yt.backoffMs(), 60000, 'the next try waits twice the interval');
    fake.answers.push({ status: 503, body: { error: { message: 'Backend Error' } } });
    await poll();
    assert.equal(yt.backoffMs(), 120000, 'then 4×');
    assert.equal(pcv.get(ID).peak, 1500, 'nothing reset by the failures');
    assert.ok(yt.state(current.id).retryAt > Date.now(), 'the page can say when it tries again');

    fake.answers.push({ status: 403, body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } });
    await poll();
    assert.equal(yt.backoffMs(), 15 * 60000, 'out of quota: every 15 minutes');

    fake.answers.push(video(null)); // live, count hidden
    await poll();
    assert.equal(yt.status, 'ok');
    assert.equal(yt.failures, 0);
    assert.equal(pcv.get(ID).ccv, null, 'hidden is not zero');
    fake.answers.push(video(1800));
    await poll();
    assert.equal(pcv.get(ID).peak, 1800);

    // The wall's own PCV (the Feeds tab): the highest wall total read in this session.
    assert.equal(yt.state(current.id).total.pcv, 1800);
    assert.equal(yt.state(current.id).total.pcvSamples, 2, 'the hidden count was no reading');
    current.id = 'another-event';
    assert.equal(yt.state(current.id).total.pcv, null, 'a new session starts its wall PCV afresh');
    fake.answers.push(video(700));
    await poll();
    assert.equal(yt.state(current.id).total.pcv, 700);
    // Totals from before they were stamped with a session belong to the one live session.
    yt.totals.unshift([Date.now() - 60000, 5000, null]);
    assert.equal(yt.state(current.id).total.pcv, 700, 'unstamped: not counted as such');
    yt.adoptUnstamped(current.id);
    assert.equal(yt.state(current.id).total.pcv, 5000, 'adopted into the session');
    assert.equal(pcv.get(ID).peak, 1800, 'the broadcast\'s own PCV is untouched by the session change');
  } finally {
    yt.stop();
  }
  const resumed = new PcvTracker({ file: path.join(dataDir, 'poller-pcv.json') });
  assert.equal(resumed.get(ID).peak, 1800, 'saved on stop: a restart resumes from it');
});
