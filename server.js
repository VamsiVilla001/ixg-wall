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
const { Accounts } = require('./backend/accounts');
const { GoogleCredentials } = require('./backend/google-credentials');
const { IngestHealth } = require('./backend/youtube-ingest');
const feedMeter = require('./backend/extension');
const { Telemetry } = require('./backend/telemetry');
const { WallBrowser, DECODE_MODES, PROFILE_DIR, findBrowser } = require('./backend/wall-browser');
const { SessionStore, SESSION_ID } = require('./backend/session-store');
const { YouTubeStats } = require('./backend/youtube');
const { StudioAudience } = require('./backend/youtube-studio');
const { PcvTracker } = require('./backend/pcv');
const { AutoCapture, BACKEND } = require('./backend/auto-capture');
const { SourceCapture, readableName, shotFolder, shortFeedName, dayFolder, LAYOUTS, FEED_NAMES } = require('./backend/source-capture');
const { SlackPoster } = require('./backend/slack');
const { GoogleDrive } = require('./backend/gdrive');
const { OneDrive } = require('./backend/onedrive');
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
const PUBLIC_PATHS = new Set(['/login', '/join', '/style.css', '/ixg-tokens.css', '/ixg-logo.svg', '/healthz', '/api/login', '/api/join', '/api/logout',
  '/api/login/options', '/api/auth/microsoft/start', '/api/auth/microsoft/callback']);
// Wall settings only an admin may change: a user's save keeps the admin's values. The poll
// interval spends the admin's YouTube quota; the rest are the wall computer's own.
const ADMIN_SETTINGS = ['ytPollSec', 'memLimitMB', 'offloadEveryMin', 'autoCapture', 'autoCaptureMin'];
// An operator (a link with that role) runs the wall, screenshots included, but the poll
// interval spends the admin's quota and the memory settings are the wall computer's.
const OPERATOR_LOCKED = ['ytPollSec', 'memLimitMB', 'offloadEveryMin'];

// Whether a wall a user wants to save holds any feed no session has (live or archived):
// users don't add feeds, an admin does.
function addsFeeds(wall) {
  const known = new Set(sessions.sessions.flatMap((s) => s.streams.map((x) => x.source?.id)));
  return (Array.isArray(wall.streams) ? wall.streams : []).some((x) => !known.has(x?.source?.id));
}
const isPublic = (p) => PUBLIC_PATHS.has(p) || p.startsWith('/fonts/');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // YouTube embeds need the page's origin as referrer (error 153 without it); this sends no more.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

// Every session (one event's wall each); any number live at once (backend/session-store.js).
const sessions = new SessionStore();
const secrets = new Secrets({ envYtKey: config.YOUTUBE_API_KEY, envOauthClient: config.GOOGLE_OAUTH_CLIENT, envSlack: config.SLACK, envMsClient: config.MS_CLIENT });
// Where screenshots go besides the disk: anyone's Slack app, a Google Drive folder, a
// OneDrive folder; each checked with its service before it's saved.
const slack = new SlackPoster({ secrets });
const userLinks = new UserLinks(secrets);
// Who may sign in with a Microsoft 365 account, and as what (Admin center → Access).
const accounts = new Accounts({ secrets, publicUrl: PUBLIC_URL, envAdmins: config.ADMINS });
// A session goes on while what it came from still grants its role: a link (with that role)
// or a listed account.
const principalActive = (role, id) => (role !== 'admin' && userLinks.active(id) && (userLinks.get(id)?.role === 'operator' ? 'operator' : 'user') === role) || accounts.active(role, id);
const auth = new Auth({ password: config.PASSWORD, secret: secrets.sessionSecret, secure: config.SECURE_COOKIES, port: new URL(PUBLIC_URL).port, principalActive });
const telemetry = new Telemetry({ intervalMs: 2000, hosted: HOSTED, wallProfile: HOSTED ? '' : PROFILE_DIR });
const wallBrowser = HOSTED ? null : new WallBrowser({ url: `http://localhost:${PORT}/` });
// Anyone's YouTube key and Google OAuth client, checked with Google before they're saved.
const credentials = new GoogleCredentials({ secrets, publicUrl: PUBLIC_URL, port: PORT });
const gdrive = new GoogleDrive({ secrets, credentials });
credentials.purposes.drive = { scope: GoogleDrive.SCOPE, finish: (tokens) => gdrive.finish(tokens) }; // the Drive sign-in, same client
const onedrive = new OneDrive({ secrets, publicUrl: PUBLIC_URL });
// Each broadcast's peak concurrent viewers: sampled at every poll, Studio's kept apart (pcv.json).
const pcv = new PcvTracker();
const youtube = new YouTubeStats({ store: sessions, credentials, pcv });
// Wall totals from before sessions stamped them: the one live session's, so its PCV keeps them.
if (sessions.live().length === 1) youtube.adoptUnstamped(sessions.live()[0].id);
const ingest = new IngestHealth({ credentials, store: sessions, pollMs: () => youtube.pollMs() });
youtube.ingest = ingest; // its state rides along with the YouTube numbers
// YouTube Studio's per-minute audience and PCV for feeds a signed-in channel owns.
const studio = new StudioAudience({ credentials, ingest, pcv });
youtube.studio = studio;
ingest.studio = studio;
// Automatic source screenshots at each new PCV and at a stream's end: decided here.
const autoCapture = new AutoCapture({ youtube, pcv, ingest, store: sessions });
// The backend takes them itself, in a headless browser: no window pops up and focus never
// moves (backend/source-capture.js). On a server that needs Chrome installed (DEPLOY.md);
// without one, admins' pages with the Feed Meter take them instead.
const sourceCapture = process.env.IXG_SERVER_CAPTURE === '0' ? null : new SourceCapture({ browserPath: findBrowser(), hosted: HOSTED });

