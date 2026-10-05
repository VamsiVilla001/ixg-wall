// The wall's own files (public/, the telemetry agent, the Feed Meter extension), read from
// the project folder the backend runs from.
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');

// Contents of a project-relative file such as 'public/app.js', or null if there is none.
function readAsset(rel) {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, rel));
  } catch {
    return null;
  }
}

// A real path for a file another program must open (PowerShell runs the telemetry agent by path).
function assetPath(rel) {
  return path.join(PROJECT_DIR, rel);
}

module.exports = { readAsset, assetPath };
