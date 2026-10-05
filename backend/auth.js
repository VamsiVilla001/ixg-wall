// Sign-in for a hosted wall, with two roles and no usernames:
//   admin  the wall password (IXG_PASSWORD): everything, including the Google integrations
//   user   a link an admin generated (user-links.js): operates the wall, never sees the
//          YouTube API key, the OAuth client or the channel sign-ins
// The session is a signed cookie naming the role (and the user link). With no password set
// (the laptop wall) every request is an admin's, as before.
const crypto = require('crypto');

const COOKIE = 'ixg_session';
const SESSION_DAYS = 30;           // a wall left running on a monitor mustn't sign itself out mid-event
const MAX_FAILS = 10;              // failed sign-ins allowed per address...
const FAIL_WINDOW_MS = 15 * 60000; // ...per this window
const FAIL_DELAY_MS = 400;         // every wrong password waits this long

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

class Auth {
  constructor({ password, secret, secure, linkActive = () => false }) {
    this.enabled = !!password;
    this.secure = !!secure;
    this.passwordHash = this.enabled ? sha256(password) : null;
    // The signing key depends on the password, so changing IXG_PASSWORD signs everyone out.
    this.key = this.enabled ? crypto.createHmac('sha256', secret).update(this.passwordHash).digest() : null;
    this.fails = new Map(); // address -> { count, resetAt }
    this.linkActive = linkActive; // whether a user link still works (not revoked or expired)
  }

  checkPassword(attempt) {
    if (!this.enabled || typeof attempt !== 'string') return false;
    return crypto.timingSafeEqual(sha256(attempt), this.passwordHash);
  }

  // v2 names the role, so cookies from before roles (v1) no longer sign anyone in.
  sign(exp, role, link) {
    return crypto.createHmac('sha256', this.key).update(`v2.${exp}.${role}.${link}`).digest('base64url');
  }

  // Token: <expiry ms>.<role>.<user link id, or ->.<signature>. Returns { role, linkId } or
  // null. A user's session ends as soon as their link is revoked.
  read(token) {
    const m = /^(\d{12,16})\.(admin|user)\.([a-f0-9]{12}|-)\.([\w-]{43})$/.exec(token || '');
    if (!m || Number(m[1]) < Date.now()) return null;
    const [, exp, role, link, sig] = m;
    if ((role === 'user') !== (link !== '-')) return null;
    const expected = Buffer.from(this.sign(exp, role, link));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (role === 'user' && !this.linkActive(link)) return null;
    return { role, linkId: role === 'user' ? link : null };
  }

  // Who is asking: { role, linkId }, or null when not signed in. Always an admin when no
  // password is set.
  session(req) {
    if (!this.enabled) return { role: 'admin', linkId: null };
    return this.read(readCookie(req.headers.cookie, COOKIE));
  }

  allows(req) {
    return !!this.session(req);
  }

  // An admin's session, or a user's from a link (ending when the link expires, if it does).
  sessionCookie(role = 'admin', linkId = null, until = Infinity) {
    const exp = Math.min(Date.now() + SESSION_DAYS * 86400e3, until);
    const link = linkId || '-';
    return cookie(`${exp}.${role}.${link}.${this.sign(exp, role, link)}`, Math.max(1, Math.floor((exp - Date.now()) / 1000)), this.secure);
  }

  clearCookie() {
    return cookie('', 0, this.secure);
  }

  // Seconds until this address may try again, or 0. Only failures count, so signing in
  // correctly never locks anyone out by itself.
  lockedFor(addr) {
    const f = this.fails.get(addr);
    if (!f) return 0;
    if (f.resetAt <= Date.now()) {
      this.fails.delete(addr);
      return 0;
    }
    return f.count >= MAX_FAILS ? Math.ceil((f.resetAt - Date.now()) / 1000) : 0;
  }

  failed(addr) {
    const now = Date.now();
    if (this.fails.size > 5000) {
      for (const [a, f] of this.fails) if (f.resetAt <= now) this.fails.delete(a);
    }
    const f = this.fails.get(addr);
    if (!f || f.resetAt <= now) this.fails.set(addr, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    else f.count += 1;
    return new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
  }

  succeeded(addr) {
    this.fails.delete(addr);
  }
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function cookie(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// The visitor's address. Behind the local reverse proxy (Caddy) the socket is loopback and
// the proxy names the real client in X-Forwarded-For.
function clientAddress(req) {
  const peer = req.socket.remoteAddress || '';
  if (/^(::1|127\.|::ffff:127\.)/.test(peer)) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return peer;
}

module.exports = { Auth, clientAddress };
