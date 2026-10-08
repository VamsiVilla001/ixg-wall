// Studio audience: YouTube Analytics' concurrent viewers for every minute of a broadcast, the
// numbers behind YouTube Studio's live graph. With them a feed's viewer graph starts when the
// broadcast went live, not when this wall started watching it (youtube.js merges the two).
//
// Only the channel that owns a broadcast can read them, so this covers the feeds owned by a
// signed-in channel (youtube-ingest.js finds which). YouTube has these minutes about 2
// minutes after they happen (measured on Rubix IXG's live broadcasts, 2026-10-08): the
// wall's own readings fill that last stretch.
//
// It also reads Studio's PCV for the whole broadcast (peakConcurrentViewers without the
// minute), which pcv.js keeps apart from the wall's sampled one. Measured: YouTube answers
// that query with an internal error if averageConcurrentViewers is asked for alongside, so
// it asks for the peak alone.
//
// It uses no YouTube Data API quota. YouTube Analytics has its own, in the OAuth client's
// Google Cloud project, where the YouTube Analytics API has to be enabled.
const { EventEmitter } = require('events');
const { GOOGLE } = require('./google-credentials');
const { ON_AIR } = require('./youtube-ingest');

const TICK_MS = 60000;
const LIVE_EVERY_MS = 2 * 60000;     // a broadcast on air: read its minutes again this often
const OFFICIAL_EVERY_MS = 10 * 60000; // and Studio's PCV this often
const ENDED_EVERY_MS = 30 * 60000;   // an ended one, while YouTube may still be adding its last minutes
const SETTLED_MS = 48 * 3600e3;      // after this long since it ended, read it once and keep that
const CHANNEL_RETRY_MS = 10 * 60000; // a channel that can't read Analytics at all: ask again this often

// Analytics reports by day in Pacific time; a day either side covers any broadcast.
const pacificDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

class StudioAudience extends EventEmitter {
  constructor({ credentials, ingest, pcv = null }) {
    super();
    this.credentials = credentials;
    this.ingest = ingest;
    this.pcv = pcv; // where Studio's PCV is kept, beside the sampled one
    this.videos = new Map();    // video id -> { channelId, startedAt, minutes: [[t, avg, peak]], fetchedAt }
    this.channels = new Map();  // channel id -> { status: ok | error, code, error, at }
  }

