// Automatic source screenshots (backend/auto-capture.js): when the backend queues one (a new
// PCV, at most once per cooldown per feed; a broadcast it saw end), and how pages claim them
// so one window takes each. In-process, with fake YouTube numbers.   npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutoCapture, BACKEND, PEAK_GAP_MIN, LEASE_MS, TTL_MS, MAX_TRIES, BUSY_HOLD_MS } = require('../backend/auto-capture');
const { PcvTracker } = require('../backend/pcv');

const PEAK_COOLDOWN_MS = PEAK_GAP_MIN * 60000;

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';

// peaks: PCVs recorded before (an earlier run of the wall).
function setup({ peaks = {}, settings = {} } = {}) {
  let t = 1_000_000;
  const youtube = { latest: {}, ids: () => [A, B] };
  const ingest = { videos: {} };
  const pcv = new PcvTracker({ file: null, now: () => t });
  for (const [id, peak] of Object.entries(peaks)) pcv.observe(id, { broadcast: 'live', viewers: peak });
  const wallStore = { wall: { settings, streams: [{ label: 'Feed A', source: { id: A } }, { label: 'Feed B', source: { id: B } }] } };
  const ac = new AutoCapture({ youtube, pcv, ingest, wallStore, now: () => t });
  const live = (id, viewers) => { youtube.latest[id] = { broadcast: 'live', viewers, endedAt: null }; };
  // A YouTube poll: each reading goes to the PCV tracker first, as youtube.js does.
  const step = (ms = 30000) => {
    t += ms;
    for (const id of youtube.ids()) pcv.observe(id, youtube.latest[id], t);
    return ac.check();
  };
  return { ac, youtube, ingest, wallStore, live, step, advance: (ms) => { t += ms; } };
}

test('a new PCV queues one screenshot; the PCV recorded before and the first reading are the baseline', () => {
  const { ac, live, step } = setup({ peaks: { [A]: 1200 } });
  live(A, 1000);
  live(B, 50);
  step();
  assert.deepEqual(ac.open(), [], 'nothing on the first look: those peaks were already seen');
  live(A, 1050);
  step();
  assert.deepEqual(ac.open(), [], 'up, but still under the PCV of 1200: not a new PCV');
  live(A, 1300);
  live(B, 60);
  step();
  const open = ac.open();
  assert.deepEqual(open.map((j) => [j.id, j.reason, j.ccv, j.label]), [[A, 'peak', 1300, 'Feed A'], [B, 'peak', 60, 'Feed B']]);
});

test('a rise after a fall is no screenshot while it stays under the PCV; beating the PCV is', () => {
  const { ac, live, step } = setup({ peaks: { [A]: 1200 } });
  live(A, 1000);
  step();
  live(A, 1150);
  step(PEAK_COOLDOWN_MS);
  assert.deepEqual(ac.open(), [], 'a 15% rise from 1000, but under the PCV of 1200');
  live(A, 1200);
  step();
  assert.deepEqual(ac.open(), [], 'level with the PCV is not a new one');
  live(A, 1201);
  step();
  assert.deepEqual(ac.open().map((j) => j.ccv), [1201]);
  ac.finish(ac.claim(ac.open()[0].job).job, { outcome: 'saved' });
  live(A, 900);
  step(PEAK_COOLDOWN_MS);
  live(A, 1190);
  step();
  assert.deepEqual(ac.open(), [], 'a second rise, still under the PCV of 1201');
});

