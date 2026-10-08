// Every setting the backend reads from its environment, in one place.
//
// Two ways to run the same code:
//   Laptop (default)  `npm run wall`: wall window, laptop telemetry, no sign-in.
//   Hosted            IXG_HOSTED=1 behind HTTPS (see DEPLOY.md): sign-in required, no
//                     wall window or laptop telemetry (the server isn't the screen).
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const HOSTED = /^(1|true|yes)$/i.test(process.env.IXG_HOSTED || '');
const PASSWORD = process.env.IXG_PASSWORD || '';
const MIN_PASSWORD = 8;

function publicUrl() {
  const raw = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_URL is not a URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`PUBLIC_URL must start with https:// (got ${raw})`);
  return url.origin;
}

let PUBLIC_URL = `http://localhost:${PORT}`;
let urlProblem = '';
try {
  PUBLIC_URL = publicUrl();
} catch (err) {
  urlProblem = err.message;
}

// Settings the backend refuses to start with. A hosted wall must not start open to the internet.
function problems() {
  const out = urlProblem ? [urlProblem] : [];
  if (HOSTED && !PASSWORD) out.push('IXG_PASSWORD is required when IXG_HOSTED=1.');
  if (PASSWORD && PASSWORD.length < MIN_PASSWORD) out.push(`IXG_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
  if (HOSTED && !process.env.PUBLIC_URL) out.push('PUBLIC_URL is required when IXG_HOSTED=1 (the address people open, e.g. https://wall.example.com).');
  return out;
}

module.exports = {
  PORT,
  HOST,
  HOSTED,
  PASSWORD,
  PUBLIC_URL,
  // Session cookies are marked Secure whenever the wall is reached over HTTPS.
  SECURE_COOKIES: PUBLIC_URL.startsWith('https:'),
  // Optional: a YouTube Data API key set on the server; it then can't be changed from the page.
  YOUTUBE_API_KEY: (process.env.YOUTUBE_API_KEY || '').trim(),
  // Optional: the Google OAuth client for the channel sign-in (ingest health). Otherwise
  // it's entered in Settings. Its redirect URI must be PUBLIC_URL + /api/youtube/oauth/callback.
  // Optional: the Feed Meter's Chrome Web Store page, once published there. The wall's install
  // prompt then offers one-click "Add to Chrome" instead of the download-and-load steps.
  EXTENSION_STORE_URL: (process.env.IXG_EXTENSION_STORE_URL || '').trim(),
  // Optional: more extension IDs to accept, comma-separated (e.g. the Web Store's ID).
  EXTENSION_IDS: (process.env.IXG_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^[a-p]{32}$/.test(s)),
  GOOGLE_OAUTH_CLIENT: {
    clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
  },
  // Optional: the Slack app's bot token and the channel ID that screenshots are posted to,
  // instead of entering them in Settings.
  SLACK: {
    token: (process.env.SLACK_BOT_TOKEN || '').trim(),
    channelId: (process.env.SLACK_CHANNEL_ID || '').trim(),
  },
  // Optional: the Microsoft app (Azure app registration) the OneDrive sign-in uses, instead
  // of entering it in Settings. Its Web redirect URI must be PUBLIC_URL + /api/onedrive/callback.
  MS_CLIENT: {
    clientId: (process.env.MS_CLIENT_ID || '').trim(),
    clientSecret: (process.env.MS_CLIENT_SECRET || '').trim(),
  },
  problems,
};
