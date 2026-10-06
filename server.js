// IXG Wall backend. Serves the wall (YouTube embeds refuse to play from file://
// pages), streams telemetry and YouTube numbers to it, and on the laptop runs the
// dedicated wall browser.
//   node server.js          serve the wall on http://localhost:8080
//   node server.js --open   ...and open it in the managed wall window
//   IXG_HOSTED=1 ...        run it as a website with a sign-in (see DEPLOY.md)
// Settings come from the environment: see backend/config.js and .env.example.
const http = require('http');
const path = require('path');
const config = require('./backend/config');
const { Auth, clientAddress } = require('./backend/auth');
const { Secrets } = require('./backend/secrets');
const { UserLinks, ID_FORMAT } = require('./backend/user-links');
const { GoogleCredentials } = require('./backend/google-credentials');
const { IngestHealth } = require('./backend/youtube-ingest');
const feedMeter = require('./backend/extension');
const { Telemetry } = require('./backend/telemetry');
const { WallBrowser, DECODE_MODES, PROFILE_DIR } = require('./backend/wall-browser');
const { WallStore } = require('./backend/wall-store');
const { YouTubeStats } = require('./backend/youtube');
const { AutoCapture } = require('./backend/auto-capture');
const { readAsset } = require('./backend/assets');

const { PORT, HOST, HOSTED, PUBLIC_URL } = config;

const problems = config.problems();
if (problems.length) {
  console.error(`IXG Wall can't start:\n  ${problems.join('\n  ')}\nSee DEPLOY.md.`);
  process.exit(1);
}

// The wall window is a laptop feature: a server has no screen to open it on.
const OPEN = !HOSTED && process.argv.includes('--open');
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
// Reachable without signing in: the sign-in page (also what a user link opens), what it
// loads, and the health check.
const PUBLIC_PATHS = new Set(['/login', '/join', '/style.css', '/ixg-tokens.css', '/ixg-logo.svg', '/healthz', '/api/login', '/api/join', '/api/logout']);
// Wall settings only an admin may change: a user's save keeps the admin's values. The poll
// interval spends the admin's YouTube quota; the rest are the wall computer's own.
const ADMIN_SETTINGS = ['ytPollSec', 'memLimitMB', 'offloadEveryMin', 'autoCapture', 'autoCaptureMin'];

// Whether a wall a user wants to save holds any feed the admin never put there.
function addsFeeds(wall) {
  const sources = (streams) => (Array.isArray(streams) ? streams : []).map((s) => s?.source?.id);
  const known = new Set([
    ...sources(wallStore.wall?.streams),
    ...(wallStore.wall?.savedSessions || []).flatMap((s) => sources(s.streams)),
  ]);
  const wanted = [...sources(wall.streams), ...(Array.isArray(wall.savedSessions) ? wall.savedSessions : []).flatMap((s) => sources(s?.streams))];
  return wanted.some((id) => !known.has(id));
}
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
const userLinks = new UserLinks(secrets);
const auth = new Auth({ password: config.PASSWORD, secret: secrets.sessionSecret, secure: config.SECURE_COOKIES, linkActive: (id) => userLinks.active(id) });
const telemetry = new Telemetry({ intervalMs: 2000, hosted: HOSTED, wallProfile: HOSTED ? '' : PROFILE_DIR });
const wallBrowser = HOSTED ? null : new WallBrowser({ url: `http://localhost:${PORT}/` });
// Anyone's YouTube key and Google OAuth client, checked with Google before they're saved.
const credentials = new GoogleCredentials({ secrets, publicUrl: PUBLIC_URL, port: PORT });
const youtube = new YouTubeStats({ wallStore, credentials });
const ingest = new IngestHealth({ credentials, wallStore, pollMs: () => youtube.pollMs() });
youtube.ingest = ingest; // its state rides along with the YouTube numbers
// Automatic source screenshots: decided here, taken by an admin's page with the Feed Meter.
const autoCapture = new AutoCapture({ youtube, ingest, wallStore });
const sseClients = new Map(); // response -> { role, linkId } of whoever opened it
const browserStatus = () => (wallBrowser ? wallBrowser.status() : { supported: false, hosted: true });

