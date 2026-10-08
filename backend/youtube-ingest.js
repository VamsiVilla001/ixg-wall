// Ingest health from YouTube's side: how each feed's encoder stream arrives at YouTube.
// Needs the channel that owns a broadcast to sign in with Google (OAuth, read-only scope);
// an API key can't see this. Any number of channels can sign in (google-credentials.js):
// each feed is read through whichever channel owns it.
//
// Every few minutes, liveBroadcasts finds which signed-in channel owns each feed and the
// encoder stream bound to it. Every poll, liveStreams reads those streams' health
// (good/ok/bad), resolution, frame rate and YouTube's configuration warnings: 1 quota unit
// per channel (per 50 streams), charged to the OAuth client's Google Cloud project.
//
// When a feed's encoder stream stops arriving, YouTube is asked straight away whether the
// broadcast is over (ended on purpose) or still on air (an outage), and again every poll
// for the next few minutes while YouTube's auto-stop catches up: 1 more unit per channel.
//
// The stream key (cdn.ingestionInfo.streamName) is never requested, so it can't leak.
const { EventEmitter } = require('events');
const { GOOGLE } = require('./google-credentials');

const VIDEO_ID = /^[\w-]{11}$/;
const OWNERS_EVERY_MS = 5 * 60000;  // look again for which channel owns each feed
const QUIET_CHECK_MS = 10 * 60000;  // after a feed's ingest stops, ask about its broadcast every poll this long
// Broadcast lifecycles in which YouTube is (or is about to be) on air.
const ON_AIR = new Set(['live', 'liveStarting', 'testing', 'testStarting']);
const receiving = (v) => v.streamStatus === 'active' && v.health !== 'noData';

class IngestHealth extends EventEmitter {
  constructor({ credentials, wallStore, pollMs }) {
    super();
    this.credentials = credentials;
    this.wallStore = wallStore;
    this.pollMs = pollMs;           // shares the YouTube API refresh interval
    this.owners = new Map();        // video id -> { channelId, streamId, broadcast, endedAt, checkedAt }
    this.asked = new Set();         // video ids every signed-in channel was asked about
    this.ownersAt = 0;
    this.receiving = new Set();     // video ids whose encoder stream was arriving at the last poll
    this.quiet = new Map();         // video id -> when its encoder stream was first seen stopped
    this.channelState = new Map();  // channel id -> { status: ok | error, error }
    this.videos = {};               // video id -> ingest details, or { owned: false }
    this.status = 'off';            // off | ok | error
    this.error = '';
    this.updatedAt = 0;
    this.units = 0;                 // quota units used since start (1 per call)
  }

