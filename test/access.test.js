// Microsoft 365 sign-in (backend/accounts.js) on a hosted wall, against a fake Microsoft: the
// sign-in page offers it once the Microsoft app is set, a listed account gets its role, an
// unlisted one is refused, the organisation switch lets its own accounts in as operators,
// and removing an account or turning the switch off signs them out.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery';
const TENANT = 't-tesseract';
const PEOPLE = {
  'code-boss': { email: 'boss@tesseract.gg', name: 'The Boss', tid: TENANT },
  'code-sam': { email: 'sam@tesseract.gg', name: 'Sam', tid: TENANT },
  'code-tina': { email: 'tina@tesseract.gg', name: 'Tina', tid: TENANT },
  'code-out': { email: 'out@elsewhere.com', name: 'Outsider', tid: 't-other' },
};
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let fake;
let wall;
let dataDir;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function fakeMicrosoft() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/auth') { res.writeHead(200); return res.end('sign-in page'); }
      if (url.pathname === '/token') {
        const p = new URLSearchParams(raw);
        if (p.get('client_secret') !== 'ms-secret-value') return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        const who = PEOPLE[p.get('code')];
        if (!who) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided authorization code is malformed or invalid.' });
        return json(200, { access_token: `access-${p.get('code')}`, id_token: `h.${b64url({ preferred_username: who.email, tid: who.tid })}.s`, expires_in: 3600 });
      }
      if (url.pathname === '/graph/me') {
        const code = /^Bearer access-(.+)$/.exec(req.headers.authorization || '')?.[1];
        const who = PEOPLE[code];
        if (!who) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'no' } });
        return json(200, { userPrincipalName: who.email, mail: who.email, displayName: who.name });
      }
      json(404, {});
    });
  });
}

before(async () => {
  fake = fakeMicrosoft().listen(await freePort(), '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const m = `http://127.0.0.1:${fake.address().port}`;
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-access-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir,
      IXG_HOSTED: '1', IXG_PASSWORD: PASSWORD, PUBLIC_URL: 'https://wall.example.com', IXG_ADMINS: 'Boss@Tesseract.gg',
      MS_CLIENT_ID: '12345678-1234-1234-1234-123456789abc', MS_CLIENT_SECRET: 'ms-secret-value',
      IXG_MS_AUTH_URL: `${m}/auth`, IXG_MS_TOKEN_URL: `${m}/token`, IXG_GRAPH_API: `${m}/graph`,
      IXG_YOUTUBE_API: 'http://127.0.0.1:9', IXG_SERVER_CAPTURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('IXG Wall running')) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error(out)));
  });
  wall = { child, base: `http://127.0.0.1:${port}` };
});

after(async () => {
  await new Promise((r) => { if (wall.child.exitCode != null) r(); else { wall.child.once('exit', r); wall.child.kill(); } });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fake.close();
});

