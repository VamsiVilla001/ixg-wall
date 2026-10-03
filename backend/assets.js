// The wall's own files (public/, the telemetry agent). Run with node they come from the
// project folder; packaged as IXG Wall.exe they are embedded in the executable.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  // Node without single-executable support: always a plain project checkout
}
const PACKAGED = Boolean(sea && sea.isSea());
const PROJECT_DIR = path.join(__dirname, '..');

// Contents of a project-relative file such as 'public/app.js', or null if there is none.
function readAsset(rel) {
  if (PACKAGED) {
    try {
      return Buffer.from(sea.getAsset(rel));
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, rel));
  } catch {
    return null;
  }
}

// A real path for a file another program must open (PowerShell runs the telemetry agent
// by path). Packaged, the file is written out to the data folder first.
function assetPath(rel) {
  if (!PACKAGED) return path.join(PROJECT_DIR, rel);
  const out = path.join(DATA_DIR, 'runtime', rel);
  const data = readAsset(rel);
  let current = null;
  try {
    current = fs.readFileSync(out);
  } catch {
    // not written yet
  }
  if (data && !(current && current.equals(data))) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  return out;
}

module.exports = { PACKAGED, readAsset, assetPath };
