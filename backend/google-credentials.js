// Google credentials for whoever runs the wall. Nothing is built in: the YouTube Data API
// key and the Google OAuth client (for the channel sign-in) can belong to anyone, and come
// from Settings or the environment. Each is checked with Google before it replaces a
// working one, and any number of channels can sign in with the client: each feed's ingest
// comes from whichever signed-in channel owns it.
//
// Keys, client secrets and tokens stay on the server (secrets.js). Pages only ever see
// keyInfo(), clientInfo() and channels().
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { YT_KEY_FORMAT, OAUTH_CLIENT_ID_FORMAT, OAUTH_SECRET_FORMAT } = require('./secrets');

// Google's endpoints. Tests point these at a fake Google.
const GOOGLE = {
  AUTH_URL: process.env.IXG_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: process.env.IXG_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  REVOKE_URL: process.env.IXG_GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  API: process.env.IXG_YOUTUBE_API || 'https://www.googleapis.com/youtube/v3',
  ANALYTICS_API: process.env.IXG_YOUTUBE_ANALYTICS_API || 'https://youtubeanalytics.googleapis.com/v2',
};
// Read-only: the channel's broadcasts and streams (ingest health), and its YouTube Analytics
// (the per-minute audience behind Studio's live graph, youtube-studio.js).
const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const SCOPE = `https://www.googleapis.com/auth/youtube.readonly ${ANALYTICS_SCOPE}`;
const STATE_TTL_MS = 10 * 60000;   // a sign-in must finish within this
const CHECK_TIMEOUT_MS = 10000;

