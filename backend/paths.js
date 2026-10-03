// Where the backend keeps its files: per-machine app data, never the synced project folder
// (a browser profile in OneDrive would sync gigabytes of cache).
const os = require('os');
const path = require('path');

// IXG_DATA_DIR runs a second, separate wall (or a test instance) side by side.
const DATA_DIR = process.env.IXG_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'IXG Multiviewer');

module.exports = { DATA_DIR };
