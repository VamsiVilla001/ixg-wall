// Google credentials (backend/google-credentials.js) and ingest health (backend/youtube-ingest.js)
// against a fake Google: anyone's API key and OAuth client checked before they're saved,
// several channels signed in at once, each feed's ingest read through the channel that
// owns it, and no key, secret, token or stream key ever reaching a page.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLIENT = { clientId: '123456789012-testclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret' };
const KEYS = { good: 'AIzaSyGOOD_TEST_KEY_000000000000000good', bad: 'AIzaSyBAD_TEST_KEY_0000000000000000bad', ip: 'AIzaSyIP_TEST_KEY_00000000000000000ipip' };
const CHANNELS = {
  UCrubix: { title: 'Rubix IXG', code: 'code-rubix', refresh: 'refresh-rubix', owns: { 'x-qOOPXB_lg': 'stream-r' }, ttl: 3600 },
  // A short-lived access token, so every poll refreshes it and a revoked sign-in shows at once.
  UCkrafton: { title: 'KRAFTON INDIA ESPORTS', code: 'code-krafton', refresh: 'refresh-krafton', owns: { Fc45LqGulQ0: 'stream-k' }, ttl: 61 },
};
const STREAMS = {
  'stream-r': { health: 'bad', resolution: '1080p', frameRate: '60fps', issues: [{ severity: 'warning', type: 'bitrateLow', reason: 'Low bitrate', description: 'The stream\'s current bitrate is lower than the recommended bitrate.' }] },
  'stream-k': { health: 'good', resolution: '1080p', frameRate: '30fps', issues: [] },
};
// Each owned broadcast went live this long ago; YouTube Analytics has processed all but the last few minutes.
const LIVE_FOR_MIN = 90;
const STUDIO_BEHIND_MIN = 4;
const startedAt = new Date(Math.floor((Date.now() - LIVE_FOR_MIN * 60000) / 1000) * 1000).toISOString();
const google = { redirects: new Set(), revoked: [], fields: [], dead: new Set(), reports: [] };
const servers = [];
let fake;
let wall;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// Google's sign-in error page carries the reason as a base64 protobuf (field 1 code, field 2 text).
function authError(code, message) {
  const field = (n, text) => {
    const b = Buffer.from(text);
    return Buffer.concat([Buffer.from([(n << 3) | 2, b.length]), b]);
  };
  return Buffer.concat([field(1, code), field(2, message), Buffer.from([0x20, 0x91, 0x03])]).toString('base64');
}

