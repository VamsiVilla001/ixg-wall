// Where the backend keeps its files: per-machine app data, never the synced project folder
// (a browser profile in OneDrive would sync gigabytes of cache).
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
const OLD_DIR = path.join(APP_DATA, 'IXG Multiviewer'); // the app's name before IXG Wall

// The wall, key and audience history move over once from the old name. If the old folder
// is in use (its wall window still open), keep using it rather than start an empty wall.
function dataDir() {
  const dir = path.join(APP_DATA, 'IXG Wall');
  if (!fs.existsSync(dir) && fs.existsSync(OLD_DIR)) {
    try {
      fs.renameSync(OLD_DIR, dir);
    } catch {
      return OLD_DIR;
    }
  }
  return dir;
}

// IXG_DATA_DIR runs a second, separate wall (or a test instance) side by side.
const DATA_DIR = process.env.IXG_DATA_DIR || dataDir();

module.exports = { DATA_DIR };
