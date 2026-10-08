// Sign-in with a Microsoft 365 account (Microsoft Entra ID, OpenID Connect), and who may:
// the organisation's own accounts, so access to the wall (and through the Admin center to
// Slack, Drive and OneDrive) is given and taken away per person, not by a shared password.
//
// The flow is the authorization code flow with PKCE and a nonce, run by this server as a
// confidential client (the app's secret never reaches a browser). The ID token Microsoft
// returns is checked against Microsoft's signing keys, our client ID, the times, the nonce
// and the tenant (ms-token.js) before anyone is let in. Personal Microsoft accounts and
// other organisations are refused: the authority is the organisation's tenant when its ID
// is set with the app, otherwise "organizations", and the organisation of the first admin
// to sign in is remembered and required from then on.
//
// Who gets in is an allow-list kept in the Admin center: each account with a role (admin,
// operator or user) and, if wanted, the sessions it may see. An account is known by its
// Object ID in the tenant (stable), bound on its first sign-in to the email the admin typed;
// its email and name follow later sign-ins. App roles assigned in Entra (IXG.Admin,
// IXG.Operator, IXG.User) also get in, with that role. Optionally everyone in the
// organisation gets in as an operator. IXG_ADMINS (emails or Object IDs, on the server)
// seeds admins so the first one can sign in before anyone is listed.
//
// Microsoft is the main way in; the password is a fallback an admin can switch off (Access
// → password sign-in) once an admin account is listed, and it comes back by itself should
// the Microsoft app be removed.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { MS } = require('./onedrive');
const { verifyIdToken } = require('./ms-token');

const SCOPE = 'openid profile email';
const ROLES = ['admin', 'operator', 'user'];
const APP_ROLES = { 'IXG.Admin': 'admin', 'IXG.Operator': 'operator', 'IXG.User': 'user', 'IXG.Viewer': 'user' };
const STATE_TTL_MS = 10 * 60000;
const SESSION_MS = 8 * 3600e3;    // a Microsoft sign-in lasts this long; the page renews it quietly before then
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACCOUNTS = 500;

// An account's session id, as the cookie carries it (auth.js): 12 hex characters, fixed when
// the account is added, so it survives a change of email.
const accountId = (seed) => crypto.createHash('sha256').update(String(seed).trim().toLowerCase()).digest('hex').slice(0, 12);
const normEmail = (e) => String(e || '').trim().toLowerCase();

class Accounts extends EventEmitter {
  constructor({ secrets, publicUrl, envAdmins = [] }) {
    super();
    this.secrets = secrets;
    this.envAdmins = envAdmins.map((e) => e.toLowerCase());
    this.publicUrl = publicUrl;
    this.redirectUri = `${publicUrl}/api/auth/microsoft/callback`;
    this.pending = new Map(); // sign-in state -> { exp, next, verifier, nonce, silent }
  }

  // Whether "Sign in with Microsoft" can be offered: the Microsoft app is set up.
  enabled() {
    return !!this.secrets.msClient();
  }

  // The organisation accounts must belong to: the app's tenant, else the one remembered from
  // the first admin's sign-in; '' until either is known.
  requiredTenant() {
    return this.secrets.msClient()?.tenantId || this.secrets.access().tenantId || '';
  }

  // Whether the wall password still signs anyone in: always while Microsoft sign-in isn't
  // available (nothing else would get an admin in), otherwise unless switched off.
  passwordAllowed() {
    return !this.enabled() || this.secrets.access().passwordSignIn !== false;
  }

  // Switching the password off needs another way in for an admin: Microsoft sign-in, and
  // an admin account listed for it.
  setPasswordSignIn(on) {
    if (!on) {
      if (!this.enabled()) return { error: 'Microsoft sign-in isn\'t set up yet: the password is the only way in.' };
      if (!this.list().some((a) => a.role === 'admin')) return { error: 'Allow an admin account first, so an admin can still sign in with Microsoft.' };
    }
    this.secrets.setAccess({ passwordSignIn: !!on });
    this.emit('change');
    return {};
  }