// Settings → Source screenshots → Folders: the base folder, when the admin chose one.
function applyShotFolder() {
  if (sourceCapture) sourceCapture.folder = secrets.shots().folder || process.env.IXG_SCREENSHOT_DIR || sourceCapture.defaultFolder;
}
applyShotFolder();

// What Settings shows of where screenshots go: the folder choices and each destination's
// state, never a token or secret.
function shotsInfo() {
  return {
    ...secrets.shots(),
    layoutChoices: LAYOUTS,
    feedNameChoices: FEED_NAMES,
    defaultFolder: sourceCapture?.defaultFolder || null,
    folderInUse: sourceCapture?.folder || null,
    slack: slack.info(),
    gdrive: gdrive.info(),
    onedrive: onedrive.info(),
  };
}
autoCapture.backendTakes = !!sourceCapture?.available();
const sseClients = new Map(); // response -> { role, linkId } of whoever opened it
const browserStatus = () => (wallBrowser ? wallBrowser.status() : { supported: false, hosted: true });

// What a user's page gets of the YouTube state: the numbers and each feed's ingest health,
// but nothing about the key, the OAuth client or which channels signed in, and no Google
// error text (it can name the key's restrictions or the client).
// A link made without YouTube gets the state of a wall with no key at all.
function youtubeFor(role, link = null, sessionId = null) {
  const s = youtube.state(sessionId);
  if (role === 'admin') return { ...s, captures: autoCapture.open(), captureLog: autoCapture.entries(), captureLogBoot: autoCapture.boot };
  if (link && link.youtube === false) {
    return { status: 'off', error: '', key: { set: false }, ingest: null, updatedAt: 0, pollMs: s.pollMs, units: { used: 0, limit: 0 }, total: { now: null }, videos: {} };
  }
  const ing = s.ingest;
  const cut = {
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
  // An operator's page takes screenshots where the server can't (the Feed Meter): the jobs and the record.
  return role === 'operator' ? { ...cut, captures: autoCapture.open(), captureLog: autoCapture.entries(), captureLogBoot: autoCapture.boot } : cut;
}

// Walls saved before the key moved to secrets.json kept it in wall.json: move it out, once.
// A wall from before several sessions could be live is read into the new shape once.
if (sessions.legacyKey && !secrets.ytKeyInfo().set) secrets.setYtApiKey(sessions.legacyKey);
if (sessions.legacyKey || sessions.migrated) {
  try {
    sessions.write();
    if (sessions.legacyKey) console.log('Moved the YouTube API key from wall.json to secrets.json.');
    if (sessions.migrated) console.log(`Read the earlier wall into sessions: ${sessions.list().map((x) => `${x.name}${x.live ? ' (live)' : ''}`).join(', ') || 'none'}.`);
  } catch (err) {
    console.error(`Could not rewrite wall.json: ${err.message}`);
  }
}

// To every window, or with `sessionId` only to the windows showing that session.
function broadcast(event, data, sessionId = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, c] of sseClients) if (!sessionId || c.sessionId === sessionId) res.write(msg);
}

// The YouTube state goes out per session, in three cuts: the admin's, the users', and
// nothing for links made without YouTube.
function broadcastYoutube() {
  const msgs = {};
  for (const [res, { role, linkId, sessionId }] of sseClients) {
    const link = linkId ? userLinks.get(linkId) : null;
    const cut = `${role === 'admin' ? 'admin' : role === 'operator' ? 'operator' : link?.youtube === false ? 'none' : 'user'}|${sessionId}`;
    msgs[cut] ??= `event: youtube\ndata: ${JSON.stringify(youtubeFor(role, link, sessionId))}\n\n`;
    res.write(msgs[cut]);
  }
}

