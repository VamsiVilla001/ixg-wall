// A feed's encoder stream stops arriving (backend/youtube-ingest.js): YouTube is asked at
// once whether the broadcast ended, and every poll after while it's still on air, then
// left alone. In-process, with a fake fetch.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-ingest-'));
process.env.IXG_DATA_DIR = dataDir; // never the real wall's folder
const { IngestHealth } = require('../backend/youtube-ingest');

const realFetch = global.fetch;
const google = { stream: {}, broadcast: {}, endedAt: {}, calls: [] };

before(() => {
  global.fetch = async (url) => {
    const u = new URL(url);
    const resource = u.pathname.split('/').pop();
    const ids = (u.searchParams.get('id') || '').split(',');
    google.calls.push({ resource, ids, part: u.searchParams.get('part') });
    const items = resource === 'liveBroadcasts'
      ? ids.map((id) => ({ id, contentDetails: { boundStreamId: `s-${id}` }, snippet: { actualEndTime: google.endedAt[id] }, status: { lifeCycleStatus: google.broadcast[id] } }))
      : ids.map((sid) => {
        const [status, health] = google.stream[sid.slice(2)];
        return { id: sid, cdn: { resolution: '1080p', frameRate: '60fps', ingestionType: 'rtmp' }, status: { streamStatus: status, healthStatus: { status: health } } };
      });
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
});

after(() => {
  global.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function ingest(videoIds) {
  const credentials = {
    oauthClient: () => ({ clientId: 'x' }),
    channels: () => [{ id: 'UCa', title: 'A' }],
    accessToken: async () => 'token',
    dropAccess() {},
    clientInfo: () => ({ set: true }),
  };
  const wallStore = { wall: { streams: videoIds.map((id) => ({ source: { kind: 'video', id } })) } };
  const ing = new IngestHealth({ credentials, wallStore, pollMs: () => 30000 });
  ing.stop(); // polls are called by hand
  return ing;
}
const asked = (since) => google.calls.slice(since).filter((c) => c.resource === 'liveBroadcasts' && c.part === 'snippet,status').flatMap((c) => c.ids);

test('an encoder that stops makes the wall ask YouTube at once, and the feed shows as ended when YouTube says so', async () => {
  const [A, B] = ['aaaaaaaaaaa', 'bbbbbbbbbbb'];
  Object.assign(google.stream, { [A]: ['active', 'good'], [B]: ['active', 'good'] });
  Object.assign(google.broadcast, { [A]: 'live', [B]: 'live' });
  const ing = ingest([A, B]);
  const quiet = [];
  ing.on('quiet', (ids) => quiet.push(...ids));

  await ing.poll();
  assert.equal(ing.videos[A].quietSince, undefined);
  let mark = google.calls.length;

  // A's encoder stops, YouTube still has it live: an outage, asked about every poll.
  google.stream[A] = ['inactive', 'noData'];
  await ing.poll();
  assert.deepEqual(asked(mark), [A], 'asked about the quiet feed only');
  assert.deepEqual(quiet, [A], 'the Data API poll is told to look too');
  assert.equal(ing.videos[A].broadcast, 'live');
  assert.ok(ing.videos[A].quietSince > 0);
  const since = ing.videos[A].quietSince;

  mark = google.calls.length;
  await ing.poll();
  assert.deepEqual(asked(mark), [A], 'asked again while it stays on air');
  assert.equal(ing.videos[A].quietSince, since, 'keeps when it went quiet');
  assert.deepEqual(quiet, [A], 'not told again for the same stop');

  // YouTube's auto-stop ends the broadcast.
  google.broadcast[A] = 'complete';
  google.endedAt[A] = '2026-10-05T12:54:13Z';
  mark = google.calls.length;
  await ing.poll();
  assert.equal(ing.videos[A].broadcast, 'complete');
  assert.equal(ing.videos[A].endedAt, '2026-10-05T12:54:13Z');
  assert.ok(ing.videos[A].checkedAt > 0);

  mark = google.calls.length;
  await ing.poll();
  assert.deepEqual(asked(mark), [], 'over: not asked again');
  assert.equal(ing.videos[A].broadcast, 'complete', 'stays ended between owner lookups');
  assert.equal(ing.videos[B].quietSince, undefined, 'the other feed is untouched');
});

test('a scheduled broadcast with an idle encoder costs nothing extra; a quiet stream stops being asked after 10 minutes', async () => {
  const [C, D] = ['ccccccccccc', 'ddddddddddd'];
  Object.assign(google.stream, { [C]: ['inactive', 'noData'], [D]: ['inactive', 'noData'] });
  Object.assign(google.broadcast, { [C]: 'ready', [D]: 'live' });
  const ing = ingest([C, D]);
  let mark = google.calls.length;
  await ing.poll();
  assert.deepEqual(asked(mark), [D], 'only the one YouTube has on air');
  assert.equal(ing.videos[C].quietSince, undefined, 'idle before its start: not quiet');

  ing.quiet.set(D, Date.now() - 11 * 60000);
  mark = google.calls.length;
  await ing.poll();
  assert.deepEqual(asked(mark), [], 'a long outage is left to the owner lookups');
  assert.ok(ing.videos[D].quietSince > 0, 'still marked quiet');

  // The encoder comes back: no longer quiet.
  google.stream[D] = ['active', 'good'];
  await ing.poll();
  assert.equal(ing.videos[D].quietSince, undefined);
  assert.equal(ing.quiet.has(D), false);
});
