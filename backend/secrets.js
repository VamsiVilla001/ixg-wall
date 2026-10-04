// Server-side secrets: the YouTube Data API key, the Google sign-in (OAuth client and the
// channel's refresh token) and the key that signs session cookies.
// Kept apart from the wall (feeds and settings), which every signed-in page downloads, so
// the API key never reaches a browser.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'secrets.json');
// Google API keys are 39 characters (AIza…); allow some slack, but not arbitrary text.
const YT_KEY_FORMAT = /^[\w-]{20,120}$/;
const OAUTH_CLIENT_ID_FORMAT = /^[\w.-]{10,200}\.apps\.googleusercontent\.com$/;
const OAUTH_SECRET_FORMAT = /^[\w-]{10,200}$/;

class Secrets {
  constructor({ envYtKey = '', envOauthClient = null } = {}) {
    this.envYtKey = String(envYtKey).trim();
    this.envOauthClient = envOauthClient?.clientId && envOauthClient?.clientSecret ? envOauthClient : null;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    } catch {
      // first run: nothing saved yet
    }
    if (typeof this.data.sessionSecret !== 'string' || this.data.sessionSecret.length < 64) {
      this.data.sessionSecret = crypto.randomBytes(32).toString('hex');
      this.write();
    }
  }

  write() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, FILE);
    } catch (err) {
      // Unwritable data folder: secrets last until restart (sessions then sign out).
      console.error(`Could not save ${FILE}: ${err.message}`);
    }
  }

  get sessionSecret() {
    return this.data.sessionSecret;
  }

  ytApiKey() {
    return this.envYtKey || String(this.data.ytApiKey || '').trim();
  }

  // All a page may know about the key: whether there is one, where it's set, its last 4 characters.
  ytKeyInfo() {
    const key = this.ytApiKey();
    return { set: !!key, source: this.envYtKey ? 'env' : key ? 'saved' : null, last4: key ? key.slice(-4) : '' };
  }

  // Saves (or, with an empty key, removes) the key. False when YOUTUBE_API_KEY manages it.
  setYtApiKey(key) {
    if (this.envYtKey) return false;
    const k = String(key || '').trim();
    if (k) this.data.ytApiKey = k;
    else delete this.data.ytApiKey;
    this.write();
    return true;
  }

  // The Google OAuth client the channel sign-in uses (Google Cloud → Credentials → OAuth
  // client ID, type Web application). From GOOGLE_OAUTH_CLIENT_ID/_SECRET if set.
  oauthClient() {
    return this.envOauthClient || this.data.oauthClient || null;
  }

  oauthClientInfo() {
    const c = this.oauthClient();
    return { set: !!c, source: this.envOauthClient ? 'env' : c ? 'saved' : null, clientId: c?.clientId || '' };
  }

  // False when the environment manages the client. Changing it signs the channel out.
  setOauthClient(client) {
    if (this.envOauthClient) return false;
    if (client) this.data.oauthClient = { clientId: client.clientId, clientSecret: client.clientSecret };
    else delete this.data.oauthClient;
    delete this.data.oauthToken;
    this.write();
    return true;
  }

  // { refreshToken, channelId, channelTitle, savedAt } once a channel has signed in.
  oauthToken() {
    return this.data.oauthToken || null;
  }

  setOauthToken(token) {
    if (token) this.data.oauthToken = token;
    else delete this.data.oauthToken;
    this.write();
  }
}

module.exports = { Secrets, YT_KEY_FORMAT, OAUTH_CLIENT_ID_FORMAT, OAUTH_SECRET_FORMAT };
