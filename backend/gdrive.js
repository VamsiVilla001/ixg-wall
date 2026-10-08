// Google Drive as a screenshot destination: each screenshot is uploaded into a folder the
// operator pasted a link to, under the same session/date/feed folders as on disk.
//
// It signs in with the same Google OAuth client as the channel sign-in (google-credentials.js)
// but as a sign-in of its own, with Drive access (`drive`: the folder is one someone shared,
// which the narrower drive.file scope can't write into), from whichever Google account can
// edit that folder. The Google Cloud project needs the Google Drive API enabled. The refresh
// token stays on the server (secrets.js); pages see the account's email and the folder.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { GOOGLE } = require('./google-credentials');
const { retrying, Queue } = require('./retry');

const GDRIVE = {
  API: process.env.IXG_GDRIVE_API || 'https://www.googleapis.com/drive/v3',
  UPLOAD: process.env.IXG_GDRIVE_UPLOAD || 'https://www.googleapis.com/upload/drive/v3',
};
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TIMEOUT_MS = 60000;
// Errors that waiting won't fix: the sign-in is gone, or the folder is.
const FINAL = new Set(['invalid_grant', 'notFound', 'insufficientPermissions', 'forbidden', 'accessNotConfigured', 'SERVICE_DISABLED', 'file_missing', 'not_set_up']);

// The folder id from what an operator pastes: a link to a Drive folder, or the id itself.
function folderIdFrom(text) {
  const raw = String(text || '').trim();
  const m = /\/folders\/([\w-]{10,})/.exec(raw) || /[?&]id=([\w-]{10,})/.exec(raw);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(raw) ? raw : null;
}

const describe = (code, what = 'the folder') => ({
  invalid_grant: 'The Drive sign-in expired or was revoked: sign in again.',
  notFound: `Google Drive has no such folder, or this account can't see it: check the link, and that ${what} is shared with the signed-in account.`,
  forbidden: `The signed-in account can't write into ${what}: share it with that account as an editor.`,
  insufficientPermissions: 'This sign-in doesn\'t allow Drive: sign in again and allow access to Google Drive.',
  accessNotConfigured: 'The Google Drive API isn\'t enabled in the OAuth client\'s Google Cloud project: enable it there, then wait a few minutes.',
  SERVICE_DISABLED: 'The Google Drive API isn\'t enabled in the OAuth client\'s Google Cloud project: enable it there, then wait a few minutes.',
  not_set_up: 'Google Drive isn\'t set up.',
}[code] || null);

class GoogleDrive extends EventEmitter {
  constructor({ secrets, credentials }) {
    super();
    this.secrets = secrets;
    this.credentials = credentials; // the OAuth client and token requests
    this.access = null;             // { token, expiresAt }
    this.queue = new Queue();
    this.folders = new Map();       // "parentId/name" -> folder id, found or made before
    this.check = null;              // what Google said last: { status, message, at }
    this.waits = undefined;         // retry waits (retry.js's by default; tests shorten them)
  }

  static get SCOPE() {
    return SCOPE;
  }

  configured() {
    const g = this.secrets.gdrive();
    return !!(g?.refreshToken && g.folderId && g.enabled !== false);
  }

  // What a page may know: never the token.
  info() {
    const g = this.secrets.gdrive();
    return {
      signedIn: !!g?.refreshToken,
      email: g?.email || '',
      folder: g?.folderId ? { id: g.folderId, name: g.folderName || '', url: g.folderUrl || '' } : null,
      enabled: g ? g.enabled !== false : false,
      configured: this.configured(),
      check: this.check,
      pending: this.queue.pending,
    };
  }

  // The sign-in came back (google-credentials.js finish(), purpose 'drive'): remember the
  // account, keep any folder already chosen.
  async finish(tokens) {
    const access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
    const me = await this.call('GET', `${GDRIVE.API}/about?fields=user(emailAddress,displayName)`, null, access.token);
    const email = me.user?.emailAddress || '';
    const g = this.secrets.gdrive() || {};
    this.access = access;
    this.secrets.setGdrive({ ...g, refreshToken: tokens.refresh_token, email, savedAt: new Date().toISOString(), enabled: g.enabled !== false });
    this.check = { status: 'ok', message: `Signed in to Google Drive as ${email}.${g.folderId ? '' : ' Now paste the folder\'s link.'}`, at: Date.now() };
    this.emit('change');
    return email;
  }

  async accessToken() {
    if (this.access && this.access.expiresAt - 60000 > Date.now()) return this.access.token;
    const g = this.secrets.gdrive();
    if (!g?.refreshToken) throw Object.assign(new Error(describe('not_set_up')), { code: 'not_set_up' });
    const body = await this.credentials.tokenRequest({ grant_type: 'refresh_token', refresh_token: g.refreshToken });
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
    return this.access.token;
  }

