// Source screenshots taken in the background by the backend, on the computer it runs on.
//
// The Feed Meter extension (extension/capture.js) can only screenshot a page in a real
// window: it opened the feed's YouTube page in a window of its own, which Windows showed
// and put on the taskbar, and brought forward (taking the keyboard from whatever the
// operator was doing) whenever Chrome wouldn't draw it hidden. Here the same page lives in
// a headless Chrome instead: no window, no taskbar entry, no change of focus. It runs at
// below-normal priority so the wall's own playback comes first.
//
// The browser runs from the moment the backend starts, and the live sessions' feeds keep
// their YouTube pages open in it (muted, at the lowest quality, up to PRELOAD_MAX of them),
// so when a screenshot is due it's a scroll and a capture, about a second, instead of a
// cold start, a page load and a wait for the count: 8–12 s in which the count on the page
// had moved on from the peak that asked for it. A feed beyond the cap opens its page in
// the running browser for the shot and closes it after. Kept pages are reloaded every so
// often, so YouTube's "Video paused. Continue watching?" never sits over one, and dismissed
// just before a shot in case it does.
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
const COUNT_KEPT_TIMEOUT_MS = 8000; // on a page kept open the count is normally there already
const SETTLE_MS = 1500;            // let the last numbers paint before the shot (a cold page)
const SETTLE_KEPT_MS = 300;        // a kept page is painted: just the scroll
const POLL_MS = 500;
const VIEW = { width: 1280, height: 920 };
const PAD_PX = 16;
// Pages kept open for the live sessions' feeds. Each is a YouTube watch page playing at
// 144p, muted: measured 200–340 MB private memory and about a tenth of a core apiece, on
// top of ~450 MB for the browser itself, so a cap (6 ≈ 1.7 GB). 0 keeps none.
const PRELOAD_MAX = Number.isFinite(Number(process.env.IXG_SHOT_PRELOAD)) ? Math.max(0, Number(process.env.IXG_SHOT_PRELOAD)) : 6;
const REFRESH_AFTER_MS = 90 * 60000; // a kept page is reloaded after this long, one at a time
const TEND_EVERY_MS = 60000;
const RESTART_AFTER_MS = 5000;     // the browser died: start it again after this

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

// Where a screenshot goes: Screenshots/<session name>/<YYYY-MM-DD>/<feed>/: the session as
// the operators typed it, the day it was taken (local time), and the feed by a short name.
const sessionFolder = (name) => tidy(name, 80) || 'Untitled session';
const dayFolder = (when = new Date()) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;

// A feed's short name: its language tag and its day, "Hindi Day 1" for "[HINDI] BMSD 2026 |
// Semi-Finals | Day 1 #BGMILIVE" ("Map Stream Day 1" for a [MAP STREAM] feed). Empty with no tag.
function shortFeedName(label) {
  const lang = languageOf(label);
  if (lang === 'Untagged') return '';
  const day = /\bday\s*(\d{1,2})\b/i.exec(label || '');
  return tidy(`${lang}${day ? ` Day ${day[1]}` : ''}`, 40);
}

// The feed's folder: its short name, unless it has none or another feed in the session
// (`siblings`: their labels) would share it, when the whole label is used, as typed. A feed
// with no label at all is named by its video id.
function feedFolder(label, videoId = '', siblings = []) {
  const short = shortFeedName(label);
  const clash = short && siblings.some((l) => l !== label && shortFeedName(l) === short);
  return (clash ? '' : short) || tidy(label, 80) || tidy(videoId, 20) || 'Unnamed feed';
}

