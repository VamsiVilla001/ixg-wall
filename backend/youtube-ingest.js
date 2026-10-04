// Ingest health from YouTube's side: how each feed's encoder stream arrives at YouTube.
// Needs the channel that owns the broadcasts to sign in with Google (OAuth, read-only scope);
// an API key can't see this. Polls liveBroadcasts (video → its ingest stream) and liveStreams
// (health good/ok/bad, resolution, frame rate, YouTube's configuration warnings).
//
// The stream key (cdn.ingestionInfo.streamName) is never requested, so it can't leak.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const AUTH_URL = process.env.IXG_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.IXG_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.IXG_GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const API = process.env.IXG_YOUTUBE_API || 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const STATE_TTL_MS = 10 * 60000;   // a sign-in must finish within this
const VIDEO_ID = /^[\w-]{11}$/;

class IngestHealth extends EventEmitter {
  constructor({ secrets, wallStore, redirectUri, pollMs }) {
    super();
    this.secrets = secrets;
    this.wallStore = wallStore;
    this.redirectUri = redirectUri;
    this.pollMs = pollMs;           // shares the YouTube API refresh interval
    this.pending = new Map();       // sign-in state -> expiry
    this.access = null;             // { token, expiresAt }
    this.videos = {};               // video id -> ingest details, or { owned: false }
    this.status = 'off';            // off | ok | error
    this.error = '';
    this.updatedAt = 0;
    this.units = 0;                 // quota units used since start (1 per call)
  }

  // What the page may know: never a token or the client secret.
  state() {
    const token = this.secrets.oauthToken();
    return {
      client: this.secrets.oauthClientInfo(),
      redirectUri: this.redirectUri,
      signedIn: !!token,
      channel: token ? { id: token.channelId, title: token.channelTitle } : null,
      status: this.status,
      error: this.error,
      updatedAt: this.updatedAt,
      units: this.units,
      videos: this.videos,
    };
  }

