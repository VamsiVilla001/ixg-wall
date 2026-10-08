// ID token checks (backend/ms-token.js), without a network: Microsoft's keys come from a fake
// fetch. Each claim that must hold is broken in turn.   npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyIdToken, KeySets } = require('../backend/ms-token');

const LOGIN = 'https://login.example';
const CLIENT = '12345678-1234-1234-1234-123456789abc';
const TID = '11111111-2222-3333-4444-555555555555';
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad';
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const NEXT = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64url = (b) => Buffer.from(b).toString('base64url');

function sign(claims, { kid = 'k1', key = KEY.privateKey, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const full = { aud: CLIENT, iss: `${LOGIN}/${TID}/v2.0`, tid: TID, oid: 'o-1', iat: now, nbf: now, exp: now + 600, nonce: 'n1', ...claims };
  const head = b64url(JSON.stringify({ alg, kid }));
  const body = b64url(JSON.stringify(full));
  return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

// Microsoft's key set: k1 at first; after a rollover, k2 as well.
let published = [['k1', KEY]];
let fetches = 0;
const sets = new KeySets(async () => {
  fetches += 1;
  return { ok: true, status: 200, json: async () => ({ keys: published.map(([kid, k]) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, use: 'sig' })) }) };
});
const expected = (over = {}) => ({ jwksUrl: `${LOGIN}/${TID}/discovery/v2.0/keys`, issuer: (tid) => `${LOGIN}/${tid}/v2.0`, clientId: CLIENT, nonce: 'n1', tenantId: TID, personalTenant: PERSONAL, ...over });
const check = (token, over) => verifyIdToken(token, expected(over), sets);

test('a good token gives its claims', async () => {
  const claims = await check(sign({ preferred_username: 'a@b.gg' }));
  assert.equal(claims.oid, 'o-1');
  assert.equal(claims.preferred_username, 'a@b.gg');
});

test('every claim that must hold is checked', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [sign({ exp: now - 3600 }), /expired/],
    [sign({ nbf: now + 3600 }), /isn't valid yet/],
    [sign({ aud: 'someone-else' }), /another app/],
    [sign({ iss: `${LOGIN}/${TID}/v1.0` }), /issuer/],
    [sign({ iss: `https://evil.example/${TID}/v2.0` }), /issuer/],
    [sign({ nonce: 'other' }), /doesn't belong to this sign-in/],
    [sign({ tid: '99999999-8888-7777-6666-555555555555', iss: `${LOGIN}/99999999-8888-7777-6666-555555555555/v2.0` }), /another organisation/],
    [sign({ tid: PERSONAL, iss: `${LOGIN}/${PERSONAL}/v2.0` }), /Personal Microsoft accounts/],
    [sign({ oid: '' }), /names no account/],
    [sign({}, { key: NEXT.privateKey }), /signature/],
    [sign({}, { alg: 'HS256' }), /isn't signed the way/],
    [sign({}, { kid: 'nobody' }), /key Microsoft doesn't publish/],
    ['not.a-token', /couldn't be read|no usable/],
    ['', /no usable/],
  ];
  for (const [token, why] of cases) await assert.rejects(check(token), why);
});

test('without a required tenant, any organisation passes but personal accounts still don\'t', async () => {
  const other = '99999999-8888-7777-6666-555555555555';
  assert.equal((await check(sign({ tid: other, iss: `${LOGIN}/${other}/v2.0` }), { tenantId: '' })).tid, other);
  await assert.rejects(check(sign({ tid: PERSONAL, iss: `${LOGIN}/${PERSONAL}/v2.0` }), { tenantId: '' }), /Personal/);
});

test('a key Microsoft rolled over to is fetched once, then cached', async () => {
  published = [['k1', KEY], ['k2', NEXT]];
  const before = fetches;
  assert.equal((await check(sign({}, { kid: 'k2', key: NEXT.privateKey }))).oid, 'o-1');
  assert.equal(fetches, before + 1, 'refetched for the new key');
  await check(sign({}, { kid: 'k2', key: NEXT.privateKey }));
  assert.equal(fetches, before + 1, 'cached after that');
});

test('the authority is the organisation\'s tenant when its ID is set, else "organizations" (never "common")', () => {
  const { MS } = require('../backend/onedrive');
  assert.equal(MS.authority(TID), TID);
  assert.equal(MS.authority(''), 'organizations');
  assert.equal(MS.authority('not-a-guid'), 'organizations');
  assert.ok(MS.authUrl(TID).endsWith(`/${TID}/oauth2/v2.0/authorize`));
  assert.match(MS.jwksUrl(''), /\/organizations\/discovery\/v2\.0\/keys$/);
  assert.ok(!MS.authUrl('').includes('/common/'));
});

test('the OneDrive archive keeps the "common" endpoint without a tenant, so a personal OneDrive still works', () => {
  const { MS } = require('../backend/onedrive');
  assert.equal(MS.authority('', 'common'), 'common');
  assert.equal(MS.authority(TID, 'common'), TID);
});