function fakeGoogle() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const to = (location) => { res.writeHead(302, { Location: location }); res.end(); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (url.pathname === '/auth') {
        const error = (code, msg) => to(`/signin/oauth/error?authError=${encodeURIComponent(authError(code, msg))}&flowName=GeneralOAuthFlow`);
        if (q.get('client_id') !== CLIENT.clientId) return error('invalid_client', 'The OAuth client was not found.');
        if (!google.redirects.has(q.get('redirect_uri'))) return error('redirect_uri_mismatch', 'Register the redirect URI in the Google Cloud Console.');
        return to('/signin/identifier?flow=test');
      }
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw);
        if (p.get('client_id') !== CLIENT.clientId) return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        if (p.get('client_secret') !== CLIENT.clientSecret) return json(401, { error: 'invalid_client', error_description: 'Unauthorized' });
        const byCode = Object.entries(CHANNELS).find(([, c]) => c.code === p.get('code'));
        if (p.get('grant_type') === 'authorization_code' && byCode) {
          const [id, c] = byCode;
          return json(200, { access_token: `access-${id}-1`, refresh_token: c.refresh, expires_in: c.ttl });
        }
        const byRefresh = Object.entries(CHANNELS).find(([, c]) => c.refresh === p.get('refresh_token'));
        if (p.get('grant_type') === 'refresh_token' && byRefresh && !google.dead.has(byRefresh[0])) {
          return json(200, { access_token: `access-${byRefresh[0]}-2`, expires_in: byRefresh[1].ttl });
        }
        return json(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
      }
      if (url.pathname === '/revoke') {
        google.revoked.push(q.get('token'));
        return json(200, {});
      }
      if (url.pathname === '/api/i18nLanguages') {
        const key = q.get('key');
        if (key === KEYS.good) return json(200, { kind: 'youtube#i18nLanguageListResponse' });
        if (key === KEYS.ip) return json(403, { error: { message: 'blocked', details: [{ reason: 'API_KEY_IP_ADDRESS_BLOCKED' }] } });
        return json(400, { error: { message: 'API key not valid.', errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } });
      }
      if (url.pathname === '/api/videos') return json(200, { items: [] });
      const channelId = /^Bearer access-(UC\w+)-\d$/.exec(req.headers.authorization || '')?.[1];
      const channel = CHANNELS[channelId];
      if (!channel) return json(401, { error: { message: 'no auth' } });
      if (url.pathname === '/api/channels') return json(200, { items: [{ id: channelId, snippet: { title: channel.title } }] });
      if (url.pathname === '/api/liveBroadcasts') {
        const ids = q.get('id').split(',').filter((id) => channel.owns[id]);
        return json(200, { items: ids.map((id) => ({ id, contentDetails: { boundStreamId: channel.owns[id] }, snippet: { actualStartTime: startedAt }, status: { lifeCycleStatus: 'live' } })) });
      }
      if (url.pathname === '/analytics/reports') {
        google.reports.push(Object.fromEntries(q));
        // KRAFTON's sign-in is fine, but its project hasn't enabled the Analytics API.
        if (channelId === 'UCkrafton') {
          return json(403, { error: { code: 403, message: 'YouTube Analytics API has not been used in project 1234 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=1234 then retry.', errors: [{ reason: 'accessNotConfigured' }] } });
        }
        const video = /^video==(.+)$/.exec(q.get('filters'))?.[1];
        if (!channel.owns[video]) return json(403, { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } });
        if (!q.get('dimensions')) {
          // As YouTube does: the whole-broadcast average alongside the peak is an internal error.
          if (q.get('metrics').includes('averageConcurrentViewers')) return json(500, { error: { code: 500, message: 'An internal error has occurred.', errors: [{ reason: 'internalError' }] } });
          return json(200, { columnHeaders: [{ name: 'peakConcurrentViewers' }], rows: [[2468]] });
        }
        // livestreamPosition is in seconds from the start, a row a minute.
        const rows = [];
        for (let m = 0; m < LIVE_FOR_MIN - STUDIO_BEHIND_MIN; m++) rows.push([m * 60, 1000 + m, 1010 + m]);
        return json(200, { columnHeaders: [{ name: 'livestreamPosition' }, { name: 'averageConcurrentViewers' }, { name: 'peakConcurrentViewers' }], rows });
      }
      if (url.pathname === '/api/liveStreams') {
        google.fields.push(q.get('fields'));
        const mine = new Set(Object.values(channel.owns));
        return json(200, { items: q.get('id').split(',').filter((id) => mine.has(id)).map((id) => ({
          id,
          cdn: { resolution: STREAMS[id].resolution, frameRate: STREAMS[id].frameRate, ingestionType: 'rtmp', ingestionInfo: { streamName: 'SECRET-STREAM-KEY' } },
          status: { streamStatus: 'active', healthStatus: { status: STREAMS[id].health, lastUpdateTimeSeconds: String(Math.floor(Date.now() / 1000)), configurationIssues: STREAMS[id].issues } },
        })) });
      }
      json(404, {});
    });
  });
}

// A wall server against the fake Google, with its own data folder.
async function startWall({ secrets } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-google-'));
  fs.writeFileSync(path.join(dataDir, 'wall.json'), JSON.stringify({ version: 1, wall: { settings: {}, session: { id: 's', name: 'Test' }, streams: [
    { id: 'a', source: { kind: 'video', id: 'x-qOOPXB_lg' }, label: 'Hindi Main' },
    { id: 'b', source: { kind: 'video', id: 'Fc45LqGulQ0' }, label: 'BMSD Hindi' },
    { id: 'c', source: { kind: 'video', id: '2QK4W5bngD0' }, label: 'Someone else' },
  ] } }));
  if (secrets) fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify(secrets));
  const g = `http://127.0.0.1:${fake.address().port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir,
      IXG_SERVER_CAPTURE: '0', IXG_YOUTUBE_API: `${g}/api`, IXG_YOUTUBE_ANALYTICS_API: `${g}/analytics`, IXG_GOOGLE_TOKEN_URL: `${g}/token`, IXG_GOOGLE_REVOKE_URL: `${g}/revoke`, IXG_GOOGLE_AUTH_URL: `${g}/auth`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('IXG Wall running')) resolve(); });
    child.on('exit', () => reject(new Error(out)));
  });
  const server = { child, dataDir, base: `http://127.0.0.1:${port}`, redirectUri: `http://localhost:${port}/api/youtube/oauth/callback` };
  servers.push(server);
  return server;
}