// The sign-in round trip for one person: where the browser ends up, and the cookie it gets.
async function signIn(code, next = '/') {
  const start = await fetch(`${wall.base}/api/auth/microsoft/start?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('redirect_uri'), 'https://wall.example.com/api/auth/microsoft/callback');
  assert.equal(to.searchParams.get('scope'), 'openid profile email User.Read');
  const back = await fetch(`${wall.base}/api/auth/microsoft/callback?code=${code}&state=${to.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(back.status, 302);
  const location = back.headers.get('location');
  const cookie = back.headers.get('set-cookie')?.split(';')[0] || null;
  return { location, cookie, as: (p, opts = {}) => fetch(`${wall.base}${p}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-IXG-Wall': '1', ...(opts.headers || {}) }, redirect: 'manual' }) };
}

test('the sign-in page offers Microsoft; an admin from IXG_ADMINS gets in as an admin, to where they were going', async () => {
  assert.deepEqual(await (await fetch(`${wall.base}/api/login/options`)).json(), { password: true, microsoft: true });
  const boss = await signIn('code-boss', '/admin');
  assert.equal(boss.location, '/admin');
  assert.ok(boss.cookie, 'a session cookie');
  const config = await (await boss.as('/api/config')).json();
  assert.equal(config.role, 'admin');
  assert.equal(config.access.enabled, true);
  assert.deepEqual(config.access.accounts.map((a) => [a.email, a.role, a.source]), [['boss@tesseract.gg', 'admin', 'env']]);
  assert.equal(config.access.tenantId, TENANT, 'the organisation, noted from the admin\'s sign-in');
  assert.equal((await boss.as('/admin')).status, 200);
  assert.equal((await fetch(`${wall.base}/api/auth/microsoft/callback?code=code-boss&state=forged`, { redirect: 'manual' })).headers.get('location').startsWith('/login?error='), true, 'a forged callback is refused');
});

test('an unlisted account is refused with the reason; listed, it gets its role; removed, it\'s signed out', async () => {
  const refused = await signIn('code-sam');
  assert.equal(refused.cookie, null);
  assert.match(decodeURIComponent(refused.location), /^\/login\?error=sam@tesseract\.gg isn't allowed in/);
  const boss = await signIn('code-boss');
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'nope', role: 'operator' }) })).status, 400);
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'Sam@Tesseract.gg', role: 'boss' }) })).status, 400);
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'Sam@Tesseract.gg', role: 'operator' }) })).status, 200);
  const sam = await signIn('code-sam', '/s/whatever');
  assert.equal(sam.location, '/s/whatever');
  const samConfig = await (await sam.as('/api/config')).json();
  assert.equal(samConfig.role, 'operator');
  assert.equal(samConfig.canOperate, true);
  assert.equal(samConfig.access, null, 'an operator sees no allow-list');
  assert.equal((await sam.as('/api/accounts')).status, 403);
  assert.equal((await sam.as('/admin')).headers.get('location'), '/');
  // Role changed: the next request carries the new role.
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'sam@tesseract.gg', role: 'admin' }) })).status, 200);
  assert.equal((await sam.as('/api/config')).status, 401, 'the old session was for an operator: sign in again');
  const samAgain = await signIn('code-sam');
  assert.equal((await (await samAgain.as('/api/config')).json()).role, 'admin');
  const listed = (await (await boss.as('/api/accounts')).json()).access.accounts;
  const samRow = listed.find((a) => a.email === 'sam@tesseract.gg');
  assert.ok(samRow.lastSignIn, 'the last sign-in is noted');
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: samRow.id }) })).status, 200);
  assert.equal((await samAgain.as('/api/config')).status, 401, 'removed: signed out on the next request');
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: samRow.id }) })).status, 404);
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: listed[0].id }) })).status, 404, 'an env admin can\'t be removed here');
});

test('the organisation switch lets its own accounts in as operators, and no one else; off, they\'re out', async () => {
  const boss = await signIn('code-boss');
  assert.equal((await signIn('code-tina')).cookie, null, 'unlisted, switch off');
  assert.equal((await boss.as('/api/accounts/tenant', { method: 'POST', body: JSON.stringify({ on: true }) })).status, 200);
  const tina = await signIn('code-tina');
  assert.ok(tina.cookie);
  assert.equal((await (await tina.as('/api/config')).json()).role, 'operator');
  const out = await signIn('code-out');
  assert.equal(out.cookie, null, 'another organisation');
  assert.match(decodeURIComponent(out.location), /isn't allowed in/);
  assert.equal((await boss.as('/api/accounts/tenant', { method: 'POST', body: JSON.stringify({ on: false }) })).status, 200);
  assert.equal((await tina.as('/api/config')).status, 401, 'switch off: signed out');
  // The password sign-in is still there, as the fallback.
  const pw = await fetch(`${wall.base}/api/login`, { method: 'POST', headers: { 'X-IXG-Wall': '1', Origin: 'https://wall.example.com' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(pw.status, 200);
});

test('Microsoft is the main sign-in: an admin can switch the password off, and the sign-in page stops offering it', async () => {
  const boss = await signIn('code-boss');
  const password = () => fetch(`${wall.base}/api/login`, { method: 'POST', headers: { 'X-IXG-Wall': '1', Origin: 'https://wall.example.com' }, body: JSON.stringify({ password: PASSWORD }) });
  const options = async () => (await fetch(`${wall.base}/api/login/options`)).json();
  assert.equal((await (await boss.as('/api/accounts')).json()).access.passwordSignIn, true, 'on to begin with');
  assert.equal((await boss.as('/api/accounts/password', { method: 'POST', body: JSON.stringify({ on: false }) })).status, 200);
  assert.deepEqual(await options(), { password: false, microsoft: true });
  assert.equal((await (await boss.as('/api/accounts')).json()).access.passwordSignIn, false);
  const refused = await password();
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /sign in with Microsoft/);
  assert.ok((await signIn('code-boss')).cookie, 'Microsoft still gets the admin in');
  assert.equal((await boss.as('/api/accounts/password', { method: 'POST', body: JSON.stringify({ on: true }) })).status, 200);
  assert.deepEqual(await options(), { password: true, microsoft: true });
  assert.equal((await password()).status, 200, 'back on');
  // The page (login.html) leads with Microsoft and keeps the password behind "other ways".
  const page = await (await fetch(`${wall.base}/login`)).text();
  assert.ok(page.indexOf('id="microsoft"') < page.indexOf('id="form"'), 'the Microsoft button comes first');
  assert.match(page, /id="use-password"/);
});