  start() {
    this.tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.soon);
  }

  // Owners found or the wall changed: read any new feed shortly.
  wallChanged() {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.tick(), 1500);
  }

  // A channel signed in again (perhaps now allowing Analytics), or out: start afresh.
  channelsChanged() {
    this.videos.clear();
    this.channels.clear();
    this.wallChanged();
  }

  // For Settings: whether this channel's Studio audience can be read. null until it was tried.
  channelState(channelId) {
    const c = this.channels.get(channelId);
    return c ? { status: c.status, code: c.code, error: c.error } : null;
  }

  // One feed's minutes as [t, average, peak], oldest first, or null.
  minutes(id) {
    return this.videos.get(id)?.minutes || null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    clearTimeout(this.timer);
    let changed = false;
    try {
      const now = Date.now();
      const feeds = Object.entries(this.ingest.videos || {}).filter(([, v]) => v.owned && v.startedAt);
      for (const id of this.videos.keys()) {
        if (!feeds.some(([f]) => f === id)) {
          this.videos.delete(id);
          changed = true;
        }
      }
      for (const [id, v] of feeds) {
        const channel = this.channels.get(v.channelId);
        if (channel?.status === 'error' && channel.code !== 'other' && now - channel.at < CHANNEL_RETRY_MS) continue;
        const have = this.videos.get(id);
        if (have && have.channelId === v.channelId && have.startedAt === v.startedAt) {
          const endedFor = v.endedAt ? now - Date.parse(v.endedAt) : 0;
          if (!ON_AIR.has(v.broadcast) && endedFor > SETTLED_MS && have.fetchedAt > Date.parse(v.endedAt) + SETTLED_MS) continue;
          if (now - have.fetchedAt < (ON_AIR.has(v.broadcast) ? LIVE_EVERY_MS : ENDED_EVERY_MS)) continue;
        }
        const same = have && have.channelId === v.channelId && have.startedAt === v.startedAt;
        const entry = same ? have : { channelId: v.channelId, startedAt: v.startedAt, minutes: [], fetchedAt: 0, officialAt: 0 };
        this.videos.set(id, entry);
        try {
          entry.minutes = await this.report(v.channelId, id, Date.parse(v.startedAt));
          this.channels.set(v.channelId, { status: 'ok', code: null, error: '', at: Date.now() });
          // Studio's PCV for the whole broadcast, kept apart from the wall's sampled one (pcv.js).
          if (Date.now() - entry.officialAt >= (ON_AIR.has(v.broadcast) ? OFFICIAL_EVERY_MS : ENDED_EVERY_MS)) {
            const official = await this.official(v.channelId, id, Date.parse(v.startedAt)).catch(() => null);
            if (official) this.pcv?.setOfficial(id, official);
            entry.officialAt = Date.now();
          }
        } catch (err) {
          // YouTube's own hiccup (5xx) says nothing about the channel; anything else does.
          if (err.code !== 'transient') this.channels.set(v.channelId, { status: 'error', code: err.code || 'other', error: String(err.message || err), at: Date.now() });
        }
        // Whatever happened, the minutes already read stay; this feed is asked again on its schedule.
        entry.fetchedAt = Date.now();
        changed = true;
      }
    } finally {
      this.busy = false;
      if (!this.stopped) this.timer = setTimeout(() => this.tick(), TICK_MS);
      if (changed) this.emit('update');
    }
  }

  async query(channelId, params) {
    const token = await this.credentials.accessToken(channelId);
    const res = await fetch(`${GOOGLE.ANALYTICS_API}/reports?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) this.credentials.dropAccess(channelId);
    if (!res.ok) throw analyticsError(body, res.status);
    return body;
  }

  // The Analytics report "concurrent viewers (for livestreams)": one row per minute since the
  // broadcast started, with that minute's average and peak. livestreamPosition counts
  // seconds from the start, in steps of 60 (measured: 0, 60 … 26700 for a 445-minute stream).
  async report(channelId, id, startedAt) {
    const body = await this.query(channelId, {
      ids: 'channel==MINE',
      startDate: pacificDay(startedAt - 86400e3),
      endDate: pacificDay(Date.now() + 86400e3),
      dimensions: 'livestreamPosition',
      metrics: 'averageConcurrentViewers,peakConcurrentViewers',
      filters: `video==${id}`,
      sort: 'livestreamPosition',
    });
    const col = Object.fromEntries((body.columnHeaders || []).map((h, i) => [h.name, i]));
    const minutes = [];
    for (const row of body.rows || []) {
      const pos = Number(row[col.livestreamPosition]);
      const avg = Number(row[col.averageConcurrentViewers]);
      const peak = Number(row[col.peakConcurrentViewers]);
      if (!Number.isFinite(pos) || !Number.isFinite(avg)) continue;
      minutes.push([startedAt + pos * 1000, Math.round(avg), Number.isFinite(peak) ? peak : null]);
    }
    return minutes.sort((a, b) => a[0] - b[0]);
  }

  // The same report without the minute: Studio's PCV for the whole broadcast, as far as
  // YouTube has processed it. null until it has a row (never a made-up 0).
  async official(channelId, id, startedAt) {
    const body = await this.query(channelId, {
      ids: 'channel==MINE',
      startDate: pacificDay(startedAt - 86400e3),
      endDate: pacificDay(Date.now() + 86400e3),
      metrics: 'peakConcurrentViewers',
      filters: `video==${id}`,
    });
    const col = Object.fromEntries((body.columnHeaders || []).map((h, i) => [h.name, i]));
    const row = body.rows?.[0];
    const peak = Number(row?.[col.peakConcurrentViewers]);
    if (!row || !Number.isSafeInteger(peak)) return null;
    return { peak, at: Date.now() };
  }
}

// Google's refusal, in words an operator can act on. code: disabled | scope | transient | other
function analyticsError(body, status) {
  if (status >= 500) {
    // YouTube Analytics' own "internal error", now and then on one video (measured): try again later.
    return Object.assign(new Error(`YouTube Analytics had an internal error (HTTP ${status})`), { code: 'transient' });
  }
  const err = body?.error || {};
  const reasons = [...(err.errors || []).map((e) => e.reason), ...(err.details || []).map((d) => d.reason)].filter(Boolean);
  const msg = String(err.message || '').replace(/<[^>]*>/g, '').trim();
  let out;
  if (reasons.some((r) => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(r))) {
    const link = /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+?(?=[\s,]|$)/.exec(msg)?.[0];
    out = new Error(`The YouTube Analytics API isn't enabled in the OAuth client's Google Cloud project: enable it${link ? ` at ${link}` : ' there'}, then wait a few minutes.`);
    out.code = 'disabled';
  } else if (status === 403 && (reasons.some((r) => ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(r)) || /scope|permission/i.test(msg))) {
    out = new Error('This sign-in doesn\'t allow YouTube Analytics: sign the channel in again and leave Analytics ticked.');
    out.code = 'scope';
  } else {
    out = new Error(msg || `YouTube Analytics answered HTTP ${status}`);
    out.code = 'other';
  }
  return out;
}

module.exports = { StudioAudience };
