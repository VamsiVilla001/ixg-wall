// Automatic source screenshots. The backend decides when one is due, so every open window
// agrees: a feed's CCV reaches a peak (a new high for the stream, or a rise of PEAK_RISE
// after a fall of PEAK_DIP from the last screenshot; at most once per feed every 2 or 4 min,
// Settings → Source screenshots), or YouTube says a feed's broadcast is over after this
// server saw it live. A wall page with the Feed Meter claims each job (first claim wins, so
// one window takes it) and reports back; the screenshot itself is the same one as Capture
// source screenshot (extension/capture.js).
const { EventEmitter } = require('events');

const PEAK_GAP_MIN = 2;              // one CCV-peak screenshot per feed per this many minutes, at most (autoCaptureMin)
const PEAK_DIP = 0.1;                // fallen this far below the last screenshot's count, the next rise is a peak of its own...
const PEAK_RISE = 0.1;               // ...once it has risen this far from the lowest point since
const LEASE_MS = 3 * 60000;          // a claim not reported back in this long is offered again
const TTL_MS = 30 * 60000;           // a job nobody claims this long (no page with the Feed Meter) is dropped
const MAX_TRIES = 3;                 // a job handed back this often (no player, the extension hiccuped) is dropped
const BUSY_HOLD_MS = 20000;          // the Feed Meter was taking another screenshot: offered again after this
const REASON = { peak: 'CCV peak', end: 'stream ended' };

class AutoCapture extends EventEmitter {
  constructor({ youtube, ingest = null, wallStore, now = () => Date.now() }) {
    super();
    this.youtube = youtube;
    this.ingest = ingest;
    this.wallStore = wallStore;
    this.now = now;
    this.feeds = new Map(); // video id -> { captured, capturedAt, low, riseHigh, liveSeen, ended }
    this.jobs = [];         // [{ job, id, reason: peak | end, ccv, label, createdAt, claimedAt, client, tries, holdUntil, busyNoted }]
    this.log = [];          // what was decided and what came of it, for the wall's event log
    this.logSeq = 0;
    this.seq = 0;
    this.boot = now().toString(36);
  }

