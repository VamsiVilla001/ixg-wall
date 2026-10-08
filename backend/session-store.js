// The sessions kept by the backend (wall.json), so every window and browser profile,
// including the managed wall window, sees the same ones.
//
// A session is one event's wall: its feeds, its settings and its name, with its own id.
// Any number can be live at once: a live session's feeds load in the windows that open it
// (/s/<id>), are polled for YouTube numbers, and get screenshots. An archived session keeps
// its feeds but does none of that, until it's reopened. Nothing one session does reaches
// another: each has its own version, event stream and screenshot folder.
//
// Before this, wall.json held one active session (`wall.session`, `wall.streams`) and a list
// of `savedSessions`; that shape is read once and becomes a live session plus archived ones.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const WALL_FILE = path.join(DATA_DIR, 'wall.json');
const VIDEO_ID = /^[\w-]{11}$/;
const SESSION_ID = /^[\w-]{1,64}$/;
const MAX_STREAMS = 200;
const MAX_SESSIONS = 200;
const SESSION_NAME_MAX = 80;

class SessionStore {
  constructor() {
    this.version = 0;      // bumps on every change to any session or the list
    this.sessions = [];    // [{ id, name, startedAt, endedAt, timeZone, live, version, settings, streams }]
    this.legacyKey = '';   // a YouTube key found in an older wall.json, for the server to move out
    this.migrated = false; // the file was in an older shape and was rewritten
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(WALL_FILE, 'utf8'));
    } catch {
      // no wall saved yet
    }
    if (Array.isArray(saved?.sessions)) {
      this.sessions = saved.sessions.filter((s) => validSession(s) && validStreams(s.streams) && validSettings(s.settings))
        .map((s) => ({ ...s, live: !!s.live, version: Number(s.version) || 1 }));
      this.version = Number(saved.version) || 1;
      for (const s of this.sessions) this.legacyKey = stripSecrets(s) || this.legacyKey;
    } else if (saved?.wall && validSettings(saved.wall.settings) && validStreams(saved.wall.streams)) {
      // One active session and its saved ones, from before several could be live.
      const wall = saved.wall;
      this.legacyKey = stripSecrets(wall);
      const at = saved.savedAt || new Date().toISOString();
      const settings = wall.settings;
      const active = wall.session && validSession(wall.session)
        ? { ...wall.session, live: true, version: Number(saved.version) || 1, settings, streams: wall.streams }
        : null;
      const earlier = !active && wall.streams.length
        ? [{ id: crypto.randomUUID(), name: 'Before sessions', startedAt: at, endedAt: at, live: false, version: 1, settings, streams: wall.streams }]
        : [];
      const archived = (Array.isArray(wall.savedSessions) ? wall.savedSessions : [])
        .filter((s) => validSession(s) && validStreams(s.streams))
        .map((s) => ({ ...s, live: false, version: 1, settings: { ...settings }, streams: s.streams }));
      this.sessions = [...(active ? [active] : []), ...earlier, ...archived].slice(0, MAX_SESSIONS);
      this.version = Number(saved.version) || 1;
      this.migrated = true;
    }
  }

  // Newest first: what the Session panel lists. Feeds themselves aren't in it.
  list() {
    return this.sessions
      .map((s) => ({ id: s.id, name: s.name, startedAt: s.startedAt || null, endedAt: s.endedAt || null, timeZone: s.timeZone || null, live: s.live, feeds: s.streams.length, version: s.version }))
      .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
  }

  get(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  live() {
    return this.sessions.filter((s) => s.live);
  }

  // The session a window with no session in its address opens: the live one started most
  // recently. With none live, a new empty one, so there's always a wall to show.
  default() {
    const live = this.list().find((s) => s.live);
    return live ? this.get(live.id) : this.create({ name: 'New session' });
  }

  // Every live session's feeds, each with the session it belongs to and that session's
  // settings: what the YouTube pollers and the screenshot queue work from.
  feeds() {
    const out = [];
    for (const s of this.live()) {
      for (const stream of s.streams) out.push({ ...stream, session: { id: s.id, name: s.name }, settings: s.settings });
    }
    return out;
  }

  // What a window gets: one session's wall, plus the list of all sessions for the panel.
  wallOf(id) {
    const s = this.get(id);
    if (!s) return null;
    return {
      version: s.version,
      wall: {
        settings: s.settings,
        streams: s.streams,
        session: { id: s.id, name: s.name, startedAt: s.startedAt || null, endedAt: s.endedAt || null, timeZone: s.timeZone || null, live: s.live },
        sessions: this.list(),
      },
    };
  }

  // A window saved its session's wall: feeds, settings and the session's name. Returns the
  // session's new version, or null if the wall was rejected.
  save(id, wall) {
    const s = this.get(id);
    if (!s || !wall || typeof wall !== 'object') return null;
    if (!validSettings(wall.settings) || !validStreams(wall.streams)) return null;
    const name = wall.session && typeof wall.session === 'object' ? wall.session.name : undefined;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > SESSION_NAME_MAX)) return null;
    stripSecrets(wall); // a page from before the key moved server-side may still send it
    s.settings = wall.settings;
    s.streams = wall.streams;
    if (name !== undefined) s.name = name.trim();
    if (wall.session?.timeZone && typeof wall.session.timeZone === 'string' && wall.session.timeZone.length <= 64 && !s.timeZone) s.timeZone = wall.session.timeZone;
    s.version += 1;
    this.write();
    return s.version;
  }

  // A new live session, empty, with the newest session's settings (layout, quality, polling)
  // so an event starts the way the last one ran.
  create({ name, timeZone = null } = {}) {
    const label = String(name || '').trim().slice(0, SESSION_NAME_MAX) || 'New session';
    if (this.sessions.length >= MAX_SESSIONS) throw new Error(`There are already ${MAX_SESSIONS} sessions: delete some first.`);
    const newest = this.list()[0];
    const settings = newest ? { ...this.get(newest.id).settings } : {};
    const s = {
      id: crypto.randomUUID(),
      name: label,
      startedAt: new Date().toISOString(),
      endedAt: null,
      timeZone: typeof timeZone === 'string' && timeZone.length <= 64 ? timeZone : null,
      live: true,
      version: 1,
      settings,
      streams: [],
    };
    this.sessions.push(s);
    this.write();
    return s;
  }

  // Archived: kept with its feeds, no longer polled, screenshotted or loaded. Reopened: live again.
  archive(id) {
    const s = this.get(id);
    if (!s || !s.live) return false;
    s.live = false;
    s.endedAt = new Date().toISOString();
    s.version += 1;
    this.write();
    return true;
  }

  reopen(id) {
    const s = this.get(id);
    if (!s || s.live) return false;
    s.live = true;
    s.endedAt = null;
    s.version += 1;
    this.write();
    return true;
  }

  // Only an archived session can be deleted: a live one is archived first.
  remove(id) {
    const s = this.get(id);
    if (!s || s.live) return false;
    this.sessions = this.sessions.filter((x) => x !== s);
    this.write();
    return true;
  }

  write() {
    this.version += 1;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${WALL_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: this.version, savedAt: new Date().toISOString(), sessions: this.sessions }, null, 2));
    fs.renameSync(tmp, WALL_FILE); // never leave a half-written wall behind
  }
}

