// Builds dist/IXG Wall.exe: a Node single executable application with the backend
// bundled into one script and the wall's files (public/, the telemetry agent) embedded.
//   npm run build
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, '.build');
const EXE = path.join(DIST, 'IXG Wall.exe');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// SEA runs one CommonJS script whose require() only knows Node's built-ins, so the
// project's own modules are wrapped into a small module table.
function bundle(entry) {
  const modules = new Map();
  const visit = (id) => {
    if (modules.has(id)) return;
    const source = fs.readFileSync(path.join(ROOT, id), 'utf8');
    const deps = {};
    modules.set(id, { source, deps });
    for (const [, spec] of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let dep = path.posix.join(path.posix.dirname(id), spec);
      if (!dep.endsWith('.js')) dep += '.js';
      deps[spec] = dep;
      visit(dep);
    }
  };
  visit(entry);
  const table = [...modules].map(([id, { source, deps }]) => `${JSON.stringify(id)}: [${JSON.stringify(deps)}, function (module, exports, require, __filename, __dirname) {\n${source}\n}]`);
  return `'use strict';
const __modules = {\n${table.join(',\n')}\n};
const __cache = {};
const __base = require('path').dirname(process.execPath);
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const [deps, fn] = __modules[id];
  const module = { exports: {} };
  __cache[id] = module;
  const local = (spec) => (deps[spec] ? __load(deps[spec]) : require(spec));
  const file = require('path').join(__base, id);
  fn.call(module.exports, module, module.exports, local, file, require('path').dirname(file));
  return module.exports;
}
__load(${JSON.stringify(entry)});
`;
}

function listFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? listFiles(rel) : [rel];
  });
}

// Wall icon: a 3Ãƒâ€”3 grid of feeds on the Live background, one tile in ember.
function iconImage(size) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const BG = hex('#1b1916');
  const TILE = hex('#4a463e');
  const EMBER = hex('#f58138');
  const roundRect = (x, y, x0, y0, w, h, r) => {
    const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
    const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
    return dx * dx + dy * dy <= r * r && x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
  };
  const pad = size * 0.17;
  const gap = size * 0.065;
  const tile = (size - 2 * pad - 2 * gap) / 3;
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!roundRect(fx, fy, 0, 0, size, size, size * 0.2)) continue;
          let color = BG;
          for (let i = 0; i < 9; i++) {
            const tx = pad + (i % 3) * (tile + gap);
            const ty = pad + Math.floor(i / 3) * (tile + gap);
            if (roundRect(fx, fy, tx, ty, tile, tile, size * 0.03)) color = i === 0 ? EMBER : TILE;
          }
          acc[0] += color[0]; acc[1] += color[1]; acc[2] += color[2]; acc[3] += 1;
        }
      }
      const n = acc[3];
      const o = ((size - 1 - y) * size + x) * 4; // BMP rows run bottom-up, BGRA
      if (n) {
        px[o] = Math.round(acc[2] / n);
        px[o + 1] = Math.round(acc[1] / n);
        px[o + 2] = Math.round(acc[0] / n);
        px[o + 3] = Math.round((255 * n) / (SS * SS));
      }
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows plus the AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, px, mask]);
}

function writeIcon(file) {
  const sizes = [16, 24, 32, 48, 64, 256];
  const images = sizes.map(iconImage);
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(s % 256, e);
    dir.writeUInt8(s % 256, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(file, Buffer.concat([dir, ...images]));
}

// node.exe carries Node's Authenticode signature, which the edits below would leave broken.
// Drop it so the exe is plainly unsigned rather than signed-but-tampered.
function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  const opt = pe + 24;
  const dirs = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const secEntry = dirs + 4 * 8;
  const certOffset = buf.readUInt32LE(secEntry);
  if (!certOffset) return buf;
  buf.writeUInt32LE(0, secEntry);
  buf.writeUInt32LE(0, secEntry + 4);
  fs.writeFileSync(file, buf.subarray(0, certOffset));
}

async function main() {
  const { inject } = require('postject');
  const rcedit = require('rcedit');

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('Bundling the backend');
  const script = path.join(WORK, 'ixg-wall.js');
  fs.writeFileSync(script, bundle('server.js'));

  const assetKeys = [...listFiles('public'), 'telemetry/win-counters.ps1'];
  const assets = Object.fromEntries(assetKeys.map((k) => [k, path.join(ROOT, k)]));
  const blob = path.join(WORK, 'sea.blob');
  const config = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
  console.log(`Embedding ${assetKeys.length} files`);
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  console.log(`Writing ${path.relative(ROOT, EXE)} (Node ${process.version})`);
  fs.copyFileSync(process.execPath, EXE);
  stripSignature(EXE);

  const icon = path.join(WORK, 'ixg.ico');
  writeIcon(icon);
  const version = `${pkg.version}.0`;
  await rcedit(EXE, {
    icon,
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'IXG Wall',
      FileDescription: 'IXG Wall',
      CompanyName: 'Tesseract Esports LLP',
      InternalName: 'IXG Wall',
      OriginalFilename: 'IXG Wall.exe',
      LegalCopyright: '',
    },
  });

  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`Done: ${(fs.statSync(EXE).size / 1024 ** 2).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
