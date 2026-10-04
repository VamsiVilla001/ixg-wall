// End-to-end check of the IXG Wall Feed Meter extension: starts Chrome with a throwaway
// profile, installs extension/ and opens a wall, then prints what each feed reports.
// Run it against a TEST wall, never the real one:
//   PORT=8095 IXG_DATA_DIR=./.data node server.js        (in one terminal; add feeds)
//   node tools/check-feed-meter.js http://localhost:8095   (in another)
// Re-run after YouTube changes its player: the meter reads YouTube internals that can move.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WALL = process.argv[2] || 'http://localhost:8095';
const WAIT_S = Number(process.argv[3]) || 45;
const CHROME = process.env.IXG_BROWSER || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('No Chrome found: set IXG_BROWSER to its path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-meter-check-'));
// Branded Chrome ignores --load-extension, so the extension goes in over the DevTools pipe.
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1600,1000',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buffer = '';
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
    else p.resolve(msg.result);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the wall page: what the wall shows for every feed, plus the header totals.
const READ_WALL = `(() => {
  const text = (el, sel) => el.querySelector(sel)?.textContent.trim() || null;
  return {
    header: {
      need: text(document, '#r-load') + ' (' + text(document, '#r-load-tag') + ')',
      getting: text(document, '#r-getting') + ' (' + text(document, '#r-getting-tag') + ')',
    },
    feeds: [...document.querySelectorAll('.tile')].map((t) => ({
      label: text(t, '.label'),
      status: text(t, '.status-text'),
      quality: text(t, '[data-stat="quality"]'),
      bitrate: text(t, '[data-stat="bitrate"]'),
    })),
  };
})()`;

// Opens the first feed's Stats sheet and returns its Network section.
const READ_FIRST_FEED = `(async () => {
  document.querySelector('.tile [data-act="stats"]').click();
  await new Promise((r) => setTimeout(r, 2500));
  const dl = document.querySelector('#fs-network');
  return [...dl.querySelectorAll('dt')].map((dt) => dt.textContent + ': ' + dt.nextElementSibling.textContent);
})()`;

(async () => {
  try {
    const { id: extensionId } = await send('Extensions.loadUnpacked', { path: path.join(__dirname, '..', 'extension') });
    console.log(`Extension loaded (${extensionId}). Opening ${WALL} and waiting ${WAIT_S} s…`);
    const { targetId } = await send('Target.createTarget', { url: WALL });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(WAIT_S * 1000);
    const { result } = await send('Runtime.evaluate', { expression: READ_WALL, returnByValue: true }, sessionId);
    console.log(JSON.stringify(result.value, null, 2));
    const sheet = await send('Runtime.evaluate', { expression: READ_FIRST_FEED, awaitPromise: true, returnByValue: true }, sessionId);
    console.log('First feed, Network:\n  ' + sheet.result.value.join('\n  '));
  } catch (err) {
    console.error(`Check failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    // Chrome's crash handler can hold a file in the profile for a moment after exit.
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      console.warn(`Couldn't remove the temporary profile ${profile}; delete it later.`);
    }
  }
})();
