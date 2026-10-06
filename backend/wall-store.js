// The wall (feeds and settings) kept by the backend, so every window and browser profile —
// including the managed wall window — opens the same wall.
//
// Sessions: `streams` are the active session's feeds, the only ones that load (and the only
// ones the YouTube pollers ask about). `session` names it. `savedSessions` keeps earlier
// sessions' feeds, which never load on their own; the wall reopens one on request.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const WALL_FILE = path.join(DATA_DIR, 'wall.json');
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_STREAMS = 200;
const MAX_SAVED_SESSIONS = 50;
const SESSION_NAME_MAX = 80;

class WallStore {
  constructor() {
    this.version = 0;
    this.wall = null;
    this.legacyKey = ''; // a YouTube key found in an older wall.json, for the server to move out
    this.migrated = false;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(WALL_FILE, 'utf8'));
      if (validate(saved.wall)) {
        this.wall = saved.wall;
        this.version = Number(saved.version) || 1;
        this.legacyKey = stripSecrets(this.wall);
      }
    } catch {
      // no wall saved yet
    }
    // A wall from before sessions: its feeds become a saved session and the wall starts a
    // new, empty one, so links from earlier events stop loading on their own.
    if (this.wall && !this.wall.session) {
      const at = saved?.savedAt || new Date().toISOString();
      const earlier = this.wall.streams.length
        ? [{ id: crypto.randomUUID(), name: 'Before sessions', startedAt: at, endedAt: at, streams: this.wall.streams }]
        : [];
      this.wall.savedSessions = [...earlier, ...(this.wall.savedSessions || [])].slice(0, MAX_SAVED_SESSIONS);
      this.wall.streams = [];
      this.wall.session = { id: crypto.randomUUID(), name: 'New session', startedAt: new Date().toISOString() };
      this.migrated = true;
    }
  }

  // Whether a save comes from a page that predates sessions. Its feed list is from before
  // the switch, so taking it would bring earlier links back: the server refuses it.
  stale(wall) {
    return !!this.wall?.session && !wall?.session;
  }

  // Returns the new version, or null if the wall was rejected.
  save(wall) {
    if (!validate(wall) || this.stale(wall)) return null;
    stripSecrets(wall); // a page from before the key moved server-side may still send it
    if (!('savedSessions' in wall) && this.wall?.savedSessions) wall.savedSessions = this.wall.savedSessions;
    this.wall = wall;
    this.version += 1;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${WALL_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: this.version, savedAt: new Date().toISOString(), wall }, null, 2));
    fs.renameSync(tmp, WALL_FILE); // never leave a half-written wall behind
    return this.version;
  }
}

// The YouTube key lives in secrets.json, never in the wall every page downloads.
// Removes it from the wall's settings and returns it ('' if there was none).
function stripSecrets(wall) {
  if (!wall?.settings || !('ytApiKey' in wall.settings)) return '';
  const key = wall.settings.ytApiKey;
  delete wall.settings.ytApiKey;
  return typeof key === 'string' ? key.trim() : '';
}

// A feed's own quality, when set from its Stats sheet; otherwise the wall's setting applies.
const FEED_QUALITIES = ['large', 'hd720', 'hd1080'];

function validStreams(list) {
  return Array.isArray(list) && list.length <= MAX_STREAMS && list.every((s) => s && typeof s.id === 'string'
    && s.source?.kind === 'video' && VIDEO_ID.test(s.source.id) && typeof s.label === 'string' && s.label.length <= 300
    && (s.quality == null || FEED_QUALITIES.includes(s.quality)));
}

// Stamps are ISO times (UTC) plus the time zone of the browser that started the session.
const optionalText = (v, max) => v == null || (typeof v === 'string' && v.length <= max);

function validSession(s) {
  return !!s && typeof s.id === 'string' && s.id.length <= 64
    && typeof s.name === 'string' && s.name.length <= SESSION_NAME_MAX
    && optionalText(s.startedAt, 40) && optionalText(s.endedAt, 40) && optionalText(s.timeZone, 64);
}

function validate(wall) {
  if (!wall || typeof wall !== 'object') return false;
  if (!wall.settings || typeof wall.settings !== 'object' || Array.isArray(wall.settings)) return false;
  if (!validStreams(wall.streams)) return false;
  if (wall.session != null && !validSession(wall.session)) return false;
  if (wall.savedSessions != null) {
    if (!Array.isArray(wall.savedSessions) || wall.savedSessions.length > MAX_SAVED_SESSIONS) return false;
    if (!wall.savedSessions.every((s) => validSession(s) && validStreams(s.streams))) return false;
  }
  return true;
}

module.exports = { WallStore };