// What a user's page gets of the YouTube state: the numbers and each feed's ingest health,
// but nothing about the key, the OAuth client or which channels signed in, and no Google
// error text (it can name the key's restrictions or the client).
// A link made without YouTube gets the state of a wall with no key at all.
function youtubeFor(role, link = null) {
  const s = youtube.state();
  if (role === 'admin') return { ...s, captures: autoCapture.open(), captureLog: autoCapture.entries(), captureLogBoot: autoCapture.boot };
  if (link && link.youtube === false) {
    return { status: 'off', error: '', key: { set: false }, ingest: null, updatedAt: 0, pollMs: s.pollMs, units: { used: 0, limit: 0 }, total: { now: null }, videos: {} };
  }
  const ing = s.ingest;
  return {
    ...s,
    error: s.error ? 'YouTube data is unavailable right now.' : '',
    key: { set: !!s.key?.set },
    ingest: ing && {
      signedIn: ing.signedIn,
      status: ing.status,
      error: ing.error ? 'Ingest health is unavailable right now.' : '',
      updatedAt: ing.updatedAt,
      ownersEveryMs: ing.ownersEveryMs,
      channels: [],
      videos: ing.videos,
    },
  };
}

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
  for (const res of sseClients.keys()) res.write(msg);
}

// The YouTube state goes out in three cuts: the admin's, the users', and nothing for
// links made without YouTube.
function broadcastYoutube() {
  const msgs = {};
  for (const [res, { role, linkId }] of sseClients) {
    const link = linkId ? userLinks.get(linkId) : null;
    const cut = role === 'admin' ? 'admin' : link?.youtube === false ? 'none' : 'user';
    msgs[cut] ??= `event: youtube\ndata: ${JSON.stringify(youtubeFor(role, link))}\n\n`;
    res.write(msgs[cut]);
  }
}

youtube.on('update', () => {
  autoCapture.check();
  broadcastYoutube();
});
ingest.on('update', () => {
  autoCapture.check();
  broadcastYoutube();
});
autoCapture.on('change', broadcastYoutube);
ingest.on('quiet', () => youtube.pollSoon()); // an encoder stopped: has YouTube ended the broadcast?
credentials.on('key', () => youtube.keyChanged());
credentials.on('change', () => {
  ingest.channelsChanged();
  broadcastYoutube();
});
credentials.on('checked', broadcastYoutube);

