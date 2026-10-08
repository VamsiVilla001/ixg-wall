// User links: the only way into a wall as a user. An admin names a link in Settings and
// shares it; whoever opens it is signed in as a user. A user operates the wall. The admin
// decides when making a link whether it ships the YouTube numbers and ingest health
// (`youtube`, on by default): those are read with the admin's API key and channel sign-ins,
// which stay out of users' pages either way (server.js strips and blocks them). A link can
// be for one session (`session`: its id), so whoever opens it sees that event alone, or
// for every session.
// A link works until it's revoked (or the optional expiry passes); revoking it signs out
// every browser that used it, on its next request.
const crypto = require('crypto');

const ID_FORMAT = /^[a-f0-9]{12}$/;
const TOKEN_FORMAT = /^[\w-]{32}$/;
const NAME_MAX = 60;
const MAX_LINKS = 200;

class UserLinks {
  constructor(secrets) {
    this.secrets = secrets;
  }

  all() {
    const list = this.secrets.data.userLinks;
    return Array.isArray(list) ? list : [];
  }

  // For the admin's list: everything but the token, which only goes into the link itself.
  list(publicUrl) {
    const now = Date.now();
    return this.all().map((l) => ({
      id: l.id,
      name: l.name,
      createdAt: l.createdAt,
      expiresAt: l.expiresAt || null,
      lastUsedAt: l.lastUsedAt || null,
      expired: !!l.expiresAt && Date.parse(l.expiresAt) <= now,
      youtube: l.youtube !== false,
      session: l.session || null,
      url: linkUrl(publicUrl, l.token),
    }));
  }

  // { name, days, youtube, session }: days 0 or missing = until revoked; youtube false = the
  // link carries no YouTube numbers or ingest health; session = the one session it opens.
  create({ name, days, youtube, session } = {}) {
    const label = String(name || '').trim().slice(0, NAME_MAX);
    if (!label) return { error: 'Give the link a name, e.g. who it\'s for.' };
    if (this.all().length >= MAX_LINKS) return { error: `There are already ${MAX_LINKS} links: revoke some first.` };
    const d = Number(days) || 0;
    if (d < 0 || d > 365) return { error: 'Expiry must be between 1 and 365 days, or none.' };
    const now = new Date();
    const link = {
      id: crypto.randomBytes(6).toString('hex'),
      name: label,
      token: crypto.randomBytes(24).toString('base64url'),
      createdAt: now.toISOString(),
      expiresAt: d ? new Date(now.getTime() + d * 86400e3).toISOString() : null,
      youtube: youtube !== false,
      session: typeof session === 'string' && session ? session : null,
      lastUsedAt: null,
    };
    this.secrets.data.userLinks = [...this.all(), link];
    this.secrets.write();
    return { link };
  }

  revoke(id) {
    const before = this.all().length;
    this.secrets.data.userLinks = this.all().filter((l) => l.id !== id);
    if (this.secrets.data.userLinks.length === before) return false;
    this.secrets.write();
    return true;
  }

  // The link a token opens, if it still works. Accepts the whole shared link as pasted.
  find(raw) {
    const token = tokenOf(raw);
    if (!token) return null;
    const given = Buffer.from(token);
    let found = null;
    // Compared with every link in constant time, so timing can't reveal a near miss.
    for (const l of this.all()) {
      const t = Buffer.from(String(l.token || ''));
      if (t.length === given.length && crypto.timingSafeEqual(t, given)) found = l;
    }
    return found && this.isActive(found) ? found : null;
  }

  isActive(link) {
    return !!link && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now());
  }

  // Whether a session made from this link may still be used.
  active(id) {
    return ID_FORMAT.test(id || '') && this.isActive(this.all().find((l) => l.id === id));
  }

  get(id) {
    return this.all().find((l) => l.id === id) || null;
  }

  used(link) {
    link.lastUsedAt = new Date().toISOString();
    this.secrets.write();
  }
}

function linkUrl(publicUrl, token) {
  return `${publicUrl}/join#${token}`;
}

// The token from a whole link (…/join#token), or a bare token.
function tokenOf(raw) {
  const s = String(raw || '').trim();
  const token = s.includes('#') ? s.slice(s.lastIndexOf('#') + 1) : s;
  return TOKEN_FORMAT.test(token) ? token : '';
}

module.exports = { UserLinks, ID_FORMAT };
