// Peak concurrent viewers (PCV), one record per broadcast (a YouTube live video ID).
//
// CCV is how many watch at once: liveStreamingDetails.concurrentViewers, read by youtube.js
// at every poll. The sampled PCV is the highest CCV this wall has read during the broadcast.
// It never goes down while the broadcast lasts, and an unreadable count (hidden, an API
// error, a network failure) is never taken as zero and never touches it. Because it's
// sampled (every 30 s by default), a spike shorter than that can be missed: it's an
// estimate of YouTube Studio's PCV, never shown as Studio's.
//
// Studio's own figure (YouTube Analytics' peakConcurrentViewers, read by youtube-studio.js
// for broadcasts a signed-in channel owns) is kept beside it as `official`, separately, and
// is preferred for final reporting. Neither overwrites the other.
//
// Records are saved to pcv.json on every change, so a restart resumes where it was.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'pcv.json');
const SAVE_DELAY_MS = 2000;     // readings arriving together are written once
const KEEP_MS = 30 * 86400e3;   // a broadcast not seen for this long is forgotten
const VIDEO_ID = /^[\w-]{11}$/;

// waiting: scheduled, not live yet · live · ended · not-live: a video that isn't a broadcast
function statusOf(v) {
  if (v.endedAt) return 'ended';
  if (v.broadcast === 'live') return 'live';
  if (v.broadcast === 'upcoming') return 'waiting';
  return v.startedAt ? 'ended' : 'not-live';
}

const fresh = (id) => ({
  id,
  status: 'waiting',
  startedAt: null,
  endedAt: null,
  ccv: null,          // the latest count; null when YouTube didn't give one
  ccvAt: null,
  lastUpdated: null,  // the last time YouTube answered for this video
  peak: null,         // sampled PCV
  peakAt: null,
  samples: 0,         // counts read during the broadcast
  official: null,     // { peak, avg, at }: YouTube Analytics, kept apart
  seenAt: null,
});

class PcvTracker extends EventEmitter {
  constructor({ file = FILE, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.records = {};
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, r] of Object.entries(saved.broadcasts || {})) {
        if (VIDEO_ID.test(id) && r && typeof r === 'object') this.records[id] = { ...fresh(id), ...r, id };
      }
    } catch {
      // first run, or an unreadable file: start empty
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, broadcasts: this.records }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`Could not save ${this.file}: ${err.message}`); // kept in memory; the next change tries again
    }
  }

  saveSoon() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  get(id) {
    return this.records[id] || null;
  }

  // One answer from YouTube for a video (youtube.js's reading: broadcast, viewers, startedAt,
  // endedAt). Returns the record. Emits 'peak' when the sampled PCV rises.
  observe(id, v, t = this.now()) {
    if (!VIDEO_ID.test(id) || !v || v.missing) return null;
    let r = this.records[id];
    // The same video ID live again from a different start is another broadcast.
    if (r && r.startedAt && v.startedAt && r.startedAt !== v.startedAt) r = null;
    if (!r) r = this.records[id] = fresh(id);
    r.status = statusOf(v);
    r.startedAt = v.startedAt || r.startedAt;
    r.endedAt = v.endedAt || null;
    r.lastUpdated = t;
    r.seenAt = t;
    let rose = null;
    if (r.status === 'live' && Number.isSafeInteger(v.viewers) && v.viewers >= 0) {
      r.ccv = v.viewers;
      r.ccvAt = t;
      r.samples += 1;
      if (r.peak == null || v.viewers > r.peak) {
        rose = { previous: r.peak };
        r.peak = v.viewers;
        r.peakAt = t;
      }
    } else {
      r.ccv = null; // hidden, not live yet, or over: unknown, not zero; the peak stays as it was
    }
    this.saveSoon(); // one small write per poll at most: a restart resumes from here
    if (rose) this.emit('peak', { id, peak: r.peak, peakAt: r.peakAt, previous: rose.previous });
    return r;
  }

  // A broadcast met for the first time (a new feed, or a wall from before pcv.json) that the
  // wall already has readings of (youtube.js's history, [t, viewers, …]): its PCV starts from
  // the highest of them since the broadcast went live, not from the next reading.
  seed(id, readings, v) {
    if (!VIDEO_ID.test(id) || this.records[id] || !v || v.missing || !v.startedAt) return;
    const since = Date.parse(v.startedAt);
    const r = this.records[id] = { ...fresh(id), startedAt: v.startedAt, status: statusOf(v) };
    for (const [t, viewers] of readings || []) {
      if (!(t >= since) || !Number.isSafeInteger(viewers) || viewers < 0) continue;
      r.samples += 1;
      if (r.peak == null || viewers > r.peak) [r.peak, r.peakAt] = [viewers, t];
    }
    this.saveSoon();
  }

  // YouTube Analytics' figures for a broadcast its channel owns: stored apart from the sampled ones.
  setOfficial(id, { peak, avg = null, at = this.now() }) {
    if (!Number.isSafeInteger(peak) || peak < 0) return;
    const r = this.records[id] || (this.records[id] = fresh(id));
    if (r.official?.peak === peak && r.official?.avg === avg) {
      r.official.at = at;
      return;
    }
    r.official = { peak, avg: Number.isFinite(avg) ? Math.round(avg) : null, at };
    this.saveSoon();
  }

  // Forgets broadcasts neither on the wall nor seen for KEEP_MS.
  prune(onWall, t = this.now()) {
    const keep = new Set(onWall);
    let changed = false;
    for (const [id, r] of Object.entries(this.records)) {
      if (!keep.has(id) && t - (r.seenAt || 0) > KEEP_MS) {
        delete this.records[id];
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  // What a page sees of one broadcast.
  view(id) {
    const r = this.records[id];
    if (!r) return null;
    const { status, startedAt, endedAt, ccv, ccvAt, lastUpdated, peak, peakAt, samples, official } = r;
    return { status, startedAt, endedAt, ccv, ccvAt, lastUpdated, peak, peakAt, samples, official };
  }
}

module.exports = { PcvTracker, statusOf };