before(async () => {
  fake = fakeGoogle().listen(await freePort(), '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  wall = await startWall();
});

after(async () => {
  for (const s of servers) {
    await new Promise((r) => { if (s.child.exitCode != null) r(); else { s.child.once('exit', r); s.child.kill(); } });
    fs.rmSync(s.dataDir, { recursive: true, force: true });
  }
  fake.close();
});

const post = (p, body, server = wall) => fetch(`${server.base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify(body || {}),
});
const youtube = async (server = wall) => (await fetch(`${server.base}/api/youtube`)).json();
const savedSecrets = (server = wall) => JSON.parse(fs.readFileSync(path.join(server.dataDir, 'secrets.json'), 'utf8'));
async function until(check, what) {
  let last;
  for (let i = 0; i < 40; i++) {
    last = await youtube();
    if (check(last.ingest)) return last.ingest;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`${what}: ${JSON.stringify(last.ingest)}`);
}

// Starts a sign-in and brings Google's answer back as the browser would.
async function signIn(code) {
  const start = await fetch(`${wall.base}/api/youtube/oauth/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return fetch(`${wall.base}/api/youtube/oauth/callback?code=${code}&state=${state}`);
}

test('anyone\'s API key is checked with YouTube before it replaces the saved one', async () => {
  const bad = await post('/api/youtube/key', { key: KEYS.bad });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /isn't valid/);
  assert.equal(savedSecrets().ytApiKey, undefined, 'an invalid key is never saved');

  const good = await post('/api/youtube/key', { key: KEYS.good });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.check.status, 'ok');
  assert.deepEqual(body.ytKey, { set: true, source: 'saved', last4: 'good' });

  const again = await (await post('/api/youtube/key', { key: KEYS.bad })).json();
  assert.match(again.error, /saved key is still in use/);
  assert.equal(again.ytKey.last4, 'good');

  // A restricted key is a Google Cloud setting, not a wrong key: saved, with the fix.
  const ip = await (await post('/api/youtube/key', { key: KEYS.ip })).json();
  assert.equal(ip.check.status, 'restricted');
  assert.match(ip.check.message, /IP/);
  assert.equal(ip.ytKey.last4, 'ipip');

  for (const p of ['/api/youtube', '/api/config', '/api/wall']) {
    const text = await (await fetch(`${wall.base}${p}`)).text();
    for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), `${p} leaks a key`);
  }
});

test('anyone\'s OAuth client: refused if Google doesn\'t know it, saved with the redirect fix otherwise', async () => {
  assert.equal((await post('/api/youtube/oauth/client', { clientId: 'nope', clientSecret: 'x' })).status, 400);
  const unknown = await post('/api/youtube/oauth/client', { clientId: '999999999999-someoneelse.apps.googleusercontent.com', clientSecret: CLIENT.clientSecret });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /no OAuth client with this ID/);
  const wrongSecret = await post('/api/youtube/oauth/client', { ...CLIENT, clientSecret: 'GOCSPX-wrong-secret' });
  assert.equal(wrongSecret.status, 400);
  assert.match((await wrongSecret.json()).error, /client secret/);
  assert.equal(savedSecrets().oauthClient, undefined, 'a refused client is never saved');

  // Right client, but this wall's address isn't registered with it yet.
  const saved = await post('/api/youtube/oauth/client', CLIENT);
  assert.equal(saved.status, 200);
  const { ingest, check } = await saved.json();
  assert.equal(check.status, 'redirect');
  assert.ok(check.message.includes(wall.redirectUri), 'says exactly which address to add');
  assert.equal(ingest.client.clientId, CLIENT.clientId);
  assert.equal(ingest.client.check.status, 'redirect');
  assert.equal(ingest.redirectUri, wall.redirectUri);

  // Fixed in Google Cloud, then "Check again".
  google.redirects.add(wall.redirectUri);
  const rechecked = await (await post('/api/youtube/oauth/check')).json();
  assert.equal(rechecked.ingest.client.check.status, 'ok');
  assert.ok(!JSON.stringify(await youtube()).includes(CLIENT.clientSecret), 'the client secret never reaches a page');
});