  start() {
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.soon);
  }

  // Feeds or the poll interval changed: poll again shortly.
  wallChanged() {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.poll(), 2000);
  }

  // ---- Sign-in ---------------------------------------------------------------------
  authUrl() {
    const client = this.secrets.oauthClient();
    if (!client) throw new Error('Add the Google OAuth client first (Settings → YouTube API → Channel sign-in).');
    const now = Date.now();
    for (const [s, exp] of this.pending) if (exp < now) this.pending.delete(s);
    const state = crypto.randomBytes(24).toString('base64url');
    this.pending.set(state, now + STATE_TTL_MS);
    return `${AUTH_URL}?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',  // a refresh token, so the wall stays signed in
      prompt: 'consent',       // Google only returns a refresh token on consent
      include_granted_scopes: 'true',
      state,
    })}`;
  }

  // Google sent the browser back with ?code&state. Returns the channel title.
  async finish({ code, state, error }) {
    const exp = this.pending.get(state);
    this.pending.delete(state);
    if (!exp || exp < Date.now()) throw new Error('This sign-in link expired or was already used. Start again from Settings.');
    if (error) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${error}`);
    if (!code) throw new Error('Google sent no authorisation code.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
    if (!tokens.refresh_token) throw new Error('Google gave no refresh token. Remove IXG Wall from the account\'s third-party access and sign in again.');
    this.access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
    const me = await this.get('channels', { part: 'snippet', mine: 'true', fields: 'items(id,snippet(title))' });
    const channel = me.items?.[0];
    if (!channel) throw new Error('That Google account has no YouTube channel.');
    this.secrets.setOauthToken({
      refreshToken: tokens.refresh_token,
      channelId: channel.id,
      channelTitle: channel.snippet?.title || channel.id,
      savedAt: new Date().toISOString(),
    });
    this.wallChanged();
    this.emit('update');
    return channel.snippet?.title || channel.id;
  }

  async signOut() {
    const token = this.secrets.oauthToken();
    this.secrets.setOauthToken(null);
    this.access = null;
    this.videos = {};
    this.status = 'off';
    this.error = '';
    this.emit('update');
    if (token?.refreshToken) {
      // Best effort: also withdraw the wall's access on Google's side.
      await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: token.refreshToken })}`, { method: 'POST', signal: AbortSignal.timeout(10000) })
        .catch(() => {});
    }
  }

  async tokenRequest(params) {
    const client = this.secrets.oauthClient();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error === 'invalid_client' ? 'The OAuth client ID or secret is wrong.'
        : body.error === 'invalid_grant' ? 'The channel sign-in expired or was revoked: sign in again.'
          : body.error_description || body.error || `Google answered HTTP ${res.status}`);
      err.code = body.error;
      throw err;
    }
    return body;
  }

  async accessToken() {
    if (this.access && this.access.expiresAt - 60000 > Date.now()) return this.access.token;
    const token = this.secrets.oauthToken();
    try {
      const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
      this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
      return this.access.token;
    } catch (err) {
      // Revoked, or a Google "testing" app's 7-day token ran out: needs a new sign-in.
      if (err.code === 'invalid_grant') this.secrets.setOauthToken(null);
      throw err;
    }
  }

  async get(resource, params) {
    const token = await this.accessToken();
    this.units += 1;
    const res = await fetch(`${API}/${resource}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) this.access = null; // expired early: the next poll refreshes it
    if (!res.ok) throw new Error(body.error?.message?.replace(/<[^>]*>/g, '') || `YouTube answered HTTP ${res.status}`);
    return body;
  }

  // ---- Polling ---------------------------------------------------------------------
  ids() {
    return [...new Set((this.wallStore.wall?.streams || []).map((s) => s.source?.id).filter((id) => VIDEO_ID.test(id)))];
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    clearTimeout(this.timer);
    try {
      if (!this.secrets.oauthClient() || !this.secrets.oauthToken()) {
        this.status = 'off';
        this.error = '';
        this.videos = {};
        return;
      }
      const ids = this.ids();
      const videos = {};
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        // Only broadcasts the signed-in channel owns come back.
        const broadcasts = await this.get('liveBroadcasts', {
          part: 'contentDetails,status',
          id: batch.join(','),
          maxResults: '50',
          fields: 'items(id,contentDetails(boundStreamId),status(lifeCycleStatus))',
        });
        const streamOf = {};
        for (const b of broadcasts.items || []) {
          videos[b.id] = { owned: true, broadcast: b.status?.lifeCycleStatus || null, streamId: b.contentDetails?.boundStreamId || null };
          if (b.contentDetails?.boundStreamId) streamOf[b.contentDetails.boundStreamId] = b.id;
        }
        for (const id of batch) if (!videos[id]) videos[id] = { owned: false };
        const streamIds = Object.keys(streamOf);
        if (!streamIds.length) continue;
        const streams = await this.get('liveStreams', {
          part: 'cdn,status',
          id: streamIds.join(','),
          maxResults: '50',
          // Deliberately not cdn.ingestionInfo: that holds the stream key.
          fields: 'items(id,cdn(ingestionType,resolution,frameRate),status(streamStatus,healthStatus))',
        });
        for (const s of streams.items || []) {
          const health = s.status?.healthStatus || {};
          Object.assign(videos[streamOf[s.id]], {
            streamStatus: s.status?.streamStatus || null,      // active | inactive | ready | created | error
            health: health.status || null,                     // good | ok | bad | noData | revoked
            healthAt: health.lastUpdateTimeSeconds ? Number(health.lastUpdateTimeSeconds) * 1000 : null,
            resolution: s.cdn?.resolution || null,              // e.g. 1080p, variable
            frameRate: s.cdn?.frameRate || null,                // 30fps, 60fps, variable
            ingestion: s.cdn?.ingestionType || null,            // rtmp, hls, dash, webrtc
            issues: (health.configurationIssues || []).slice(0, 10).map((x) => ({
              severity: x.severity || null,                     // info | warning | error
              type: x.type || null,
              reason: String(x.reason || '').slice(0, 200),
              description: String(x.description || '').slice(0, 500),
            })),
          });
        }
      }
      this.videos = videos;
      this.status = 'ok';
      this.error = '';
      this.updatedAt = Date.now();
    } catch (err) {
      this.status = 'error';
      this.error = String(err.message || err);
    } finally {
      this.polling = false;
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), this.pollMs());
      this.emit('update');
    }
  }
}

module.exports = { IngestHealth };