class GoogleCredentials extends EventEmitter {
  // Emits 'key' when the API key changes, 'change' when the OAuth client or the signed-in
  // channels change, and 'checked' when the client was checked again.
  constructor({ secrets, publicUrl, port }) {
    super();
    this.secrets = secrets;
    this.referer = `${publicUrl}/`;  // lets a key restricted to the wall's address work from here
    // Google returns sign-ins only to https addresses and to localhost: it refuses a plain-http
    // network address ("device_id and device_name are required for private IP"). A wall
    // served that way, like a review copy at http://192.168.x.x, signs channels in from the
    // server's own computer at http://localhost:PORT instead; the sign-ins are shared by
    // everyone who opens the wall.
    const { protocol, hostname } = new URL(publicUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    this.localUrl = protocol === 'https:' || loopback ? null : `http://localhost:${port}`;
    this.redirectUri = `${this.localUrl || publicUrl}/api/youtube/oauth/callback`;
    this.pending = new Map();        // sign-in state -> { exp, purpose }
    // Other sign-ins with the same client, by purpose: { scope, finish(tokens) -> name }.
    // The server registers 'drive' (gdrive.js); 'channel' is the one here.
    this.purposes = {};
    this.access = new Map();         // channel id -> { token, expiresAt }
    this.clientCheck = null;         // what Google said about the OAuth client: { status, message, at }
  }

  // Checks the saved OAuth client once at startup, so Settings can say what's wrong with it.
  start() {
    if (this.oauthClient()) this.recheckOauthClient().catch(() => {});
  }

  // ---- YouTube Data API key ----------------------------------------------------------
  apiKey() {
    return this.secrets.ytApiKey();
  }

  keyInfo() {
    return this.secrets.ytKeyInfo();
  }

  // Asks YouTube about a key with the cheapest call there is (1 quota unit).
  // status: ok | quota | restricted | disabled | invalid | unchecked
  async checkApiKey(key) {
    try {
      const res = await fetch(`${GOOGLE.API}/i18nLanguages?${new URLSearchParams({ part: 'snippet', hl: 'en', fields: 'kind', key })}`, {
        headers: { Referer: this.referer },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.ok) return { status: 'ok', message: 'YouTube accepted this key.' };
      const { code, message } = describeGoogleError(await res.json().catch(() => ({})), res.status, this.referer);
      const status = { invalid: 'invalid', quota: 'quota', ip: 'restricted', referrer: 'restricted', disabled: 'disabled' }[code] || 'unchecked';
      return { status, message };
    } catch (err) {
      return { status: 'unchecked', message: `Couldn't reach YouTube to check the key (${err.message}).` };
    }
  }

  // Saves anyone's key, or removes it with an empty one. A key Google calls invalid is
  // refused, so a mistyped key never replaces a working one. Anything else is saved (a
  // restriction or a disabled API is fixed in Google Cloud, not by changing the key) and
  // the reason is returned. Returns { status: HTTP code, error?, check? }.
  async saveApiKey(raw) {
    const key = typeof raw === 'string' ? raw.trim() : null;
    if (key == null || (key && !YT_KEY_FORMAT.test(key))) {
      return { status: 400, error: 'That doesn\'t look like a YouTube Data API key (AIza…, 39 characters).' };
    }
    if (this.keyInfo().source === 'env') {
      return { status: 409, error: 'This server sets the key itself (YOUTUBE_API_KEY), so it can\'t be changed here.' };
    }
    let check = null;
    if (key) {
      check = await this.checkApiKey(key);
      if (check.status === 'invalid') {
        const kept = this.keyInfo().set ? ' The saved key is still in use.' : '';
        return { status: 400, error: `Google says this key isn't valid: check it was copied in full.${kept}`, check };
      }
    }
    this.secrets.setYtApiKey(key);
    this.emit('key');
    return { status: 200, check };
  }

  // ---- OAuth client --------------------------------------------------------------------
  oauthClient() {
    return this.secrets.oauthClient();
  }

  clientInfo() {
    return { ...this.secrets.oauthClientInfo(), check: this.clientCheck };
  }

  // Asks Google about a client without anyone signing in:
  //  1. the token endpoint with a made-up code: "invalid_grant" means the ID and secret were
  //     accepted; "invalid_client" means one of them is wrong.
  //  2. the sign-in page with this wall's redirect address: Google either sends it on to
  //     the sign-in, or to an error page that names the problem (redirect_uri_mismatch…).
  // status: ok | redirect (fixable in Google Cloud) | invalid | unchecked
  async checkOauthClient(client) {
    const problems = [];
    try {
      const res = await fetch(GOOGLE.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: 'authorization_code',
          code: 'ixg-wall-client-check',
          redirect_uri: this.redirectUri,
        }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      if (body.error === 'invalid_client') {
        return {
          status: 'invalid',
          message: /not found/i.test(body.error_description || '')
            ? 'Google has no OAuth client with this ID: check it was copied in full, and that the client wasn\'t deleted.'
            : 'Google rejected the client secret: copy it again from the client\'s page in Google Cloud (Credentials).',
        };
      }
      if (body.error === 'unauthorized_client') {
        return { status: 'invalid', message: 'This client can\'t sign in a web server: in Google Cloud, create an OAuth client ID of type Web application.' };
      }
      if (body.error !== 'invalid_grant') problems.push(`Google's token check answered ${body.error || `HTTP ${res.status}`}.`);
    } catch (err) {
      problems.push(`Couldn't reach Google to check the client (${err.message}).`);
    }

    try {
      const res = await fetch(this.authUrlFor(client, 'ixg-wall-client-check'), { redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      const location = res.headers.get('location') || '';
      const error = res.status >= 300 && res.status < 400 ? readAuthError(location) : null;
      if (error) {
        if (['invalid_client', 'deleted_client', 'disabled_client'].includes(error.code)) {
          return { status: 'invalid', message: `Google refused this client: ${error.message || error.code}.` };
        }
        if (error.code === 'redirect_uri_mismatch') {
          return { status: 'redirect', message: `Google doesn't accept this wall's address yet. In Google Cloud, open the client (type Web application) and add this authorised redirect URI: ${this.redirectUri}` };
        }
        if (error.code === 'invalid_request') {
          return { status: 'redirect', message: `Google won't return sign-ins to ${this.redirectUri}: ${error.message || 'invalid request'}. Use a public https address, or localhost.` };
        }
        problems.push(`Google's sign-in page said: ${error.code}${error.message ? ` (${error.message})` : ''}.`);
      } else if (res.status >= 400) {
        problems.push(`Google's sign-in page answered HTTP ${res.status}.`);
      }
    } catch (err) {
      problems.push(`Couldn't reach Google's sign-in page (${err.message}).`);
    }
    return problems.length
      ? { status: 'unchecked', message: problems.join(' ') }
      : {
        status: 'ok',
        message: `Google accepted the client ID, secret and this wall's redirect address.${this.localUrl ? ` Channels sign in from this server's own computer, at ${this.localUrl}.` : ''}`,
      };
  }

  // Saves anyone's OAuth client, or removes it with empty fields. A client Google refuses is
  // not saved, so it never replaces a working one. A redirect address Google doesn't know
  // yet is saved with the fix to make. A different client signs every channel out: their
  // sign-ins belong to the old client. Returns { status: HTTP code, error?, check? }.
  async saveOauthClient({ clientId, clientSecret }) {
    const id = String(clientId || '').trim();
    const secret = String(clientSecret || '').trim();
    if (this.clientInfo().source === 'env') {
      return { status: 409, error: 'This server sets the OAuth client itself (GOOGLE_OAUTH_CLIENT_ID), so it can\'t be changed here.' };
    }
    if (!id && !secret) {
      await this.signOut();
      this.secrets.setOauthClient(null);
      this.clientCheck = null;
      this.emit('change');
      return { status: 200, check: null };
    }
    if (!OAUTH_CLIENT_ID_FORMAT.test(id) || !OAUTH_SECRET_FORMAT.test(secret)) {
      return { status: 400, error: 'That isn\'t a Google OAuth client: the ID ends in .apps.googleusercontent.com and the secret usually starts GOCSPX-.' };
    }
    const check = await this.checkOauthClient({ clientId: id, clientSecret: secret });
    if (check.status === 'invalid') {
      const kept = this.oauthClient() ? ' The saved client is still in use.' : '';
      return { status: 400, error: `${check.message}${kept}`, check };
    }
    if (this.oauthClient()?.clientId !== id) await this.signOut();
    this.secrets.setOauthClient({ clientId: id, clientSecret: secret });
    this.clientCheck = { ...check, at: Date.now() };
    this.emit('change');
    return { status: 200, check };
  }

  // "Check again" after fixing the client in Google Cloud.
  async recheckOauthClient() {
    const client = this.oauthClient();
    this.clientCheck = client ? { ...(await this.checkOauthClient(client)), at: Date.now() } : null;
    this.emit('checked');
    return this.clientCheck;
  }

  // ---- Channel sign-ins ----------------------------------------------------------------
  // Every channel signed in with the client: [{ id, title, savedAt, expired, analytics }].
  // analytics: whether the sign-in allowed YouTube Analytics; null for a sign-in from before
  // the wall asked, which may still turn out to work. No tokens.
  channels() {
    return this.secrets.channelTokens().map((t) => ({
      id: t.channelId,
      title: t.channelTitle,
      savedAt: t.savedAt,
      expired: !t.refreshToken,
      analytics: typeof t.scopes === 'string' ? t.scopes.split(' ').includes(ANALYTICS_SCOPE) : null,
    }));
  }

  authUrlFor(client, state, scope = SCOPE) {
    return `${GOOGLE.AUTH_URL}?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope,
      access_type: 'offline',  // a refresh token, so the wall stays signed in
      prompt: 'consent',       // Google only returns a refresh token on consent
      include_granted_scopes: 'true',
      state,
    })}`;
  }

  // Where the sign-in popup goes. For 'channel' each sign-in adds a channel (or renews one);
  // another purpose (e.g. 'drive') asks for that purpose's scope and is finished by it.
  authUrl(purpose = 'channel') {
    const client = this.oauthClient();
    if (!client) throw new Error('Add a Google OAuth client first (Settings → YouTube API → Channel sign-in).');
    if (purpose !== 'channel' && !this.purposes[purpose]) throw new Error(`Unknown sign-in purpose: ${purpose}`);
    const now = Date.now();
    for (const [s, p] of this.pending) if (p.exp < now) this.pending.delete(s);
    const state = crypto.randomBytes(24).toString('base64url');
    this.pending.set(state, { exp: now + STATE_TTL_MS, purpose });
    return this.authUrlFor(client, state, purpose === 'channel' ? SCOPE : this.purposes[purpose].scope);
  }

  // Google sent the browser back with ?code&state. Returns { purpose, name }: the channel's
  // title, or what the purpose's finish() says (the Drive account).
  async finish({ code, state, error }) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.exp < Date.now()) throw new Error('This sign-in link expired or was already used. Start again from Settings.');
    if (error) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${error}`);
    if (!code) throw new Error('Google sent no authorisation code.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
    if (!tokens.refresh_token) throw new Error('Google gave no refresh token. Remove IXG Wall from the account\'s third-party access and sign in again.');
    if (pending.purpose !== 'channel') return { purpose: pending.purpose, name: await this.purposes[pending.purpose].finish(tokens) };
    const access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
    const res = await fetch(`${GOOGLE.API}/channels?${new URLSearchParams({ part: 'snippet', mine: 'true', fields: 'items(id,snippet(title))' })}`, {
      headers: { Authorization: `Bearer ${access.token}` },
      signal: AbortSignal.timeout(15000),
    });
    const me = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(describeGoogleError(me, res.status, this.referer).message);
    const channel = me.items?.[0];
    if (!channel) throw new Error('That Google account has no YouTube channel.');
    this.access.set(channel.id, access);
    this.secrets.saveChannelToken({
      refreshToken: tokens.refresh_token,
      channelId: channel.id,
      channelTitle: channel.snippet?.title || channel.id,
      savedAt: new Date().toISOString(),
      scopes: tokens.scope || SCOPE, // what the account allowed: it can untick Analytics
    });
    this.emit('change');
    return { purpose: 'channel', name: channel.snippet?.title || channel.id };
  }

  // Signs one channel out, or every channel without an id, and withdraws the wall's access
  // on Google's side (best effort).
  async signOut(channelId) {
    const tokens = this.secrets.channelTokens().filter((t) => !channelId || t.channelId === channelId);
    if (!tokens.length) return false;
    for (const t of tokens) {
      this.secrets.removeChannelToken(t.channelId);
      this.access.delete(t.channelId);
    }
    this.emit('change');
    await Promise.all(tokens.filter((t) => t.refreshToken).map((t) => fetch(`${GOOGLE.REVOKE_URL}?${new URLSearchParams({ token: t.refreshToken })}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})));
    return true;
  }

  async tokenRequest(params) {
    const client = this.oauthClient();
    if (!client) throw new Error('No Google OAuth client is set up.');
    const res = await fetch(GOOGLE.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error === 'invalid_client' ? 'The OAuth client ID or secret is wrong.'
        : body.error === 'invalid_grant' ? 'The channel sign-in expired or was revoked: sign in again.'
          : body.error_description || body.error || `Google answered HTTP ${res.status}`);
      err.code = body.error;
      throw err;
    }
    return body;
  }

  // A current access token for one signed-in channel.
  async accessToken(channelId) {
    const cached = this.access.get(channelId);
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.token;
    const saved = this.secrets.channelTokens().find((t) => t.channelId === channelId);
    if (!saved?.refreshToken) throw new Error('This channel needs to sign in again.');
    try {
      const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refreshToken });
      this.access.set(channelId, { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 });
      return body.access_token;
    } catch (err) {
      // Revoked, or a Google "testing" app's 7-day sign-in ran out: the channel stays listed,
      // marked to sign in again.
      if (err.code === 'invalid_grant') this.secrets.expireChannelToken(channelId);
      throw err;
    }
  }

  // The token was refused early (401): fetch a new one next time.
  dropAccess(channelId) {
    this.access.delete(channelId);
  }
}