  // One line of the record: the feed, what happened, and which window did it (so that
  // window can skip what it already logged itself).
  note(id, text, level = 'info', client = '') {
    this.logSeq += 1;
    this.log.push({ seq: this.logSeq, t: this.now(), id, label: this.label(id), text, level, client });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  entries() {
    return this.log.slice(-60);
  }

  enabled() {
    return this.wallStore.wall?.settings?.autoCapture !== false;
  }

  // Settings → Source screenshots: the least time between two CCV-peak screenshots of a feed.
  peakGapMs() {
    const m = Number(this.wallStore.wall?.settings?.autoCaptureMin);
    return (Number.isFinite(m) ? Math.min(60, Math.max(1, m)) : PEAK_GAP_MIN) * 60000;
  }

  label(id) {
    return (this.wallStore.wall?.streams || []).find((s) => s.source?.id === id)?.label || '';
  }

  // YouTube's word that the broadcast is over: its end time, or the owning channel's sign-in.
  over(id, v) {
    if (v.endedAt) return true;
    const i = this.ingest?.videos?.[id];
    return !!(i?.owned && i.broadcast === 'complete');
  }

  // A window is taking it right now: claimed, and the claim hasn't run out.
  taken(j, now) {
    return !!j.claimedAt && now - j.claimedAt < LEASE_MS;
  }

  // After every YouTube or ingest update: queue what's due. True when the open jobs changed
  // (the update itself goes out to the pages, so there's nothing to announce).
  check() {
    const now = this.now();
    const before = this.signature();
    const ids = new Set(this.youtube.ids());
    for (const id of this.feeds.keys()) if (!ids.has(id)) this.feeds.delete(id);
    this.jobs = this.jobs.filter((j) => {
      // Never while a window is taking it: its result is still to come.
      const why = !ids.has(j.id) ? 'the feed was taken off the wall'
        : this.taken(j, now) ? ''
          : now - j.createdAt >= TTL_MS ? 'no window with the Feed Meter took it in 30 min'
            : !this.enabled() ? 'automatic screenshots were turned off' : '';
      if (why) this.note(j.id, `Automatic screenshot (${REASON[j.reason]}) dropped: ${why}`, 'warn');
      return !why;
    });
    for (const id of ids) {
      const v = this.youtube.latest[id];
      if (!v || v.missing) continue;
      let f = this.feeds.get(id);
      if (!f) {
        // The high already in the history stands for the last screenshot (it was seen
        // before); the rise is tracked from this first reading.
        const high = Math.max(v.viewers ?? -1, ...(this.youtube.history[id] || []).map((p) => p[1] ?? -1));
        const start = v.viewers ?? high;
        f = { captured: high, capturedAt: 0, low: start, riseHigh: start, liveSeen: false, ended: false };
        this.feeds.set(id, f);
      }
      const over = this.over(id, v);
      if (over) {
        // An end only this server saw happen; a feed that was over when it got here isn't news.
        if (f.liveSeen && !f.ended && this.enabled()) this.queue(id, 'end', null, now);
        f.ended = f.ended || f.liveSeen;
        // A peak nobody is taking is no longer worth a screenshot of an ended stream.
        this.jobs = this.jobs.filter((j) => !(j.id === id && j.reason === 'peak' && !this.taken(j, now)));
        continue;
      }
      if (v.broadcast !== 'live') continue;
      f.liveSeen = true;
      const ccv = v.viewers;
      if (ccv == null) continue;
      // The lowest point since the last screenshot, and the high of the rise from it.
      if (ccv < f.low) {
        f.low = ccv;
        f.riseHigh = ccv;
      } else if (ccv > f.riseHigh) {
        f.riseHigh = ccv;
      }
      // A peak while the count is at it: higher than the last screenshot, or a rise of its own
      // after a real fall. One cut short by the cooldown is taken once the cooldown is over,
      // if the count is still at the high then.
      const dipped = f.low <= f.captured * (1 - PEAK_DIP) && ccv >= f.low * (1 + PEAK_RISE);
      if (ccv >= f.riseHigh && (ccv > f.captured || dipped) && now - f.capturedAt >= this.peakGapMs() && this.enabled()) {
        this.queue(id, 'peak', ccv, now);
        f.captured = ccv;
        f.capturedAt = now;
        f.low = ccv;
        f.riseHigh = ccv;
      }
    }
    return this.signature() !== before;
  }

  queue(id, reason, ccv, now) {
    // One open job per feed: a newer peak replaces a waiting one, an end replaces a peak.
    // A job whose claim ran out is waiting too; replaced, it starts afresh.
    const waiting = this.jobs.find((j) => j.id === id && !this.taken(j, now));
    const what = reason === 'peak' ? `CCV peak, ${ccv} watching` : 'stream ended';
    if (waiting && (waiting.reason === reason || reason === 'end')) {
      Object.assign(waiting, { reason, ccv, label: this.label(id), createdAt: now, claimedAt: 0, client: '', tries: 0, holdUntil: 0, busyNoted: false });
      this.note(id, `Automatic screenshot waiting: now for the ${what}`);
      return;
    }
    if (waiting && waiting.reason === 'end') return;
    this.seq += 1;
    this.jobs.push({ job: `${this.boot}-${this.seq}`, id, reason, ccv, label: this.label(id), createdAt: now, claimedAt: 0, client: '', tries: 0, holdUntil: 0, busyNoted: false });
    this.note(id, `Automatic screenshot queued: ${what}`);
  }

  // What pages may claim: not being taken, and not held back after a busy Feed Meter.
  open() {
    if (!this.enabled()) return [];
    const now = this.now();
    return this.jobs
      .filter((j) => !this.taken(j, now) && now >= j.holdUntil)
      .map(({ job, id, reason, ccv, label }) => ({ job, id, reason, ccv, label: this.label(id) || label }));
  }

  // The first page to ask gets it.
  claim(job, client = '') {
    const now = this.now();
    const j = this.jobs.find((x) => x.job === job);
    if (!j || !this.enabled() || this.taken(j, now) || now < j.holdUntil) return null;
    j.claimedAt = now;
    j.client = client;
    this.note(j.id, `Automatic screenshot (${REASON[j.reason]}) being taken by a wall window`, 'info', client);
    this.emit('change');
    return { job: j.job, id: j.id, reason: j.reason, ccv: j.ccv, label: this.label(j.id) || j.label };
  }

  // Taken (saved or failed for good), or handed back for another page or a later try.
  // outcome: 'saved' (detail: the file) or 'failed' (detail: why), as the page reports it.
  // busy: the Feed Meter was taking another screenshot, so this wasn't a try: offered again
  // shortly. Only the window holding the claim is heard; a late word from one that lost it
  // (its claim ran out and another window took over) is ignored.
  finish(job, { retry = false, busy = false, outcome = '', detail = '', client = '' } = {}) {
    const j = this.jobs.find((x) => x.job === job);
    if (!j || !j.claimedAt || (j.client && j.client !== client)) return false;
    const what = `Automatic screenshot (${REASON[j.reason]})`;
    const why = String(detail || '').slice(0, 300);
    if (busy && retry) {
      j.claimedAt = 0;
      j.client = '';
      j.holdUntil = this.now() + BUSY_HOLD_MS;
      if (!j.busyNoted) this.note(j.id, `${what} waiting for the Feed Meter to finish another screenshot`, 'info', client);
      j.busyNoted = true;
    } else {
      j.tries += 1;
      if (retry && j.tries < MAX_TRIES) {
        j.claimedAt = 0;
        j.client = '';
        this.note(j.id, `${what} handed back, will be tried again: ${why || 'the window could not take it'}`, 'warn', client);
      } else {
        this.jobs = this.jobs.filter((x) => x !== j);
        if (outcome === 'saved') this.note(j.id, `${what} saved: ${why}`, 'info', client);
        else if (retry) this.note(j.id, `${what} dropped after ${j.tries} tries: ${why || 'no window could take it'}`, 'bad', client);
        else this.note(j.id, `${what} failed: ${why || 'unknown reason'}`, 'bad', client);
      }
    }
    this.emit('change');
    return true;
  }

  signature() {
    return this.jobs.map((j) => `${j.job}:${j.reason}:${j.claimedAt ? 1 : 0}:${j.holdUntil}`).join(',');
  }
}

module.exports = { AutoCapture, PEAK_GAP_MIN, PEAK_DIP, PEAK_RISE, LEASE_MS, TTL_MS, MAX_TRIES, BUSY_HOLD_MS };
