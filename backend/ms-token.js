// Checks an ID token from Microsoft Entra ID the way OpenID Connect asks: the signature
// against Microsoft's published signing keys (JWKS), then the issuer, the audience (our app),
// the times, the nonce of this sign-in and the tenant. Node's own crypto does the RSA
// verification; nothing is home-made. The keys are cached, and fetched again once when a
// token names a key we don't have (Microsoft rolls them over).
const crypto = require('crypto');

const SKEW_S = 300;                 // clocks differ a little
const KEYS_TTL_MS = 24 * 3600e3;    // how long a fetched key set is trusted
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class KeySets {
  constructor(fetchImpl = fetch) {
    this.fetch = fetchImpl;
    this.sets = new Map(); // url -> { keys: Map kid -> KeyObject, at }
  }

  async key(url, kid, { refresh = false } = {}) {
    let set = this.sets.get(url);
    if (!set || refresh || Date.now() - set.at > KEYS_TTL_MS) {
      let res;
      try {
        res = await this.fetch(url, { signal: AbortSignal.timeout(10000) });
      } catch (err) {
        throw new Error(`Couldn't fetch Microsoft's signing keys (${err.message}).`);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.keys)) throw new Error(`Microsoft's signing keys weren't available (HTTP ${res.status}).`);
      const keys = new Map();
      for (const jwk of body.keys) {
        if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
        try {
          keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
        } catch {
          // a key we can't read is a key we don't use
        }
      }
      set = { keys, at: Date.now() };
      this.sets.set(url, set);
    }
    return set.keys.get(kid) || null;
  }
}

const keySets = new KeySets();

// Returns the claims, or throws with why not. expected: { jwksUrl, issuer(tid), clientId,
// nonce, tenantId (required, or '' for any organisation), personalTenant }.
async function verifyIdToken(token, expected, sets = keySets) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Microsoft sent no usable ID token.');
  let header;
  let claims;
  try {
    header = JSON.parse(b64url(parts[0]).toString());
    claims = JSON.parse(b64url(parts[1]).toString());
  } catch {
    throw new Error('The ID token from Microsoft couldn\'t be read.');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('The ID token isn\'t signed the way Microsoft signs them.');
  let key = await sets.key(expected.jwksUrl, header.kid);
  if (!key) key = await sets.key(expected.jwksUrl, header.kid, { refresh: true });
  if (!key) throw new Error('The ID token is signed with a key Microsoft doesn\'t publish.');
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, b64url(parts[2]));
  if (!ok) throw new Error('The ID token\'s signature doesn\'t check out.');
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new Error('The sign-in took too long and its token expired. Start again.');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) throw new Error('The ID token isn\'t valid yet (check the server\'s clock).');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw new Error('The ID token is from the future (check the server\'s clock).');
  if (claims.aud !== expected.clientId) throw new Error('The ID token was issued for another app.');
  if (!claims.tid || typeof claims.tid !== 'string') throw new Error('The ID token names no organisation.');
  if (claims.iss !== expected.issuer(claims.tid)) throw new Error('The ID token names an issuer that isn\'t Microsoft\'s for this organisation.');
  if (expected.nonce && claims.nonce !== expected.nonce) throw new Error('The ID token doesn\'t belong to this sign-in. Start again.');
  if (claims.tid.toLowerCase() === String(expected.personalTenant || '').toLowerCase()) throw new Error('Personal Microsoft accounts can\'t sign in: use your organisation account.');
  if (expected.tenantId && claims.tid.toLowerCase() !== expected.tenantId.toLowerCase()) throw new Error('This account belongs to another organisation and can\'t sign in here.');
  if (typeof claims.oid !== 'string' || !claims.oid) throw new Error('The ID token names no account.');
  return claims;
}

module.exports = { verifyIdToken, KeySets };