test('one new-PCV screenshot per feed per cooldown; a PCV the cooldown held back is taken after, if back at it', () => {
  const { ac, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const first = ac.open()[0];
  assert.equal(first.ccv, 200);
  ac.finish(ac.claim(first.job).job);
  live(A, 300);
  step(60000);
  assert.deepEqual(ac.open(), [], 'inside the cooldown');
  live(A, 250);
  step(PEAK_COOLDOWN_MS);
  assert.deepEqual(ac.open(), [], 'the count fell from the PCV of 300: that peak has passed');
  live(A, 300);
  step();
  assert.equal(ac.open()[0].ccv, 300, 'back at the PCV after the cooldown');
});

test('the gap between new-PCV screenshots is 2 min by default, or what Settings says (4 min)', () => {
  assert.equal(PEAK_GAP_MIN, 2);
  const { ac, live, step } = setup({ settings: { autoCaptureMin: 4 } });
  live(A, 100);
  step();
  live(A, 200);
  step();
  ac.finish(ac.claim(ac.open()[0].job).job);
  live(A, 300);
  step(2 * 60000);
  assert.deepEqual(ac.open(), [], '2 min is inside a 4 min gap');
  step(2 * 60000);
  assert.equal(ac.open()[0].ccv, 300, 'taken at 4 min');
});

test('a waiting new-PCV screenshot is replaced by a newer one, not queued twice', () => {
  const { ac, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const job = ac.open()[0].job;
  ac.claim(job);
  ac.finish(job, { retry: true }); // handed back: waiting again
  live(A, 400);
  step(PEAK_COOLDOWN_MS);
  const open = ac.open();
  assert.equal(open.length, 1);
  assert.equal(open[0].ccv, 400);
});

test('a broadcast seen live and then over queues one end screenshot, replacing a waiting peak', () => {
  const { ac, youtube, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  youtube.latest[A] = { broadcast: 'none', viewers: null, endedAt: '2026-10-06T10:00:00Z' };
  step();
  assert.deepEqual(ac.open().map((j) => [j.id, j.reason, j.ccv]), [[A, 'end', null]]);
  ac.finish(ac.claim(ac.open()[0].job).job);
  step();
  step();
  assert.deepEqual(ac.open(), [], 'once');
});

test('the owning channel\'s sign-in saying complete is an end too; a feed already over when seen is not', () => {
  const { ac, youtube, ingest, live, step } = setup();
  live(A, 100);
  youtube.latest[B] = { broadcast: 'none', viewers: null, endedAt: '2026-10-06T09:00:00Z' };
  step();
  ingest.videos[A] = { owned: true, broadcast: 'complete' };
  step();
  assert.deepEqual(ac.open().map((j) => [j.id, j.reason]), [[A, 'end']]);
});

test('the first claim wins; an unreported claim is offered again after the lease', () => {
  const { ac, live, step, advance } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  assert.ok(ac.claim(job));
  assert.equal(ac.claim(job), null, 'a second window is turned away');
  assert.deepEqual(ac.open(), []);
  advance(LEASE_MS);
  assert.equal(ac.open()[0].job, job, 'that window went quiet: offered again');
});

test('handed back too often, a job is dropped; turned off, nothing is offered or queued', () => {
  const { ac, wallStore, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  for (let i = 0; i < MAX_TRIES; i++) {
    assert.ok(ac.claim(job));
    ac.finish(job, { retry: true });
  }
  assert.deepEqual(ac.open(), []);
  wallStore.wall.settings.autoCapture = false;
  live(A, 900);
  step(PEAK_COOLDOWN_MS);
  assert.deepEqual(ac.open(), []);
  wallStore.wall.settings.autoCapture = true;
  live(A, 950);
  step();
  assert.equal(ac.open()[0].ccv, 950);
});

test('the record says what was queued, taken, saved, handed back and dropped, and why', () => {
  const { ac, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  ac.claim(job, 'win-1');
  ac.finish(job, { retry: true, detail: 'no player to send the request through', client: 'win-1' });
  ac.claim(job, 'win-2');
  ac.finish(job, { outcome: 'saved', detail: 'A_B_200CCV_PEAK.png', client: 'win-2' });
  live(A, 300);
  step(PEAK_COOLDOWN_MS);
  const second = ac.open()[0].job;
  for (let i = 0; i < MAX_TRIES; i++) {
    ac.claim(second, 'win-1');
    ac.finish(second, { retry: true, detail: 'busy', client: 'win-1' });
  }
  const log = ac.entries();
  assert.deepEqual(log.map((e) => [e.label, e.level, e.client, e.text]), [
    ['Feed A', 'info', '', 'Automatic screenshot queued: new PCV, 200 watching'],
    ['Feed A', 'info', 'win-1', 'Automatic screenshot (new PCV) being taken by a wall window'],
    ['Feed A', 'warn', 'win-1', 'Automatic screenshot (new PCV) handed back, will be tried again: no player to send the request through'],
    ['Feed A', 'info', 'win-2', 'Automatic screenshot (new PCV) being taken by a wall window'],
    ['Feed A', 'info', 'win-2', 'Automatic screenshot (new PCV) saved: A_B_200CCV_PEAK.png'],
    ['Feed A', 'info', '', 'Automatic screenshot queued: new PCV, 300 watching'],
    ['Feed A', 'info', 'win-1', 'Automatic screenshot (new PCV) being taken by a wall window'],
    ['Feed A', 'warn', 'win-1', 'Automatic screenshot (new PCV) handed back, will be tried again: busy'],
    ['Feed A', 'info', 'win-1', 'Automatic screenshot (new PCV) being taken by a wall window'],
    ['Feed A', 'warn', 'win-1', 'Automatic screenshot (new PCV) handed back, will be tried again: busy'],
    ['Feed A', 'info', 'win-1', 'Automatic screenshot (new PCV) being taken by a wall window'],
    ['Feed A', 'bad', 'win-1', 'Automatic screenshot (new PCV) dropped after 3 tries: busy'],
  ]);
  assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq), 'numbered in order, so a window can read on from where it was');
});

test('a feed taken off the wall drops its jobs', () => {
  const { ac, youtube, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  assert.equal(ac.open().length, 1);
  youtube.ids = () => [B];
  step();
  assert.deepEqual(ac.open(), []);
});

test('a replaced job starts afresh: the earlier hand-backs are not counted against it', () => {
  const { ac, youtube, live, step } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  for (let i = 0; i < MAX_TRIES - 1; i++) {
    ac.claim(job, 'w');
    ac.finish(job, { retry: true, detail: 'no player', client: 'w' });
  }
  youtube.latest[A] = { broadcast: 'none', viewers: null, endedAt: '2026-10-06T10:00:00Z' };
  step();
  const end = ac.open()[0];
  assert.equal(end.reason, 'end');
  assert.equal(end.job, job, 'the same job, turned into the end');
  ac.claim(job, 'w');
  ac.finish(job, { retry: true, detail: 'no player', client: 'w' });
  assert.equal(ac.open().length, 1, 'one hand-back does not drop a job that only just became the end');
});

test('a claim that ran out counts as waiting: no second job, and the end replaces it', () => {
  const { ac, youtube, live, step, advance } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  ac.claim(job, 'gone');
  advance(LEASE_MS);
  live(A, 400);
  step(PEAK_COOLDOWN_MS);
  assert.deepEqual(ac.open().map((j) => [j.job, j.ccv]), [[job, 400]], 'the old job carries the new high, no second one');
  youtube.latest[A] = { broadcast: 'none', viewers: null, endedAt: '2026-10-06T10:00:00Z' };
  step();
  assert.deepEqual(ac.open().map((j) => [j.job, j.reason]), [[job, 'end']], 'no peak screenshot of an ended stream');
});

test('only the window holding the claim is heard; a job being taken is never dropped by the 30-min limit', () => {
  const { ac, live, step, advance } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  ac.claim(job, 'w1');
  advance(TTL_MS - 60000); // w1 went quiet long ago; the job is a minute from its 30-min limit
  ac.claim(job, 'w2');
  assert.equal(ac.finish(job, { outcome: 'saved', detail: 'late.png', client: 'w1' }), false, 'w1 lost the claim: ignored');
  assert.equal(ac.open().length, 0, 'w2 still has it');
  advance(90000);
  step();
  assert.equal(ac.jobs.length, 1, 'w2 is taking it: kept past the 30 min');
  assert.equal(ac.finish(job, { outcome: 'saved', detail: 'ok.png', client: 'w2' }), true);
  assert.equal(ac.entries().at(-1).text, 'Automatic screenshot (new PCV) saved: ok.png');
  assert.equal(ac.finish(job, { outcome: 'saved', client: 'w2' }), false, 'nothing left to report on');
});

test('a busy Feed Meter is not a failed try: the job is held back briefly, then offered again', () => {
  const { ac, live, step, advance } = setup();
  live(A, 100);
  step();
  live(A, 200);
  step();
  const { job } = ac.open()[0];
  for (let i = 0; i < MAX_TRIES + 1; i++) {
    assert.ok(ac.claim(job, 'w'), `claim ${i + 1}`);
    assert.equal(ac.finish(job, { retry: true, busy: true, detail: 'A screenshot is already being captured', client: 'w' }), true);
    assert.deepEqual(ac.open(), [], 'held back while the other screenshot finishes');
    assert.equal(ac.claim(job, 'w'), null, 'and not claimable meanwhile');
    advance(BUSY_HOLD_MS);
  }
  assert.equal(ac.open().length, 1, 'still there after more busy answers than MAX_TRIES');
  assert.equal(ac.entries().filter((e) => e.text.includes('waiting for the Feed Meter')).length, 1, 'said once, not on every try');
});

test('on a laptop the backend takes every job in the background: pages are offered none and can\'t claim', () => {
  const { ac, live, step } = setup();
  ac.backendTakes = true;
  live(A, 100);
  step();
  live(A, 200);
  step();
  assert.deepEqual(ac.open(), [], 'a wall page is offered nothing');
  const [job] = ac.open(BACKEND);
  assert.equal(job.reason, 'peak');
  assert.equal(ac.claim(job.job, 'some-page'), null, 'an older page offering to help is refused');
  const claimed = ac.claim(job.job, BACKEND);
  assert.equal(claimed.id, A);
  assert.match(ac.entries().at(-1).text, /being taken in the background/);
  assert.ok(ac.finish(job.job, { outcome: 'saved', detail: 'C:/shots/a.png', client: BACKEND }));
  assert.match(ac.entries().at(-1).text, /saved: C:\/shots\/a\.png/);
  assert.deepEqual(ac.open(BACKEND), []);
});
