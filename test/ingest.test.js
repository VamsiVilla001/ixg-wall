// Channel sign-in and ingest health (backend/youtube-ingest.js) against a fake Google:
// the OAuth round trip, polling liveBroadcasts/liveStreams, and that no token or stream key
// ever reaches a page.   npm test
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
const seen = { fields: [], revoked: [] };
let google;
let wall;
let dataDir;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// Fake Google: token endpoint, revoke, and the YouTube Data API calls the wall makes.
function fakeGoogle() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw);
        if (p.get('client_secret') !== CLIENT.clientSecret) return json(401, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code' && p.get('code') === 'good-code') {
          return json(200, { access_token: 'access-1', refresh_token: 'refresh-secret-token', expires_in: 3600 });
        }
        if (p.get('grant_type') === 'refresh_token') return json(200, { access_token: 'access-2', expires_in: 3600 });
        return json(400, { error: 'invalid_grant' });
      }
      if (url.pathname === '/revoke') {
        seen.revoked.push(url.searchParams.get('token'));
        return json(200, {});
      }
      const authed = /^Bearer access-/.test(req.headers.authorization || '');
      if (url.pathname === '/api/channels') {
        if (!authed) return json(401, { error: { message: 'no auth' } });
        return json(200, { items: [{ id: 'UCtestchannel', snippet: { title: 'Rubix Test' } }] });
      }
      if (url.pathname === '/api/liveBroadcasts') {
        if (!authed) return json(401, { error: { message: 'no auth' } });
        const ids = url.searchParams.get('id').split(',');
        return json(200, { items: ids.filter((id) => id === 'x-qOOPXB_lg').map((id) => ({ id, contentDetails: { boundStreamId: 'stream-1' }, status: { lifeCycleStatus: 'live' } })) });
      }
      if (url.pathname === '/api/liveStreams') {
        seen.fields.push(url.searchParams.get('fields'));
        return json(200, { items: [{
          id: 'stream-1',
          cdn: { resolution: '1080p', frameRate: '60fps', ingestionType: 'rtmp', ingestionInfo: { streamName: 'SECRET-STREAM-KEY' } },
          status: { streamStatus: 'active', healthStatus: { status: 'bad', lastUpdateTimeSeconds: String(Math.floor(Date.now() / 1000)),
            configurationIssues: [{ severity: 'warning', type: 'bitrateLow', reason: 'Low bitrate', description: 'The stream\'s current bitrate is lower than the recommended bitrate.' }] } },
        }] });
      }
      if (url.pathname === '/api/videos') return json(200, { items: [] });
      json(404, {});
    });
  });
}

before(async () => {
  const gPort = await freePort();
  google = fakeGoogle().listen(gPort, '127.0.0.1');
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-ingest-'));
  fs.writeFileSync(path.join(dataDir, 'wall.json'), JSON.stringify({ version: 1, wall: { settings: {}, session: { id: 's', name: 'Test' }, streams: [
    { id: 'a', source: { kind: 'video', id: 'x-qOOPXB_lg' }, label: 'Hindi Main' },
    { id: 'b', source: { kind: 'video', id: '2QK4W5bngD0' }, label: 'Someone else' },
  ] } }));
  const g = `http://127.0.0.1:${gPort}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir,
      IXG_YOUTUBE_API: `${g}/api`, IXG_GOOGLE_TOKEN_URL: `${g}/token`, IXG_GOOGLE_REVOKE_URL: `${g}/revoke`,
      IXG_GOOGLE_AUTH_URL: `${g}/auth`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('IXG Wall running')) resolve(); });
    child.on('exit', () => reject(new Error(out)));
  });
  wall = { child, base: `http://127.0.0.1:${port}`, publicBase: `http://localhost:${port}` };
});

after(async () => {
  await new Promise((r) => { wall.child.once('exit', r); wall.child.kill(); });
  google.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${wall.base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify(body || {}),
});
const ingestState = async () => (await (await fetch(`${wall.base}/api/youtube`)).json()).ingest;

test('the OAuth client is checked, saved, and its secret never shown', async () => {
  assert.equal((await post('/api/youtube/oauth/client', { clientId: 'nope', clientSecret: 'x' })).status, 400);
  const res = await post('/api/youtube/oauth/client', CLIENT);
  assert.equal(res.status, 200);
  const state = await ingestState();
  assert.deepEqual(state.client, { set: true, source: 'saved', clientId: CLIENT.clientId });
  assert.equal(state.redirectUri, `${wall.publicBase}/api/youtube/oauth/callback`);
  assert.ok(!JSON.stringify(state).includes(CLIENT.clientSecret));
});

test('sign-in round trip: forged callbacks are refused, the real one signs the channel in', async () => {
  const start = await fetch(`${wall.base}/api/youtube/oauth/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(to.searchParams.get('access_type'), 'offline');
  assert.equal(to.searchParams.get('redirect_uri'), `${wall.publicBase}/api/youtube/oauth/callback`);
  const state = to.searchParams.get('state');

  const forged = await fetch(`${wall.base}/api/youtube/oauth/callback?code=good-code&state=made-up`);
  assert.equal(forged.status, 400);
  const ok = await fetch(`${wall.base}/api/youtube/oauth/callback?code=good-code&state=${state}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Signed in/);
  const replay = await fetch(`${wall.base}/api/youtube/oauth/callback?code=good-code&state=${state}`);
  assert.equal(replay.status, 400, 'a sign-in link works once');

  const s = await ingestState();
  assert.equal(s.signedIn, true);
  assert.deepEqual(s.channel, { id: 'UCtestchannel', title: 'Rubix Test' });
});

test('ingest health per feed, without the stream key or tokens', async () => {
  let s;
  for (let i = 0; i < 20; i++) {
    s = await ingestState();
    if (s.status === 'ok') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(s.status, 'ok', s.error);
  const v = s.videos['x-qOOPXB_lg'];
  assert.equal(v.health, 'bad');
  assert.equal(v.resolution, '1080p');
  assert.equal(v.frameRate, '60fps');
  assert.equal(v.issues[0].severity, 'warning');
  assert.deepEqual(s.videos['2QK4W5bngD0'], { owned: false });
  assert.ok(seen.fields.every((f) => !f.includes('ingestionInfo')), 'the stream key is never requested');
  const everything = await (await fetch(`${wall.base}/api/youtube`)).text();
  for (const secret of ['SECRET-STREAM-KEY', 'refresh-secret-token', 'access-1', 'access-2']) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
});

test('sign-out forgets the channel and revokes the token at Google', async () => {
  const res = await post('/api/youtube/oauth/signout');
  assert.equal(res.status, 200);
  const s = await ingestState();
  assert.equal(s.signedIn, false);
  assert.deepEqual(s.videos, {});
  assert.deepEqual(seen.revoked, ['refresh-secret-token']);
  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  assert.equal(secrets.oauthToken, undefined);
});
