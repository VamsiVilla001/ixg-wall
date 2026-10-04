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
  assert.equal((await fetch(`${laptop.base}/login`, { redirect: 'manual' })).status, 302);
});
