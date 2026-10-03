// IXG Wall backend. Serves the wall (YouTube embeds refuse to play from file://
// pages), streams system telemetry to it, and runs the dedicated wall browser.
//   node server.js          serve the wall on http://localhost:8080
//   node server.js --open   ...and open it in the managed wall window
// IXG Wall.exe (npm run build) opens the wall window by default; --serve skips it.
const http = require('http');
const path = require('path');
const { Telemetry } = require('./backend/telemetry');
const { WallBrowser, DECODE_MODES } = require('./backend/wall-browser');
const { WallStore } = require('./backend/wall-store');
const { YouTubeStats } = require('./backend/youtube');
const { PACKAGED, readAsset } = require('./backend/assets');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const OPEN = process.argv.includes('--open') || (PACKAGED && !process.argv.includes('--serve'));
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const telemetry = new Telemetry({ intervalMs: 2000 });
const wallBrowser = new WallBrowser({ url: `http://localhost:${PORT}/` });
const wallStore = new WallStore();
const youtube = new YouTubeStats({ wallStore, referer: `http://localhost:${PORT}/` });
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

youtube.on('update', () => broadcast('youtube', youtube.state()));

telemetry.on('sample', (sample) => {
  const msg = `data: ${JSON.stringify({ ...sample, browser: wallBrowser.status() })}\n\n`;
  for (const res of sseClients) res.write(msg);
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10000) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

// Only the wall page itself may drive the browser: same origin, plus a custom header a
// cross-site form can't send without a CORS preflight this server never approves.
function trusted(req) {
  const origin = req.headers.origin;
  return req.headers['x-ixg-wall'] === '1' && (!origin || ORIGINS.has(origin));
}

async function handleApi(req, res, urlPath) {
  if (urlPath === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (telemetry.latest) res.write(`data: ${JSON.stringify({ ...telemetry.latest, browser: wallBrowser.status() })}\n\n`);
    res.write(`event: youtube\ndata: ${JSON.stringify(youtube.state())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (urlPath === '/api/wall' && req.method === 'GET') {
    return sendJson(res, 200, { version: wallStore.version, wall: wallStore.wall });
  }
  if (urlPath === '/api/wall' && req.method === 'PUT') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 512 * 1024);
    const version = wallStore.save(body.wall);
    if (version == null) return sendJson(res, 400, { error: 'Invalid wall' });
    broadcast('wall', { version, clientId: String(body.clientId || '') });
    youtube.wallChanged();
    return sendJson(res, 200, { version });
  }
  if (urlPath === '/api/youtube' && req.method === 'GET') {
    return sendJson(res, 200, youtube.state());
  }
  if (urlPath === '/api/youtube/history' && req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    return sendJson(res, 200, { id, series: youtube.series(id) });
  }
  if (urlPath === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { telemetry: telemetry.latest, browser: wallBrowser.status() });
  }
  if (urlPath === '/api/wall-browser' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req);
    try {
      if (body.action === 'launch') return sendJson(res, 200, await wallBrowser.launch());
      if (body.action === 'relaunch') {
        if (body.decode && !DECODE_MODES.includes(body.decode)) return sendJson(res, 400, { error: 'Unknown decode mode' });
        // Answer first: when the request comes from the wall window itself, it is about to close.
        sendJson(res, 202, { ...wallBrowser.status(), decode: body.decode || wallBrowser.decode, relaunching: true });
        wallBrowser.relaunch({ decode: body.decode }).catch((err) => console.error('Relaunch failed:', err.message));
        return;
      }
      return sendJson(res, 400, { error: 'Unknown action' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath).catch((err) => sendJson(res, 500, { error: err.message }));
    return;
  }
  const rel = path.posix.normalize(urlPath === '/' ? '/index.html' : urlPath).slice(1);
  if (!rel || rel.startsWith('..') || rel.includes('\\') || rel.includes('\0')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const data = readAsset(`public/${rel}`);
  if (!data) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(data);
});

// Already running (a second double-click): hand over to that backend instead of failing.
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`The IXG Wall backend is already running on port ${PORT}.`);
  if (OPEN) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/wall-browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify({ action: 'launch' }),
      });
      const s = await res.json();
      console.log(s.running ? `Wall window is open (${s.browser}, ${s.decode} decode).` : `Could not open the wall window: ${s.error || res.status}`);
    } catch (e) {
      console.error(`Port ${PORT} is taken by something else: ${e.message}`);
    }
  }
  // A double-clicked exe's window closes on exit; leave the message up long enough to read.
  setTimeout(() => process.exit(0), PACKAGED ? 4000 : 0);
});

// Same for a crash: show the error instead of a window that blinks shut.
if (PACKAGED) {
  process.on('uncaughtException', (err) => {
    console.error(`\nIXG Wall stopped: ${err.stack || err}`);
    console.error('Press Enter to close.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`IXG Wall running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (PACKAGED) console.log('Keep this window open while the wall runs. Closing it stops the backend.');
  telemetry.start();
  youtube.start();
  if (OPEN) {
    // Give an adopted wall window a moment to be recognised before launching a new one.
    setTimeout(() => wallBrowser.launch()
      .then((s) => console.log(`Wall window: ${s.browser} · ${s.decode} decode · pid ${s.pid}`))
      .catch((err) => console.error(err.message)), 1500);
  }
});

// SIGHUP: the backend's console window was closed (Windows allows a few seconds to finish).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    telemetry.stop();
    youtube.stop(); // writes the audience history so a restart keeps it
    process.exit(0);
  });
}
