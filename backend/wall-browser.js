// Runs the wall in a dedicated browser window tuned for many simultaneous videos:
// its own profile (no other tabs or extensions competing), app mode (no tab strip or
// address bar), no throttling when other windows cover it, and a decode mode chosen
// from benchmarks. Restarts the window if the browser crashes.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./paths');

const CONFIG_FILE = path.join(DATA_DIR, 'backend.json');
const PROFILE_DIR = path.join(DATA_DIR, 'wall-profile');
const DECODE_MODES = ['software', 'hardware'];
// Software decode measured smoothest on the lowest-spec wall laptop (Ryzen 5 4600H,
// Radeon iGPU): 0% dropped frames at 30 feeds vs 4–7% at 24 feeds on the GPU decoder.
const DEFAULT_DECODE = 'software';

function findBrowser() {
  if (process.env.IXG_BROWSER && fs.existsSync(process.env.IXG_BROWSER)) return process.env.IXG_BROWSER;
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    // settings fall back to defaults next start
  }
}

// Name of the process with this pid, or null if it isn't running.
function processName(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      const m = !err && String(out).match(/^"([^"]+)","(\d+)"/m);
      resolve(m && Number(m[2]) === pid ? m[1].toLowerCase() : null);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WallBrowser {
  constructor({ url }) {
    this.url = url;
    this.browserPath = findBrowser();
    const cfg = readConfig();
    this.decode = DECODE_MODES.includes(cfg.decode) ? cfg.decode : DEFAULT_DECODE;
    this.pid = null;
    this.child = null;
    this.startedAt = null;
    this.restarts = 0;
    this.lastExit = null;
    this.adopted = false;
    this.stopping = false;
    this.busy = null; // in-flight launch/relaunch promise
    this.adopt(cfg.pid);
  }

  // A wall window left running by a previous backend run is reused, not duplicated.
  async adopt(pid) {
    const name = await processName(pid);
    if (!name || !this.browserPath || name !== path.basename(this.browserPath).toLowerCase()) return;
    this.pid = pid;
    this.adopted = true;
    this.startedAt = Date.now();
    this.watchAdopted();
  }

  watchAdopted() {
    clearInterval(this.adoptTimer);
    this.adoptTimer = setInterval(async () => {
      if (!this.adopted) return clearInterval(this.adoptTimer);
      if (!(await processName(this.pid))) {
        this.lastExit = { code: null, at: Date.now(), note: 'closed' };
        this.pid = null;
        this.adopted = false;
        clearInterval(this.adoptTimer);
      }
    }, 5000);
  }

  args() {
    const url = new URL(this.url);
    url.searchParams.set('wall', 'managed');
    return [
      `--user-data-dir=${PROFILE_DIR}`,
      `--app=${url}`,
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--autoplay-policy=no-user-gesture-required',
      // Keep every feed rendering at full rate when another window covers the wall.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      ...(this.decode === 'software' ? ['--disable-accelerated-video-decode'] : []),
    ];
  }

  status() {
    return {
      supported: !!this.browserPath,
      browser: this.browserPath ? path.basename(this.browserPath) : null,
      decode: this.decode,
      running: !!this.pid,
      pid: this.pid,
      adopted: this.adopted,
      uptimeSec: this.pid && this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      restarts: this.restarts,
      lastExit: this.lastExit,
    };
  }

  launch() {
    if (this.busy) return this.busy;
    this.busy = this.doLaunch().finally(() => { this.busy = null; });
    return this.busy;
  }

  async doLaunch() {
    if (!this.browserPath) throw new Error('No Chrome or Edge found. Set IXG_BROWSER to the browser exe.');
    if (this.pid && (await processName(this.pid))) return this.status();
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    this.stopping = false;
    const child = spawn(this.browserPath, this.args(), { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    this.child = child;
    this.pid = child.pid;
    this.adopted = false;
    this.startedAt = Date.now();
    writeConfig({ decode: this.decode, pid: this.pid });
    child.on('exit', (code) => this.onExit(child, code));
    return this.status();
  }

  onExit(child, code) {
    if (child !== this.child) return;
    const uptime = Date.now() - this.startedAt;
    this.lastExit = { code, at: Date.now(), note: this.stopping ? 'relaunch' : code === 0 ? 'closed' : 'crashed' };
    this.pid = null;
    this.child = null;
    if (this.stopping || code === 0) return; // closed on purpose
    // Crashed: bring the wall back, backing off if it keeps crashing.
    if (uptime > 300000) this.restarts = 0;
    const delay = Math.min(60000, 3000 * 2 ** this.restarts++);
    setTimeout(() => { if (!this.pid) this.launch().catch(() => {}); }, delay);
  }

  async close() {
    const pid = this.pid;
    if (!pid) return;
    this.stopping = true;
    this.adopted = false;
    // Ask the window to close first (without /T, so the browser gets the close message and
    // shuts its own child processes down cleanly, ~0.6s); force the tree only if it won't.
    execFile('taskkill', ['/PID', String(pid)], { windowsHide: true }, () => {});
    for (let i = 0; i < 15 && (await processName(pid)); i++) await sleep(200);
    if (await processName(pid)) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    for (let i = 0; i < 25 && (await processName(pid)); i++) await sleep(200);
    this.pid = null;
  }

  async relaunch({ decode } = {}) {
    if (decode && DECODE_MODES.includes(decode)) this.decode = decode;
    writeConfig({ decode: this.decode, pid: this.pid });
    await this.close();
    await sleep(500);
    return this.launch();
  }
}

module.exports = { WallBrowser, DECODE_MODES, PROFILE_DIR };
