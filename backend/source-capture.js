// Source screenshots taken in the background by the backend, on the computer it runs on.
//
// The Feed Meter extension (extension/capture.js) can only screenshot a page in a real
// window: it opened the feed's YouTube page in a window of its own, which Windows showed
// and put on the taskbar, and brought forward (taking the keyboard from whatever the
// operator was doing) whenever Chrome wouldn't draw it hidden. Here the same page opens in
// a headless Chrome instead: no window, no taskbar entry, no change of focus. It runs at
// below-normal priority so the wall's own playback comes first.
//
// The rest is the extension's: the same YouTube page reader (extension/source-youtube.js),
// the same waits, the same crop and the same file names, saved to the same folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./paths');
const { IXGYouTube } = require('../extension/source-youtube');
const { fileName, union, FOLDER } = require('../extension/capture');

const START_TIMEOUT_MS = 20000;    // Chrome itself
const LOAD_TIMEOUT_MS = 30000;     // the page
const SOURCE_TIMEOUT_MS = 25000;   // its player, title and channel
const COUNT_TIMEOUT_MS = 20000;    // the viewer count, which renders late
const SETTLE_MS = 1500;            // let the last numbers paint before the shot
const POLL_MS = 500;
const VIEW = { width: 1280, height: 920 };
const PAD_PX = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (reason, message) => Object.assign(new Error(message), { reason });

// On a laptop, where Chrome saves downloads, so files land where the extension put them. On a
// server (hosted) there's no one's Downloads: the data folder, and Slack carries them out.
const defaultFolder = (hosted) => (hosted ? path.join(DATA_DIR, 'screenshots') : path.join(os.homedir(), 'Downloads', ...FOLDER.split('/')));

// ---- Names, language first: [Hindi] - BMSD 2026 Semi-Finals Day 1 - 154,337 PCV - 2026-10-08 15-52.png
// The language is the feed's own tag ([HINDI] …, as the operators name feeds), else a
// language its label or title names, else Untagged. A [MAP STREAM] feed is [Map Stream].
const LANGUAGES = /\b(hindi|english|tamil|telugu|kannada|malayalam|bengali|bangla|marathi|gujarati|punjabi|urdu|odia)\b/i;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, c) => a + c.toUpperCase());
// Safe in a Windows file name and readable: characters Windows refuses become spaces.
const tidy = (s, max) => String(s || '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max).replace(/[\s.]+$/, '');
const countText = (s) => String(s || '').replace(/[^\d,.KMB]/gi, '');

function languageOf(...texts) {
  for (const t of texts) {
    const tag = /^\s*\[([^\]]{1,40})\]/.exec(t || '');
    if (tag && tidy(tag[1], 40)) return titleCase(tidy(tag[1], 40));
  }
  for (const t of texts) {
    const named = LANGUAGES.exec(t || '');
    if (named) return titleCase(named[1]);
  }
  return 'Untagged';
}

// The folder a session's screenshots go in, from its name as the operators typed it.
const sessionFolder = (name) => tidy(name, 80) || 'Untitled session';

// kind: peak (a new PCV: `pcv` is the sampled PCV) | end | manual. facts: what the page showed.
function readableName({ label, facts = {}, kind = 'manual', pcv = null }, when = new Date()) {
  const lang = languageOf(label, facts.title);
  const title = tidy(String(facts.title || label || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/#[\p{L}\p{N}_]+/gu, ''), 90) || 'Untitled';
  const ccv = countText(facts.ccv);
  const views = countText(facts.views);
  const count = kind === 'peak' && Number.isSafeInteger(pcv) ? `${pcv.toLocaleString('en-US')} PCV`
    : kind === 'end' ? (views ? `${views} Views - END` : ccv ? `${ccv} CCV - END` : 'END')
      : ccv ? `${ccv} CCV` : views ? `${views} Views` : 'CCV N-A';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}-${p(when.getMinutes())}`;
  return `[${lang}] - ${title} - ${count} - ${stamp}.png`;
}

class SourceCapture {
  constructor({ browserPath, hosted = false, folder = process.env.IXG_SCREENSHOT_DIR || defaultFolder(hosted) }) {
    this.browserPath = browserPath;
    this.folder = folder;
    this.queue = Promise.resolve(); // one at a time: each waits for the one before
    this.waiting = 0;
  }

  available() {
    return !!this.browserPath;
  }

  // { videoId, name?: (facts) => file name, subfolder? } -> { file, facts, note }. Throws
  // { reason, message }. Without `name`, the extension's name with `tag` ('' | 'PEAK' | 'END').
  // `subfolder` (the session's folder, sessionFolder()) keeps one session's screenshots apart.
  capture(request) {
    this.waiting += 1;
    const run = this.queue.then(() => this.take(request)).finally(() => { this.waiting -= 1; });
    this.queue = run.catch(() => {});
    return run;
  }

  async take({ videoId, tag = '', name = null, subfolder = '' }) {
    if (!IXGYouTube.handles({ platform: 'youtube', videoId })) throw fail('no-source', 'Source URL unavailable for this feed');
    const chrome = await Chrome.start(this.browserPath);
    try {
      const page = await chrome.open(IXGYouTube.url({ videoId }));
      let { state, timedOut } = await page.waitFor(IXGYouTube.sourceReady, SOURCE_TIMEOUT_MS);
      if (timedOut) {
        if (state.unavailable) throw fail('unavailable', `Source video unavailable: ${state.unavailable}`);
        throw fail('source', `Source page did not show its ${!state.player ? 'player' : !state.title ? 'title' : 'channel'} in time`);
      }
      let note = '';
      if (IXGYouTube.wantsCount(state)) {
        ({ state, timedOut } = await page.waitFor(IXGYouTube.countReady, COUNT_TIMEOUT_MS));
        if (timedOut) note = 'No viewer or view count could be detected: saved as CCV-NA';
      }
      await sleep(SETTLE_MS);
      state = await page.probe(); // fresh positions and numbers for the shot
      const png = await page.screenshot(union(IXGYouTube.parts(state)));
      const facts = IXGYouTube.facts(state);
      const file = this.save(png, name ? name(facts) : fileName(facts, new Date(), tag), subfolder);
      return { file, facts, note };
    } finally {
      await chrome.close();
    }
  }

  save(png, name, subfolder = '') {
    const folder = subfolder ? path.join(this.folder, subfolder) : this.folder;
    try {
      fs.mkdirSync(folder, { recursive: true });
      const ext = path.extname(name);
      let file = path.join(folder, name);
      for (let i = 1; fs.existsSync(file); i++) file = path.join(folder, `${path.basename(name, ext)} (${i})${ext}`);
      fs.writeFileSync(file, png);
      return file;
    } catch (err) {
      throw fail('save', `Screenshot capture failed: couldn't save it in ${folder} (${err.message})`);
    }
  }
}

