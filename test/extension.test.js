// The Feed Meter extension as the wall ships it (backend/extension.js): a fixed ID from the
// manifest's key, its version for the page's install check, and a valid zip to download.
//   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { extensionId } = require('../backend/extension');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
let child;
let base;
let dataDir;

before(async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-extension-'));
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

test('the manifest pins the extension ID and lets wall pages see it', () => {
  assert.ok(manifest.key, 'manifest.key fixes the ID on every computer');
  assert.equal(extensionId(manifest.key), 'knlkonhkiknjnnfgalmkdfadkjaiidfe');
  const war = manifest.web_accessible_resources?.[0];
  assert.deepEqual(war.resources, ['manifest.json']);
});

test('the page learns the ID, version and download from /api/config', async () => {
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.extension, {
    ids: ['knlkonhkiknjnnfgalmkdfadkjaiidfe'],
    version: manifest.version,
    download: '/extension/ixg-wall-feed-meter.zip',
    storeUrl: null,
  });
});

// Reads a zip's central directory and checks each file against the extension folder.
test('the download is a valid zip of the extension, in one folder', async () => {
  const res = await fetch(`${base}/extension/ixg-wall-feed-meter.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await res.arrayBuffer());
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    names.push(name);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    assert.deepEqual(data, fs.readFileSync(path.join(ROOT, 'extension', path.basename(name))), `${name} matches the extension folder`);
    assert.equal(crc, zlib.crc32(data), `${name} CRC`);
    at += 46 + nameLen;
  }
  assert.deepEqual(names.sort(), ['IXG Wall Feed Meter/README.md', 'IXG Wall Feed Meter/capture.js', 'IXG Wall Feed Meter/courier.js',
    'IXG Wall Feed Meter/manifest.json', 'IXG Wall Feed Meter/meter.js', 'IXG Wall Feed Meter/source-youtube.js']);
  // Everything the manifest names is in the zip, and the version the page checks matches meter.js.
  for (const f of [manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js)]) {
    assert.ok(names.includes(`IXG Wall Feed Meter/${f}`), `${f} is shipped`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'extension', 'meter.js'), 'utf8'), new RegExp(`VERSION = '${manifest.version.replace(/\\./g, '\\\\.')}'`));
});
