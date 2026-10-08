// Google Drive (backend/gdrive.js) and OneDrive (backend/onedrive.js) as screenshot
// destinations, against a fake Google and a fake Microsoft: folder links checked before
// they're saved, the session/date/feed folders made once and reused, uploads retried on a
// hiccup and not on a dead folder, big files by upload session.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-dest-'));
const fake = { folders: new Map(), creates: 0, uploads: [], flaky: 0, graph: [], msTokens: [] };
let base;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    // ---- Google Drive ----
    if (p === '/gtoken') {
      const params = new URLSearchParams(raw.toString());
      return json(200, { access_token: `g-access-${params.get('grant_type')}`, expires_in: 3600 });
    }
    if (p === '/drive/about') return json(200, { user: { emailAddress: 'ops@tesseract.gg' } });
    if (p.startsWith('/drive/files/')) {
      const id = decodeURIComponent(p.slice('/drive/files/'.length));
      if (id === 'FOLDER1234567') return json(200, { id, name: 'IXG Screenshots', mimeType: 'application/vnd.google-apps.folder', webViewLink: 'https://drive.google.com/drive/folders/FOLDER1234567', capabilities: { canAddChildren: true } });
      if (id === 'FILE12345678') return json(200, { id, name: 'notes.txt', mimeType: 'text/plain' });
      if (id === 'READONLY1234') return json(200, { id, name: 'Locked', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: false } });
      return json(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } });
    }
    if (p === '/drive/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const m = /'([^']+)' in parents and name = '((?:[^'\\]|\\.)*)'/.exec(q);
      if (m && m[1] === 'NOPE1234567') return json(404, { error: { code: 404, message: 'File not found: NOPE1234567', errors: [{ reason: 'notFound' }] } });
      const key = m && `${m[1]}/${m[2].replace(/\\(.)/g, '$1')}`;
      const id = key && fake.folders.get(key);
      return json(200, { files: id ? [{ id }] : [] });
    }
    if (p === '/drive/files' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      if (body.parents[0] === 'NOPE1234567') return json(404, { error: { code: 404, message: 'File not found: NOPE1234567', errors: [{ reason: 'notFound' }] } });
      fake.creates += 1;
      const id = `f${fake.creates}`;
      fake.folders.set(`${body.parents[0]}/${body.name}`, id);
      return json(200, { id });
    }
    if (p === '/driveup/files' && req.method === 'POST') {
      if (fake.flaky > 0) { fake.flaky -= 1; return json(503, { error: { message: 'Backend Error' } }); }
      const text = raw.toString('latin1');
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)[1]);
      fake.uploads.push({ ...meta, bytes: raw.length, auth: req.headers.authorization, type: req.headers['content-type'] });
      return json(200, { id: `u${fake.uploads.length}`, name: meta.name });
    }
    // ---- Microsoft ----
    if (p === '/mstoken') {
      const params = new URLSearchParams(raw.toString());
      fake.msTokens.push(Object.fromEntries(params));
      if (params.get('client_secret') !== 'ms-secret-value') return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      if (params.get('client_id') === '00000000-0000-0000-0000-000000000000') return json(400, { error: 'unauthorized_client', error_description: 'AADSTS700016: Application with identifier was not found in the directory.' });
      if (params.get('grant_type') === 'authorization_code') {
        if (params.get('code') !== 'ms-code') return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided authorization code is malformed or invalid.' });
        return json(200, { access_token: 'ms-access-1', refresh_token: 'ms-refresh-1', expires_in: 3600 });
      }
      if (params.get('grant_type') === 'refresh_token') return json(200, { access_token: 'ms-access-2', refresh_token: 'ms-refresh-2', expires_in: 3600 });
      return json(400, { error: 'invalid_request' });
    }
    if (p.startsWith('/graph/')) {
      if (!/^Bearer ms-access-/.test(req.headers.authorization || '')) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'no' } });
      fake.graph.push({ method: req.method, path: p, range: req.headers['content-range'], bytes: raw.length, type: req.headers['content-type'] });
      if (p === '/graph/me') return json(200, { userPrincipalName: 'ops@tesseract.onmicrosoft.com' });
      const share = /^\/graph\/shares\/([^/]+)\/driveItem$/.exec(p);
      if (share) {
        const link = Buffer.from(share[1].slice(2).replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString();
        if (link.includes('folder')) return json(200, { id: 'item1', name: 'IXG Screenshots', folder: { childCount: 0 }, webUrl: 'https://tesseract-my.sharepoint.com/personal/ops/Documents/IXG%20Screenshots', parentReference: { driveId: 'drive1' } });
        if (link.includes('file')) return json(200, { id: 'item2', name: 'notes.txt', file: {}, parentReference: { driveId: 'drive1' } });
        return json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } });
      }
      if (/\/items\/item1:\/.+:\/content$/.test(p) && req.method === 'PUT') return json(201, { id: 'new', name: 'x' });
      if (/\/items\/item1:\/.+:\/createUploadSession$/.test(p) && req.method === 'POST') return json(200, { uploadUrl: `${base}/graph/upload/session1` });
      if (p === '/graph/upload/session1' && req.method === 'PUT') return json(201, { id: 'big' });
      if (/\/items\/gone:/.test(p)) return json(404, { error: { code: 'itemNotFound', message: 'gone' } });
      return json(404, { error: { code: 'itemNotFound', message: `no route ${p}` } });
    }
    json(404, {});
  });
}).listen(0, '127.0.0.1');
const ready = new Promise((r) => server.once('listening', r)).then(() => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.IXG_GDRIVE_API = `${base}/drive`;
  process.env.IXG_GDRIVE_UPLOAD = `${base}/driveup`;
  process.env.IXG_GOOGLE_REVOKE_URL = `${base}/grevoke`;
  process.env.IXG_MS_TOKEN_URL = `${base}/mstoken`;
  process.env.IXG_MS_AUTH_URL = `${base}/msauth`;
  process.env.IXG_GRAPH_API = `${base}/graph`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The storage the modules use, as secrets.js keeps it, in memory.
function fakeSecrets() {
  const d = {};
  return {
    gdrive: () => d.gdrive || null,
    setGdrive: (v) => { if (v) d.gdrive = v; else delete d.gdrive; },
    onedrive: () => d.onedrive || null,
    setOnedrive: (v) => { if (v) d.onedrive = v; else delete d.onedrive; },
    msClient: () => d.msClient || null,
    msClientInfo: () => ({ set: !!d.msClient, source: d.msClient ? 'saved' : null, clientId: d.msClient?.clientId || '' }),
    setMsClient: (c) => { if (c) d.msClient = c; else delete d.msClient; return true; },
  };
}

let shotFile;
before(async () => {
  await ready;
  shotFile = path.join(dir, 'shot.png');
  fs.writeFileSync(shotFile, Buffer.alloc(1000, 1));
});

test('Google Drive: the sign-in keeps the account, the folder link is checked, and the test file lands in the folder', async () => {
  const { GoogleDrive, folderIdFrom } = require('../backend/gdrive');
  assert.equal(folderIdFrom('https://drive.google.com/drive/folders/FOLDER1234567?usp=sharing'), 'FOLDER1234567');
  assert.equal(folderIdFrom('FOLDER1234567'), 'FOLDER1234567');
  assert.equal(folderIdFrom('https://drive.google.com/file/d/abc'), null);
  const credentials = { tokenRequest: async (params) => (await fetch(`${base}/gtoken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })).json() };
  const drive = new GoogleDrive({ secrets: fakeSecrets(), credentials });
  assert.equal(drive.configured(), false);
  assert.equal((await drive.setFolder('https://drive.google.com/drive/folders/FOLDER1234567')).status, 409, 'sign in first');
  assert.equal(await drive.finish({ access_token: 'g-access-code', refresh_token: 'g-refresh', expires_in: 3600 }), 'ops@tesseract.gg');
  assert.equal(drive.info().email, 'ops@tesseract.gg');
  assert.equal((await drive.setFolder('not a link')).status, 400);
  assert.match((await drive.setFolder('https://drive.google.com/drive/folders/FILE12345678')).error, /file, not a folder/);
  assert.match((await drive.setFolder('https://drive.google.com/drive/folders/NOPE1234567')).error, /no such folder/);
  assert.match((await drive.setFolder('https://drive.google.com/drive/folders/READONLY1234')).error, /can't write/);
  const ok = await drive.setFolder('https://drive.google.com/drive/folders/FOLDER1234567');
  assert.equal(ok.status, 200);
  assert.equal(drive.info().folder.name, 'IXG Screenshots');
  assert.equal(drive.configured(), true);
  const t = await drive.test();
  assert.equal(t.ok, true, t.message);
  assert.deepEqual(fake.uploads.at(-1).parents, ['FOLDER1234567']);
  assert.match(fake.uploads.at(-1).name, /^IXG Wall test /);
  assert.match(fake.uploads.at(-1).type, /^multipart\/related; boundary=/);
  assert.ok(!JSON.stringify(drive.info()).includes('g-refresh'), 'never the token');
});

test('Google Drive: session/date/feed folders are made once and reused; a hiccup is retried, a dead folder is not', async () => {
  const { GoogleDrive } = require('../backend/gdrive');
  const secrets = fakeSecrets();
  secrets.setGdrive({ refreshToken: 'g-refresh', email: 'ops@tesseract.gg', folderId: 'FOLDER1234567', folderName: 'IXG Screenshots', enabled: true });
  const credentials = { tokenRequest: async () => ({ access_token: 'g-access-refresh', expires_in: 3600 }) };
  const drive = new GoogleDrive({ secrets, credentials });
  drive.waits = [20, 20];
  const before = fake.creates;
  const first = await drive.post({ file: shotFile, relPath: 'Krafton SF Day 1/2026-10-08/Hindi Day 1/[Hindi] - x.png' });
  assert.deepEqual(first, { ok: true, tries: 1 });
  assert.equal(fake.creates - before, 3, 'session, day and feed folders made');
  assert.deepEqual(fake.uploads.at(-1).parents, ['f3']);
  assert.equal(fake.uploads.at(-1).name, '[Hindi] - x.png');
  fake.flaky = 1;
  const second = await drive.post({ file: shotFile, relPath: 'Krafton SF Day 1/2026-10-08/Hindi Day 1/[Hindi] - y.png' });
  assert.deepEqual(second, { ok: true, tries: 2 }, 'one 503, then through');
  assert.equal(fake.creates - before, 3, 'the folders were remembered, not made again');
  const other = await drive.post({ file: shotFile, relPath: 'Krafton SF Day 1/2026-10-08/English Day 1/[English] - x.png' });
  assert.equal(other.ok, true);
  assert.equal(fake.creates - before, 4, 'only the new feed folder');
  secrets.setGdrive({ ...secrets.gdrive(), folderId: 'NOPE1234567' });
  drive.folders.clear();
  const dead = await drive.post({ file: shotFile, relPath: 'a/b.png' });
  assert.equal(dead.ok, false);
  assert.equal(dead.tries, 1, 'a folder that is gone is not worth retrying');
  const gone = await drive.post({ file: path.join(dir, 'missing.png'), relPath: 'a/b.png' });
  assert.deepEqual([gone.ok, gone.tries], [false, 1]);
});

test('OneDrive: the app is checked with Microsoft, the sign-in keeps the account, the sharing link is checked', async () => {
  const { OneDrive, shareId } = require('../backend/onedrive');
  assert.equal(shareId('https://1drv.ms/f/s!abc'), `u!${Buffer.from('https://1drv.ms/f/s!abc').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`);
  const od = new OneDrive({ secrets: fakeSecrets(), publicUrl: 'https://wall.example.com' });
  assert.equal(od.redirectUri, 'https://wall.example.com/api/onedrive/callback');
  assert.equal((await od.saveClient({ clientId: 'nope', clientSecret: 'x' })).status, 400);
  const wrong = await od.saveClient({ clientId: '12345678-1234-1234-1234-123456789abc', clientSecret: 'wrong-secret' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.error, /client secret/);
  const unknown = await od.saveClient({ clientId: '00000000-0000-0000-0000-000000000000', clientSecret: 'ms-secret-value' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.error, /no app with this client ID/);
  const saved = await od.saveClient({ clientId: '12345678-1234-1234-1234-123456789abc', clientSecret: 'ms-secret-value' });
  assert.equal(saved.status, 200);
  assert.equal(saved.check.status, 'ok');
  assert.equal(od.info().client.clientId, '12345678-1234-1234-1234-123456789abc');
  const authUrl = new URL(od.authUrl());
  assert.equal(authUrl.searchParams.get('scope'), 'offline_access Files.ReadWrite User.Read');
  assert.equal(authUrl.searchParams.get('redirect_uri'), od.redirectUri);
  const state = authUrl.searchParams.get('state');
  await assert.rejects(od.finish({ code: 'ms-code', state: 'forged' }), /expired or was already used/);
  assert.equal(await od.finish({ code: 'ms-code', state }), 'ops@tesseract.onmicrosoft.com');
  assert.equal(od.info().signedIn, true);
  assert.equal((await od.setFolder('https://example.com/not-onedrive')).status, 400);
  assert.match((await od.setFolder('https://tesseract-my.sharepoint.com/:t:/g/personal/ops/file')).error, /file, not a folder/);
  assert.match((await od.setFolder('https://1drv.ms/f/s!nothing')).error, /no such folder/);
  const ok = await od.setFolder('https://tesseract-my.sharepoint.com/:f:/g/personal/ops/folder?e=abc');
  assert.equal(ok.status, 200, ok.error);
  assert.equal(od.info().folder.name, 'IXG Screenshots');
  assert.equal(od.configured(), true);
  assert.ok(!JSON.stringify(od.info()).includes('ms-secret-value') && !JSON.stringify(od.info()).includes('ms-refresh'), 'never the secret or a token');
});

test('OneDrive: a screenshot is PUT by path (folders made on the way), a big one goes by upload session, a dead folder is not retried', async () => {
  const { OneDrive } = require('../backend/onedrive');
  const secrets = fakeSecrets();
  secrets.setMsClient({ clientId: '12345678-1234-1234-1234-123456789abc', clientSecret: 'ms-secret-value' });
  secrets.setOnedrive({ refreshToken: 'ms-refresh-1', account: 'ops@tesseract.onmicrosoft.com', driveId: 'drive1', itemId: 'item1', folderName: 'IXG Screenshots', enabled: true });
  const od = new OneDrive({ secrets, publicUrl: 'https://wall.example.com' });
  od.waits = [20, 20];
  fake.graph.length = 0;
  const small = await od.post({ file: shotFile, relPath: 'Krafton SF Day 1\\2026-10-08\\Hindi Day 1\\[Hindi] - x.png' });
  assert.deepEqual(small, { ok: true, tries: 1 });
  const put = fake.graph.find((g) => g.method === 'PUT');
  assert.equal(put.path, '/graph/drives/drive1/items/item1:/Krafton%20SF%20Day%201/2026-10-08/Hindi%20Day%201/%5BHindi%5D%20-%20x.png:/content');
  assert.equal(put.bytes, 1000);
  assert.equal(put.type, 'image/png');
  assert.equal(secrets.onedrive().refreshToken, 'ms-refresh-2', 'Microsoft rotates the refresh token: the new one is kept');
  const bigFile = path.join(dir, 'big.png');
  fs.writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024, 2));
  fake.graph.length = 0;
  assert.equal((await od.post({ file: bigFile, relPath: 'S/big.png' })).ok, true);
  assert.deepEqual(fake.graph.map((g) => g.method), ['POST', 'PUT'], 'an upload session, then the bytes');
  assert.equal(fake.graph[1].range, `bytes 0-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
  secrets.setOnedrive({ ...secrets.onedrive(), itemId: 'gone' });
  const dead = await od.post({ file: shotFile, relPath: 'a/b.png' });
  assert.deepEqual([dead.ok, dead.tries], [false, 1]);
  assert.match(dead.error, /no such folder/);
  await od.signOut();
  assert.equal(od.configured(), false);
});
