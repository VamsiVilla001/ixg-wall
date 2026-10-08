// Sessions (backend/session-store.js): any number live at once, each with its own feeds,
// version and address; a wall from before sessions is read into the new shape; archived
// sessions keep their feeds, and only those can be deleted.   npm test
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
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir, IXG_YOUTUBE_API: 'http://127.0.0.1:9', IXG_SERVER_CAPTURE: '0' },
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

const api = (p, opts) => fetch(`${base}${p}`, opts);
const json = async (p) => (await api(p)).json();
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify(body || {}) });
const getWall = async (id) => (await json(`/api/wall${id ? `?session=${id}` : ''}`)).wall;
const putWall = (wall, id) => api(`/api/wall${id ? `?session=${id}` : ''}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' }, body: JSON.stringify({ wall }),
});

test('a wall from before sessions becomes an archived session; a new live one is the default', async () => {
  const wall = await getWall();
  assert.deepEqual(wall.streams, [], 'earlier feeds must not load');
  assert.equal(wall.session.name, 'New session');
  assert.equal(wall.session.live, true);
  const archived = wall.sessions.filter((s) => !s.live);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].name, 'Before sessions');
  assert.equal(archived[0].feeds, 2);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'wall.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk.sessions), 'written in the new shape, so a restart doesn\'t redo it');
  // The bare address goes to the default live session; an unknown one goes back there.
  const home = await api('/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), `/s/${wall.session.id}`);
  assert.equal((await api(`/s/${wall.session.id}`)).status, 200);
  assert.equal((await api('/s/nope', { redirect: 'manual' })).headers.get('location'), '/');
});

test('several sessions live at once, each with its own feeds, version and wall', async () => {
  const a = (await getWall()).session;
  const made = await (await post('/api/sessions', { name: 'BMSD Day 4', timeZone: 'Asia/Kolkata' })).json();
  const b = made.session;
  assert.ok(b.id && b.id !== a.id);
  assert.equal((await putWall({ settings: {}, session: { name: a.name }, streams: OLD_FEEDS.slice(0, 1) }, a.id)).status, 200);
  assert.equal((await putWall({ settings: { ytPollSec: 15 }, session: { name: 'BMSD Day 4' }, streams: OLD_FEEDS.slice(1) }, b.id)).status, 200);
  const wa = await getWall(a.id);
  const wb = await getWall(b.id);
  assert.deepEqual(wa.streams.map((s) => s.label), ['Hindi Test Main']);
  assert.deepEqual(wb.streams.map((s) => s.label), ['English Test Main']);
  assert.equal(wb.session.timeZone, 'Asia/Kolkata');
  assert.equal(wa.sessions.filter((s) => s.live).length, 2);
  // Each session's wall has its own version: a save to one doesn't move the other's.
  const va = (await json(`/api/wall?session=${a.id}`)).version;
  assert.equal((await putWall({ ...wb, streams: [] }, b.id)).status, 200);
  assert.equal((await json(`/api/wall?session=${a.id}`)).version, va);
  const list = await json('/api/sessions');
  assert.deepEqual(list.sessions.map((s) => [s.name, s.live, s.feeds]).sort(), [['BMSD Day 4', true, 0], ['Before sessions', false, 2], ['New session', true, 1]]);
  assert.equal(list.current, b.id, 'the default is the live session started most recently');
  assert.equal((await api('/', { redirect: 'manual' })).headers.get('location'), `/s/${b.id}`);
});

test('archived: kept and deletable, not live; reopened: live again with its feeds; a live session can\'t be deleted', async () => {
  const list = (await json('/api/sessions')).sessions;
  const b = list.find((s) => s.name === 'BMSD Day 4');
  const before = list.find((s) => s.name === 'Before sessions');
  assert.equal((await post('/api/sessions/delete', { id: b.id })).status, 409, 'live: archive it first');
  assert.equal((await post('/api/sessions/archive', { id: b.id })).status, 200);
  assert.equal((await post('/api/sessions/archive', { id: b.id })).status, 409, 'already archived');
  const wb = await getWall(b.id);
  assert.equal(wb.session.live, false);
  assert.ok(wb.session.endedAt);
  assert.equal((await post('/api/sessions/reopen', { id: before.id })).status, 200);
  const reopened = await getWall(before.id);
  assert.equal(reopened.session.live, true);
  assert.deepEqual(reopened.streams.map((s) => s.label), ['Hindi Test Main', 'English Test Main'], 'its feeds came back with it');
  assert.equal((await post('/api/sessions/delete', { id: b.id })).status, 200);
  assert.equal((await api(`/api/wall?session=${b.id}`)).status, 404);
  assert.equal((await post('/api/sessions/delete', { id: 'nope' })).status, 409);
});

test('a page from before sessions can\'t save over a session', async () => {
  const current = await getWall();
  assert.equal((await putWall({ settings: current.settings, streams: OLD_FEEDS.slice(0, 1) })).status, 409);
  assert.equal((await getWall()).streams.length, current.streams.length, 'untouched');
});

test('renames and stamps are saved with the wall; a bad name or wall is rejected', async () => {
  const current = await getWall();
  assert.equal((await putWall({ ...current, session: { ...current.session, name: 'Finals' } })).status, 200);
  assert.equal((await getWall()).session.name, 'Finals');
  assert.equal((await putWall({ ...current, session: { ...current.session, name: '' } })).status, 400);
  assert.equal((await putWall({ ...current, session: { ...current.session, name: 'x'.repeat(81) } })).status, 400);
  assert.equal((await putWall({ ...current, streams: [{ id: 'bad' }] })).status, 400);
  assert.equal((await putWall({ ...current, settings: [] })).status, 400);
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
