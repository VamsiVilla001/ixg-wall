// Smoke tests for the backend: starts real servers on free ports with throwaway data
// folders, and never touches the real wall or calls YouTube.
//   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const LEGACY_KEY = 'AIzaSyTEST_KEY_ONLY_FOR_TESTS_0000wxyz';
const running = [];
const dataDirs = [];

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Starts `node server.js` and resolves once it listens (or rejects with its output if it exits).
async function startServer(env, { expectExit = false } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-test-'));
  dataDirs.push(dataDir);
  if (env.seedWall) fs.writeFileSync(path.join(dataDir, 'wall.json'), JSON.stringify(env.seedWall));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PORT: String(port),
      IXG_DATA_DIR: dataDir,
      IXG_YOUTUBE_API: 'http://127.0.0.1:9', // nothing listens there: YouTube is never called
      ...env.vars,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  if (expectExit) return { code: await exited, output };
  running.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);
    child.stdout.on('data', () => {
      if (output.includes('IXG Wall running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    exited.then((code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
  return { base: `http://127.0.0.1:${port}`, port, dataDir, output: () => output };
}

const SEED = {
  version: 3,
  wall: {
    settings: { ytApiKey: LEGACY_KEY, ytPollSec: 30 },
    streams: [{ id: 'a', source: { kind: 'video', id: 'x-qOOPXB_lg' }, label: 'Hindi Test Main' }],
  },
};

let hosted;
let cookie = '';
const headers = (extra = {}) => ({ Cookie: cookie, 'Content-Type': 'application/json', ...extra });

before(async () => {
  hosted = await startServer({
    seedWall: SEED,
    vars: { IXG_HOSTED: '1', IXG_PASSWORD: PASSWORD, PUBLIC_URL: 'https://wall.example.com' },
  });
});

after(async () => {
  await Promise.all(running.map((child) => new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on('exit', resolve);
    child.kill();
  })));
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('a hosted wall refuses to start without a password', async () => {
  const { code, output } = await startServer({ vars: { IXG_HOSTED: '1', PUBLIC_URL: 'https://wall.example.com' } }, { expectExit: true });
  assert.equal(code, 1);
  assert.match(output, /IXG_PASSWORD is required/);
});

test('signed out: pages redirect to sign-in, the API answers 401', async () => {
  const page = await fetch(`${hosted.base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const deep = await fetch(`${hosted.base}/?wall=managed`, { redirect: 'manual' });
  assert.equal(deep.headers.get('location'), `/login?next=${encodeURIComponent('/?wall=managed')}`);
  for (const p of ['/api/wall', '/api/config', '/api/telemetry', '/app.js', '/extension/ixg-wall-feed-meter.zip']) {
    const res = await fetch(`${hosted.base}${p}`, { redirect: 'manual' });
    assert.ok([302, 401].includes(res.status), `${p} answered ${res.status}`);
  }
  // Opened by the browser itself (the Google sign-in popup): to the sign-in page, then back.
  // (fetch won't send Sec-Fetch-* headers: only a browser may, so this is a raw request.)
  const popup = await new Promise((resolve, reject) => {
    require('node:http').get(`${hosted.base}/api/youtube/oauth/start`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
  });
  assert.equal(popup.status, 302);
  assert.equal(popup.location, `/login?next=${encodeURIComponent('/api/youtube/oauth/start')}`);
  for (const p of ['/login', '/style.css', '/healthz', '/fonts/Manrope-500.woff2']) {
    assert.equal((await fetch(`${hosted.base}${p}`)).status, 200, p);
  }
  assert.equal((await fetch(`${hosted.base}/login`)).headers.get('x-frame-options'), 'DENY');
});

test('sign-in needs the page header and the right password', async () => {
  const noHeader = await fetch(`${hosted.base}/api/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(noHeader.status, 403);
  const wrong = await fetch(`${hosted.base}/api/login`, {
    method: 'POST', headers: { 'X-IXG-Wall': '1' }, body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${hosted.base}/api/login`, {
    method: 'POST', headers: { 'X-IXG-Wall': '1', Origin: 'https://wall.example.com' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(right.status, 200);
  const set = right.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  cookie = set.split(';')[0];
  assert.equal((await fetch(`${hosted.base}/`, { headers: headers() })).status, 200);
});

test('a forged session cookie is refused', async () => {
  const forged = cookie.replace(/\.[\w-]+$/, `.${'A'.repeat(43)}`);
  assert.equal((await fetch(`${hosted.base}/api/wall`, { headers: { Cookie: forged } })).status, 401);
});

test('the YouTube key moved out of wall.json and never reaches a page', async () => {
  const onDisk = fs.readFileSync(path.join(hosted.dataDir, 'wall.json'), 'utf8');
  assert.ok(!onDisk.includes(LEGACY_KEY), 'wall.json still holds the key');
  const secrets = JSON.parse(fs.readFileSync(path.join(hosted.dataDir, 'secrets.json'), 'utf8'));
  assert.equal(secrets.ytApiKey, LEGACY_KEY);

  for (const p of ['/api/wall', '/api/config', '/api/youtube']) {
    const text = await (await fetch(`${hosted.base}${p}`, { headers: headers() })).text();
    assert.ok(!text.includes(LEGACY_KEY), `${p} leaks the key`);
  }
  const config = await (await fetch(`${hosted.base}/api/config`, { headers: headers() })).json();
  assert.equal(config.hosted, true);
  assert.equal(config.auth, true);
  assert.deepEqual(config.ytKey, { set: true, source: 'saved', last4: 'wxyz' });
});

test('saving the wall needs the page header, and drops a key sent with it', async () => {
  const { session } = (await (await fetch(`${hosted.base}/api/wall`, { headers: headers() })).json()).wall;
  const wall = { settings: { ytApiKey: 'AIzaSySHOULD_NOT_BE_STORED_ANYWHERE_1', ytPollSec: 60 }, session, streams: SEED.wall.streams };
  const forged = await fetch(`${hosted.base}/api/wall`, { method: 'PUT', headers: headers(), body: JSON.stringify({ wall }) });
  assert.equal(forged.status, 403);
  const crossSite = await fetch(`${hosted.base}/api/wall`, {
    method: 'PUT', headers: headers({ 'X-IXG-Wall': '1', Origin: 'https://evil.example' }), body: JSON.stringify({ wall }),
  });
  assert.equal(crossSite.status, 403);
  const ok = await fetch(`${hosted.base}/api/wall`, { method: 'PUT', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify({ wall }) });
  assert.equal(ok.status, 200);
  const saved = await (await fetch(`${hosted.base}/api/wall`, { headers: headers() })).json();
  assert.equal(saved.wall.settings.ytPollSec, 60);
  assert.ok(!('ytApiKey' in saved.wall.settings));
});

test('the key is set and removed through its own endpoint', async () => {
  const post = (key) => fetch(`${hosted.base}/api/youtube/key`, {
    method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify({ key }),
  });
  assert.equal((await post('not a key!')).status, 400);
  const saved = await post('AIzaSyANOTHER_TEST_KEY_FOR_TESTS_00abcd');
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).ytKey, { set: true, source: 'saved', last4: 'abcd' });
  const removed = await post('');
  assert.deepEqual((await removed.json()).ytKey, { set: false, source: null, last4: '' });
});

test('user links: an admin generates one, and whoever opens it is a user who never sees the integrations', async () => {
  const KEY = 'AIzaSyUSER_LINK_TEST_KEY_FOR_TESTS_9876';
  const admin = (p, body) => fetch(`${hosted.base}${p}`, body === undefined ? { headers: headers() }
    : { method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify(body) });
  assert.equal((await admin('/api/youtube/key', { key: KEY })).status, 200);
  assert.equal((await admin('/api/links', { name: '' })).status, 400);
  const made = await admin('/api/links', { name: 'Production desk' });
  assert.equal(made.status, 200);
  const [link] = (await made.json()).links;
  assert.equal(link.name, 'Production desk');
  assert.equal(link.expiresAt, null);
  assert.match(link.url, /^https:\/\/wall\.example\.com\/join#[\w-]{32}$/);
  assert.equal((await fetch(`${hosted.base}/join`)).status, 200, 'the link page opens signed out');

  // Opening it: the page posts the link. A wrong one is refused like a wrong password.
  const join = (body, extra = {}) => fetch(`${hosted.base}/api/join`, {
    method: 'POST', headers: { 'X-IXG-Wall': '1', ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await join({ link: `${link.url.slice(0, -4)}AAAA` })).status, 401);
  assert.equal((await fetch(`${hosted.base}/api/join`, { method: 'POST', body: JSON.stringify({ link: link.url }) })).status, 403);
  const joined = await join({ link: link.url });
  assert.equal(joined.status, 200);
  const userCookie = joined.headers.get('set-cookie').split(';')[0];
  const user = (p, opts = {}) => fetch(`${hosted.base}${p}`, { ...opts, headers: { Cookie: userCookie, 'Content-Type': 'application/json', 'X-IXG-Wall': '1', ...opts.headers } });

  assert.equal((await user('/')).status, 200);
  const config = await (await user('/api/config')).json();
  assert.equal(config.role, 'user');
  assert.equal(config.linkName, 'Production desk');
  assert.deepEqual(config.ytKey, { set: true });
  const yt = await (await user('/api/youtube')).json();
  assert.deepEqual(yt.key, { set: true });
  assert.deepEqual(yt.ingest.channels, []);
  assert.equal(yt.ingest.client, undefined);
  assert.equal(yt.ingest.redirectUri, undefined);
  for (const p of ['/api/config', '/api/youtube', '/api/wall']) {
    const text = await (await user(p)).text();
    assert.ok(!text.includes(KEY) && !text.includes('9876'), `${p} shows a user the key`);
  }
  // Blocked on the server, not just hidden on the page.
  for (const [p, body] of [['/api/youtube/key', { key: '' }], ['/api/youtube/oauth/client', {}], ['/api/youtube/oauth/signout', {}], ['/api/links', { name: 'more' }]]) {
    assert.equal((await user(p, { method: 'POST', body: JSON.stringify(body) })).status, 403, p);
  }
  assert.equal((await user('/api/links')).status, 403);
  assert.equal((await user('/api/youtube/oauth/start', { redirect: 'manual' })).status, 403);
  assert.equal((await (await admin('/api/config')).json()).ytKey.last4, '9876', 'the key is still in place');

  // A user operates the wall, but can't change the admin's YouTube polling.
  const { wall } = await (await user('/api/wall')).json();
  const saved = await user('/api/wall', { method: 'PUT', body: JSON.stringify({ wall: { ...wall, settings: { ...wall.settings, ytPollSec: 15, scrollColumns: 3 } } }) });
  assert.equal(saved.status, 200);
  const after = (await (await user('/api/wall')).json()).wall.settings;
  assert.equal(after.scrollColumns, 3);
  assert.equal(after.ytPollSec, 60);

  // Users don't add feeds: refused on the server, whether on the wall or smuggled into a
  // saved session. Reordering, removing and bringing back a saved session's feeds are fine.
  const put = (w) => user('/api/wall', { method: 'PUT', body: JSON.stringify({ wall: w }) });
  const feed = (id, label) => ({ id: `s-${id}`, source: { kind: 'video', id }, label });
  const base = (await (await user('/api/wall')).json()).wall;
  const seeded = await admin('/api/wall');
  assert.equal(seeded.status, 200);
  const adminPut = await fetch(`${hosted.base}/api/wall`, {
    method: 'PUT', headers: headers({ 'X-IXG-Wall': '1', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ wall: { ...base, streams: [feed('aaaaaaaaaaa', 'A'), feed('bbbbbbbbbbb', 'B')], savedSessions: [{ id: 'old', name: 'Earlier', startedAt: '2026-10-04T09:00:00.000Z', endedAt: '2026-10-04T10:00:00.000Z', streams: [feed('ccccccccccc', 'C')] }] } }),
  });
  assert.equal(adminPut.status, 200, 'the admin seeds two feeds and a saved session');
  const current = (await (await user('/api/wall')).json()).wall;
  const added = await put({ ...current, streams: [...current.streams, feed('ddddddddddd', 'D')] });
  assert.equal(added.status, 403);
  assert.match((await added.json()).error, /admin can add feeds/);
  const smuggled = await put({ ...current, savedSessions: [...current.savedSessions, { ...current.savedSessions[0], id: 'new', streams: [feed('eeeeeeeeeee', 'E')] }] });
  assert.equal(smuggled.status, 403);
  assert.equal((await put({ ...current, streams: [feed('ccccccccccc', 'C'), current.streams[1], current.streams[0]] })).status, 200, 'a saved session\'s feed comes back, and feeds reorder');
  assert.deepEqual((await (await user('/api/wall')).json()).wall.streams.map((s) => s.label), ['C', 'B', 'A']);
  assert.equal((await put({ ...current, streams: [current.streams[1]] })).status, 200, 'removing feeds');
  // A feed a user removed is gone for them: bringing it back is adding it, the admin's job.
  assert.equal((await put({ ...current, streams: [current.streams[0], current.streams[1]] })).status, 403);

  // A link made without YouTube: that user's page sees a wall with no key at all.
  const plain = await admin('/api/links', { name: 'Client review', youtube: false });
  assert.equal(plain.status, 200);
  const plainLink = (await plain.json()).links.find((l) => l.name === 'Client review');
  assert.equal(plainLink.youtube, false);
  assert.equal(link.youtube, true, 'on by default');
  const plainCookie = (await join({ link: plainLink.url })).headers.get('set-cookie').split(';')[0];
  const plainUser = (p) => fetch(`${hosted.base}${p}`, { headers: { Cookie: plainCookie } });
  assert.deepEqual((await (await plainUser('/api/config')).json()).ytKey, { set: false });
  const nothing = await (await plainUser('/api/youtube')).json();
  assert.equal(nothing.status, 'off');
  assert.deepEqual(nothing.key, { set: false });
  assert.equal(nothing.ingest, null);
  assert.deepEqual(nothing.videos, {});
  assert.equal((await plainUser('/api/youtube/history?id=aaaaaaaaaaa')).status, 403);
  assert.equal((await admin('/api/links/revoke', { id: plainLink.id })).status, 200);

  // Revoked: the link and every browser that used it stop working at once.
  assert.equal((await admin('/api/links/revoke', { id: link.id })).status, 200);
  assert.equal((await user('/api/wall')).status, 401);
  assert.equal((await join({ link: link.url })).status, 401);
  assert.deepEqual((await (await admin('/api/links')).json()).links, []);
  await admin('/api/youtube/key', { key: '' });
});

test('a session cookie can\'t be edited from user to admin', async () => {
  const made = await fetch(`${hosted.base}/api/links`, { method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify({ name: 'Edit test', days: 7 }) });
  const [link] = (await made.json()).links;
  assert.ok(Date.parse(link.expiresAt) > Date.now() + 6 * 86400e3);
  const joined = await fetch(`${hosted.base}/api/join`, { method: 'POST', headers: { 'X-IXG-Wall': '1' }, body: JSON.stringify({ link: link.url }) });
  const userCookie = joined.headers.get('set-cookie').split(';')[0];
  const promoted = userCookie.replace('.user.', '.admin.').replace(/\.[a-f0-9]{12}\./, '.-.');
  assert.equal((await fetch(`${hosted.base}/api/links`, { headers: { Cookie: promoted } })).status, 401);
  await fetch(`${hosted.base}/api/links/revoke`, { method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify({ id: link.id }) });
});

test('hosted: no wall window, and telemetry is only a heartbeat', async () => {
  const res = await fetch(`${hosted.base}/api/wall-browser`, {
    method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }), body: JSON.stringify({ action: 'launch' }),
  });
  assert.equal(res.status, 404);
  await new Promise((r) => setTimeout(r, 2500)); // one telemetry interval
  const status = await (await fetch(`${hosted.base}/api/status`, { headers: headers() })).json();
  assert.equal(status.telemetry.agent, 'hosted');
  assert.equal(status.telemetry.cpu, undefined);
  assert.deepEqual(status.browser, { supported: false, hosted: true });
});

test('sign-out clears the cookie', async () => {
  const res = await fetch(`${hosted.base}/api/logout`, { method: 'POST', headers: headers({ 'X-IXG-Wall': '1' }) });
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('repeated wrong passwords are locked out for a while', async () => {
  const attempt = () => fetch(`${hosted.base}/api/login`, {
    method: 'POST', headers: { 'X-IXG-Wall': '1', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ password: 'guess' }),
  });
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await attempt()).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
});

test('laptop mode: no sign-in, as before', async () => {
  const laptop = await startServer({ vars: {} });
  assert.equal((await fetch(`${laptop.base}/`)).status, 200);
  const config = await (await fetch(`${laptop.base}/api/config`)).json();
  assert.equal(config.hosted, false);
  assert.equal(config.auth, false);
  assert.equal(config.role, 'admin');
  assert.equal((await fetch(`${laptop.base}/login`, { redirect: 'manual' })).status, 302);
  // Without a password everyone is already an admin, so there's nothing for a link to grant.
  const link = await fetch(`${laptop.base}/api/links`, { method: 'POST', headers: { 'X-IXG-Wall': '1' }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(link.status, 409);
});
