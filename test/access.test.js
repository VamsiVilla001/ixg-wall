// Microsoft 365 sign-in (backend/accounts.js, backend/ms-token.js) on a hosted wall, against
// a fake Microsoft Entra ID that signs real RS256 ID tokens, publishes its keys and checks
// PKCE: the sign-in page offers it once the Microsoft app is set, a listed account gets its
// role, unlisted ones, other organisations and personal accounts are refused, a token that
// doesn't check out lets nobody in, the organisation switch and Entra app roles work, an
// account keeps its access through a change of email, accounts limited to sessions see only
// those, renewal and sign-out work, and every sign-in lands in the audit.   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery';
const CLIENT_ID = '12345678-1234-1234-1234-123456789abc';
const CLIENT_SECRET = 'ms-secret-value';
const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad';
// Who each test "code" signs in as. oid is the stable Entra identity; the email can change.
const PEOPLE = {
  'code-boss': { email: 'boss@tesseract.gg', name: 'The Boss', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000001' },
  'code-sam': { email: 'sam@tesseract.gg', name: 'Sam', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000002' },
  'code-tina': { email: 'tina@tesseract.gg', name: 'Tina', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000003' },
  'code-pm': { email: 'pm@tesseract.gg', name: 'Pat Manager', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000004' },
  'code-role': { email: 'rolf@tesseract.gg', name: 'Rolf', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000005', roles: ['IXG.Operator'] },
  'code-out': { email: 'out@elsewhere.com', name: 'Outsider', tid: OTHER, oid: 'bbbbbbbb-0000-0000-0000-000000000001' },
  'code-personal': { email: 'someone@outlook.com', name: 'Personal', tid: PERSONAL, oid: 'cccccccc-0000-0000-0000-000000000001' },
  // Tokens that must not check out, for an account that is otherwise allowed (the boss).
  'code-expired': { email: 'boss@tesseract.gg', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000001', bad: 'expired' },
  'code-forged': { email: 'boss@tesseract.gg', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000001', bad: 'signature' },
  'code-aud': { email: 'boss@tesseract.gg', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000001', bad: 'audience' },
  'code-nonce': { email: 'boss@tesseract.gg', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-000000000001', bad: 'nonce' },
};
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ROGUE = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const b64url = (b) => Buffer.from(b).toString('base64url');
let fake;
let wall;
let dataDir;
let fakeBase;
const codes = new Map(); // code -> { challenge, nonce } from the authorize request

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function idToken(who, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: who.bad === 'audience' ? '00000000-0000-0000-0000-000000000000' : CLIENT_ID,
    iss: `${fakeBase}/${who.tid}/v2.0`,
    iat: now - 5, nbf: now - 5, exp: who.bad === 'expired' ? now - 3600 : now + 3600,
    tid: who.tid, oid: who.oid, preferred_username: who.email, name: who.name || '',
    nonce: who.bad === 'nonce' ? 'not-this-one' : nonce,
    ...(who.roles ? { roles: who.roles } : {}),
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), who.bad === 'signature' ? ROGUE.privateKey : KEY.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

function fakeMicrosoft() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      // The authority must be the organisation's tenant or "organizations", never "common".
      const m = /^\/([\w-]+)\/(oauth2\/v2\.0\/authorize|oauth2\/v2\.0\/token|discovery\/v2\.0\/keys)$/.exec(url.pathname);
      if (!m || !['organizations', TENANT].includes(m[1])) return json(404, { error: 'unknown authority' });
      if (m[2] === 'discovery/v2.0/keys') return json(200, { keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] });
      if (m[2] === 'oauth2/v2.0/authorize') {
        // The test says which person "signs in" (test_code); Microsoft would redirect with a code.
        codes.set(url.searchParams.get('test_code'), { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), nonce: url.searchParams.get('nonce') });
        res.writeHead(200);
        return res.end('sign-in page');
      }
      const p = new URLSearchParams(raw);
      if (p.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      const code = p.get('code');
      const who = PEOPLE[code];
      const pending = codes.get(code);
      if (!who || !pending) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided authorization code is malformed or invalid.' });
      codes.delete(code);
      const verifier = p.get('code_verifier') || '';
      if (pending.method !== 'S256' || crypto.createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.' });
      }
      return json(200, { access_token: `access-${code}`, id_token: idToken(who, pending.nonce), expires_in: 3600 });
    });
  });
}

before(async () => {
  fake = fakeMicrosoft().listen(await freePort(), '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-access-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), IXG_DATA_DIR: dataDir,
      IXG_HOSTED: '1', IXG_PASSWORD: PASSWORD, PUBLIC_URL: 'https://wall.example.com', IXG_ADMINS: 'Boss@Tesseract.gg',
      MS_CLIENT_ID: CLIENT_ID, MS_CLIENT_SECRET: CLIENT_SECRET, IXG_MS_LOGIN_URL: fakeBase,
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

const headersFor = (cookie, extra = {}) => ({ Cookie: cookie, 'Content-Type': 'application/json', 'X-IXG-Wall': '1', ...extra });
const as = (cookie) => (p, opts = {}) => fetch(`${wall.base}${p}`, { ...opts, headers: headersFor(cookie, opts.headers), redirect: 'manual' });

// The sign-in round trip for one person: where the browser ends up, and the cookie it gets.
async function signIn(code, next = '/', { silent = false } = {}) {
  const start = await fetch(`${wall.base}/api/auth/microsoft/start?next=${encodeURIComponent(next)}${silent ? '&silent=1' : ''}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('redirect_uri'), 'https://wall.example.com/api/auth/microsoft/callback');
  assert.equal(to.searchParams.get('scope'), 'openid profile email');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('nonce'));
  assert.equal(to.searchParams.get('prompt'), silent ? 'none' : 'select_account');
  await fetch(`${to}&test_code=${code}`); // "the person signs in at Microsoft"
  const back = await fetch(`${wall.base}/api/auth/microsoft/callback?code=${code}&state=${to.searchParams.get('state')}`, { redirect: 'manual' });
  const location = back.headers.get('location');
  const cookie = back.headers.get('set-cookie')?.split(';')[0] || null;
  return { status: back.status, location, cookie, body: silent ? await back.text() : null, as: as(cookie) };
}

test('the sign-in page offers Microsoft; an admin from IXG_ADMINS gets in as an admin, to where they were going', async () => {
  assert.deepEqual(await (await fetch(`${wall.base}/api/login/options`)).json(), { password: true, microsoft: true });
  const boss = await signIn('code-boss', '/admin');
  assert.equal(boss.location, '/admin');
  assert.ok(boss.cookie, 'a session cookie');
  assert.match(boss.cookie, /^ixg_session=/);
  const config = await (await boss.as('/api/config')).json();
  assert.equal(config.role, 'admin');
  assert.equal(config.sessionVia, 'microsoft');
  assert.deepEqual(config.account, { email: 'boss@tesseract.gg', name: 'The Boss', role: 'admin' });
  assert.ok(config.sessionExpiresAt - Date.now() > 7 * 3600e3 && config.sessionExpiresAt - Date.now() <= 8 * 3600e3, 'a Microsoft sign-in lasts 8 hours');
  assert.equal(config.access.enabled, true);
  assert.deepEqual(config.access.accounts.map((a) => [a.email, a.role, a.source, a.oid]), [['boss@tesseract.gg', 'admin', 'env', PEOPLE['code-boss'].oid]]);
  assert.equal(config.access.tenantId, TENANT, 'the organisation, noted from the admin\'s sign-in');
  assert.equal((await boss.as('/admin')).status, 200);
  assert.equal((await fetch(`${wall.base}/api/auth/microsoft/callback?code=code-boss&state=forged`, { redirect: 'manual' })).headers.get('location').startsWith('/login?error='), true, 'a forged state is refused');
});

test('tokens that don\'t check out let nobody in: expired, forged signature, another app\'s, another sign-in\'s', async () => {
  for (const [code, why] of [['code-expired', /expired/], ['code-forged', /signature/], ['code-aud', /another app/], ['code-nonce', /doesn't belong to this sign-in/]]) {
    const r = await signIn(code);
    assert.equal(r.cookie, null, code);
    assert.match(decodeURIComponent(r.location), why, code);
  }
  // No PKCE verifier, no tokens: a code stolen from the address bar is useless on its own.
  const start = new URL((await fetch(`${wall.base}/api/auth/microsoft/start`, { redirect: 'manual' })).headers.get('location'));
  await fetch(`${start}&test_code=code-boss`);
  const stolen = await fetch(`${fakeBase}/organizations/oauth2/v2.0/token`, { method: 'POST', body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: 'code-boss', grant_type: 'authorization_code' }) });
  assert.equal(stolen.status, 400);
});

test('other organisations and personal Microsoft accounts are refused', async () => {
  const out = await signIn('code-out');
  assert.equal(out.cookie, null);
  assert.match(decodeURIComponent(out.location), /another organisation/);
  const personal = await signIn('code-personal');
  assert.equal(personal.cookie, null);
  assert.match(decodeURIComponent(personal.location), /Personal Microsoft accounts can't sign in/);
});

test('an unlisted account is refused; listed, it gets its role; renamed, it keeps it; removed, it\'s signed out', async () => {
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
  assert.equal((await sam.as('/api/accounts/audit')).status, 403);
  assert.equal((await sam.as('/admin')).headers.get('location'), '/');
  let samRow = (await (await boss.as('/api/accounts')).json()).access.accounts.find((a) => a.email === 'sam@tesseract.gg');
  assert.equal(samRow.oid, PEOPLE['code-sam'].oid, 'bound to the Entra Object ID on the first sign-in');
  // Renamed in Microsoft 365: the Object ID still finds the account, and the new email is noted.
  PEOPLE['code-sam'].email = 'samuel@tesseract.gg';
  const renamed = await signIn('code-sam');
  assert.ok(renamed.cookie, 'a change of email keeps the access');
  samRow = (await (await boss.as('/api/accounts')).json()).access.accounts.find((a) => a.id === samRow.id);
  assert.equal(samRow.email, 'samuel@tesseract.gg');
  // Someone else given the old email can't take the account over: it's bound to Sam's Object ID.
  PEOPLE['code-imposter'] = { email: 'sam@tesseract.gg', tid: TENANT, oid: 'aaaaaaaa-0000-0000-0000-00000000dead' };
  assert.equal((await signIn('code-imposter')).cookie, null);
  // Role changed: the next request carries the new role.
  assert.equal((await boss.as('/api/accounts/update', { method: 'POST', body: JSON.stringify({ id: samRow.id, role: 'admin' }) })).status, 200);
  assert.equal((await sam.as('/api/config')).status, 401, 'the old session was for an operator: sign in again');
  const samAgain = await signIn('code-sam');
  assert.equal((await (await samAgain.as('/api/config')).json()).role, 'admin');
  assert.ok(samRow.lastSignIn, 'the last sign-in is noted');
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: samRow.id }) })).status, 200);
  assert.equal((await samAgain.as('/api/config')).status, 401, 'removed: signed out on the next request');
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: samRow.id }) })).status, 404);
  const env = (await (await boss.as('/api/accounts')).json()).access.accounts.find((a) => a.source === 'env');
  assert.equal((await boss.as('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: env.id }) })).status, 404, 'an env admin can\'t be removed here');
  PEOPLE['code-sam'].email = 'sam@tesseract.gg';
});

test('an app role assigned in Microsoft Entra lets its holder in with that role, and the list says where it came from', async () => {
  const rolf = await signIn('code-role');
  assert.ok(rolf.cookie);
  assert.equal((await (await rolf.as('/api/config')).json()).role, 'operator');
  const boss = await signIn('code-boss');
  const row = (await (await boss.as('/api/accounts')).json()).access.accounts.find((a) => a.email === 'rolf@tesseract.gg');
  assert.equal(row.source, 'entra');
  assert.equal(row.role, 'operator');
  const change = await boss.as('/api/accounts/update', { method: 'POST', body: JSON.stringify({ id: row.id, role: 'admin' }) });
  assert.equal(change.status, 400, 'Entra owns that role');
  assert.match((await change.json()).error, /Microsoft Entra/);
});

test('an account limited to one session sees that session alone, and can\'t start another', async () => {
  const boss = await signIn('code-boss');
  const mine = (await (await boss.as('/api/wall')).json()).wall.session;
  const other = (await (await boss.as('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Another event' }) })).json()).session;
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'pm@tesseract.gg', role: 'operator', sessions: ['nope'] }) })).status, 400, 'a session that doesn\'t exist');
  assert.equal((await boss.as('/api/accounts', { method: 'POST', body: JSON.stringify({ email: 'pm@tesseract.gg', role: 'operator', sessions: [mine.id] }) })).status, 200);
  const pm = await signIn('code-pm');
  assert.equal(pm.location, `/s/${mine.id}`, 'lands on its own session');
  const config = await (await pm.as('/api/config')).json();
  assert.deepEqual(config.allowedSessions, [mine.id]);
  assert.equal((await pm.as('/')).headers.get('location'), `/s/${mine.id}`);
  assert.equal((await pm.as(`/s/${other.id}`)).headers.get('location'), `/s/${mine.id}`, 'another session\'s address goes back to its own');
  assert.equal((await pm.as(`/api/wall?session=${other.id}`)).status, 403);
  assert.equal((await pm.as(`/api/youtube/history?session=${other.id}`)).status, 403);
  assert.deepEqual((await (await pm.as('/api/sessions')).json()).sessions.map((s) => s.id), [mine.id], 'the list holds its own session alone');
  assert.equal((await pm.as('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Mine now' }) })).status, 403);
  assert.equal((await pm.as('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: other.id }) })).status, 403);
  assert.equal((await pm.as(`/api/wall?session=${mine.id}`)).status, 200);
  // Widened to all: the next request sees everything.
  const row = (await (await boss.as('/api/accounts')).json()).access.accounts.find((a) => a.email === 'pm@tesseract.gg');
  assert.equal((await boss.as('/api/accounts/update', { method: 'POST', body: JSON.stringify({ id: row.id, sessions: null }) })).status, 200);
  assert.equal((await pm.as(`/api/wall?session=${other.id}`)).status, 200);
  assert.equal((await boss.as('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: other.id }) })).status, 200);
});

test('a quiet renewal gives a fresh session without the account picker; a refusal comes back to the frame, not the page', async () => {
  const renewed = await signIn('code-boss', '/', { silent: true });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.cookie, 'a fresh cookie');
  assert.match(renewed.body, /ixg-renewed/);
  assert.match(renewed.body, /ok: true/);
  // Microsoft says it needs the person (MFA, Conditional Access, or no session there): the frame hears it.
  const start = new URL((await fetch(`${wall.base}/api/auth/microsoft/start?silent=1`, { redirect: 'manual' })).headers.get('location'));
  const back = await fetch(`${wall.base}/api/auth/microsoft/callback?error=interaction_required&error_description=AADSTS50076&state=${start.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('set-cookie'), null);
  assert.equal(back.headers.get('x-frame-options'), 'SAMEORIGIN', 'the wall may frame it, nobody else');
  assert.match(await back.text(), /ok: false/);
});

test('signing out ends the wall\'s session and goes on to Microsoft\'s sign-out; the cookie no longer works', async () => {
  const boss = await signIn('code-boss');
  const out = await boss.as('/api/logout', { method: 'POST' });
  const body = await out.json();
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const next = new URL(body.next);
  assert.equal(next.pathname, '/organizations/oauth2/v2.0/logout');
  assert.equal(next.searchParams.get('post_logout_redirect_uri'), 'https://wall.example.com/login?signedout=1');
  // The browser drops the cookie; an unsigned request is turned away, and a page asks to sign in.
  assert.equal((await fetch(`${wall.base}/api/config`)).status, 401);
  const page = await fetch(`${wall.base}/s/x`, { redirect: 'manual', headers: { Cookie: 'ixg_session=12345678901234.admin.-.forgedforgedforgedforgedforgedforgedforgedf' } });
  assert.match(page.headers.get('location'), /^\/login\?next=.*reason=expired/, 'a cookie that no longer works: the sign-in page says the session ended');
});

test('the organisation switch lets its own accounts in as operators, and no one else; off, they\'re out', async () => {
  const boss = await signIn('code-boss');
  assert.equal((await signIn('code-tina')).cookie, null, 'unlisted, switch off');
  assert.equal((await boss.as('/api/accounts/tenant', { method: 'POST', body: JSON.stringify({ on: true }) })).status, 200);
  const tina = await signIn('code-tina');
  assert.ok(tina.cookie);
  assert.equal((await (await tina.as('/api/config')).json()).role, 'operator');
  assert.equal((await signIn('code-out')).cookie, null, 'another organisation');
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

test('the audit holds every sign-in, refusal, sign-out and change, and never a secret or a token', async () => {
  const boss = await signIn('code-boss');
  const { audit } = await (await boss.as('/api/accounts/audit?limit=500')).json();
  const kinds = new Set(audit.map((e) => `${e.action}:${e.result}`));
  for (const k of ['signin:ok', 'signin:refused', 'signout:ok', 'access:ok', 'renew:ok', 'renew:refused']) assert.ok(kinds.has(k), k);
  assert.ok(audit.some((e) => e.action === 'signin' && e.result === 'refused' && /Personal Microsoft accounts/.test(e.detail)));
  assert.ok(audit.some((e) => e.action === 'signin' && e.result === 'refused' && e.via === 'password'), 'a refused password is audited too');
  const file = fs.readFileSync(path.join(dataDir, 'auth-audit.log'), 'utf8');
  for (const secret of [CLIENT_SECRET, PASSWORD, 'access-code', 'eyJ']) assert.ok(!file.includes(secret), `no ${secret} in the audit`);
});
