// YouTube Data API poller. One poll a minute covers every video on the wall however many
// windows are open (each window polling on its own would multiply the quota), and keeps a
// 24-hour audience history on disk for the per-feed analytics.
//
// For a feed owned by a signed-in channel, YouTube Studio's own per-minute audience
// (youtube-studio.js) goes back to when the broadcast went live; the history a page sees is
// those minutes, then this wall's readings after the last minute YouTube has processed.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./paths');
const { GOOGLE, describeGoogleError } = require('./google-credentials');

const HISTORY_FILE = path.join(DATA_DIR, 'youtube-history.json');
const POLL_DEFAULT_S = 30;              // Settings → YouTube API → Refresh every (15–300 s)
const CHANNELS_EVERY_MS = 10 * 60000;   // subscriber counts barely move; 1 unit per 50 channels
const HISTORY_MS = 24 * 3600e3;
const SAVE_EVERY_MS = 60000;            // a backend killed outright loses at most a minute of history
const DAILY_QUOTA = 10000;              // YouTube's default; videos.list and channels.list cost 1 unit
const TREND_MS = 10 * 60000;
const RATE_WINDOW_MS = 60 * 60000;
const BACKOFF_MAX_MS = 5 * 60000;
const QUOTA_RETRY_MS = 15 * 60000;
const VIDEO_ID = /^[\w-]{11}$/;

// Quota resets at midnight Pacific time.
const quotaDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// ISO 8601 duration (PT6H31M57S) in seconds; live broadcasts report P0D.
function seconds(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => Number(v) || 0);
  return d * 86400 + h * 3600 + min * 60 + s || null;
}