test('several channels sign in; each feed\'s ingest comes from the channel that owns it', async () => {
  const start = await fetch(`${wall.base}/api/youtube/oauth/start`, { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly');
  assert.equal(to.searchParams.get('access_type'), 'offline');
  assert.equal(to.searchParams.get('redirect_uri'), wall.redirectUri);
  const state = to.searchParams.get('state');
  assert.equal((await fetch(`${wall.base}/api/youtube/oauth/callback?code=code-rubix&state=made-up`)).status, 400, 'a forged callback is refused');
  const ok = await fetch(`${wall.base}/api/youtube/oauth/callback?code=code-rubix&state=${state}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Rubix IXG/);
  assert.equal((await fetch(`${wall.base}/api/youtube/oauth/callback?code=code-rubix&state=${state}`)).status, 400, 'a sign-in link works once');

  assert.equal((await signIn('code-krafton')).status, 200);

  const s = await until((i) => i.channels.length === 2 && i.channels.every((c) => c.status === 'ok')
    && i.videos.Fc45LqGulQ0?.health && i.videos['x-qOOPXB_lg']?.health, 'both channels polled');
  assert.deepEqual(s.channels.map((c) => [c.id, c.title, c.feeds]).sort(), [['UCkrafton', 'KRAFTON INDIA ESPORTS', 1], ['UCrubix', 'Rubix IXG', 1]]);
  assert.equal(s.signedIn, true);
  assert.equal(s.videos['x-qOOPXB_lg'].channelId, 'UCrubix');
  assert.equal(s.videos['x-qOOPXB_lg'].health, 'bad');
  assert.equal(s.videos['x-qOOPXB_lg'].frameRate, '60fps');
  assert.equal(s.videos['x-qOOPXB_lg'].issues[0].severity, 'warning');
  assert.equal(s.videos.Fc45LqGulQ0.channelId, 'UCkrafton');
  assert.equal(s.videos.Fc45LqGulQ0.health, 'good');
  assert.deepEqual(s.videos['2QK4W5bngD0'], { owned: false });

  assert.ok(google.fields.every((f) => !f.includes('ingestionInfo')), 'the stream key is never requested');
  const everything = await (await fetch(`${wall.base}/api/youtube`)).text();
  for (const secret of ['SECRET-STREAM-KEY', 'refresh-rubix', 'refresh-krafton', 'access-UC', CLIENT.clientSecret]) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
});

test('a feed\'s viewer history starts at go-live from the owning channel\'s Studio audience', async () => {
  let series = [];
  for (let i = 0; i < 40 && !series.length; i++) {
    series = (await (await fetch(`${wall.base}/api/youtube/history?id=x-qOOPXB_lg`)).json()).series;
    if (!series.length) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(series.length, LIVE_FOR_MIN - STUDIO_BEHIND_MIN, 'one point a minute from go-live');
  assert.equal(series[0][0], Date.parse(startedAt), 'the first minute is the broadcast\'s start');
  assert.deepEqual(series[0], [Date.parse(startedAt), 1000, null, null, null, 1010]);
  assert.equal(series[1][0] - series[0][0], 60000);

  const report = google.reports.find((r) => r.filters === 'video==x-qOOPXB_lg');
  assert.equal(report.ids, 'channel==MINE');
  assert.equal(report.dimensions, 'livestreamPosition');
  assert.equal(report.metrics, 'averageConcurrentViewers,peakConcurrentViewers');
  assert.ok(!google.reports.some((r) => r.filters === 'video==2QK4W5bngD0'), 'a feed no signed-in channel owns isn\'t asked about');

  // Studio's PCV for the whole broadcast: the peak alone, kept apart from the sampled PCV.
  const official = google.reports.find((r) => r.filters === 'video==x-qOOPXB_lg' && !r.dimensions);
  assert.equal(official.metrics, 'peakConcurrentViewers', 'never the average alongside: YouTube errors on that');
  let kept = null;
  for (let i = 0; i < 20 && !kept; i++) {
    try {
      kept = JSON.parse(fs.readFileSync(path.join(wall.dataDir, 'pcv.json'), 'utf8')).broadcasts['x-qOOPXB_lg']?.official;
    } catch { /* not written yet */ }
    if (!kept) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(kept?.peak, 2468, 'Studio\'s PCV is saved, as its own figure');

  // The Analytics API is off in KRAFTON's project: Settings says so and how to fix it.
  const s = await until((i) => i.channels.find((c) => c.id === 'UCkrafton')?.studio, 'KRAFTON\'s Studio audience tried');
  const krafton = s.channels.find((c) => c.id === 'UCkrafton');
  assert.equal(krafton.studio.code, 'disabled');
  assert.match(krafton.studio.error, /YouTube Analytics API isn't enabled.*youtubeanalytics\.googleapis\.com/);
  assert.equal(krafton.status, 'ok', 'ingest health carries on');
  assert.deepEqual(s.channels.find((c) => c.id === 'UCrubix').studio, { status: 'ok', code: null, error: '' });
  assert.equal((await (await fetch(`${wall.base}/api/youtube/history?id=Fc45LqGulQ0`)).json()).series.length, 0);
});

test('an expired sign-in is marked for signing in again, and the other channel keeps working', async () => {
  google.dead.add('UCkrafton');
  const { wall: current } = await (await fetch(`${wall.base}/api/wall`)).json();
  await fetch(`${wall.base}/api/wall`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify({ wall: current }) });
  const s = await until((i) => i.channels.find((c) => c.id === 'UCkrafton')?.status === 'expired', 'KRAFTON marked expired');
  assert.equal(s.channels.find((c) => c.id === 'UCrubix').status, 'ok');
  assert.equal(s.videos['x-qOOPXB_lg'].health, 'bad');
  assert.equal(savedSecrets().channels.find((c) => c.channelId === 'UCkrafton').refreshToken, undefined);
});

test('channels sign out one at a time, or all at once, and Google is told', async () => {
  const one = await (await post('/api/youtube/oauth/signout', { channelId: 'UCrubix' })).json();
  assert.deepEqual(one.ingest.channels.map((c) => c.id), ['UCkrafton']);
  assert.ok(google.revoked.includes('refresh-rubix'));
  const all = await (await post('/api/youtube/oauth/signout')).json();
  assert.deepEqual(all.ingest.channels, []);
  assert.equal(all.ingest.signedIn, false);
  assert.deepEqual(savedSecrets().channels, []);
});

test('a channel signed in before several were possible carries over', async () => {
  const older = await startWall({ secrets: {
    sessionSecret: 'a'.repeat(64),
    oauthClient: CLIENT,
    oauthToken: { refreshToken: 'refresh-rubix', channelId: 'UCrubix', channelTitle: 'Rubix IXG', savedAt: '2026-10-04T09:00:00.000Z' },
  } });
  const { ingest } = await youtube(older);
  assert.deepEqual(ingest.channels.map((c) => [c.id, c.title, c.expired]), [['UCrubix', 'Rubix IXG', false]]);
  const onDisk = savedSecrets(older);
  assert.equal(onDisk.oauthToken, undefined);
  assert.equal(onDisk.channels[0].refreshToken, 'refresh-rubix');

  // Someone else's client that Google refuses doesn't replace the working one.
  const refused = await post('/api/youtube/oauth/client', { clientId: '999999999999-someoneelse.apps.googleusercontent.com', clientSecret: 'GOCSPX-other' }, older);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /saved client is still in use/);
  assert.equal(savedSecrets(older).channels.length, 1);
});