// The YouTube key lives in secrets.json, never in the wall every page downloads.
// Removes it from a session's settings and returns it ('' if there was none).
function stripSecrets(s) {
  if (!s?.settings || !('ytApiKey' in s.settings)) return '';
  const key = s.settings.ytApiKey;
  delete s.settings.ytApiKey;
  return typeof key === 'string' ? key.trim() : '';
}

// A feed's own quality, when set from its Stats sheet; otherwise the wall's setting applies.
const FEED_QUALITIES = ['large', 'hd720', 'hd1080'];

function validStreams(list) {
  return Array.isArray(list) && list.length <= MAX_STREAMS && list.every((s) => s && typeof s.id === 'string'
    && s.source?.kind === 'video' && VIDEO_ID.test(s.source.id) && typeof s.label === 'string' && s.label.length <= 300
    && (s.quality == null || FEED_QUALITIES.includes(s.quality)));
}

function validSettings(settings) {
  return !!settings && typeof settings === 'object' && !Array.isArray(settings);
}

// Stamps are ISO times (UTC) plus the time zone of the browser that started the session.
const optionalText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);

function validSession(s) {
  return !!s && typeof s.id === 'string' && SESSION_ID.test(s.id)
    && typeof s.name === 'string' && s.name.length <= SESSION_NAME_MAX
    && optionalText(s.startedAt, 40) && optionalText(s.endedAt, 40) && optionalText(s.timeZone, 64);
}

module.exports = { SessionStore, SESSION_ID };
