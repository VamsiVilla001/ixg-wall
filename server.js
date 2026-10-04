// IXG Wall backend. Serves the wall (YouTube embeds refuse to play from file://
// pages), streams telemetry and YouTube numbers to it, and on the laptop runs the
// dedicated wall browser.
//   node server.js          serve the wall on http://localhost:8080
//   node server.js --open   ...and open it in the managed wall window
//   IXG_HOSTED=1 ...        run it as a website with a sign-in (see DEPLOY.md)
// IXG Wall.exe (npm run build) opens the wall window by default; --serve skips it.
// Settings come from the environment: see backend/config.js and .env.example.
const http = require('http');
const path = require('path');
const config = require('./backend/config');
const { Auth, clientAddress } = require('./backend/auth');
const { Secrets, YT_KEY_FORMAT, OAUTH_CLIENT_ID_FORMAT, OAUTH_SECRET_FORMAT } = require('./backend/secrets');
const { IngestHealth } = require('./backend/youtube-ingest');
const feedMeter = require('./backend/extension');
const { Telemetry } = require('./backend/telemetry');
const { WallBrowser, DECODE_MODES } = require('./backend/wall-browser');
const { WallStore } = require('./backend/wall-store');
const { YouTubeStats } = require('./backend/youtube');
const { PACKAGED, readAsset } = require('./backend/assets');

const { PORT, HOST, HOSTED, PUBLIC_URL } = config;

const problems = config.problems();
if (problems.length) {
  console.error(`IXG Wall can't start:\n  ${problems.join('\n  ')}\nSee DEPLOY.md.`);
  process.exit(1);
}

// The wall window is a laptop feature: a server has no screen to open it on.
const OPEN = !HOSTED && (process.argv.includes('--open') || (PACKAGED && !process.argv.includes('--serve')));
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, PUBLIC_URL]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
// Reachable without signing in: the sign-in page, what it loads, and the health check.
const PUBLIC_PATHS = new Set(['/login', '/style.css', '/healthz', '/api/login', '/api/logout']);
const isPublic = (p) => PUBLIC_PATHS.has(p) || p.startsWith('/fonts/');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // YouTube embeds need the page's origin as referrer (error 153 without it); this sends no more.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

const wallStore = new WallStore();
const secrets = new Secrets({ envYtKey: config.YOUTUBE_API_KEY, envOauthClient: config.GOOGLE_OAUTH_CLIENT });
const auth = new Auth({ password: config.PASSWORD, secret: secrets.sessionSecret, secure: config.SECURE_COOKIES });
const telemetry = new Telemetry({ intervalMs: 2000, hosted: HOSTED });
const wallBrowser = HOSTED ? null : new WallBrowser({ url: `http://localhost:${PORT}/` });
const youtube = new YouTubeStats({ wallStore, secrets, referer: `${PUBLIC_URL}/` });
const ingest = new IngestHealth({
  secrets,
  wallStore,
  redirectUri: `${PUBLIC_URL}/api/youtube/oauth/callback`,
  pollMs: () => youtube.pollMs(),
});
youtube.ingest = ingest; // its state rides along with the YouTube numbers
const sseClients = new Set();
const browserStatus = () => (wallBrowser ? wallBrowser.status() : { supported: false, hosted: true });

// Walls saved before the key moved to secrets.json kept it in wall.json: move it out, once.
// Walls from before sessions get their feeds put in a saved session (see wall-store.js).
if (wallStore.legacyKey && !secrets.ytKeyInfo().set) secrets.setYtApiKey(wallStore.legacyKey);
if (wallStore.legacyKey || wallStore.migrated) {
  try {
    wallStore.save(wallStore.wall);
    if (wallStore.legacyKey) console.log('Moved the YouTube API key from wall.json to secrets.json.');
    if (wallStore.migrated) console.log('Saved the earlier feeds as the session "Before sessions"; the wall starts a new, empty session.');
  } catch (err) {
    console.error(`Could not rewrite wall.json: ${err.message}`);
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

youtube.on('update', () => broadcast('youtube', youtube.state()));
ingest.on('update', () => broadcast('youtube', youtube.state()));

telemetry.on('sample', (sample) => {
  const msg = `data: ${JSON.stringify({ ...sample, browser: browserStatus() })}\n\n`;
  for (const res of sseClients) res.write(msg);
});

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
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

// Only the wall page itself may change things: same origin, plus a custom header a
// cross-site form can't send without a CORS preflight this server never approves.
function trusted(req) {
  const origin = req.headers.origin;
  return req.headers['x-ixg-wall'] === '1' && (!origin || ORIGINS.has(origin));
}

async function login(req, res) {
  if (!auth.enabled) return sendJson(res, 200, { ok: true });
  if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const addr = clientAddress(req);
  const wait = auth.lockedFor(addr);
  if (wait) {
    return sendJson(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });
  }
  const body = await readBody(req, 2000);
  if (!auth.checkPassword(body.password)) {
    await auth.failed(addr);
    console.warn(`Failed sign-in from ${addr}`);
    return sendJson(res, 401, { error: 'Wrong password.' });
  }
  auth.succeeded(addr);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie() });
}

