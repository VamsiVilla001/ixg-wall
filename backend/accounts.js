// Sign-in with a Microsoft 365 account, and who may: the organisation's own accounts, so
// access to the wall (and through the Admin center to Slack, Drive and OneDrive) is given
// and taken away by email, not by a shared password.
//
// It uses the Microsoft app registered for OneDrive (secrets.js msClient), with one more
// Web redirect URI: PUBLIC_URL/api/auth/microsoft/callback. Who gets in is an allow-list
// kept in the Admin center: each email with a role (admin, operator or user); optionally
// everyone in the organisation (the tenant) as an operator. IXG_ADMINS seeds admins so the
// first one can sign in before anyone is listed. The password sign-in stays, as the way in
// when Microsoft or the app is unavailable.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { MS } = require('./onedrive');

const SCOPE = 'openid profile email User.Read';
const ROLES = ['admin', 'operator', 'user'];
const STATE_TTL_MS = 10 * 60000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCOUNTS = 500;

// An account's session id, as the cookie carries it (auth.js): 12 hex characters of its email.
const accountId = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 12);

// The claims of an ID token from Microsoft's token endpoint (reached over TLS with the app's
// secret, so they're taken as given; the token isn't shown to anyone).
function claimsOf(idToken) {
  try {
    const [, payload] = String(idToken || '').split('.');
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return {};
  }
}

class Accounts extends EventEmitter {
  constructor({ secrets, publicUrl, envAdmins = [] }) {
    super();
    this.secrets = secrets;
    this.envAdmins = envAdmins.map((e) => e.toLowerCase());
    this.redirectUri = `${publicUrl}/api/auth/microsoft/callback`;
    this.pending = new Map(); // sign-in state -> { exp, next }
  }

  // Whether "Sign in with Microsoft" can be offered: the Microsoft app is set up.
  enabled() {
    return !!this.secrets.msClient();
  }

  // Everyone who may sign in, newest first; env admins first and unremovable.
  list() {
    const saved = this.secrets.accounts().map((a) => ({ ...a, source: 'saved' }));
    const env = this.envAdmins.filter((e) => !saved.some((a) => a.email === e)).map((e) => ({ id: accountId(e), email: e, role: 'admin', addedAt: null, lastSignIn: null, source: 'env' }));
    return [...env, ...saved];
  }

  find(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.list().find((a) => a.email === e) || null;
  }

  // Whether a session with this role may go on: the account is still listed with that role
  // (or, an operator's, the organisation still lets everyone in).
  active(role, id) {
    const a = this.list().find((x) => x.id === id);
    if (a) return a.role === role;
    return role === 'operator' && this.secrets.access().tenantOperators && id === this.tenantOperatorId();
  }

  // Operators let in by the organisation as a whole share one session id, so the switch
  // going off signs them all out.
  tenantOperatorId() {
    const t = this.secrets.access().tenantId;
    return t ? accountId(`tenant:${t}`) : null;
  }

  // Admin center: add or change an account. Returns { error } or { account }.
  add({ email, role }) {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL.test(e) || e.length > 254) return { error: 'Give the account\'s email address, e.g. name@tesseract.gg.' };
    if (!ROLES.includes(role)) return { error: 'The role is admin, operator or user.' };
    if (this.envAdmins.includes(e)) return { error: 'That account is an admin set on the server (IXG_ADMINS): change it there.' };
    const saved = this.secrets.accounts();
    const existing = saved.find((a) => a.email === e);
    if (!existing && saved.length >= MAX_ACCOUNTS) return { error: `There are already ${MAX_ACCOUNTS} accounts.` };
    const account = existing ? { ...existing, role } : { id: accountId(e), email: e, role, addedAt: new Date().toISOString(), lastSignIn: null };
    this.secrets.setAccounts([...saved.filter((a) => a.email !== e), account]);
    this.emit('change');
    return { account };
  }

  remove(id) {
    const saved = this.secrets.accounts();
    const next = saved.filter((a) => a.id !== id);
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
    return {
      enabled: this.enabled(),
      redirectUri: this.redirectUri,
      accounts: this.list(),
      tenantOperators: access.tenantOperators,
      tenantId: access.tenantId,
      tenantName: access.tenantName,
    };
  }

  // ---- The sign-in round trip ----
  authUrl(next = '/') {
    const client = this.secrets.msClient();
    if (!client) throw new Error('Microsoft sign-in isn\'t set up: an admin adds the Microsoft app under Admin center → Where screenshots go → OneDrive.');
    const now = Date.now();
    for (const [s, p] of this.pending) if (p.exp < now) this.pending.delete(s);
    const state = crypto.randomBytes(24).toString('base64url');
    this.pending.set(state, { exp: now + STATE_TTL_MS, next: /^\/(?![/\\])/.test(next) ? next : '/' });
    return `${MS.AUTH_URL}?${new URLSearchParams({
      client_id: client.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: SCOPE,
      prompt: 'select_account',
      state,
    })}`;
  }

  // Microsoft sent the browser back with ?code&state. Returns { id, email, role, next }, or
  // throws with why not (in words for the sign-in page).
  async finish({ code, state, error, errorDescription }) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.exp < Date.now()) throw new Error('This sign-in link expired or was already used. Start again.');
    if (error) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Microsoft said: ${errorDescription || error}`);
    if (!code) throw new Error('Microsoft sent no authorisation code.');
    const client = this.secrets.msClient();
    if (!client) throw new Error('Microsoft sign-in isn\'t set up.');
    let res;
    try {
      res = await fetch(MS.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, scope: SCOPE }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Microsoft (${err.message}).`);
    }
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Microsoft refused the sign-in: ${String(tokens.error_description || tokens.error || `HTTP ${res.status}`).split('\n')[0].slice(0, 200)}`);
    let me;
    try {
      const r = await fetch(`${MS.GRAPH}/me?$select=userPrincipalName,mail,displayName`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000) });
      me = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(me.error?.message || `HTTP ${r.status}`);
    } catch (err) {
      throw new Error(`Microsoft signed you in but didn't say who you are (${err.message}).`);
    }
    const claims = claimsOf(tokens.id_token);
    const email = String(me.mail || me.userPrincipalName || claims.preferred_username || claims.email || '').trim().toLowerCase();
    if (!email) throw new Error('Microsoft didn\'t give an email address for this account.');
    const tenantId = String(claims.tid || '');
    const account = this.find(email);
    const access = this.secrets.access();
    let role = account?.role || null;
    let id = account?.id || null;
    if (!role && access.tenantOperators && tenantId && tenantId === access.tenantId) {
      role = 'operator';
      id = this.tenantOperatorId();
    }
    if (!role) throw new Error(`${email} isn't allowed in: an admin adds accounts under Admin center → Access.`);
    // Remembered: when they last signed in, and (from an admin's sign-in) which organisation this is.
    const saved = this.secrets.accounts();
    const mine = saved.find((a) => a.id === id);
    if (mine) {
      mine.lastSignIn = new Date().toISOString();
      this.secrets.setAccounts(saved);
    }
    if (role === 'admin' && tenantId && access.tenantId !== tenantId) this.secrets.setAccess({ tenantId, tenantName: email.split('@')[1] || '' });
    this.emit('change');
    return { id, email, role, name: me.displayName || email, next: pending.next };
  }
}

module.exports = { Accounts, accountId, ROLES, SCOPE };
