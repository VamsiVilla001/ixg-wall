// The wall (feeds and settings) kept by the backend, so every window and browser profile —
// including the managed wall window — opens the same wall.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const WALL_FILE = path.join(DATA_DIR, 'wall.json');
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_STREAMS = 200;

class WallStore {
  constructor() {
    this.version = 0;
    this.wall = null;
    try {
      const saved = JSON.parse(fs.readFileSync(WALL_FILE, 'utf8'));
      if (validate(saved.wall)) {
        this.wall = saved.wall;
        this.version = Number(saved.version) || 1;
      }
    } catch {
      // no wall saved yet
    }
  }

  // Returns the new version, or null if the wall was rejected.
  save(wall) {
    if (!validate(wall)) return null;
    this.wall = wall;
    this.version += 1;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${WALL_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: this.version, savedAt: new Date().toISOString(), wall }, null, 2));
    fs.renameSync(tmp, WALL_FILE); // never leave a half-written wall behind
    return this.version;
  }
}

function validate(wall) {
  if (!wall || typeof wall !== 'object') return false;
  if (!wall.settings || typeof wall.settings !== 'object' || Array.isArray(wall.settings)) return false;
  if (!Array.isArray(wall.streams) || wall.streams.length > MAX_STREAMS) return false;
  return wall.streams.every((s) => s && typeof s.id === 'string' && s.source?.kind === 'video'
    && VIDEO_ID.test(s.source.id) && typeof s.label === 'string' && s.label.length <= 300);
}

module.exports = { WallStore };