  // Everyone who may sign in: env admins first and unremovable (with what their sign-ins
  // taught us), then the saved list (added here, or from an Entra app role).
  list() {
    const saved = this.secrets.accounts();
    const env = this.envAdmins.map((entry) => {
      const bound = saved.find((a) => a.envEntry === entry);
      return {
        id: accountId(entry),
        email: entry.includes('@') ? entry : bound?.email || '',
        oid: bound?.oid || (GUID.test(entry) ? entry : null),
        name: bound?.name || '',
        role: 'admin',
        sessions: null,
        addedAt: null,
        lastSignIn: bound?.lastSignIn || null,
        source: 'env',
      };
    });
    const rest = saved.filter((a) => !a.envEntry).map((a) => ({ sessions: null, oid: null, name: '', ...a, source: a.entra ? 'entra' : 'saved' }));
    return [...env, ...rest];
  }

  find(email) {
    const e = normEmail(email);
    return this.list().find((a) => a.email === e) || null;
  }

  byId(id) {
    return this.list().find((a) => a.id === id) || null;
  }

  // Whether a session with this role may go on: the account is still listed with that role
  // (or, an operator's, the organisation still lets everyone in).
  active(role, id) {
    const a = this.byId(id);
    if (a) return a.role === role;
    return role === 'operator' && this.secrets.access().tenantOperators && id === this.tenantOperatorId();
  }

  // The sessions this account may see: null for all of them.
  scopeOf(id) {
    return this.byId(id)?.sessions || null;
  }

  // Operators let in by the organisation as a whole share one session id, so the switch
  // going off signs them all out.
  tenantOperatorId() {
    const t = this.secrets.access().tenantId;
    return t ? accountId(`tenant:${t}`) : null;
  }

  // Admin center: add an account by email, or change a listed one's role. Returns { error }
  // or { account }.
  add({ email, role, sessions }) {
    const e = normEmail(email);
    if (!EMAIL.test(e) || e.length > 254) return { error: 'Give the account\'s email address, e.g. name@tesseract.gg.' };
    if (!ROLES.includes(role)) return { error: 'The role is admin, operator or user.' };
    if (this.envAdmins.includes(e)) return { error: 'That account is an admin set on the server (IXG_ADMINS): change it there.' };
    const saved = this.secrets.accounts();
    const existing = saved.find((a) => !a.envEntry && a.email === e);
    if (existing) return this.update(existing.id, { role, sessions });
    if (saved.filter((a) => !a.envEntry).length >= MAX_ACCOUNTS) return { error: `There are already ${MAX_ACCOUNTS} accounts.` };
    const scope = cleanSessions(sessions);
    if (scope.error) return scope;
    const account = { id: accountId(e), email: e, role, oid: null, tid: null, name: '', sessions: scope.sessions, addedAt: new Date().toISOString(), lastSignIn: null };
    this.secrets.setAccounts([...saved, account]);
    this.emit('change');
    return { account };
  }

  // A listed account's role or sessions. An account from an Entra app role keeps the role
  // Entra gives it.
  update(id, { role, sessions } = {}) {
    const saved = this.secrets.accounts();
    const a = saved.find((x) => x.id === id && !x.envEntry);
    if (!a) return { error: this.byId(id) ? 'That account is an admin set on the server (IXG_ADMINS): change it there.' : 'No such account.' };
    if (role !== undefined) {
      if (!ROLES.includes(role)) return { error: 'The role is admin, operator or user.' };
      if (a.entra && role !== a.role) return { error: 'This account\'s role comes from an app role assigned in Microsoft Entra: change it there.' };
      a.role = role;
    }
    if (sessions !== undefined) {
      const scope = cleanSessions(sessions);
      if (scope.error) return scope;
      a.sessions = scope.sessions;
    }
    this.secrets.setAccounts(saved);
    this.emit('change');
    return { account: a };
  }