// The list of sessions changed, or one went live or archived: every window's panel, and the
// pollers (a session going live brings its feeds in; archived, takes them out).
function sessionsChanged() {
  broadcast('sessions', { version: sessions.version, sessions: sessions.list() });
  youtube.wallChanged();
  ingest.wallChanged();
  preloadShots();
}

// The live sessions' feeds keep their YouTube pages open in the background browser, so a
// screenshot is a second's work when a peak asks for it (backend/source-capture.js).
function preloadShots() {
  sourceCapture?.preload(sessions.feeds().map((f) => f.source?.id).filter(Boolean));
}

// The admin's list of links, each named with its session.
function linkList() {
  return userLinks.list(PUBLIC_URL).map((l) => ({ ...l, sessionName: l.session ? sessions.get(l.session)?.name || '(deleted session)' : null }));
}

youtube.on('update', () => {
  autoCapture.check();
  broadcastYoutube();
  takeAutoCaptures();
});
ingest.on('update', () => {
  autoCapture.check();
  broadcastYoutube();
  takeAutoCaptures();
  studio.wallChanged(); // owners and go-live times may be new
});
studio.on('update', broadcastYoutube);
autoCapture.on('change', broadcastYoutube);

// What a saved screenshot shows, for the record: the file, then account · LIVE · the count.
function shotDetail({ file, facts = {} }) {
  const what = [facts.account, facts.live ? 'LIVE' : '', facts.ccv ? `${facts.ccv} watching` : facts.views ? `${facts.views} views` : 'CCV not shown'].filter(Boolean).join(' · ');
  return `${file}${what ? ` (${what})` : ''}`;
}

// The message a screenshot goes to Slack with. A new PCV says it's the wall's sampled figure;
// at the end, Studio's official PCV comes first when the channel's sign-in has it.
function slackComment(kind, id, shot, name, shotPcv, sessionName = '') {
  const n = (v) => Number(v).toLocaleString('en-US');
  const at = (ms) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const r = pcv.get(id);
  const f = shot.facts || {};
  const page = f.ccv ? `${f.ccv} watching` : f.views ? `${f.views} views` : 'no count shown';
  const lines = [`*${name.replace(/\.png$/, '')}*`];
  if (kind === 'peak') {
    // The PCV this screenshot was taken for (a higher one may have been read since).
    const when = r?.peak === shotPcv && r?.peakAt ? ` at ${at(r.peakAt)}` : '';
    lines.push(`New PCV *${n(shotPcv)}*${when}: sampled by IXG Wall from the YouTube Data API every ${Math.round(youtube.pollMs() / 1000)} s (not YouTube Studio's figure). YouTube's page showed ${page} when this was taken.`);
  } else if (kind === 'end') {
    const official = r?.official ? `PCV *${n(r.official.peak)}* (YouTube Studio, official) · ` : '';
    lines.push(`Stream ended. ${official}PCV ${n(r?.peak)} sampled by IXG Wall${r?.peakAt ? ` at ${at(r.peakAt)}` : ''}. YouTube's page showed ${page}.`);
  } else {
    lines.push(`Screenshot taken on request: YouTube's page showed ${page}.`);
  }
  lines.push(`${sessionName ? `${sessionName} · ` : ''}${f.account || ''} · https://youtu.be/${id}`.replace(/^ · /, ''));
  return lines.join('\n');
}

// Each screenshot goes to Slack once it's saved, when Slack is set up; the record says how it went.
function toSlack(kind, id, shot, shotPcv = null, sessionName = '') {
  if (!slack.configured()) return;
  const name = path.basename(shot.file);
  autoCapture.note(id, `Screenshot posting to Slack: ${name}`, 'info', BACKEND);
  broadcastYoutube();
  slack.post({ file: shot.file, title: name.replace(/\.png$/, ''), comment: slackComment(kind, id, shot, name, shotPcv, sessionName) }).then((r) => {
    autoCapture.note(id, r.ok ? `Screenshot posted to Slack: ${name}` : `Screenshot not posted to Slack: ${r.error}`, r.ok ? 'info' : 'bad', BACKEND);
    broadcastYoutube();
  });
}