// A throwaway headless Chrome, driven over the DevTools pipe.
class Chrome {
  static async start(browserPath) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-shot-'));
    const child = spawn(browserPath, [
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${VIEW.width},${VIEW.height}`,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    // Its renderers inherit this, so the wall's own players keep the CPU first.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chrome = new Chrome(child, profile);
    try {
      await chrome.send('Browser.getVersion', {}, undefined, START_TIMEOUT_MS);
    } catch (err) {
      await chrome.close();
      throw fail('browser', `Screenshot capture failed: the background browser didn't start (${err.message})`);
    }
    return chrome;
  }

  constructor(child, profile) {
    this.child = child;
    this.profile = profile;
    this.nextId = 1;
    this.pending = new Map();
    let buf = '';
    child.stdio[4].on('data', (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\0')) >= 0) {
        let msg;
        try { msg = JSON.parse(buf.slice(0, end)); } catch { msg = {}; }
        buf = buf.slice(end + 1);
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    child.stdio[3].on('error', () => {});
    child.on('exit', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('the background browser closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} took too long`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false }, sessionId);
    const nav = await this.send('Page.navigate', { url }, sessionId, LOAD_TIMEOUT_MS).catch((err) => { throw fail('load', `Source page failed to load: ${err.message}`); });
    if (nav.errorText) throw fail('load', `Source page failed to load: ${nav.errorText}`);
    return page;
  }

  async close() {
    await this.send('Browser.close', {}, undefined, 3000).catch(() => {});
    if (this.child.exitCode == null) {
      await Promise.race([new Promise((r) => this.child.once('exit', r)), sleep(3000)]);
      if (this.child.exitCode == null) this.child.kill();
    }
    // Chrome lets go of its profile a moment after it exits.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300);
      }
    }
  }
}

class Page {
  constructor(chrome, sessionId) {
    this.chrome = chrome;
    this.sessionId = sessionId;
  }

  async probe() {
    let r;
    try {
      r = await this.chrome.send('Runtime.evaluate', { expression: `(${IXGYouTube.probe})()`, returnByValue: true }, this.sessionId);
    } catch (err) {
      throw fail('load', `Source page failed to load: ${err.message}`);
    }
    const state = r?.result?.value;
    if (!state) return {}; // between documents while it loads: ask again
    if (state.blocked) throw fail('blocked', state.blocked);
    return state;
  }

  // Polls the page until `ready` holds, or the time is up.
  async waitFor(ready, timeoutMs) {
    const until = Date.now() + timeoutMs;
    let state = await this.probe();
    while (!ready(state)) {
      if (state.unavailable && !state.player) throw fail('unavailable', `Source video unavailable: ${state.unavailable}`);
      if (Date.now() > until) return { state, timedOut: true };
      await sleep(POLL_MS);
      state = await this.probe();
    }
    return { state, timedOut: false };
  }

  // The block (page CSS pixels) padded, as a PNG; the whole view without one.
  async screenshot(block) {
    const clip = block
      ? { x: Math.max(0, block.x - PAD_PX), y: Math.max(0, block.y - PAD_PX), width: block.width + 2 * PAD_PX, height: block.height + 2 * PAD_PX, scale: 1 }
      : { x: 0, y: 0, ...VIEW, scale: 1 };
    const { data } = await this.chrome.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, this.sessionId);
    return Buffer.from(data, 'base64');
  }
}

module.exports = { SourceCapture, readableName, languageOf, sessionFolder };