  remove(id) {
    const saved = this.secrets.accounts();
    const next = saved.filter((a) => a.id !== id || a.envEntry);
    if (next.length === saved.length) return false;
    this.secrets.setAccounts(next);
    this.emit('change');
    return true;
  }

  setTenantOperators(on) {
    this.secrets.setAccess({ tenantOperators: !!on });
    this.emit('change');
  }

  // What the Admin center shows: never a token.
  info() {
    const access = this.secrets.access();
    const client = this.secrets.msClient();
    return {
      enabled: this.enabled(),
      passwordSignIn: this.passwordAllowed(),
      redirectUri: this.redirectUri,
      postLogoutRedirectUri: `${this.publicUrl}/login`,
      accounts: this.list().map(({ tid, envEntry, entra, ...a }) => a),
      tenantOperators: access.tenantOperators,
      tenantId: access.tenantId,
      tenantName: access.tenantName,
      appTenantId: client?.tenantId || '',
      sessionHours: SESSION_MS / 3600e3,
    };
  }

  // ---- The sign-in round trip ----
  // silent: a renewal from the page's hidden frame (prompt=none): no account picker, and
  // Microsoft answers at once whether its own session still stands.
  authUrl(next = '/', { silent = false } = {}) {
    const client = this.secrets.msClient();
    if (!client) throw new Error('Microsoft sign-in isn\'t set up: an admin adds the Microsoft app under Admin center → Where screenshots go → OneDrive.');
    const now = Date.now();
    for (const [s, p] of this.pending) if (p.exp < now) this.pending.delete(s);
    if (this.pending.size > 1000) this.pending.clear(); // a flood of starts never finished: none of them is worth keeping
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    this.pending.set(state, { exp: now + STATE_TTL_MS, next: /^\/(?![/\\])/.test(next) ? next : '/', verifier, nonce, silent });
    return `${MS.authUrl(client.tenantId)}?${new URLSearchParams({
      client_id: client.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: SCOPE,
      prompt: silent ? 'none' : 'select_account',
      state,
      nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })}`;
  }

  // Where to send the browser after signing out, so Microsoft ends its side too and comes
  // back to the sign-in page.
  logoutUrl() {
    const client = this.secrets.msClient();
    if (!client) return null;
    return `${MS.logoutUrl(client.tenantId)}?${new URLSearchParams({ post_logout_redirect_uri: `${this.publicUrl}/login?signedout=1` })}`;
  }

  // Whether this state belongs to a silent renewal (the callback answers the frame, not the
  // browser), read before finishing.
  isSilent(state) {
    return !!this.pending.get(state)?.silent;
  }

