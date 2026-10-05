// Capture Source Screenshot: the generic workflow, run in the extension's service worker.
//
// A wall page asks for evidence of a feed from its own source page (through the courier in
// one of its players: a page can't reach a service worker itself). The source opens in a
// small, muted window of its own behind the wall, the page's own title, channel and
// viewer count are waited for, the meaningful block (player, title, channel, "N watching")
// is cropped out of a screenshot, saved as PNG, and the window closes. What to wait for and
// where things are on the page come from one source-*.js module per platform.
if (typeof importScripts === 'function') importScripts('source-youtube.js');

// eslint-disable-next-line no-undef
const SOURCES = [typeof IXGYouTube !== 'undefined' ? IXGYouTube : typeof require === 'function' ? require('./source-youtube').IXGYouTube : null].filter(Boolean);
const LOAD_TIMEOUT_MS = 30000;     // the page itself
const SOURCE_TIMEOUT_MS = 25000;   // its player, title and channel
const COUNT_TIMEOUT_MS = 20000;    // the viewer count, which renders late
const SETTLE_MS = 1500;            // let the last numbers paint before the shot
const POLL_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 20000;
const SOURCE_WINDOW = { width: 1280, height: 920 };
const ZOOM = 0.8;                  // the player and the lines under it fit one screen
const PAD_PX = 16;
const FOLDER = 'IXG-Wall/Screenshots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (reason, message) => Object.assign(new Error(message), { reason });

// ---- Where screenshots go. One backend today (the browser's Downloads folder); a native
// helper writing straight into a production folder would be another entry here. ----
const Storage = {
  backend: 'downloads',
  save(blob, name) {
    return this[this.backend](blob, name);
  },
  async downloads(blob, name) {
    const url = await dataUrl(blob);
    const id = await chrome.downloads.download({ url, filename: `${FOLDER}/${name}`, conflictAction: 'uniquify', saveAs: false });
    await downloadDone(id);
    const [item] = await chrome.downloads.search({ id });
    return item?.filename || `${FOLDER}/${name}`;
  },
};

async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

function downloadDone(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(fail('save', 'Screenshot capture failed: the download did not finish')); }, DOWNLOAD_TIMEOUT_MS);
    const onChange = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') { off(); resolve(); }
      if (delta.state.current === 'interrupted') { off(); reject(fail('save', `Screenshot capture failed: download ${delta.error?.current || 'interrupted'}`)); }
    };
    const off = () => { clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChange); };
    chrome.downloads.onChanged.addListener(onChange);
  });
}