// Google's sign-in page reports a problem by redirecting to /signin/oauth/error with an
// authError parameter: a small base64 protobuf whose field 1 is the error code
// (redirect_uri_mismatch, invalid_client…) and field 2 the explanation.
function readAuthError(location) {
  let raw;
  try {
    const url = new URL(location, GOOGLE.AUTH_URL);
    const param = url.searchParams.get('authError');
    if (!param) return url.pathname.includes('/oauth/error') ? { code: 'unknown', message: '' } : null;
    raw = Buffer.from(param, 'base64');
  } catch {
    return null;
  }
  const fields = {};
  let i = 0;
  while (i < raw.length) {
    const tag = raw[i++];
    if ((tag & 7) !== 2) break; // only the leading text fields matter
    let len = 0;
    let shift = 0;
    let b;
    do {
      b = raw[i++];
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && i < raw.length);
    const field = tag >> 3;
    if (!(field in fields)) fields[field] = raw.subarray(i, i + len).toString('utf8');
    i += len;
  }
  if (fields[1]) return { code: fields[1].trim(), message: String(fields[2] || '').trim() };
  const known = /(redirect_uri_mismatch|invalid_client|deleted_client|disabled_client|unauthorized_client|invalid_request)/.exec(raw.toString('latin1'));
  return { code: known ? known[1] : 'unknown', message: '' };
}