  // Microsoft sent the browser back with ?code&state. Returns { id, email, role, name,
  // sessions, next, silent }, or throws with why not (in words for the sign-in page).
  async finish({ code, state, error, errorDescription }) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.exp < Date.now()) throw new Error('This sign-in link expired or was already used. Start again.');
    if (error) {
      if (error === 'access_denied') throw new Error('Sign-in was cancelled.');
      if (['login_required', 'interaction_required', 'consent_required'].includes(error)) throw Object.assign(new Error('Microsoft needs you to sign in again.'), { code: 'interaction' });
      throw new Error(`Microsoft said: ${String(errorDescription || error).split('\n')[0].slice(0, 200)}`);
    }
    if (!code) throw new Error('Microsoft sent no authorisation code.');
    const client = this.secrets.msClient();
    if (!client) throw new Error('Microsoft sign-in isn\'t set up.');
    let res;
    try {
      res = await fetch(MS.tokenUrl(client.tenantId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, scope: SCOPE, code_verifier: pending.verifier }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Microsoft (${err.message}).`);
    }
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Microsoft refused the sign-in: ${String(tokens.error_description || tokens.error || `HTTP ${res.status}`).split('\n')[0].slice(0, 200)}`);
    // Who this is, from the ID token alone, once it checks out.
    const claims = await verifyIdToken(tokens.id_token, {
      jwksUrl: MS.jwksUrl(client.tenantId),
      issuer: MS.issuer,
      clientId: client.clientId,
      nonce: pending.nonce,
      tenantId: this.requiredTenant(),
      personalTenant: MS.PERSONAL_TENANT,
    });
    const oid = claims.oid.toLowerCase();
    const tenantId = claims.tid.toLowerCase();
    // The sign-in name (UPN) of a work account: set by the organisation on its own verified
    // domains. The optional "email" claim isn't verified by Microsoft, so it never names anyone here.
    const email = normEmail(claims.preferred_username);
    const name = String(claims.name || email || oid).slice(0, 120);
    // The app role assigned in Entra, if any.
    const appRole = (Array.isArray(claims.roles) ? claims.roles : []).map((r) => APP_ROLES[r]).filter(Boolean)
      .sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b))[0] || null;
    // The account: by Object ID first (it survives renames), else by the email the admin typed.
    const listed = this.list();
    let account = listed.find((a) => a.oid === oid) || (email ? listed.find((a) => !a.oid && a.email === email) : null) || null;
    const access = this.secrets.access();
    let role = account?.role || null;
    let id = account?.id || null;
    let sessions = account?.sessions || null;
    const saved = this.secrets.accounts();
    if (appRole && account?.source !== 'env') {
      // Entra's say is the organisation's: it sets the role, and lists the account if nobody did.
      role = appRole;
      if (!account) {
        id = accountId(`oid:${oid}`);
        sessions = null;
        saved.push({ id, email, role, oid, tid: tenantId, name, sessions: null, addedAt: new Date().toISOString(), lastSignIn: null, entra: true });
        account = { id, source: 'entra' };
      }
    }
    if (!role && access.tenantOperators && tenantId === access.tenantId) {
      role = 'operator';
      id = this.tenantOperatorId();
    }
    if (!role) throw new Error(`${email || 'This account'} isn't allowed in: an admin adds accounts under Admin center → Access.`);
    // Remembered: the Object ID, the current email and name, the last sign-in; and from an
    // admin's sign-in, which organisation this is.
    const now = new Date().toISOString();
    if (account?.source === 'env') {
      const entry = this.envAdmins.find((e) => e === email || e === oid) || this.envAdmins.find((e) => accountId(e) === id);
      let shadow = saved.find((a) => a.envEntry === entry);
      if (!shadow) {
        shadow = { envEntry: entry, id, email, oid, name, lastSignIn: null };
        saved.push(shadow);
      }
      Object.assign(shadow, { email, oid, name, lastSignIn: now });
    } else if (account) {
      const mine = saved.find((a) => a.id === id);
      if (mine) Object.assign(mine, { oid, tid: tenantId, email: email || mine.email, name, lastSignIn: now, ...(mine.entra ? { role } : {}) });
    }
    this.secrets.setAccounts(saved);
    if (role === 'admin' && access.tenantId !== tenantId) this.secrets.setAccess({ tenantId, tenantName: email.split('@')[1] || '' });
    this.emit('change');
    return { id, email, role, name, sessions, next: pending.next, silent: pending.silent };
  }
}

// The sessions an account may see: null (all), or 1..50 session ids.
function cleanSessions(sessions) {
  if (sessions == null || sessions === '' || sessions === 'all') return { sessions: null };
  if (!Array.isArray(sessions)) return { error: 'The sessions are a list of session ids, or none for all of them.' };
  const ids = [...new Set(sessions.map((s) => String(s || '').trim()).filter(Boolean))];
  if (!ids.length) return { sessions: null };
  if (ids.length > 50 || ids.some((s) => !/^[\w-]{1,64}$/.test(s))) return { error: 'The sessions are a list of session ids, or none for all of them.' };
  return { sessions: ids };
}

module.exports = { Accounts, accountId, ROLES, SCOPE, SESSION_MS, APP_ROLES };
