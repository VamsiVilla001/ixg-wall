// YouTube Data API poller. One poll a minute covers every video on the wall however many
// windows are open (each window polling on its own would multiply the quota), and keeps a
// 24-hour audience history on disk for the per-feed analytics.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./paths');

const API = process.env.IXG_YOUTUBE_API || 'https://www.googleapis.com/youtube/v3';
const HISTORY_FILE = path.join(DATA_DIR, 'youtube-history.json');
const POLL_DEFAULT_S = 30;              // Settings → YouTube API → Refresh every (15–300 s)
const CHANNELS_EVERY_MS = 10 * 60000;   // subscriber counts barely move; 1 unit per 50 channels
const HISTORY_MS = 24 * 3600e3;
const SAVE_EVERY_MS = 5 * 60000;
const DAILY_QUOTA = 10000;              // YouTube's default; videos.list and channels.list cost 1 unit
const TREND_MS = 10 * 60000;
const RATE_WINDOW_MS = 60 * 60000;
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
  constructor({ wallStore, referer }) {
    super();
    this.wallStore = wallStore;
    this.referer = referer;       // lets a key restricted to the wall's address work from here
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
  }

  // Seconds between polls, from the wall's settings.
  pollMs() {
    const s = Number(this.wallStore.wall?.settings?.ytPollSec);
    return (Number.isFinite(s) ? Math.min(300, Math.max(15, s)) : POLL_DEFAULT_S) * 1000;
  }

  key() {
    return String(this.wallStore.wall?.settings?.ytApiKey || '').trim();
  }

  ids() {
    return [...new Set((this.wallStore.wall?.streams || []).map((s) => s.source?.id).filter((id) => VIDEO_ID.test(id)))];
  }

  // The wall was saved: a new key, new feeds or a new interval take effect within seconds.
  wallChanged() {
    if (`${this.key()}|${this.ids().join(',')}|${this.pollMs()}` === this.signature) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.poll(), 1500);
  }

  async get(resource, params, key) {
    const today = quotaDay();
    if (this.units.day !== today) this.units = { day: today, used: 0 };
    this.units.used += 1;
    const res = await fetch(`${API}/${resource}?${new URLSearchParams({ ...params, key })}`, {
      headers: { Referer: this.referer },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(body, res.status));
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
      this.record(now, ids);
      this.status = 'ok';
      this.error = '';
      this.updatedAt = now;
    } catch (err) {
      this.status = 'error';
      this.error = String(err.message || err);
    } finally {
      this.polling = false;
      if (Date.now() - this.savedAt > SAVE_EVERY_MS) this.save();
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), this.pollMs());
      this.emit('update');
    }
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
    let total = 0;
    let any = false;
    for (const id of ids) {
      const v = this.latest[id];
      if (!v || v.missing) continue;
      (this.history[id] ||= []).push([now, v.viewers, v.likes, v.views, v.comments]);
      if (v.viewers != null) {
        total += v.viewers;
        any = true;
      }
    }
    if (any) this.totals.push([now, total]);
    for (const [id, series] of Object.entries(this.history)) {
      while (series.length && series[0][0] < cutoff) series.shift();
      if (!series.length) delete this.history[id];
    }
    while (this.totals.length && this.totals[0][0] < cutoff) this.totals.shift();
  }

  // What the wall shows: the latest numbers plus the analysis, for the feeds on the wall.
  state() {
    const now = Date.now();
    const videos = {};
    for (const id of this.ids()) {
      const v = this.latest[id];
      if (!v) continue;
      videos[id] = v.missing ? v : {
        ...v,
        subscribers: v.channelId ? this.channels[v.channelId]?.subscribers ?? null : null,
        analysis: analyse(this.history[id] || [], now),
      };
    }
    const totalSeries = this.totals.map(([t, v]) => [t, v]);
    return {
      status: this.status,
      error: this.error,
      updatedAt: this.updatedAt,
      pollMs: this.pollMs(),
      units: { used: this.units.used, limit: DAILY_QUOTA },
      total: { ...peakOf(totalSeries, 1), now: totalSeries.at(-1)?.[1] ?? null, since: totalSeries[0]?.[0] ?? null },
      videos,
    };
  }

  // Raw series for a chart: one video's [t, viewers, likes, views, comments], or the wall total.
  series(id) {
    return id === 'total' ? this.totals : this.history[id] || [];
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

function analyse(series, now) {
  const viewers = peakOf(series, 1);
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
    trackedSince: series[0]?.[0] ?? null,
  };
}

// Google's error reasons, in words an operator can act on.
function explain(body, status) {
  const err = body?.error || {};
  const reasons = [...(err.errors || []).map((e) => e.reason), ...(err.details || []).map((d) => d.reason)].filter(Boolean);
  const has = (...r) => r.some((x) => reasons.includes(x));
  if (has('API_KEY_INVALID', 'keyInvalid')) return 'Key not valid: check it was copied in full';
  if (has('quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED')) return 'Daily quota used up: numbers resume after midnight Pacific time';
  if (has('API_KEY_HTTP_REFERRER_BLOCKED', 'ipRefererBlocked', 'API_KEY_IP_ADDRESS_BLOCKED')) {
    return 'Key restricted to other addresses: allow http://localhost:8080/* in its Google Cloud restrictions';
  }
  if (has('accessNotConfigured', 'SERVICE_DISABLED', 'API_KEY_SERVICE_BLOCKED')) return 'YouTube Data API v3 is not enabled for this key\'s Google Cloud project';
  const msg = String(err.message || '').replace(/<[^>]*>/g, '').trim();
  return msg || `YouTube answered HTTP ${status}`;
}

module.exports = { YouTubeStats };