// Every destination that's set up gets the screenshot: Slack as a post, Google Drive and
// OneDrive as uploads under the same session/date/feed folders. The record says how each went.
function deliver(kind, id, shot, shotPcv = null, sessionName = '') {
  const relPath = path.relative(sourceCapture.folder, shot.file);
  const name = path.basename(shot.file);
  const uploads = [];
  for (const [label, dest] of [['Google Drive', gdrive], ['OneDrive', onedrive]]) {
    if (!dest.configured()) continue;
    autoCapture.note(id, `Screenshot uploading to ${label}: ${name}`, 'info', BACKEND);
    uploads.push(dest.post({ file: shot.file, relPath }).then((r) => {
      autoCapture.note(id, r.ok ? `Screenshot uploaded to ${label}: ${relPath.replace(/\\/g, '/')}` : `Screenshot not uploaded to ${label}: ${r.error}`, r.ok ? 'info' : 'bad', BACKEND);
      broadcastYoutube();
      return r.ok && r.url ? { label, url: r.url } : null;
    }));
  }
  // Slack: the screenshot itself, or (the default) a one-line note once the archive has it,
  // linking the archived file: "2026-10-08 · Hindi Day 1 · 233,375 CCV · new PCV".
  if (secrets.shots().slackPost === 'file') toSlack(kind, id, shot, shotPcv, sessionName);
  else if (slack.configured()) {
    Promise.all(uploads).then((links) => {
      const text = slackNote(kind, id, shot, shotPcv, sessionName, links.filter(Boolean));
      slack.notify(text).then((r) => {
        autoCapture.note(id, r.ok ? `Slack note posted: ${text.replace(/<[^|>]*\|([^>]*)>/g, '$1')}` : `Slack note not posted: ${r.error}`, r.ok ? 'info' : 'bad', BACKEND);
        broadcastYoutube();
      });
    });
  }
  broadcastYoutube();
}

// The note: the day, the feed's short name, the count, why, which session, and where the
// file is. The count is the PCV the shot was taken for; at the end, the views the page showed.
function slackNote(kind, id, shot, shotPcv, sessionName, links) {
  const n = (v) => Number(v).toLocaleString('en-US');
  const f = shot.facts || {};
  const label = autoCapture.label(id) || f.title || id;
  const count = kind === 'peak' && Number.isSafeInteger(shotPcv) ? `${n(shotPcv)} CCV`
    : kind === 'end' ? (f.views ? `${f.views} views` : f.ccv ? `${f.ccv} CCV` : 'ended')
      : f.ccv ? `${f.ccv} CCV` : f.views ? `${f.views} views` : 'no count';
  const why = { peak: 'new PCV', end: 'stream ended', manual: 'on request' }[kind] || kind;
  const parts = [dayFolder(new Date()), shortFeedName(label) || label, count, why];
  if (sessionName) parts.push(sessionName);
  for (const l of links) parts.push(`<${l.url}|Open in ${l.label}>`);
  return parts.join(' · ');
}