telemetry.on('sample', (sample) => {
  const msg = `data: ${JSON.stringify({ ...sample, browser: browserStatus() })}\n\n`;
  for (const res of sseClients.keys()) res.write(msg);
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
  sendJson(res, 200, { ok: true, role: 'admin' }, { 'Set-Cookie': auth.sessionCookie('admin') });
}

// A user link, opened or pasted: signs this browser in as a user. Wrong links count
// towards the same lockout as wrong passwords.
async function join(req, res) {
  if (!auth.enabled) return sendJson(res, 409, { error: 'This wall has no sign-in, so it needs no link: open it directly.' });
  if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const addr = clientAddress(req);
  const wait = auth.lockedFor(addr);
  if (wait) {
    return sendJson(res, 429, { error: `Too many wrong links. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });
  }
  const body = await readBody(req, 2000);
  const link = userLinks.find(body.link);
  if (!link) {
    await auth.failed(addr);
    console.warn(`Failed user link from ${addr}`);
    return sendJson(res, 401, { error: 'This link doesn\'t work: it may have been revoked or have expired. Ask the wall\'s admin for a new one.' });
  }
  auth.succeeded(addr);
  userLinks.used(link);
  const until = link.expiresAt ? Date.parse(link.expiresAt) : Infinity;
  sendJson(res, 200, { ok: true, role: 'user' }, { 'Set-Cookie': auth.sessionCookie('user', link.id, until) });
}

const adminOnly = (res) => sendJson(res, 403, { error: 'Only an admin can do this. Sign in with the wall password.' });

async function handleApi(req, res, urlPath, session) {
  if (urlPath === '/api/login' && req.method === 'POST') return login(req, res);
  if (urlPath === '/api/join' && req.method === 'POST') return join(req, res);
  if (urlPath === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }
  const role = session.role;
  const admin = role === 'admin';
  const link = session.linkId ? userLinks.get(session.linkId) : null; // the user link this session came from
  // Integrations and the wall computer: an admin's alone. Checked here, so a user can't
  // reach them by calling the API directly, whatever their page shows.
  if (!admin && (urlPath.startsWith('/api/youtube/key') || urlPath.startsWith('/api/youtube/oauth/')
    || urlPath.startsWith('/api/links') || urlPath === '/api/wall-browser')) {
    return adminOnly(res);
  }
  // A link made without YouTube gets none of its data, the audience history included.
  if (!admin && link?.youtube === false && urlPath === '/api/youtube/history') {
    return sendJson(res, 403, { error: 'This link was made without YouTube data.' });
  }
  // What this server is: the page adapts (no laptop readouts when hosted, a Sign out button,
  // and for a user, no integrations).
  if (urlPath === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      hosted: HOSTED,
      auth: auth.enabled,
      role,
      linkName: link?.name || null,
      ytKey: admin ? credentials.keyInfo() : { set: credentials.keyInfo().set && link?.youtube !== false },
      linkYoutube: admin ? null : link?.youtube !== false, // false: the admin made this link without YouTube data
      // The Feed Meter extension: what the page checks for, and where to get it.
      extension: feedMeter.info({ extraIds: config.EXTENSION_IDS, storeUrl: config.EXTENSION_STORE_URL }),
    });
  }
  if (urlPath === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (telemetry.latest) res.write(`data: ${JSON.stringify({ ...telemetry.latest, browser: browserStatus() })}\n\n`);
    res.write(`event: youtube\ndata: ${JSON.stringify(youtubeFor(role, link))}\n\n`);
    sseClients.set(res, session);
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
    if (!admin && body.wall && typeof body.wall === 'object') {
      const kept = wallStore.wall?.settings || {};
      body.wall.settings = { ...(body.wall.settings || {}) };
      for (const key of ADMIN_SETTINGS) {
        if (key in kept) body.wall.settings[key] = kept[key];
        else delete body.wall.settings[key];
      }
      // Users don't add feeds: only links already on the wall, or in a saved session the
      // admin left, may appear in what they save (so reordering, removing, renaming and
      // switching sessions still work).
      if (addsFeeds(body.wall)) return sendJson(res, 403, { error: 'Only the wall\'s admin can add feeds.' });
    }
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
    return sendJson(res, 200, youtubeFor(role, link));
  }
  // ---- User links: an admin generates and revokes them; each signs browsers in as users ----
  if (urlPath === '/api/links' && req.method === 'GET') {
    return sendJson(res, 200, { enabled: auth.enabled, links: userLinks.list(PUBLIC_URL) });
  }
  if (urlPath === '/api/links' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!auth.enabled) return sendJson(res, 409, { error: 'User links need a wall password (IXG_PASSWORD): without one, anyone who can reach the wall is already an admin.' });
    const body = await readBody(req, 2000);
    const { error } = userLinks.create({ name: body.name, days: body.days, youtube: body.youtube !== false });
    if (error) return sendJson(res, 400, { error });
    return sendJson(res, 200, { links: userLinks.list(PUBLIC_URL) });
  }
  if (urlPath === '/api/links/revoke' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    if (!ID_FORMAT.test(String(body.id || '')) || !userLinks.revoke(body.id)) return sendJson(res, 404, { error: 'No such link: it may already be revoked.' });
    // Its live streams were let in before: close them. The page then finds it's signed out.
    for (const [stream, s] of sseClients) {
      if (s.linkId === body.id) {
        sseClients.delete(stream);
        stream.end();
      }
    }
    return sendJson(res, 200, { links: userLinks.list(PUBLIC_URL) });
  }
  // Anyone's key goes in here (checked with YouTube first) and never comes back out: pages
  // only learn whether one is set.
  if (urlPath === '/api/youtube/key' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const result = await credentials.saveApiKey(body.key);
    return sendJson(res, result.status, { ytKey: credentials.keyInfo(), check: result.check || null, error: result.error });
  }
  // ---- Channel sign-in: ingest health for the feeds each signed-in channel owns -------
  // Anyone's OAuth client, checked with Google first; empty fields remove it.
  if (urlPath === '/api/youtube/oauth/client' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const result = await credentials.saveOauthClient({ clientId: body.clientId, clientSecret: body.clientSecret });
    return sendJson(res, result.status, { ingest: ingest.state(), check: result.check || null, error: result.error });
  }
  // "Check again" once the client is fixed in Google Cloud.
  if (urlPath === '/api/youtube/oauth/check' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    await credentials.recheckOauthClient();
    return sendJson(res, 200, { ingest: ingest.state() });
  }
  if (urlPath === '/api/youtube/oauth/start' && req.method === 'GET') {
    // Google would send the browser back to localhost, which is only this server on its own computer.
    const onThisComputer = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
    if (credentials.localUrl && !onThisComputer) {
      return sendHtml(res, 400, oauthPage('Sign in from the server\'s computer',
        `Google only returns sign-ins to https addresses or to localhost, not to ${PUBLIC_URL}. On the computer running this wall, open ${credentials.localUrl}, sign in to the wall, and sign the channel in from Settings there. Every window of the wall then gets its ingest health.`, false));
    }
    try {
      return redirect(res, credentials.authUrl());
    } catch (err) {
      return sendHtml(res, 400, oauthPage('Can\'t start the sign-in', err.message, false));
    }
  }
  if (urlPath === '/api/youtube/oauth/callback' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    try {
      const title = await credentials.finish({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
      return sendHtml(res, 200, oauthPage('Signed in', `IXG Wall now reads ingest health for the feeds on ${title}. You can close this window.`, true));
    } catch (err) {
      return sendHtml(res, 400, oauthPage('Sign-in didn\'t finish', err.message, false));
    }
  }
  // { channelId } signs that channel out; without one, every channel.
  if (urlPath === '/api/youtube/oauth/signout' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    await credentials.signOut(typeof body.channelId === 'string' && body.channelId ? body.channelId : undefined);
    return sendJson(res, 200, { ingest: ingest.state() });
  }
  if (urlPath === '/api/youtube/history' && req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    return sendJson(res, 200, { id, series: youtube.series(id) });
  }
  // ---- Automatic source screenshots: a page claims a job, takes it, and reports back ----
  if ((urlPath === '/api/capture/claim' || urlPath === '/api/capture/result') && req.method === 'POST') {
    if (!admin) return adminOnly(res);
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const job = String(body.job || '');
    const client = String(body.client || '').slice(0, 40);
    if (urlPath === '/api/capture/claim') {
      const claimed = autoCapture.claim(job, client);
      return claimed ? sendJson(res, 200, claimed) : sendJson(res, 409, { error: 'Taken by another window, or no longer due' });
    }
    return sendJson(res, 200, { ok: autoCapture.finish(job, { retry: body.retry === true, busy: body.busy === true, outcome: String(body.outcome || ''), detail: String(body.detail || ''), client }) });
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

  const session = auth.session(req);
  const signedIn = !!session;
  if (!signedIn && !isPublic(urlPath)) {
    // The page's own calls get JSON. A browser opening an API address itself (the Google
    // sign-in popup, a bookmarked link) goes to the sign-in page and comes back afterwards.
    const navigating = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate';
    if (urlPath.startsWith('/api/') && !navigating) return sendJson(res, 401, { error: 'Sign in required' });
    return redirect(res, req.method === 'GET' && req.url !== '/' ? `/login?next=${encodeURIComponent(req.url)}` : '/login');
  }
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath, session || { role: null, linkId: null }).catch((err) => sendJson(res, 500, { error: err.message }));
    return;
  }
  // A user link (/join#token): the sign-in page reads the token from the address and signs
  // in with it. The token is after the #, so it never reaches the server's logs.
  if (urlPath === '/join') return serveFile(res, 'login.html');
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

// Already running (started twice): hand over to that backend instead of failing.
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
  process.exit(HOSTED ? 1 : 0);
});

server.listen(PORT, HOST, () => {
  console.log(`IXG Wall running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOSTED) {
    console.log(`Hosted: people open ${PUBLIC_URL} and sign in with IXG_PASSWORD.`);
    if (!config.SECURE_COOKIES) console.warn('PUBLIC_URL is plain http: fine for a local test, but serve the real site over https.');
  } else if (auth.enabled) {
    console.log('Sign-in required (IXG_PASSWORD is set).');
  }
  telemetry.start();
  credentials.start();
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
