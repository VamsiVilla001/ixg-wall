// The IXG Wall Feed Meter extension (extension/), shipped by the wall itself: its ID and
// version for the page's install check, and a zip of it to download from the wall's URL.
// The ID comes from the public key in the manifest, so it's the same on every computer.
const crypto = require('crypto');
const { readAsset } = require('./assets');

const FILES = ['manifest.json', 'meter.js', 'README.md'];
const FOLDER = 'IXG Wall Feed Meter'; // what the zip unpacks to
const DOWNLOAD_PATH = '/extension/ixg-wall-feed-meter.zip';

// Chrome's extension ID: the first 128 bits of SHA-256 of the public key, in letters a–p.
function extensionId(keyBase64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
}

function info({ extraIds = [], storeUrl = '' } = {}) {
  let manifest = {};
  try {
    manifest = JSON.parse(readAsset('extension/manifest.json'));
  } catch {
    return null; // not shipped with this build
  }
  const ids = [...new Set([manifest.key ? extensionId(manifest.key) : null, ...extraIds].filter(Boolean))];
  return { ids, version: manifest.version || null, download: DOWNLOAD_PATH, storeUrl: storeUrl || null };
}

// ---- A minimal zip (stored, uncompressed): a few small text files need nothing more ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files, when = new Date()) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0x0800, 6);     // names are UTF-8
    local.writeUInt16LE(0, 8);          // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, n);
    offset += local.length + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// The extension as a zip that unpacks to one folder, ready for "Load unpacked".
function zipFile() {
  const files = FILES.map((f) => ({ name: `${FOLDER}/${f}`, data: readAsset(`extension/${f}`) }));
  if (files.some((f) => !f.data)) return null;
  return zip(files);
}

module.exports = { info, zipFile, extensionId, DOWNLOAD_PATH };