// Google's API error reasons, in words an operator can act on.
// code: invalid | quota | ip | referrer | disabled | other
function describeGoogleError(body, status, referer) {
  const err = body?.error || {};
  const reasons = [...(err.errors || []).map((e) => e.reason), ...(err.details || []).map((d) => d.reason)].filter(Boolean);
  const has = (...r) => r.some((x) => reasons.includes(x));
  if (has('API_KEY_INVALID', 'keyInvalid')) return { code: 'invalid', message: 'Key not valid: check it was copied in full' };
  if (has('quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED')) {
    return { code: 'quota', message: 'Daily quota used up: numbers resume after midnight Pacific time' };
  }
  if (has('API_KEY_IP_ADDRESS_BLOCKED')) {
    return { code: 'ip', message: 'Key restricted to other IP addresses: allow this server\'s public IP in its Google Cloud restrictions' };
  }
  if (has('API_KEY_HTTP_REFERRER_BLOCKED', 'ipRefererBlocked')) {
    return { code: 'referrer', message: `Key restricted to other addresses: allow ${referer}* in its Google Cloud restrictions` };
  }
  if (has('accessNotConfigured', 'SERVICE_DISABLED', 'API_KEY_SERVICE_BLOCKED')) {
    return { code: 'disabled', message: 'YouTube Data API v3 is not enabled for this key\'s Google Cloud project' };
  }
  const msg = String(err.message || '').replace(/<[^>]*>/g, '').trim();
  return { code: 'other', message: msg || `YouTube answered HTTP ${status}` };
}

module.exports = { GoogleCredentials, GOOGLE, describeGoogleError, readAuthError };