// ---- Names: {Account}_{Title}_{CCV}_{date_time}.png, safe on Windows ----
function fileName({ account, title, ccv }, when = new Date()) {
  const safe = (s, max) => String(s || '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\s.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    .slice(0, max).replace(/_$/, '') || 'Unknown';
  const count = ccv ? `${String(ccv).replace(/[^\dKMB.]/gi, '').replace(/\.$/, '')}CCV` : 'CCV-NA';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}_${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  return `${safe(account, 40)}_${safe(title, 60)}_${count}_${stamp}.png`;
}

// ---- Geometry: the block to keep, in page CSS pixels, then as viewport pixels ----
function union(parts) {
  const boxes = parts.filter((b) => b && b.width > 0 && b.height > 0);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

// The crop in image pixels: the block padded, moved into the viewport, clamped to it, and
// scaled from CSS pixels to the screenshot's pixels.
function cropRect(block, view, image) {
  const scale = image.width / view.width;
  const whole = { x: 0, y: 0, width: image.width, height: image.height };
  if (!block) return whole;
  const x0 = Math.max(0, block.x - PAD_PX - view.scrollX);
  const y0 = Math.max(0, block.y - PAD_PX - view.scrollY);
  const x1 = Math.min(view.width, block.x + block.width + PAD_PX - view.scrollX);
  const y1 = Math.min(view.height, block.y + block.height + PAD_PX - view.scrollY);
  if (x1 - x0 < 50 || y1 - y0 < 50) return whole;
  const r = (v) => Math.round(v * scale);
  return { x: r(x0), y: r(y0), width: Math.min(image.width - r(x0), r(x1 - x0)), height: Math.min(image.height - r(y0), r(y1 - y0)) };
}

// ---- The workflow ----
function detectPlatform(request) {
  return SOURCES.find((s) => s.handles(request)) || null;
}

async function openSourceTab(url, wallWindowId) {
  // No bigger than the wall's own window, so it fits whatever screen this is; Chrome places it.
  let bounds = { ...SOURCE_WINDOW };
  try {
    const wall = wallWindowId != null ? await chrome.windows.get(wallWindowId) : await chrome.windows.getLastFocused();
    if (wall?.width && wall?.height) bounds = { width: Math.min(bounds.width, wall.width), height: Math.min(bounds.height, wall.height) };
  } catch { /* the default size */ }
  const win = await chrome.windows.create({ url, type: 'popup', focused: false, ...bounds })
    .catch(() => chrome.windows.create({ url, type: 'popup', focused: false }));
  const tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  await chrome.tabs.update(tab.id, { muted: true }).catch(() => {}); // the source plays; nobody should hear it
  return { id: tab.id, windowId: win.id };
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(fail('load', 'Source page failed to load in time')); }, LOAD_TIMEOUT_MS);
    const onUpdated = (id, change) => { if (id === tabId && change.status === 'complete') { off(); resolve(); } };
    const onRemoved = (id) => { if (id === tabId) { off(); reject(fail('load', 'Source page was closed')); } };
    const off = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onRemoved.removeListener(onRemoved); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { off(); resolve(); } }, () => {});
  });
}

async function run(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r?.result;
}

const viewportOf = (tabId) => run(tabId, () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }));

async function probe(tabId, source) {
  let state;
  try {
    state = await run(tabId, source.probe);
  } catch (err) {
    throw fail('load', `Source page failed to load: ${err.message}`);
  }
  if (!state) throw fail('load', 'Source page failed to load');
  if (state.blocked) throw fail('blocked', state.blocked);
  return state;
}

// Polls the source until `ready` holds, or the time is up.
async function waitFor(tabId, source, ready, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let state = await probe(tabId, source);
  while (!ready(state)) {
    if (state.unavailable && !state.player) throw fail('unavailable', `Source video unavailable: ${state.unavailable}`);
    if (Date.now() > until) return { state, timedOut: true };
    await sleep(POLL_MS);
    state = await probe(tabId, source);
  }
  return { state, timedOut: false };
}

// The screenshot of the source window, cropped to the block. The window sits behind the
// wall; if the browser won't draw it there, it's brought forward for the shot and the
// operator's window gets focus straight back.
async function captureRelevantArea(tab, parts, wallWindowId) {
  const block = union(parts);
  if (block) await run(tab.id, (y) => window.scrollTo(0, y), [Math.max(0, block.y - PAD_PX)]);
  await sleep(250);
  const view = await viewportOf(tab.id);
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    await chrome.windows.update(tab.windowId, { focused: true });
    await sleep(400);
    try {
      shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } finally {
      if (wallWindowId != null) chrome.windows.update(wallWindowId, { focused: true }).catch(() => {});
    }
  }
  const image = await createImageBitmap(await (await fetch(shot)).blob());
  const crop = cropRect(block, view, image);
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  canvas.getContext('2d').drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  image.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

const saveScreenshot = (blob, name) => Storage.save(blob, name);

async function closeSourceTab(tab) {
  await chrome.windows.remove(tab.windowId).catch(() => chrome.tabs.remove(tab.id).catch(() => {}));
  // Gone for real before the wall hears back, so a second capture never meets the first's window.
  for (let i = 0; i < 20; i++) {
    const still = await chrome.tabs.get(tab.id).then(() => true, () => false);
    if (!still) return;
    await sleep(100);
  }
}

