// Sessions in the stored wall (backend/wall-store.js): only the active session's feeds load,
// a wall from before sessions starts empty with its feeds saved, and pages from before
// sessions can't wipe the saved ones.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let child;
let base;
let dataDir;

const feed = (id, label) => ({ id: `s-${id}`, source: { kind: 'video', id }, label });
const OLD_FEEDS = [feed('x-qOOPXB_lg', 'Hindi Test Main'), feed('2QK4W5bngD0', 'English Test Main')];

before(async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-sessions-'));
  // A wall.json written before sessions existed.
  fs.writeFileSync(path.join(dataDir, 'wall.json'), JSON.stringify({
    version: 7, savedAt: '2026-10-03T18:37:32.120Z', wall: { settings: { ytPollSec: 30 }, streams: OLD_FEEDS },
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir, IXG_YOUTUBE_API: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('IXG Wall running')) resolve(); });
    child.on('exit', () => reject(new Error(out)));
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => { child.once('exit', r); child.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const getWall = async () => (await (await fetch(`${base}/api/wall`)).json()).wall;
const putWall = (wall) => fetch(`${base}/api/wall`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify({ wall }),
});

test('a wall from before sessions starts empty, its feeds saved as a session', async () => {
  const wall = await getWall();
  assert.deepEqual(wall.streams, [], 'earlier feeds must not load');
  assert.equal(wall.session.name, 'New session');
  assert.equal(wall.savedSessions.length, 1);
  assert.equal(wall.savedSessions[0].name, 'Before sessions');
  assert.deepEqual(wall.savedSessions[0].streams.map((s) => s.label), ['Hindi Test Main', 'English Test Main']);
  // The migration is written to disk, so a restart doesn't redo it.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'wall.json'), 'utf8'));
  assert.ok(onDisk.wall.session);
});

test('only the active session is polled, and switching sessions is just a save', async () => {
  const wall = await getWall();
  const opened = wall.savedSessions[0];
  const next = {
    settings: wall.settings,
    session: { id: opened.id, name: opened.name, startedAt: opened.startedAt },
    streams: opened.streams,
    savedSessions: [],
  };
  assert.equal((await putWall(next)).status, 200);
  const after2 = await getWall();
  assert.equal(after2.session.name, 'Before sessions');
  assert.equal(after2.streams.length, 2);
});

test('a page from before sessions can\'t put its old feeds back', async () => {
  const current = await getWall();
  const withSaved = { ...current, savedSessions: [{ id: 'old', name: 'BMSD Day 3', startedAt: null, endedAt: null, streams: OLD_FEEDS }] };
  assert.equal((await putWall(withSaved)).status, 200);
  // An old page sends only settings and its (old) feeds.
  const res = await putWall({ settings: current.settings, streams: OLD_FEEDS.slice(0, 1) });
  assert.equal(res.status, 409);
  const wall = await getWall();
  assert.equal(wall.session.name, 'Before sessions');
  assert.equal(wall.streams.length, 2, 'the active session is untouched');
  assert.deepEqual(wall.savedSessions.map((s) => s.name), ['BMSD Day 3']);
});

test('sessions keep their local time zone and stamps', async () => {
  const current = await getWall();
  const stamped = { ...current, session: { ...current.session, startedAt: '2026-10-04T09:08:06.296Z', timeZone: 'Asia/Kolkata' } };
  assert.equal((await putWall(stamped)).status, 200);
  assert.equal((await getWall()).session.timeZone, 'Asia/Kolkata');
  assert.equal((await putWall({ ...current, session: { ...current.session, timeZone: 'x'.repeat(65) } })).status, 400);
});

test('malformed sessions are rejected', async () => {
  const current = await getWall();
  assert.equal((await putWall({ ...current, session: { id: 1, name: 'x' } })).status, 400);
  assert.equal((await putWall({ ...current, savedSessions: [{ id: 'a', name: 'x', streams: [{ id: 'bad' }] }] })).status, 400);
  assert.equal((await putWall({ ...current, savedSessions: Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, name: 'x', streams: [] })) })).status, 400);
});

test('a feed keeps its own quality; anything but 480p, 720p or 1080p is rejected', async () => {
  const wall = await getWall();
  const streams = [{ ...feed('x-qOOPXB_lg', 'Hindi Test Main'), quality: 'hd720' }, feed('2QK4W5bngD0', 'English Test Main')];
  assert.equal((await putWall({ ...wall, streams })).status, 200);
  assert.deepEqual((await getWall()).streams.map((s) => s.quality), ['hd720', undefined]);
  for (const quality of ['hd2160', 'tiny', 720, '']) {
    assert.equal((await putWall({ ...wall, streams: [{ ...streams[0], quality }] })).status, 400, `quality ${JSON.stringify(quality)}`);
  }
});