  // What the page may know: never a token or the client secret.
  state() {
    const owned = {};
    for (const o of this.owners.values()) owned[o.channelId] = (owned[o.channelId] || 0) + 1;
    const channels = this.credentials.channels().map((c) => {
      const s = this.channelState.get(c.id);
      return {
        ...c,
        status: c.expired ? 'expired' : s?.status || 'checking',
        error: c.expired ? '' : s?.error || '',
        feeds: owned[c.id] || 0,
        studio: c.expired ? null : this.studio?.channelState(c.id) || null, // reading its Studio audience
      };
    });
    return {
      client: this.credentials.clientInfo(),
      redirectUri: this.credentials.redirectUri,
      signInFrom: this.credentials.localUrl, // set when channels can only sign in from the server's own computer
      channels,
      signedIn: channels.some((c) => !c.expired),
      status: this.status,
      error: this.error,
      updatedAt: this.updatedAt,
      units: this.units,
      ownersEveryMs: OWNERS_EVERY_MS,
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

  // A channel signed in or out, or the OAuth client changed: find the owners afresh.
  channelsChanged() {
    this.owners.clear();
    this.asked.clear();
    this.ownersAt = 0;
    this.receiving.clear();
    this.quiet.clear();
    this.channelState.clear();
    this.videos = {};
    this.wallChanged();
  }

  async get(channelId, resource, params) {
    const token = await this.credentials.accessToken(channelId);
    this.units += 1;
    const res = await fetch(`${GOOGLE.API}/${resource}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) this.credentials.dropAccess(channelId); // expired early: the next poll refreshes it
    if (!res.ok) throw new Error(body.error?.message?.replace(/<[^>]*>/g, '') || `YouTube answered HTTP ${res.status}`);
    return body;
  }

  ids() {
    return [...new Set((this.wallStore.wall?.streams || []).map((s) => s.source?.id).filter((id) => VIDEO_ID.test(id)))];
  }

  ok(channelId) {
    this.channelState.set(channelId, { status: 'ok', error: '' });
  }

  fail(channelId, err) {
    this.channelState.set(channelId, { status: 'error', error: String(err.message || err) });
  }

  // Asks each channel which of `ids` it owns (only a channel's own broadcasts come back),
  // and which encoder stream each is bound to. A feed found on one channel isn't asked
  // about again. `all`: start over; otherwise add to what's known. Returns the ids of the
  // channels that failed to answer.
  async findOwners(channels, ids, all) {
    const owners = all ? new Map() : new Map(this.owners);
    const failed = new Set();
    for (const c of channels) {
      const ask = ids.filter((id) => !owners.has(id));
      try {
        await this.credentials.accessToken(c.id); // no quota: confirms the sign-in still works
        for (let i = 0; i < ask.length; i += 50) {
          const found = await this.get(c.id, 'liveBroadcasts', {
            part: 'contentDetails,snippet,status',
            id: ask.slice(i, i + 50).join(','),
            maxResults: '50',
            fields: 'items(id,contentDetails(boundStreamId),snippet(actualStartTime,actualEndTime),status(lifeCycleStatus))',
          });
          for (const b of found.items || []) {
            owners.set(b.id, {
              channelId: c.id,
              streamId: b.contentDetails?.boundStreamId || null,
              broadcast: b.status?.lifeCycleStatus || null, // created | ready | testing | live | complete | revoked …
              startedAt: b.snippet?.actualStartTime || null,
              endedAt: b.snippet?.actualEndTime || null,
              checkedAt: Date.now(),
            });
          }
        }
        this.ok(c.id);
      } catch (err) {
        this.fail(c.id, err);
        failed.add(c.id);
        // Keep what this channel was known to own until it answers again.
        for (const [id, o] of this.owners) if (o.channelId === c.id && !owners.has(id)) owners.set(id, o);
      }
    }
    this.owners = owners;
    if (all) {
      this.asked = new Set(ids);
      this.ownersAt = Date.now();
    } else {
      for (const id of ids) this.asked.add(id);
    }
    return failed;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    clearTimeout(this.timer);
    try {
      const channels = this.credentials.oauthClient() ? this.credentials.channels().filter((c) => !c.expired) : [];
      if (!channels.length) {
        this.status = 'off';
        this.error = '';
        this.videos = {};
        this.receiving.clear();
        this.quiet.clear();
        return;
      }
      const ids = this.ids();
      const now = Date.now();
      const unknown = ids.filter((id) => !this.owners.has(id) && !this.asked.has(id));
      let failedNow = new Set();
      if (now - this.ownersAt > OWNERS_EVERY_MS) failedNow = await this.findOwners(channels, ids, true);
      else if (unknown.length) failedNow = await this.findOwners(channels, unknown, false);

      const videos = {};
      for (const id of ids) {
        const o = this.owners.get(id);
        if (o) videos[id] = { owned: true, channelId: o.channelId, broadcast: o.broadcast, startedAt: o.startedAt, endedAt: o.endedAt, checkedAt: o.checkedAt, streamId: o.streamId };
        else if (this.asked.has(id)) videos[id] = { owned: false };
      }
      for (const c of channels) {
        if (failedNow.has(c.id)) continue; // its error is already recorded
        const feedsOf = {}; // stream id -> the channel's feeds bound to it
        for (const [id, o] of this.owners) {
          if (o.channelId === c.id && o.streamId && videos[id]) (feedsOf[o.streamId] ||= []).push(id);
        }
        const streamIds = Object.keys(feedsOf);
        try {
          for (let i = 0; i < streamIds.length; i += 50) {
            const streams = await this.get(c.id, 'liveStreams', {
              part: 'cdn,status',
              id: streamIds.slice(i, i + 50).join(','),
              maxResults: '50',
              // Deliberately not cdn.ingestionInfo: that holds the stream key.
              fields: 'items(id,cdn(ingestionType,resolution,frameRate),status(streamStatus,healthStatus))',
            });
            for (const s of streams.items || []) {
              const health = s.status?.healthStatus || {};
              const details = {
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
              };
              for (const id of feedsOf[s.id] || []) Object.assign(videos[id], details);
            }
          }
          if (streamIds.length) this.ok(c.id);
        } catch (err) {
          this.fail(c.id, err);
        }
      }
      await this.checkQuiet(videos, failedNow, now);
      this.videos = videos;
      const failed = channels.filter((c) => this.channelState.get(c.id)?.status === 'error');
      this.status = failed.length && failed.length === channels.length ? 'error' : 'ok';
      this.error = failed.map((c) => `${c.title}: ${this.channelState.get(c.id).error}`).join(' · ');
      this.updatedAt = now;
    } catch (err) {
      this.status = 'error';
      this.error = String(err.message || err);
    } finally {
      this.polling = false;
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), this.pollMs());
      this.emit('update');
    }
  }

  // A feed's encoder stream stopped arriving (or never arrived while YouTube had it on air):
  // ask YouTube whether the broadcast ended, rather than wait for the next owners lookup.
  // Asked every poll for QUIET_CHECK_MS, until YouTube says it's over or the stream comes
  // back. Marks those feeds with quietSince, and emits 'quiet' with the feeds that just
  // stopped so the Data API poll can look too.
  async checkQuiet(videos, failedNow, now) {
    const ask = {};      // channel id -> video ids to ask about
    const stopped = [];  // video ids whose stream stopped since the last poll
    for (const [id, v] of Object.entries(videos)) {
      if (!v.owned || !v.streamStatus) continue; // no stream reading this poll: nothing new to judge
      if (receiving(v)) {
        this.quiet.delete(id);
        continue;
      }
      let since = this.quiet.get(id);
      if (since == null && (this.receiving.has(id) || ON_AIR.has(v.broadcast))) {
        since = now;
        this.quiet.set(id, since);
        stopped.push(id);
      }
      if (since == null) continue; // not on air and never was here: an idle stream, by design
      v.quietSince = since;
      if (ON_AIR.has(v.broadcast) && now - since <= QUIET_CHECK_MS && !failedNow.has(v.channelId)) (ask[v.channelId] ||= []).push(id);
    }
    this.receiving = new Set(Object.keys(videos).filter((id) => videos[id].owned && receiving(videos[id])));
    for (const id of this.quiet.keys()) if (!videos[id]) this.quiet.delete(id);

    for (const [channelId, ids] of Object.entries(ask)) {
      try {
        for (let i = 0; i < ids.length; i += 50) {
          const found = await this.get(channelId, 'liveBroadcasts', {
            part: 'snippet,status',
            id: ids.slice(i, i + 50).join(','),
            maxResults: '50',
            fields: 'items(id,snippet(actualEndTime),status(lifeCycleStatus))',
          });
          for (const b of found.items || []) {
            const reading = { broadcast: b.status?.lifeCycleStatus || null, endedAt: b.snippet?.actualEndTime || null, checkedAt: Date.now() };
            const o = this.owners.get(b.id);
            if (o) Object.assign(o, reading);
            if (videos[b.id]) Object.assign(videos[b.id], reading);
          }
        }
      } catch (err) {
        this.fail(channelId, err);
      }
    }
    if (stopped.length) this.emit('quiet', stopped);
  }
}

module.exports = { IngestHealth, ON_AIR };