async function captureSourceScreenshot(request, notify) {
  const source = detectPlatform(request);
  if (!source) throw fail('no-source', 'Source URL unavailable for this feed');
  notify('opening', 'Opening source…');
  const tab = await openSourceTab(source.url(request), request.wallWindowId);
  try {
    await waitForLoad(tab.id);
    await chrome.tabs.setZoomSettings(tab.id, { scope: 'per-tab' }).catch(() => {});
    await chrome.tabs.setZoom(tab.id, ZOOM).catch(() => {});
    notify('source', 'Waiting for source data…');
    let { state, timedOut } = await waitFor(tab.id, source, source.sourceReady, SOURCE_TIMEOUT_MS);
    if (timedOut) {
      if (state.unavailable) throw fail('unavailable', `Source video unavailable: ${state.unavailable}`);
      throw fail('source', `Source page did not show its ${!state.player ? 'player' : !state.title ? 'title' : 'channel'} in time`);
    }
    let countMissing = '';
    if (source.wantsCount(state)) {
      notify('count', 'Waiting for CCV…');
      ({ state, timedOut } = await waitFor(tab.id, source, source.countReady, COUNT_TIMEOUT_MS));
      if (timedOut) countMissing = 'Viewer count could not be detected: saved as CCV-NA';
    }
    await sleep(SETTLE_MS);
    state = await probe(tab.id, source); // fresh positions and numbers for the shot
    notify('capturing', 'Capturing…');
    const png = await captureRelevantArea(tab, source.parts(state), request.wallWindowId);
    const facts = source.facts(state);
    const file = await saveScreenshot(png, fileName(facts));
    return { ok: true, file, facts, note: countMissing };
  } finally {
    await closeSourceTab(tab);
  }
}

// ---- This computer's CPU and memory, for walls whose server isn't the screen ----
// CPU is busy time over the time since the last reading (cumulative counters, so the first
// reading after the worker starts has no percentage yet). Memory is used ÷ installed.
let lastCpu = null;

function cpuPercent(prev, next) {
  if (!prev || !next) return null;
  let busy = 0;
  let total = 0;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]?.usage;
    const b = next[i]?.usage;
    if (!a || !b) continue;
    total += b.total - a.total;
    busy += (b.total - a.total) - (b.idle - a.idle);
  }
  return total > 0 ? Math.max(0, Math.min(100, (busy / total) * 100)) : null;
}

async function machineSample() {
  const out = { at: Date.now(), cpu: null, cores: null, memUsedPct: null, memTotalGB: null };
  try {
    const info = await chrome.system.cpu.getInfo();
    out.cores = info.numOfProcessors;
    out.cpu = cpuPercent(lastCpu, info.processors);
    lastCpu = info.processors;
  } catch { /* no system.cpu: cpu stays null */ }
  try {
    const mem = await chrome.system.memory.getInfo();
    out.memTotalGB = Math.round(mem.capacity / 1024 ** 3 * 10) / 10;
    out.memUsedPct = ((mem.capacity - mem.availableCapacity) / mem.capacity) * 100;
  } catch { /* no system.memory */ }
  return out;
}

// ---- Requests arrive from the courier in a wall's player frame; one capture at a time ----
let running = null;

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ixg-pc-request') {
      machineSample().then(sendResponse, () => sendResponse({ error: 'unavailable' }));
      return true;
    }
    if (msg?.type !== 'ixg-capture-request') return false;
    if (running) {
      sendResponse({ ok: false, reason: 'busy', message: 'A screenshot is already being captured: wait for it to finish' });
      return false;
    }
    const notify = (step, message) => {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'ixg-capture-progress', job: msg.job, step, message }, { frameId: sender.frameId }).catch(() => {});
    };
    const request = { platform: msg.platform, videoId: msg.videoId, label: msg.label, wallWindowId: sender.tab?.windowId };
    running = captureSourceScreenshot(request, notify).finally(() => { running = null; });
    running.then(sendResponse, (err) => sendResponse({ ok: false, reason: err.reason || 'failed', message: err.reason ? err.message : `Screenshot capture failed: ${err.message || err}` }));
    return true; // answered when the capture ends
  });
}

if (typeof module !== 'undefined') module.exports = { fileName, union, cropRect, detectPlatform, cpuPercent, SOURCES, FOLDER };