async function handleApi(req, res, urlPath) {
  if (urlPath === '/api/login' && req.method === 'POST') return login(req, res);
  if (urlPath === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }
  // What this server is: the page adapts (no laptop readouts when hosted, a Sign out button).
  if (urlPath === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      hosted: HOSTED,
      auth: auth.enabled,
      ytKey: secrets.ytKeyInfo(),
      // The Feed Meter extension: what the page checks for, and where to get it.
      extension: feedMeter.info({ extraIds: config.EXTENSION_IDS, storeUrl: config.EXTENSION_STORE_URL }),
    });
  }
  if (urlPath === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (telemetry.latest) res.write(`data: ${JSON.stringify({ ...telemetry.latest, browser: browserStatus() })}\n\n`);
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
    if (wallStore.stale(body.wall)) {
      return sendJson(res, 409, { error: 'This page is older than sessions: reload it.' });
    }
    const version = wallStore.save(body.wall);
    if (version == null) return sendJson(res, 400, { error: 'Invalid wall' });
    const session = wallStore.wall.session;
    broadcast('wall', { version, clientId: String(body.clientId || ''), session: session ? { id: session.id, name: session.name } : null });
    youtube.wallChanged();
    ingest.wallChanged();
    return sendJson(res, 200, { version });
  }
  if (urlPath === '/api/youtube' && req.method === 'GET') {
    return sendJson(res, 200, youtube.state());
  }
  // The key goes in here and never comes back out: pages only learn whether one is set.
  if (urlPath === '/api/youtube/key' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const key = typeof body.key === 'string' ? body.key.trim() : null;
    if (key == null || (key && !YT_KEY_FORMAT.test(key))) {
      return sendJson(res, 400, { error: 'That doesn\'t look like a YouTube Data API key (AIza…, 39 characters).' });
    }
    if (!secrets.setYtApiKey(key)) {
      return sendJson(res, 409, { error: 'This server sets the key itself (YOUTUBE_API_KEY), so it can\'t be changed here.', ytKey: secrets.ytKeyInfo() });
    }
    youtube.keyChanged();
    return sendJson(res, 200, { ytKey: secrets.ytKeyInfo() });
  }
  // ---- Channel sign-in: ingest health for the feeds the channel owns ----------------
  if (urlPath === '/api/youtube/oauth/client' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const clientId = String(body.clientId || '').trim();
    const clientSecret = String(body.clientSecret || '').trim();
    const clearing = !clientId && !clientSecret;
    if (!clearing && (!OAUTH_CLIENT_ID_FORMAT.test(clientId) || !OAUTH_SECRET_FORMAT.test(clientSecret))) {
      return sendJson(res, 400, { error: 'That isn\'t a Google OAuth client: the ID ends in .apps.googleusercontent.com and the secret usually starts GOCSPX-.' });
    }
    if (!secrets.setOauthClient(clearing ? null : { clientId, clientSecret })) {
      return sendJson(res, 409, { error: 'This server sets the OAuth client itself (GOOGLE_OAUTH_CLIENT_ID), so it can\'t be changed here.' });
    }
    ingest.access = null;
    ingest.wallChanged();
    broadcast('youtube', youtube.state());
    return sendJson(res, 200, { ingest: ingest.state() });
  }
  if (urlPath === '/api/youtube/oauth/start' && req.method === 'GET') {
    try {
      return redirect(res, ingest.authUrl());
    } catch (err) {
      return sendHtml(res, 400, oauthPage('Can\'t start the sign-in', err.message, false));
    }
  }
  if (urlPath === '/api/youtube/oauth/callback' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    try {
      const title = await ingest.finish({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
      return sendHtml(res, 200, oauthPage('Signed in', `IXG Wall now reads ingest health for the feeds on ${title}. You can close this window.`, true));
    } catch (err) {
      return sendHtml(res, 400, oauthPage('Sign-in didn\'t finish', err.message, false));
    }
  }
  if (urlPath === '/api/youtube/oauth/signout' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    await ingest.signOut();
    return sendJson(res, 200, { ingest: ingest.state() });
  }
  if (urlPath === '/api/youtube/history' && req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    return sendJson(res, 200, { id, series: youtube.series(id) });
  }
  if (urlPath === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { telemetry: telemetry.latest, browser: browserStatus() });
  }
  if (urlPath === '/api/wall-browser' && req.method === 'POST') {
    if (!wallBrowser) return sendJson(res, 404, { error: 'No wall window on a hosted wall' });
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

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The page Google's sign-in returns to, in the wall's popup. It tells the wall and closes.
function oauthPage(title, message, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · IXG Wall</title><link rel="stylesheet" href="/style.css">
<style>main{flex:1;display:grid;place-items:center;padding:24px}.card{max-width:420px;display:grid;gap:10px}.card h1{font:800 20px/1.2 var(--font-sans)}</style>
</head><body><main><div class="card"><p class="telemetry muted">IXG Wall · Channel sign-in</p><h1>${escapeHtml(title)}</h1>
<p class="${ok ? 'hint' : 'form-error'}">${escapeHtml(message)}</p></div></main>
<script>try { window.opener && window.opener.postMessage({ type: 'ixg-oauth-done', ok: ${ok ? 'true' : 'false'} }, location.origin); } catch (e) {}
${ok ? 'setTimeout(function () { window.close(); }, 2500);' : ''}</script></body></html>`;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function serveFile(res, rel) {
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
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (HOSTED) for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (urlPath === '/healthz') return sendJson(res, 200, { ok: true });

  const signedIn = auth.allows(req);
  if (!signedIn && !isPublic(urlPath)) {
    if (urlPath.startsWith('/api/')) return sendJson(res, 401, { error: 'Sign in required' });
    return redirect(res, req.method === 'GET' && req.url !== '/' ? `/login?next=${encodeURIComponent(req.url)}` : '/login');
  }
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath).catch((err) => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (urlPath === feedMeter.DOWNLOAD_PATH && req.method === 'GET') {
    const data = feedMeter.zipFile();
    if (!data) return sendJson(res, 404, { error: 'The extension isn\'t shipped with this build' });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="ixg-wall-feed-meter.zip"',
      'Cache-Control': 'no-store',
    });
    res.end(data);
    return;
  }
  if (urlPath === '/login') {
    // Nothing to sign in to on the laptop wall, and no second sign-in once signed in.
    if (!auth.enabled || signedIn) return redirect(res, '/');
    return serveFile(res, 'login.html');
  }
  const rel = path.posix.normalize(urlPath === '/' ? '/index.html' : urlPath).slice(1);
  if (!rel || rel.startsWith('..') || rel.includes('\\') || rel.includes('\0')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  serveFile(res, rel);
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
  setTimeout(() => process.exit(HOSTED ? 1 : 0), PACKAGED ? 4000 : 0);
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
  if (HOSTED) {
    console.log(`Hosted: people open ${PUBLIC_URL} and sign in with IXG_PASSWORD.`);
    if (!config.SECURE_COOKIES) console.warn('PUBLIC_URL is plain http: fine for a local test, but serve the real site over https.');
  } else if (auth.enabled) {
    console.log('Sign-in required (IXG_PASSWORD is set).');
  }
  if (PACKAGED) console.log('Keep this window open while the wall runs. Closing it stops the backend.');
  telemetry.start();
  youtube.start();
  ingest.start();
  if (OPEN) {
    // Give an adopted wall window a moment to be recognised before launching a new one.
    setTimeout(() => wallBrowser.launch()
      .then((s) => console.log(`Wall window: ${s.browser} · ${s.decode} decode · pid ${s.pid}`))
      .catch((err) => console.error(err.message)), 1500);
  }
});

// SIGHUP: the backend's console window was closed (Windows allows a few seconds to finish).
// SIGTERM: systemd stopping or restarting the service on a server.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    telemetry.stop();
    ingest.stop();
    youtube.stop(); // writes the audience history so a restart keeps it
    process.exit(0);
  });
}