class YouTubeStats extends EventEmitter {
  constructor({ store, credentials, pcv = null }) {
    super();
    this.store = store;             // the sessions: every live one's feeds are polled (session-store.js)
    this.credentials = credentials; // whoever's API key is saved; pages only ever see keyInfo()
    this.pcv = pcv;               // each broadcast's peak concurrent viewers (pcv.js)
    this.failures = 0;            // polls failed in a row: the next waits longer
    this.quotaOut = false;
    this.nextPollAt = 0;
    this.history = {};            // video id -> [[t, viewers, likes, views, comments], ...]
    this.totals = [];             // [[t, viewers across the wall]]
    this.latest = {};             // video id -> what YouTube reported last
    this.channels = {};           // channel id -> { title, subscribers }
    this.channelsAt = 0;
    this.status = 'off';          // off | ok | error
    this.error = '';
    this.updatedAt = 0;
    this.units = { day: quotaDay(), used: 0 };
    this.savedAt = Date.now();
    this.signature = '';
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const cutoff = Date.now() - HISTORY_MS;
      for (const [id, series] of Object.entries(saved.history || {})) {
        if (VIDEO_ID.test(id) && Array.isArray(series)) this.history[id] = series.filter((p) => p[0] >= cutoff);
      }
      this.totals = (saved.totals || []).filter((p) => p[0] >= cutoff);
      if (saved.units?.day === quotaDay()) this.units = saved.units;
    } catch {
      // first run, or an unreadable file: start a fresh history
    }
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${HISTORY_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ history: this.history, totals: this.totals, units: this.units }));
      fs.renameSync(tmp, HISTORY_FILE);
      this.savedAt = Date.now();
    } catch {
      // history stays in memory; the next save tries again
    }
  }

  start() {
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.soon);
    this.save();
    this.pcv?.save();
  }

  // Seconds between polls: the shortest any live session asks for in its settings.
  pollMs() {
    const asked = this.store.live().map((s) => Number(s.settings?.ytPollSec)).filter((n) => Number.isFinite(n));
    const s = asked.length ? Math.min(...asked) : POLL_DEFAULT_S;
    return Math.min(300, Math.max(15, s)) * 1000;
  }

  key() {
    return this.credentials.apiKey();
  }

  // Every live session's feeds, once each: one poll serves them all.
  ids() {
    return [...new Set(this.store.feeds().map((s) => s.source?.id).filter((id) => VIDEO_ID.test(id)))];
  }

  // The wall or key was saved: a new key, new feeds or a new interval take effect within seconds.
  wallChanged() {
    if (`${this.key()}|${this.ids().join(',')}|${this.pollMs()}` === this.signature) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.poll(), 1500);
  }

  // A key was saved: check it with YouTube now, even if it's the same key as before.
  keyChanged() {
    this.signature = '';
    this.wallChanged();
  }

  // A feed's encoder stream just stopped (youtube-ingest.js): read whether its broadcast
  // ended now, not at the next poll.
  pollSoon() {
    if (!this.key()) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.poll(), 1500);
  }

  async get(resource, params, key) {
    const today = quotaDay();
    if (this.units.day !== today) this.units = { day: today, used: 0 };
    this.units.used += 1;
    const res = await fetch(`${GOOGLE.API}/${resource}?${new URLSearchParams({ ...params, key })}`, {
      headers: { Referer: this.credentials.referer },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { code, message } = describeGoogleError(body, res.status, this.credentials.referer);
      throw Object.assign(new Error(message), { code });
    }
    return body;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    clearTimeout(this.timer);
    const key = this.key();
    const ids = this.ids();
    this.signature = `${key}|${ids.join(',')}|${this.pollMs()}`;
    try {
      if (!key) {
        this.status = 'off';
        this.error = '';
        this.latest = {}; // key removed: show nothing rather than numbers that stop updating
        return;
      }
      const now = Date.now();
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        // One unit however many parts: status and contentDetails come free with the rest.
        const body = await this.get('videos', {
          part: 'snippet,statistics,liveStreamingDetails,status,contentDetails',
          id: batch.join(','),
          fields: 'items(id,snippet(title,channelId,channelTitle,liveBroadcastContent),statistics(viewCount,likeCount,commentCount),'
            + 'liveStreamingDetails(concurrentViewers,actualStartTime,actualEndTime,scheduledStartTime,activeLiveChatId),'
            + 'status(privacyStatus,embeddable),contentDetails(definition,duration))',
        }, key);
        const returned = new Set();
        for (const item of body.items || []) {
          returned.add(item.id);
          const live = item.liveStreamingDetails || {};
          this.latest[item.id] = {
            title: item.snippet?.title ?? null,
            channelId: item.snippet?.channelId ?? null,
            channelTitle: item.snippet?.channelTitle ?? null,
            broadcast: item.snippet?.liveBroadcastContent ?? null, // live | upcoming | none
            viewers: num(live.concurrentViewers),
            views: num(item.statistics?.viewCount),
            likes: num(item.statistics?.likeCount),
            comments: num(item.statistics?.commentCount),
            startedAt: live.actualStartTime ?? null,
            endedAt: live.actualEndTime ?? null,
            scheduledAt: live.scheduledStartTime ?? null,
            chat: item.liveStreamingDetails ? Boolean(live.activeLiveChatId) : null,
            privacy: item.status?.privacyStatus ?? null,        // public | unlisted | private
            embeddable: item.status?.embeddable ?? null,         // false: the wall can't play it
            definition: item.contentDetails?.definition ?? null, // hd | sd
            lengthSec: seconds(item.contentDetails?.duration),   // recordings; null while live
          };
        }
        // Deleted, private or mistyped: YouTube leaves the ID out of the response.
        for (const id of batch) if (!returned.has(id)) this.latest[id] = { missing: true };
      }
      if (now - this.channelsAt > CHANNELS_EVERY_MS) await this.pollChannels(key, ids);
      // A broadcast new to the PCV tracker starts from the readings already in the history.
      for (const id of ids) this.pcv?.seed(id, this.history[id], this.latest[id]);
      this.record(now, ids);
      for (const id of ids) this.pcv?.observe(id, this.latest[id], now);
      this.pcv?.prune(ids, now);
      this.status = 'ok';
      this.error = '';
      this.updatedAt = now;
      this.failures = 0;
    } catch (err) {
      // The PCVs, the history and the last numbers stay as they were: nothing is reset.
      this.status = 'error';
      this.error = String(err.message || err);
      this.failures += 1;
      this.quotaOut = err.code === 'quota';
    } finally {
      this.polling = false;
      if (Date.now() - this.savedAt > SAVE_EVERY_MS) this.save();
      const wait = this.status === 'error' ? this.backoffMs() : this.pollMs();
      this.nextPollAt = Date.now() + wait;
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), wait);
      this.emit('update');
    }
  }

  // After a failed poll: twice the interval, then 4×, 8×… up to 5 minutes, so an outage or a
  // flaky network isn't hammered. Out of quota, every 15 minutes until it resets.
  backoffMs() {
    if (this.quotaOut) return QUOTA_RETRY_MS;
    return Math.min(BACKOFF_MAX_MS, this.pollMs() * 2 ** Math.min(this.failures, 6));
  }

  async pollChannels(key, ids) {
    const channelIds = [...new Set(ids.map((id) => this.latest[id]?.channelId).filter(Boolean))];
    for (let i = 0; i < channelIds.length; i += 50) {
      const body = await this.get('channels', {
        part: 'statistics',
        id: channelIds.slice(i, i + 50).join(','),
        fields: 'items(id,statistics(subscriberCount,hiddenSubscriberCount))',
      }, key);
      for (const item of body.items || []) {
        this.channels[item.id] = { subscribers: item.statistics?.hiddenSubscriberCount ? null : num(item.statistics?.subscriberCount) };
      }
    }
    this.channelsAt = Date.now();
  }

  record(now, ids) {
    const cutoff = now - HISTORY_MS;
    for (const id of ids) {
      const v = this.latest[id];
      if (!v || v.missing) continue;
      (this.history[id] ||= []).push([now, v.viewers, v.likes, v.views, v.comments]);
    }
    // One total per live session, stamped with it: its Feeds tab's CCV history and PCV.
    for (const s of this.store.live()) {
      let total = 0;
      let any = false;
      for (const id of new Set(s.streams.map((x) => x.source?.id))) {
        const v = this.latest[id];
        if (!v || v.missing || v.viewers == null) continue;
        total += v.viewers;
        any = true;
      }
      if (any) this.totals.push([now, total, s.id]);
    }
    for (const [id, series] of Object.entries(this.history)) {
      while (series.length && series[0][0] < cutoff) series.shift();
      if (!series.length) delete this.history[id];
    }
    while (this.totals.length && this.totals[0][0] < cutoff) this.totals.shift();
  }

  // What a window of one session shows: the latest numbers plus the analysis for its feeds
  // (every live session's without a session), and that session's wall total and PCV.
  state(sessionId = null) {
    const now = Date.now();
    const videos = {};
    const session = sessionId ? this.store.get(sessionId) : null;
    const ids = session ? [...new Set(session.streams.map((s) => s.source?.id).filter((id) => VIDEO_ID.test(id)))] : this.ids();
    for (const id of ids) {
      const v = this.latest[id];
      if (!v) continue;
      videos[id] = v.missing ? v : {
        ...v,
        subscribers: v.channelId ? this.channels[v.channelId]?.subscribers ?? null : null,
        analysis: analyse(this.series(id), now, this.history[id] || []),
        pcv: this.pcv?.view(id) ?? null, // current CCV, sampled PCV and Studio's, kept apart
      };
    }
    const totalSeries = this.series('total', sessionId);
    // The wall's PCV: the highest wall-total CCV read in this session (sampled, like a feed's).
    const wallPcv = peakOf(totalSeries, 1);
    return {
      status: this.status,
      error: this.error,
      key: this.credentials.keyInfo(),
      ingest: this.ingest ? this.ingest.state() : null, // channel sign-in: encoder → YouTube health
      updatedAt: this.updatedAt,
      pollMs: this.pollMs(),
      retryAt: this.status === 'error' ? this.nextPollAt : null, // backing off after failures
      units: { used: this.units.used, limit: DAILY_QUOTA },
      total: { ...peakOf(totalSeries, 1), now: totalSeries.at(-1)?.[1] ?? null, since: totalSeries[0]?.[0] ?? null, pcv: wallPcv.peak, pcvAt: wallPcv.peakAt, pcvSamples: wallPcv.samples },
      videos,
    };
  }

  // Wall totals recorded before they were stamped with a session (one session at a time
  // then) belong to the session that was live, so its Feeds-tab PCV keeps them.
  adoptUnstamped(sessionId) {
    let changed = false;
    for (const p of this.totals) {
      if (p[2] == null) {
        p[2] = sessionId;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // Raw series for a chart: one video's [t, viewers, likes, views, comments], or a session's
  // wall total. A Studio minute is [t, average viewers, null, null, null, peak viewers].
  series(id, sessionId = null) {
    if (id === 'total') return this.totals.filter((p) => (p[2] ?? null) === sessionId).map(([t, v]) => [t, v]);
    const wall = this.history[id] || [];
    const minutes = this.studio?.minutes(id);
    if (!minutes?.length) return wall;
    const cutoff = Date.now() - HISTORY_MS;
    const until = minutes.at(-1)[0] + 60000; // a minute's row covers the minute it starts
    return [
      ...minutes.filter((m) => m[0] >= cutoff).map(([t, avg, peak]) => [t, avg, null, null, null, peak]),
      ...wall.filter((p) => p[0] >= until),
    ];
  }
}

// Peak, lowest and average of column `col` across a series.
function peakOf(series, col) {
  let peak = null;
  let peakAt = null;
  let low = null;
  let sum = 0;
  let n = 0;
  for (const p of series) {
    const v = p[col];
    if (v == null) continue;
    if (peak == null || v > peak) [peak, peakAt] = [v, p[0]];
    if (low == null || v < low) low = v;
    sum += v;
    n += 1;
  }
  return { peak, peakAt, low, avg: n ? Math.round(sum / n) : null, samples: n };
}

// Change per hour of column `col` over the last hour (needs at least 5 minutes of data).
function perHour(series, col, now) {
  const recent = series.filter((p) => p[0] >= now - RATE_WINDOW_MS && p[col] != null);
  if (recent.length < 2) return null;
  const [first, last] = [recent[0], recent.at(-1)];
  const hours = (last[0] - first[0]) / 3600e3;
  return hours >= 5 / 60 ? Math.round((last[col] - first[col]) / hours) : null;
}

// series: Studio's minutes (if any) then the wall's readings; wall: all of the wall's readings.
function analyse(series, now, wall) {
  const viewers = peakOf(series, 1);
  // A Studio minute's peak can top its average.
  for (const p of series) if (p[5] != null && p[5] > viewers.peak) [viewers.peak, viewers.peakAt] = [p[5], p[0]];
  const studio = series.filter((p) => p.length > 5);
  const last = series.at(-1);
  // Viewers now against roughly ten minutes ago.
  const before = series.find((p) => p[0] >= now - TREND_MS - 30000 && p[1] != null);
  const trendPct = last?.[1] != null && before && before !== last && before[1] > 0
    ? Math.round(((last[1] - before[1]) / before[1]) * 1000) / 10
    : null;
  return {
    ...viewers,
    trendPct,
    trendMins: before && before !== last ? Math.round((last[0] - before[0]) / 60000) : null,
    likesPerHour: perHour(series, 2, now),
    viewsPerHour: perHour(series, 3, now),
    trackedSince: wall[0]?.[0] ?? null,
    readings: wall.length,
    studioFrom: studio[0]?.[0] ?? null,          // Studio's minutes, from the broadcast's start
    studioUntil: studio.length ? studio.at(-1)[0] + 60000 : null,
  };
}

module.exports = { YouTubeStats };