// Automatic screenshots, taken by the backend one at a time. A browser or network hiccup is
// tried again (after a pause); a source that's the problem (unavailable, no player) isn't.
const SHOT_RETRY = new Set(['browser', 'load']);
const SHOT_RETRY_PAUSE_MS = 30000;
let backendShooting = false;
async function takeAutoCaptures() {
  if (!autoCapture.backendTakes || backendShooting) return;
  const next = autoCapture.open(BACKEND)[0];
  const job = next && autoCapture.claim(next.job, BACKEND);
  if (!job) return;
  backendShooting = true;
  let pause = 0;
  try {
    const sessionName = autoCapture.sessionOf(job.id)?.name || '';
    const name = (facts) => readableName({ label: autoCapture.label(job.id), facts, kind: job.reason, pcv: job.ccv });
    const siblings = (sessions.get(autoCapture.sessionOf(job.id)?.id)?.streams || []).map((x) => x.label);
    const shot = await sourceCapture.capture({ videoId: job.id, name, subfolder: shotFolder(sessionName, autoCapture.label(job.id), job.id, new Date(), siblings, secrets.shots()) });
    const how = `${shot.kept ? 'page kept open' : 'page opened for it'}, ${(shot.tookMs / 1000).toFixed(1)} s`;
    autoCapture.finish(job.job, { outcome: 'saved', detail: `${shotDetail(shot)}${shot.note ? ` · ${shot.note}` : ''} · ${how}`, client: BACKEND });
    deliver(job.reason, job.id, shot, job.ccv, sessionName);
  } catch (err) {
    const retry = SHOT_RETRY.has(err.reason);
    if (retry) pause = SHOT_RETRY_PAUSE_MS;
    autoCapture.finish(job.job, { retry, outcome: 'failed', detail: err.message, client: BACKEND });
  } finally {
    backendShooting = false;
    setTimeout(takeAutoCaptures, pause);
  }
}
ingest.on('quiet', () => youtube.pollSoon()); // an encoder stopped: has YouTube ended the broadcast?
credentials.on('key', () => youtube.keyChanged());
credentials.on('change', () => {
  ingest.channelsChanged();
  studio.channelsChanged();
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
  const role = link.role === 'operator' ? 'operator' : 'user';
  sendJson(res, 200, { ok: true, role, next: link.session ? `/s/${link.session}` : '/' }, { 'Set-Cookie': auth.sessionCookie(role, link.id, until) });
}

const adminOnly = (res) => sendJson(res, 403, { error: 'Only an admin can do this. Sign in with the wall password.' });

async function handleApi(req, res, urlPath, session) {
  if (urlPath === '/api/login' && req.method === 'POST') return login(req, res);
  if (urlPath === '/api/join' && req.method === 'POST') return join(req, res);
  if (urlPath === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }
  // ---- Microsoft 365 sign-in: the sign-in page asks what's on offer, then goes round Microsoft ----
  if (urlPath === '/api/login/options' && req.method === 'GET') {
    return sendJson(res, 200, { password: auth.enabled, microsoft: auth.enabled && accounts.enabled() });
  }
  if (urlPath === '/api/auth/microsoft/start' && req.method === 'GET') {
    if (!auth.enabled) return redirect(res, '/');
    try {
      return redirect(res, accounts.authUrl(new URL(req.url, 'http://localhost').searchParams.get('next') || '/'));
    } catch (err) {
      return redirect(res, `/login?error=${encodeURIComponent(err.message)}`);
    }
  }
  if (urlPath === '/api/auth/microsoft/callback' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const addr = clientAddress(req);
    if (auth.lockedFor(addr)) return redirect(res, `/login?error=${encodeURIComponent('Too many refused sign-ins from this address. Try again in a few minutes.')}`);
    try {
      const who = await accounts.finish({ code: q.get('code'), state: q.get('state'), error: q.get('error'), errorDescription: q.get('error_description') });
      auth.succeeded(addr);
      res.writeHead(302, { Location: who.next, 'Set-Cookie': auth.sessionCookie(who.role, who.id) });
      return res.end();
    } catch (err) {
      await auth.failed(addr); // a refused account counts like a wrong password
      console.warn(`Microsoft sign-in refused from ${addr}: ${err.message}`);
      return redirect(res, `/login?error=${encodeURIComponent(err.message)}`);
    }
  }
  const role = session.role;
  const admin = role === 'admin';
  const operator = admin || role === 'operator'; // runs the wall: feeds, sessions, screenshots
  const link = session.linkId ? userLinks.get(session.linkId) : null; // the user link this session came from
  // Integrations and the wall computer: an admin's alone. Checked here, so a user can't
  // reach them by calling the API directly, whatever their page shows.
  if (!admin && (urlPath.startsWith('/api/youtube/key') || urlPath.startsWith('/api/youtube/oauth/')
    || urlPath.startsWith('/api/links') || urlPath === '/api/wall-browser' || urlPath.startsWith('/api/slack')
    || urlPath.startsWith('/api/shots') || urlPath.startsWith('/api/gdrive') || urlPath.startsWith('/api/onedrive')
    || urlPath.startsWith('/api/accounts'))) {
    return adminOnly(res);
  }
  // A link made without YouTube gets none of its data, the audience history included.
  if (!admin && link?.youtube === false && urlPath === '/api/youtube/history') {
    return sendJson(res, 403, { error: 'This link was made without YouTube data.' });
  }
  // Which session the request is about (?session=<id>): a link made for one session can
  // only ask about that one; with none named, the link's, else the default live one.
  const query = new URL(req.url, 'http://localhost').searchParams;
  let sessionId = query.get('session') || '';
  if (sessionId && !SESSION_ID.test(sessionId)) sessionId = '';
  const scope = link?.session || null;
  if (scope && sessionId && sessionId !== scope) return sendJson(res, 403, { error: 'This link is for another session.' });
  if (!sessionId) sessionId = scope || sessions.default().id;
  const current = sessions.get(sessionId);
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
      // The session this window is on, and the one its link is for (users of such a link see it alone).
      session: current ? { id: current.id, name: current.name, live: current.live } : null,
      linkSession: scope,
      canOperate: operator, // adds feeds, runs sessions, takes screenshots (admins and operators)
      // Who may sign in with Microsoft (admins), and whether that sign-in is on offer at all.
      access: admin ? accounts.info() : null,
      microsoftSignIn: auth.enabled && accounts.enabled(),
      // Source screenshots are taken by this backend, in the background, not by the page's Feed Meter.
      backendCapture: operator && autoCapture.backendTakes,
      // Where they're posted: never the token itself.
      slack: admin ? slack.info() : null,
      // Where they go: folders and every destination (admin).
      shots: admin ? shotsInfo() : null,
      // The Feed Meter extension: what the page checks for, and where to get it.
      extension: feedMeter.info({ extraIds: config.EXTENSION_IDS, storeUrl: config.EXTENSION_STORE_URL }),
    });
  }
  if (urlPath === '/api/telemetry' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (telemetry.latest) res.write(`data: ${JSON.stringify({ ...telemetry.latest, browser: browserStatus() })}\n\n`);
    res.write(`event: youtube\ndata: ${JSON.stringify(youtubeFor(role, link, sessionId))}\n\n`);
    sseClients.set(res, { ...session, sessionId });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  // ---- Sessions: the list, and starting, archiving, reopening and deleting one (admins) ----
  if (urlPath === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { version: sessions.version, sessions: sessions.list(), current: sessionId });
  }
  if (urlPath === '/api/sessions' && req.method === 'POST') {
    if (!operator) return sendJson(res, 403, { error: 'Only an admin or an operator can do this.' });
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    let made;
    try {
      made = sessions.create({ name: body.name, timeZone: body.timeZone });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    sessionsChanged();
    return sendJson(res, 200, { session: { id: made.id, name: made.name }, sessions: sessions.list() });
  }
  if (['/api/sessions/archive', '/api/sessions/reopen', '/api/sessions/delete'].includes(urlPath) && req.method === 'POST') {
    if (!operator) return sendJson(res, 403, { error: 'Only an admin or an operator can do this.' });
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const id = String(body.id || '');
    const action = urlPath.slice('/api/sessions/'.length);
    const ok = action === 'archive' ? sessions.archive(id) : action === 'reopen' ? sessions.reopen(id) : sessions.remove(id);
    if (!ok) {
      return sendJson(res, 409, { error: action === 'delete' ? 'Only an archived session can be deleted: archive it first.'
        : action === 'archive' ? 'That session isn\'t live.' : 'That session is already live.' });
    }
    sessionsChanged();
    // Its own windows learn it went live or quiet (the version moved on).
    const changed = sessions.get(id);
    if (changed) broadcast('wall', { version: changed.version, clientId: '', session: { id: changed.id, name: changed.name } }, id);
    return sendJson(res, 200, { sessions: sessions.list() });
  }
  if (urlPath === '/api/wall' && req.method === 'GET') {
    const w = sessions.wallOf(sessionId);
    return w ? sendJson(res, 200, w) : sendJson(res, 404, { error: 'No such session.' });
  }
  if (urlPath === '/api/wall' && req.method === 'PUT') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!current) return sendJson(res, 404, { error: 'No such session.' });
    const body = await readBody(req, 512 * 1024);
    if (!admin && body.wall && typeof body.wall === 'object') {
      const kept = current.settings || {};
      body.wall.settings = { ...(body.wall.settings || {}) };
      for (const key of operator ? OPERATOR_LOCKED : ADMIN_SETTINGS) {
        if (key in kept) body.wall.settings[key] = kept[key];
        else delete body.wall.settings[key];
      }
      // Users don't add feeds: only links already on the wall, or in a saved session the
      // admin left, may appear in what they save (so reordering, removing, renaming and
      // switching sessions still work).
      if (!operator && addsFeeds(body.wall)) return sendJson(res, 403, { error: 'Only the wall\'s admin or an operator can add feeds.' });
    }
    if (body.wall && !body.wall.session) return sendJson(res, 409, { error: 'This page is older than sessions: reload it.' });
    const version = sessions.save(sessionId, body.wall);
    if (version == null) return sendJson(res, 400, { error: 'Invalid wall' });
    broadcast('wall', { version, clientId: String(body.clientId || ''), session: { id: current.id, name: current.name } }, sessionId);
    sessionsChanged(); // the name or feed count in every panel's list
    return sendJson(res, 200, { version });
  }
  if (urlPath === '/api/youtube' && req.method === 'GET') {
    return sendJson(res, 200, youtubeFor(role, link, sessionId));
  }
  // ---- User links: an admin generates and revokes them; each signs browsers in as users ----
  if (urlPath === '/api/links' && req.method === 'GET') {
    return sendJson(res, 200, { enabled: auth.enabled, links: linkList() });
  }
  if (urlPath === '/api/links' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!auth.enabled) return sendJson(res, 409, { error: 'User links need a wall password (IXG_PASSWORD): without one, anyone who can reach the wall is already an admin.' });
    const body = await readBody(req, 2000);
    // A link for one session: that session's id, which has to exist.
    const forSession = typeof body.session === 'string' && body.session ? body.session : null;
    if (forSession && !sessions.get(forSession)) return sendJson(res, 400, { error: 'No such session.' });
    const { error } = userLinks.create({ name: body.name, days: body.days, youtube: body.youtube !== false, session: forSession, role: body.role === 'operator' ? 'operator' : 'user' });
    if (error) return sendJson(res, 400, { error });
    return sendJson(res, 200, { links: linkList() });
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
    return sendJson(res, 200, { links: linkList() });
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
      // ?purpose=drive: the Google Drive sign-in (gdrive.js), with the same client.
      return redirect(res, credentials.authUrl(query.get('purpose') === 'drive' ? 'drive' : 'channel'));
    } catch (err) {
      return sendHtml(res, 400, oauthPage('Can\'t start the sign-in', err.message, false));
    }
  }
  if (urlPath === '/api/youtube/oauth/callback' && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    try {
      const { purpose, name } = await credentials.finish({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
      return sendHtml(res, 200, oauthPage('Signed in', purpose === 'drive'
        ? `IXG Wall is signed in to Google Drive as ${name}. Paste the folder's link in Settings if you haven't. You can close this window.`
        : `IXG Wall now reads ingest health for the feeds on ${name}. You can close this window.`, true));
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
    const id = query.get('id') || '';
    return sendJson(res, 200, { id, series: youtube.series(id, sessionId) });
  }
  // ---- Automatic source screenshots: a page claims a job, takes it, and reports back ----
  if ((urlPath === '/api/capture/claim' || urlPath === '/api/capture/result') && req.method === 'POST') {
    if (!operator) return sendJson(res, 403, { error: 'Only an admin or an operator can do this.' });
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
  // ---- Capture source screenshot (the button), taken by this backend in the background ----
  if (urlPath === '/api/capture/now' && req.method === 'POST') {
    if (!operator) return sendJson(res, 403, { error: 'Only an admin or an operator can do this.' });
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!autoCapture.backendTakes) return sendJson(res, 404, { error: 'This wall takes screenshots with the Feed Meter in the browser.' });
    const body = await readBody(req, 2000);
    const id = String(body.id || '');
    if (!/^[\w-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, reason: 'no-source', message: 'Source URL unavailable for this feed' });
    const queued = sourceCapture.waiting;
    try {
      const sessionName = current?.name || '';
      const label = current?.streams.find((x) => x.source?.id === id)?.label || autoCapture.label(id);
      const name = (facts) => readableName({ label, facts, kind: 'manual' });
      const shot = await sourceCapture.capture({ videoId: id, name, subfolder: shotFolder(sessionName, label, id, new Date(), (current?.streams || []).map((x) => x.label), secrets.shots()) });
      deliver('manual', id, shot, null, sessionName);
      return sendJson(res, 200, { ok: true, file: shot.file, facts: shot.facts, note: shot.note, detail: shotDetail(shot), queued, slack: slack.configured(), kept: shot.kept, tookMs: shot.tookMs });
    } catch (err) {
      return sendJson(res, 200, { ok: false, reason: err.reason || 'failed', message: err.reason ? err.message : `Screenshot capture failed: ${err.message}`, queued });
    }
  }
  // ---- Slack: where screenshots are posted (admin) ----
  if (urlPath === '/api/slack' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 4000);
    const result = await slack.save({ token: body.token, channel: body.channel });
    return sendJson(res, result.status, { slack: slack.info(), check: result.check || null, error: result.error });
  }
  if (urlPath === '/api/slack/test' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const result = await slack.test();
    return sendJson(res, 200, { ...result, slack: slack.info() });
  }
  // ---- Access: who may sign in with a Microsoft 365 account, and as what (admin) ----
  if (urlPath === '/api/accounts' && req.method === 'GET') return sendJson(res, 200, { access: accounts.info() });
  if (urlPath === '/api/accounts' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const { error } = accounts.add({ email: body.email, role: body.role });
    if (error) return sendJson(res, 400, { error, access: accounts.info() });
    // A changed role: that account's open streams end, and its next request gets the new role.
    const changed = accounts.find(body.email);
    for (const [stream, c] of sseClients) {
      if (c.linkId === changed?.id && c.role !== changed.role) {
        sseClients.delete(stream);
        stream.end();
      }
    }
    return sendJson(res, 200, { access: accounts.info() });
  }
  if (urlPath === '/api/accounts/remove' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    const id = String(body.id || '');
    if (!accounts.remove(id)) return sendJson(res, 404, { error: 'No such account.', access: accounts.info() });
    for (const [stream, c] of sseClients) {
      if (c.linkId === id) {
        sseClients.delete(stream);
        stream.end();
      }
    }
    return sendJson(res, 200, { access: accounts.info() });
  }
  if (urlPath === '/api/accounts/tenant' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 2000);
    accounts.setTenantOperators(body.on === true);
    if (body.on !== true) {
      const tenantId = accounts.tenantOperatorId();
      for (const [stream, c] of sseClients) {
        if (c.linkId === tenantId) {
          sseClients.delete(stream);
          stream.end();
        }
      }
    }
    return sendJson(res, 200, { access: accounts.info() });
  }
  // ---- Where screenshots go: the folders, and the Google Drive and OneDrive destinations (admin) ----
  if (urlPath === '/api/shots' && req.method === 'GET') return sendJson(res, 200, { shots: shotsInfo() });
  if (urlPath === '/api/shots' && req.method === 'POST') {
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 4000);
    const patch = {};
    if (body.layout !== undefined) {
      if (!LAYOUTS.includes(body.layout)) return sendJson(res, 400, { error: 'Unknown folder layout.' });
      patch.layout = body.layout;
    }
    if (body.feedNames !== undefined) {
      if (!FEED_NAMES.includes(body.feedNames)) return sendJson(res, 400, { error: 'Unknown feed folder naming.' });
      patch.feedNames = body.feedNames;
    }
    if (body.slackPost !== undefined) {
      if (!['note', 'file'].includes(body.slackPost)) return sendJson(res, 400, { error: 'Slack posts are either a note or the file.' });
      patch.slackPost = body.slackPost;
    }
    if (body.folder !== undefined) {
      const folder = String(body.folder || '').trim();
      if (folder && !path.isAbsolute(folder)) return sendJson(res, 400, { error: 'Give the folder as a full path (e.g. D:\\Screenshots), or leave it empty for the default.' });
      patch.folder = folder;
    }
    secrets.setShots(patch);
    applyShotFolder();
    return sendJson(res, 200, { shots: shotsInfo() });
  }
  if (urlPath.startsWith('/api/gdrive') || urlPath.startsWith('/api/onedrive')) {
    const dest = urlPath.startsWith('/api/gdrive') ? gdrive : onedrive;
    const action = urlPath.replace(/^\/api\/(gdrive|onedrive)\/?/, '');
    if (action === 'start' && req.method === 'GET' && dest === onedrive) {
      try {
        return redirect(res, onedrive.authUrl());
      } catch (err) {
        return sendHtml(res, 400, oauthPage('Can\'t start the sign-in', err.message, false));
      }
    }
    if (action === 'callback' && req.method === 'GET' && dest === onedrive) {
      try {
        const account = await onedrive.finish({ code: query.get('code'), state: query.get('state'), error: query.get('error'), errorDescription: query.get('error_description') });
        return sendHtml(res, 200, oauthPage('Signed in', `IXG Wall is signed in to OneDrive as ${account}. Paste the folder's sharing link in Settings if you haven't. You can close this window.`, true));
      } catch (err) {
        return sendHtml(res, 400, oauthPage('Sign-in didn\'t finish', err.message, false));
      }
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
    if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const body = await readBody(req, 4000);
    if (action === '') {
      const result = await dest.setFolder(body.folder);
      return sendJson(res, result.status, { shots: shotsInfo(), check: result.check || null, error: result.error });
    }
    if (action === 'client' && dest === onedrive) {
      const result = await onedrive.saveClient({ clientId: body.clientId, clientSecret: body.clientSecret });
      return sendJson(res, result.status, { shots: shotsInfo(), check: result.check || null, error: result.error });
    }
    if (action === 'enabled') {
      dest.setEnabled(body.on !== false);
      return sendJson(res, 200, { shots: shotsInfo() });
    }
    if (action === 'signout') {
      await dest.signOut();
      return sendJson(res, 200, { shots: shotsInfo() });
    }
    if (action === 'test') {
      const result = await dest.test();
      return sendJson(res, 200, { ...result, shots: shotsInfo() });
    }
    return sendJson(res, 404, { error: 'Not found' });
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
  // A window shows one session: /s/<id>. The bare address goes to the link's session, or
  // the live one started most recently.
  const scopedTo = session?.linkId ? userLinks.get(session.linkId)?.session || null : null;
  if (urlPath === '/admin') return session?.role === 'admin' ? serveFile(res, 'index.html') : redirect(res, '/');
  if (urlPath === '/') return redirect(res, `/s/${scopedTo || sessions.default().id}`);
  const page = /^\/s\/([\w-]{1,64})$/.exec(urlPath);
  if (page) {
    if (scopedTo && page[1] !== scopedTo) return redirect(res, `/s/${scopedTo}`);
    if (!sessions.get(page[1])) return redirect(res, '/');
    return serveFile(res, 'index.html');
  }
  // The page's own files, asked for relative to /s/<id> (style.css → /s/style.css, fonts/…):
  // the same files as at the root.
  const rel = path.posix.normalize(urlPath.replace(/^\/s\//, '/')).slice(1);
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
      const headers = { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' };
      if (config.PASSWORD) {
        // A wall with sign-in: in like a page would be, with the password this start was given.
        const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password: config.PASSWORD }) });
        const cookie = login.headers.get('set-cookie');
        if (cookie) headers.Cookie = cookie.split(';')[0];
      }
      const res = await fetch(`http://127.0.0.1:${PORT}/api/wall-browser`, {
        method: 'POST',
        headers,
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
  studio.start();
  sourceCapture?.start();
  preloadShots();
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
    studio.stop();
    sourceCapture?.stop();
    youtube.stop(); // writes the audience history so a restart keeps it
    process.exit(0);
  });
}