// Settings → Source screenshots → Folders: which of the three levels to keep, and whether
// the feed level is the short name or the whole label.
const LAYOUTS = ['session-date-feed', 'session-feed', 'session-date', 'session'];
const FEED_NAMES = ['short', 'full'];
function shotFolder(sessionName, label, videoId = '', when = new Date(), siblings = [], { layout = 'session-date-feed', feedNames = 'short' } = {}) {
  const levels = [sessionFolder(sessionName)];
  if (layout.includes('date')) levels.push(dayFolder(when));
  if (layout.includes('feed')) levels.push(feedNames === 'full' ? (tidy(label, 80) || tidy(videoId, 20) || 'Unnamed feed') : feedFolder(label, videoId, siblings));
  return path.join(...levels);
}

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
    this.defaultFolder = defaultFolder(hosted);
    this.folder = folder; // the base folder; Settings → Source screenshots can change it
    this.queue = Promise.resolve(); // one shot at a time: each waits for the one before
    this.waiting = 0;
    this.chrome = null;             // the one browser, running from start()
    this.starting = null;
    this.pages = new Map();         // video id -> Page kept open for it
    this.opening = new Set();       // video ids whose kept page is loading
    this.wanted = [];               // the live sessions' video ids, in the order to keep them
    this.stopped = false;
  }

  available() {
    return !!this.browserPath;
  }

  // Starts the browser now, so the first screenshot doesn't wait for it, and tends the kept
  // pages every minute: opens any missing, reloads one that's been up a long time.
  start() {
    if (!this.available()) return;
    this.browser().catch(() => {});
    this.tendTimer = setInterval(() => this.tend().catch(() => {}), TEND_EVERY_MS);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.tendTimer);
    const chrome = this.chrome;
    this.chrome = null;
    this.pages.clear();
    if (chrome) await chrome.close();
  }

  // What the browser keeps open: the live sessions' feeds, first PRELOAD_MAX of them. Called
  // whenever the sessions change. Pages for feeds no longer wanted close; wanted ones open.
  preload(videoIds) {
    this.wanted = [...new Set(videoIds.filter((id) => IXGYouTube.handles({ platform: 'youtube', videoId: id })))];
    if (!this.available() || this.stopped) return;
    this.tend().catch(() => {});
  }

  // How the kept pages stand, for the log and Settings: { kept, wanted, max }.
  status() {
    return { kept: [...this.pages.keys()], wanted: this.wanted.length, max: PRELOAD_MAX, browser: !!this.chrome && !this.chrome.dead };
  }

  // The one browser: started when first needed, and again after it dies.
  async browser() {
    if (this.chrome && !this.chrome.dead) return this.chrome;
    if (!this.starting) {
      this.starting = Chrome.start(this.browserPath).then((chrome) => {
        this.chrome = chrome;
        chrome.onExit = () => {
          // Crashed or killed: the kept pages went with it; back shortly, pages and all.
          this.pages.clear();
          this.opening.clear();
          if (this.chrome === chrome) this.chrome = null;
          if (!this.stopped) setTimeout(() => this.tend().catch(() => {}), RESTART_AFTER_MS);
        };
        return chrome;
      }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async tend() {
    if (this.stopped || !this.available()) return;
    const chrome = await this.browser();
    const keep = PRELOAD_MAX > 0 ? this.wanted.slice(0, PRELOAD_MAX) : [];
    for (const [id, page] of this.pages) {
      if (!keep.includes(id) || page.dead) {
        this.pages.delete(id);
        page.close().catch(() => {});
      }
    }
    for (const id of keep) {
      if (!this.pages.has(id) && !this.opening.has(id)) await this.keepOpen(chrome, id);
    }
    // One stale page at a time, so the others stay ready for a shot.
    const stale = [...this.pages.entries()].find(([, p]) => Date.now() - p.openedAt > REFRESH_AFTER_MS);
    if (stale) {
      this.pages.delete(stale[0]);
      await stale[1].close().catch(() => {});
      await this.keepOpen(chrome, stale[0]);
    }
  }

  async keepOpen(chrome, id) {
    this.opening.add(id);
    try {
      const page = await chrome.open(IXGYouTube.url({ videoId: id }));
      try {
        const { state, timedOut } = await page.waitFor(IXGYouTube.sourceReady, SOURCE_TIMEOUT_MS);
        if (timedOut && state.unavailable) throw fail('unavailable', state.unavailable);
        await page.quieten();
        this.pages.set(id, page);
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    } catch {
      // Unavailable or slow: not kept; the next tend tries again, and a shot opens it afresh.
    } finally {
      this.opening.delete(id);
    }
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
    const chrome = await this.browser().catch((err) => { throw fail('browser', `Screenshot capture failed: the background browser didn't start (${err.message})`); });
    let page = this.pages.get(videoId);
    if (page?.dead) {
      this.pages.delete(videoId);
      page = null;
    }
    const kept = !!page;
    if (!page) page = await chrome.open(IXGYouTube.url({ videoId }));
    const started = Date.now();
    try {
      if (kept) await page.freshen();
      let { state, timedOut } = await page.waitFor(IXGYouTube.sourceReady, kept ? COUNT_KEPT_TIMEOUT_MS : SOURCE_TIMEOUT_MS);
      if (timedOut) {
        if (state.unavailable) throw fail('unavailable', `Source video unavailable: ${state.unavailable}`);
        throw fail('source', `Source page did not show its ${!state.player ? 'player' : !state.title ? 'title' : 'channel'} in time`);
      }
      let note = '';
      if (IXGYouTube.wantsCount(state)) {
        ({ state, timedOut } = await page.waitFor(IXGYouTube.countReady, kept ? COUNT_KEPT_TIMEOUT_MS : COUNT_TIMEOUT_MS));
        if (timedOut) note = 'No viewer or view count could be detected: saved as CCV-NA';
      }
      await sleep(kept ? SETTLE_KEPT_MS : SETTLE_MS);
      state = await page.probe(); // fresh positions and numbers for the shot
      const png = await page.screenshot(union(IXGYouTube.parts(state)));
      const facts = IXGYouTube.facts(state);
      const file = this.save(png, name ? name(facts) : fileName(facts, new Date(), tag), subfolder);
      return { file, facts, note, kept, tookMs: Date.now() - started };
    } finally {
      if (!kept) await page.close().catch(() => {});
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

// The headless Chrome, driven over the DevTools pipe. One for the backend's lifetime.
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
      // Kept pages must keep updating their counts although nothing looks at them.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--window-size=${VIEW.width},${VIEW.height}`,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    // Its renderers inherit this, so the wall's own players keep the CPU first.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chrome = new Chrome(child, profile);
    try {
      await chrome.send('Browser.getVersion', {}, undefined, START_TIMEOUT_MS);
    } catch (err) {
      await chrome.close();
      throw err;
    }
    return chrome;
  }

  constructor(child, profile) {
    this.child = child;
    this.profile = profile;
    this.dead = false;
    this.onExit = null;
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
      this.dead = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('the background browser closed'));
      }
      this.pending.clear();
      this.removeProfile().catch(() => {});
      if (this.onExit) this.onExit();
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (this.dead) return Promise.reject(new Error('the background browser closed'));
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
    const page = new Page(this, sessionId, targetId);
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
    await this.removeProfile();
  }

  // Chrome lets go of its profile a moment after it exits.
  async removeProfile() {
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
  constructor(chrome, sessionId, targetId) {
    this.chrome = chrome;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.openedAt = Date.now();
    this.dead = false;
  }

  async close() {
    this.dead = true;
    await this.chrome.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000).catch(() => {});
  }

  async run(expression) {
    const r = await this.chrome.send('Runtime.evaluate', { expression, returnByValue: true }, this.sessionId);
    return r?.result?.value;
  }

  async probe() {
    let r;
    try {
      r = await this.chrome.send('Runtime.evaluate', { expression: `(${IXGYouTube.probe})()`, returnByValue: true }, this.sessionId);
    } catch (err) {
      if (this.chrome.dead) this.dead = true;
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

  // A page kept open costs as little as it can: muted, at YouTube's lowest quality.
  async quieten() {
    await this.run(`(() => { const p = document.querySelector('#movie_player'); try { p?.mute?.(); } catch {} try { p?.setPlaybackQualityRange?.('tiny', 'tiny'); } catch {} return true; })()`).catch(() => {});
  }

  // Before a shot on a kept page: YouTube's "Continue watching?" put away, playback resumed
  // if it was paused, so the page shows the stream and its live count.
  async freshen() {
    await this.run(`(() => {
      for (const b of document.querySelectorAll('yt-confirm-dialog-renderer #confirm-button, tp-yt-paper-dialog #confirm-button, #confirm-button')) { try { b.click(); } catch {} }
      const v = document.querySelector('video');
      if (v && v.paused) { try { v.play().catch(() => {}); } catch {} }
      return true;
    })()`).catch(() => {});
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

module.exports = { SourceCapture, readableName, languageOf, sessionFolder, feedFolder, shortFeedName, dayFolder, shotFolder, defaultFolder, LAYOUTS, FEED_NAMES, PRELOAD_MAX };