  // A Drive API call. Throws { code, message, retryAfterMs? } when Google says no.
  async call(method, url, body = null, token = null, headers = {}) {
    const tok = token || await this.accessToken();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${tok}`, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body == null ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error(`Couldn't reach Google Drive (${err.message})`), { code: 'network' });
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const e = json.error || {};
    const reasons = [...(e.errors || []).map((x) => x.reason), ...(e.details || []).map((d) => d.reason)].filter(Boolean);
    const code = reasons.find((r) => FINAL.has(r)) || (res.status === 401 ? 'invalid_grant' : res.status === 429 ? 'ratelimited' : res.status === 404 ? 'notFound' : res.status === 403 ? 'forbidden' : `http_${res.status}`);
    if (res.status === 401) this.access = null;
    const err = new Error(describe(code) || String(e.message || '').replace(/<[^>]*>/g, '') || `Google Drive answered HTTP ${res.status}`);
    err.code = code;
    if (res.status === 429 || res.status >= 500) {
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after)) err.retryAfterMs = after * 1000;
    }
    throw err;
  }

  // Settings: the folder link. Checked with Drive (the account must be able to add to it)
  // before it's saved. Returns { status: HTTP code, error?, check? }.
  async setFolder(link) {
    const id = folderIdFrom(link);
    if (!id) return { status: 400, error: 'That isn\'t a Google Drive folder link (drive.google.com/drive/folders/…) or folder id.' };
    const g = this.secrets.gdrive();
    if (!g?.refreshToken) return { status: 409, error: 'Sign in to Google Drive first, with an account that can edit the folder.' };
    let f;
    try {
      f = await this.call('GET', `${GDRIVE.API}/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: 'id,name,mimeType,webViewLink,capabilities(canAddChildren)', supportsAllDrives: 'true' })}`);
    } catch (err) {
      this.check = { status: 'bad', message: err.message, at: Date.now() };
      this.emit('change');
      return { status: 400, error: err.message, check: this.check };
    }
    if (f.mimeType !== FOLDER_MIME) return { status: 400, error: 'That link is to a file, not a folder.' };
    if (f.capabilities?.canAddChildren === false) return { status: 400, error: describe('forbidden', `"${f.name}"`) };
    this.secrets.setGdrive({ ...g, folderId: f.id, folderName: f.name, folderUrl: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`, enabled: g.enabled !== false });
    this.folders.clear();
    this.check = { status: 'ok', message: `Screenshots go to the Drive folder "${f.name}" as ${g.email}.`, at: Date.now() };
    this.emit('change');
    return { status: 200, check: this.check };
  }

  setEnabled(on) {
    const g = this.secrets.gdrive();
    if (!g) return;
    this.secrets.setGdrive({ ...g, enabled: !!on });
    this.emit('change');
  }

  // Signs out and forgets the folder; withdraws the wall's access at Google (best effort).
  async signOut() {
    const g = this.secrets.gdrive();
    this.secrets.setGdrive(null);
    this.access = null;
    this.folders.clear();
    this.check = null;
    this.emit('change');
    if (g?.refreshToken) await fetch(`${GOOGLE.REVOKE_URL}?${new URLSearchParams({ token: g.refreshToken })}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
  }

  // Settings → Send a test: a small text file into the folder.
  async test() {
    if (!this.configured()) return { ok: false, message: describe('not_set_up') };
    try {
      const name = `IXG Wall test ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')}.txt`;
      await this.upload({ bytes: Buffer.from('IXG Wall is connected: screenshots will be uploaded here.\n'), name, relFolders: [], mime: 'text/plain' });
      this.check = { status: 'ok', message: `Test file "${name}" uploaded to "${this.secrets.gdrive().folderName}".`, at: Date.now() };
      return { ok: true, message: this.check.message };
    } catch (err) {
      this.check = { status: 'bad', message: err.message, at: Date.now() };
      return { ok: false, message: err.message };
    } finally {
      this.emit('change');
    }
  }

  // Queues a screenshot: `relPath` is its path under the Screenshots folder (session/date/feed/name).
  // Resolves { ok, tries, url?, error? } once it's uploaded (url: the file in Drive) or given up.
  async post({ file, relPath }) {
    const r = await this.queue.run(() => retrying(async () => {
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        throw Object.assign(new Error('The screenshot file is gone'), { code: 'file_missing' });
      }
      const parts = relPath.split(/[\\/]/).filter(Boolean);
      const made = await this.upload({ bytes, name: parts.pop(), relFolders: parts, mime: 'image/png' });
      return made.webViewLink || (made.id ? `https://drive.google.com/file/d/${made.id}/view` : null);
    }, { waits: this.waits, final: (err) => FINAL.has(err?.code), onRetry: (e) => this.emit('retry', { file, ...e }) }));
    return r.ok ? { ok: true, tries: r.tries, url: r.value } : r;
  }

  // The folder for a path under the destination folder, found or made one level at a time.
  async folderFor(relFolders) {
    const g = this.secrets.gdrive();
    if (!g?.folderId) throw Object.assign(new Error(describe('not_set_up')), { code: 'not_set_up' });
    let parent = g.folderId;
    for (const name of relFolders) {
      const key = `${parent}/${name}`;
      let id = this.folders.get(key);
      if (!id) {
        const q = `'${parent}' in parents and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
        const found = await this.call('GET', `${GDRIVE.API}/files?${new URLSearchParams({ q, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '1' })}`);
        id = found.files?.[0]?.id;
        if (!id) {
          const made = await this.call('POST', `${GDRIVE.API}/files?${new URLSearchParams({ fields: 'id', supportsAllDrives: 'true' })}`, { name, mimeType: FOLDER_MIME, parents: [parent] });
          id = made.id;
        }
        this.folders.set(key, id);
      }
      parent = id;
    }
    return parent;
  }

  // One multipart upload: the metadata (name, parent) and the bytes together.
  async upload({ bytes, name, relFolders, mime }) {
    const parent = await this.folderFor(relFolders);
    const boundary = `ixg${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name, parents: [parent] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.call('POST', `${GDRIVE.UPLOAD}/files?${new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name,webViewLink' })}`, body, null, { 'Content-Type': `multipart/related; boundary=${boundary}` });
  }
}

module.exports = { GoogleDrive, folderIdFrom, GDRIVE, SCOPE };
