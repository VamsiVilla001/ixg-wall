// OneDrive as a screenshot destination (Microsoft Graph): each screenshot is uploaded into a
// folder the operator pasted a sharing link to, under the same session/date/feed folders as
// on disk.
//
// The wall signs in as an app registered in a Microsoft 365 tenant (or a personal Microsoft
// account's free registration): a client ID and secret from Settings or MS_CLIENT_ID/_SECRET,
// with the delegated permission Files.ReadWrite and this wall's redirect address. Whoever
// signs in must be able to edit the folder. The refresh token stays on the server
// (secrets.js); pages see the account and the folder.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const { retrying, Queue } = require('./retry');

// Microsoft's endpoints. The authority is the organisation's tenant when the app is
// registered single-tenant (its Directory (tenant) ID, set with the client), otherwise
// "organizations": work and school accounts of any tenant, never personal ones. Tests point
// IXG_MS_LOGIN_URL (or the two older single-endpoint overrides) at a fake.
const LOGIN = (process.env.IXG_MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS = {
  LOGIN,
  GRAPH: process.env.IXG_GRAPH_API || 'https://graph.microsoft.com/v1.0',
  // fallback: 'organizations' for the sign-in; the OneDrive archive passes 'common', so a
  // personal OneDrive folder keeps working when no tenant is set.
  authority: (tenantId, fallback = 'organizations') => (GUID.test(tenantId || '') ? tenantId.toLowerCase() : fallback),
  authUrl: (tenantId, fallback) => process.env.IXG_MS_AUTH_URL || `${LOGIN}/${MS.authority(tenantId, fallback)}/oauth2/v2.0/authorize`,
  tokenUrl: (tenantId, fallback) => process.env.IXG_MS_TOKEN_URL || `${LOGIN}/${MS.authority(tenantId, fallback)}/oauth2/v2.0/token`,
  jwksUrl: (tenantId) => `${LOGIN}/${MS.authority(tenantId)}/discovery/v2.0/keys`,
  logoutUrl: (tenantId) => `${LOGIN}/${MS.authority(tenantId)}/oauth2/v2.0/logout`,
  // The issuer an ID token names: always the account's own tenant, whatever the authority.
  issuer: (tid) => `${LOGIN}/${tid}/v2.0`,
  // Microsoft's tenant for personal accounts (outlook.com, live.com): never an organisation's.
  PERSONAL_TENANT: '9188040d-6c67-4c5b-b112-36a304b66dad',
};
const SCOPE = 'offline_access Files.ReadWrite User.Read';
const CLIENT_ID_FORMAT = GUID;
const STATE_TTL_MS = 10 * 60000;
const TIMEOUT_MS = 60000;
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;  // Graph's limit for one PUT; bigger files go by upload session
const FINAL = new Set(['invalid_grant', 'invalid_client', 'itemNotFound', 'accessDenied', 'file_missing', 'not_set_up', 'unauthenticated']);

const describe = (code) => ({
  invalid_grant: 'The OneDrive sign-in expired or was revoked: sign in again.',
  invalid_client: 'Microsoft refused the app\'s client ID or secret: check them in the app registration (a secret expires; make a new one).',
  itemNotFound: 'OneDrive has no such folder, or this account can\'t see it: check the link, and that the folder is shared with the signed-in account.',
  accessDenied: 'The signed-in account can\'t write into that folder: share it with that account with edit access.',
  unauthenticated: 'OneDrive isn\'t signed in.',
  not_set_up: 'OneDrive isn\'t set up.',
  ratelimited: 'OneDrive asked the wall to slow down',
}[code] || null);

// Graph's "shares" address for a sharing link: "u!" and the link, base64url-encoded.
const shareId = (url) => `u!${Buffer.from(String(url)).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

class OneDrive extends EventEmitter {
  constructor({ secrets, publicUrl }) {
    super();
    this.secrets = secrets;
    this.redirectUri = `${publicUrl}/api/onedrive/callback`;
    this.pending = new Map();   // sign-in state -> expiry
    this.access = null;         // { token, expiresAt }
    this.queue = new Queue();
    this.check = null;          // what Microsoft said last: { status, message, at }
    this.clientCheck = null;    // what Microsoft said about the client: { status, message, at }
    this.waits = undefined;     // retry waits (retry.js's by default; tests shorten them)
  }

  configured() {
    const o = this.secrets.onedrive();
    return !!(this.secrets.msClient() && o?.refreshToken && o.driveId && o.itemId && o.enabled !== false);
  }

  // What a page may know: never the secret or a token.
  info() {
    const o = this.secrets.onedrive();
    return {
      client: { ...this.secrets.msClientInfo(), check: this.clientCheck },
      redirectUri: this.redirectUri,
      signedIn: !!o?.refreshToken,
      account: o?.account || '',
      folder: o?.itemId ? { name: o.folderName || '', url: o.webUrl || o.shareUrl || '' } : null,
      enabled: o ? o.enabled !== false : false,
      configured: this.configured(),
      check: this.check,
      pending: this.queue.pending,
    };
  }

  // ---- The app (client) --------------------------------------------------------------
  // Asks Microsoft about a client with a made-up code: "invalid_grant" means the ID and
  // secret were accepted; "invalid_client" / "unauthorized_client" means one is wrong.
  async checkClient(client) {
    try {
      const res = await fetch(MS.tokenUrl(client.tenantId, 'common'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'authorization_code', code: 'ixg-wall-client-check', redirect_uri: this.redirectUri, scope: SCOPE }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => ({}));
      const text = String(body.error_description || '');
      if (body.error === 'invalid_grant' || /AADSTS(70000|54005|700?21)/.test(text)) return { status: 'ok', message: 'Microsoft accepted the client ID and secret.' };
      if (/AADSTS700016/.test(text)) return { status: 'invalid', message: 'Microsoft has no app with this client ID: check it, and that the app registration wasn\'t deleted.' };
      if (/AADSTS7000215|AADSTS7000222/.test(text) || body.error === 'invalid_client') return { status: 'invalid', message: 'Microsoft rejected the client secret: copy its value again from the app registration (a secret expires; make a new one if it has).' };
      if (/AADSTS50011/.test(text)) return { status: 'redirect', message: `Microsoft doesn't know this wall's address yet: in the app registration, under Authentication, add the Web redirect URI ${this.redirectUri}` };
      if (/AADSTS50194|AADSTS90002/.test(text)) return { status: 'invalid', message: 'This app registration is single-tenant: give its Directory (tenant) ID with the client ID and secret.' };
      return { status: 'unchecked', message: `Microsoft answered ${body.error || `HTTP ${res.status}`}${text ? ` (${text.slice(0, 160)})` : ''}.` };
    } catch (err) {
      return { status: 'unchecked', message: `Couldn't reach Microsoft to check the client (${err.message}).` };
    }
  }

  // Saves anyone's app, or removes it with both fields empty. A client Microsoft refuses
  // isn't saved. A different client signs the account out. Returns { status: HTTP code, error?, check? }.
  async saveClient({ clientId, clientSecret, tenantId }) {
    const id = String(clientId || '').trim();
    const secret = String(clientSecret || '').trim();
    const tenant = String(tenantId || '').trim().toLowerCase();
    if (this.secrets.msClientInfo().source === 'env') return { status: 409, error: 'This server sets the Microsoft app itself (MS_CLIENT_ID), so it can\'t be changed here.' };
    if (!id && !secret) {
      await this.signOut();
      this.secrets.setMsClient(null);
      this.clientCheck = null;
      this.emit('change');
      return { status: 200, check: null };
    }
    if (!CLIENT_ID_FORMAT.test(id) || secret.length < 10) return { status: 400, error: 'That isn\'t a Microsoft app: the client ID is a GUID (Application (client) ID on the app\'s Overview page) and the secret its Value under Certificates & secrets.' };
    if (tenant && !GUID.test(tenant)) return { status: 400, error: 'The Directory (tenant) ID is a GUID (on the app\'s Overview page), or empty for an app open to any organisation.' };
    const check = await this.checkClient({ clientId: id, clientSecret: secret, tenantId: tenant });
    if (check.status === 'invalid') return { status: 400, error: check.message, check };
    if (this.secrets.msClient()?.clientId !== id) await this.signOut();
    this.secrets.setMsClient({ clientId: id, clientSecret: secret, tenantId: tenant });
    this.clientCheck = { ...check, at: Date.now() };
    this.emit('change');
    return { status: 200, check };
  }

  // ---- The sign-in -------------------------------------------------------------------
  authUrl() {
    const client = this.secrets.msClient();
    if (!client) throw new Error('Add the Microsoft app\'s client ID and secret first (Settings → Source screenshots → OneDrive).');
    const now = Date.now();
    for (const [s, exp] of this.pending) if (exp < now) this.pending.delete(s);
    const state = crypto.randomBytes(24).toString('base64url');
    this.pending.set(state, now + STATE_TTL_MS);
    return `${MS.authUrl(client.tenantId, 'common')}?${new URLSearchParams({
      client_id: client.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: SCOPE,
      prompt: 'select_account',
      state,
    })}`;
  }

  // Microsoft sent the browser back with ?code&state. Returns the account.
  async finish({ code, state, error, errorDescription }) {
    const exp = this.pending.get(state);
    this.pending.delete(state);
    if (!exp || exp < Date.now()) throw new Error('This sign-in link expired or was already used. Start again from Settings.');
    if (error) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Microsoft said: ${errorDescription || error}`);
    if (!code) throw new Error('Microsoft sent no authorisation code.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, scope: SCOPE });
    if (!tokens.refresh_token) throw new Error('Microsoft gave no refresh token: the app needs the offline_access permission.');
    this.access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
    const me = await this.graph('GET', '/me?$select=displayName,userPrincipalName,mail');
    const account = me.userPrincipalName || me.mail || me.displayName || 'Microsoft account';
    const o = this.secrets.onedrive() || {};
    this.secrets.setOnedrive({ ...o, refreshToken: tokens.refresh_token, account, savedAt: new Date().toISOString(), enabled: o.enabled !== false });
    this.check = { status: 'ok', message: `Signed in to OneDrive as ${account}.${o.itemId ? '' : ' Now paste the folder\'s sharing link.'}`, at: Date.now() };
    this.emit('change');
    return account;
  }

  async tokenRequest(params) {
    const client = this.secrets.msClient();
    if (!client) throw Object.assign(new Error(describe('not_set_up')), { code: 'not_set_up' });
    let res;
    try {
      res = await fetch(MS.tokenUrl(client.tenantId, 'common'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw Object.assign(new Error(`Couldn't reach Microsoft (${err.message})`), { code: 'network' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = body.error === 'invalid_client' || /AADSTS7000215|AADSTS700016/.test(body.error_description || '') ? 'invalid_client' : body.error === 'invalid_grant' ? 'invalid_grant' : body.error || `http_${res.status}`;
      throw Object.assign(new Error(describe(code) || body.error_description || body.error || `Microsoft answered HTTP ${res.status}`), { code });
    }
    return body;
  }

  async accessToken() {
    if (this.access && this.access.expiresAt - 60000 > Date.now()) return this.access.token;
    const o = this.secrets.onedrive();
    if (!o?.refreshToken) throw Object.assign(new Error(describe('unauthenticated')), { code: 'unauthenticated' });
    const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: o.refreshToken, scope: SCOPE });
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
    if (body.refresh_token && body.refresh_token !== o.refreshToken) this.secrets.setOnedrive({ ...o, refreshToken: body.refresh_token }); // Microsoft rotates them
    return this.access.token;
  }

  // A Graph call. Throws { code, message, retryAfterMs? } when Microsoft says no.
  async graph(method, pathOrUrl, body = null, headers = {}) {
    const token = await this.accessToken();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${MS.GRAPH}${pathOrUrl}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body == null ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error(`Couldn't reach OneDrive (${err.message})`), { code: 'network' });
    }
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (res.ok) return json;
    const g = json.error || {};
    const code = g.code === 'InvalidAuthenticationToken' || res.status === 401 ? 'unauthenticated_now'
      : g.code === 'itemNotFound' || res.status === 404 ? 'itemNotFound'
        : g.code === 'accessDenied' || res.status === 403 ? 'accessDenied'
          : res.status === 429 ? 'ratelimited' : g.code || `http_${res.status}`;
    if (res.status === 401) this.access = null; // expired early: the next call refreshes it
    const err = new Error(describe(code) || String(g.message || '') || `OneDrive answered HTTP ${res.status}`);
    err.code = code === 'unauthenticated_now' ? 'token_expired' : code;
    if (res.status === 429 || res.status >= 500) {
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after)) err.retryAfterMs = after * 1000;
    }
    throw err;
  }

  // ---- The folder --------------------------------------------------------------------
  // Settings: the folder's sharing link, checked with Graph (it must be a folder the account
  // can see) before it's saved. Returns { status: HTTP code, error?, check? }.
  async setFolder(link) {
    const url = String(link || '').trim();
    if (!/^https:\/\/[\w.-]+\.(sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//i.test(url) && !/^https:\/\/1drv\.ms\//i.test(url)) {
      return { status: 400, error: 'That isn\'t a OneDrive sharing link: in OneDrive, open the folder, Share → Copy link, and paste that (…sharepoint.com/… or 1drv.ms/…).' };
    }
    const o = this.secrets.onedrive();
    if (!o?.refreshToken) return { status: 409, error: 'Sign in with Microsoft first, with an account that can edit the folder.' };
    let item;
    try {
      item = await this.graph('GET', `/shares/${shareId(url)}/driveItem?$select=id,name,folder,webUrl,parentReference`);
    } catch (err) {
      this.check = { status: 'bad', message: err.message, at: Date.now() };
      this.emit('change');
      return { status: 400, error: err.message, check: this.check };
    }
    if (!item.folder) return { status: 400, error: 'That link is to a file, not a folder.' };
    const driveId = item.parentReference?.driveId;
    if (!driveId) return { status: 400, error: 'OneDrive didn\'t say which drive that folder is in: try the folder\'s link from your own OneDrive.' };
    this.secrets.setOnedrive({ ...o, shareUrl: url, driveId, itemId: item.id, folderName: item.name || '', webUrl: item.webUrl || url, enabled: o.enabled !== false });
    this.check = { status: 'ok', message: `Screenshots go to the OneDrive folder "${item.name}" as ${o.account}.`, at: Date.now() };
    this.emit('change');
    return { status: 200, check: this.check };
  }

  setEnabled(on) {
    const o = this.secrets.onedrive();
    if (!o) return;
    this.secrets.setOnedrive({ ...o, enabled: !!on });
    this.emit('change');
  }

  // Signs out and forgets the folder. (Microsoft has no token-revocation endpoint for apps;
  // the account can remove the app under its Microsoft account settings.)
  async signOut() {
    this.secrets.setOnedrive(null);
    this.access = null;
    this.check = null;
    this.emit('change');
  }

  // Settings → Send a test: a small text file into the folder.
  async test() {
    if (!this.configured()) return { ok: false, message: describe('not_set_up') };
    try {
      const name = `IXG Wall test ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')}.txt`;
      await this.upload({ bytes: Buffer.from('IXG Wall is connected: screenshots will be uploaded here.\n'), relPath: name, mime: 'text/plain' });
      this.check = { status: 'ok', message: `Test file "${name}" uploaded to "${this.secrets.onedrive().folderName}".`, at: Date.now() };
      return { ok: true, message: this.check.message };
    } catch (err) {
      this.check = { status: 'bad', message: err.message, at: Date.now() };
      return { ok: false, message: err.message };
    } finally {
      this.emit('change');
    }
  }

  // Queues a screenshot: `relPath` is its path under the Screenshots folder (session/date/feed/name).
  // Resolves { ok, tries, url?, error? } once it's uploaded (url: the file in OneDrive) or given up.
  async post({ file, relPath }) {
    const r = await this.queue.run(() => retrying(async () => {
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        throw Object.assign(new Error('The screenshot file is gone'), { code: 'file_missing' });
      }
      const made = await this.upload({ bytes, relPath, mime: 'image/png' });
      return made.webUrl || null;
    }, { waits: this.waits, final: (err) => FINAL.has(err?.code), onRetry: (e) => this.emit('retry', { file, ...e }) }));
    return r.ok ? { ok: true, tries: r.tries, url: r.value } : r;
  }

  // Into the folder, by path: Graph makes the folders along the way. One PUT up to 4 MB;
  // beyond that, an upload session with the file as one chunk.
  async upload({ bytes, relPath, mime }) {
    const o = this.secrets.onedrive();
    if (!o?.driveId) throw Object.assign(new Error(describe('not_set_up')), { code: 'not_set_up' });
    const rel = relPath.split(/[\\/]/).filter(Boolean).map((p) => encodeURIComponent(p)).join('/');
    const base = `/drives/${encodeURIComponent(o.driveId)}/items/${encodeURIComponent(o.itemId)}:/${rel}`;
    if (bytes.length <= SIMPLE_UPLOAD_MAX) {
      return this.graph('PUT', `${base}:/content?@microsoft.graph.conflictBehavior=rename`, bytes, { 'Content-Type': mime });
    }
    const session = await this.graph('POST', `${base}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } });
    return this.graph('PUT', session.uploadUrl, bytes, { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` });
  }
}

module.exports = { OneDrive, shareId, MS, SCOPE };
