'use strict';

(() => {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'ixg-multiviewer:v1'; // the app's name before it became IXG Wall; kept so saved walls carry over
  const DEFAULT_SETTINGS = {
    checkIntervalSec: 2,
    driftThresholdSec: 4,
    hardReloadMin: 30,
    autoResync: true,
    showStats: true,
    layoutMode: 'scroll',      // scroll: fixed columns, big tiles, scroll for more | fit: every feed on screen
    scrollColumns: 2,
    feedQuality: 'hd1080',     // what on-screen feeds stream at in scroll mode
    cardPct: 32,               // stats card's share of the tile width in scroll mode
    layout: 'auto',            // columns in fit mode
    bandwidthMbps: 0,          // 0 = unknown: boosts are governed by stall feedback alone
    priorityQuality: 'hd1080',
    loadConcurrency: 2,
    ytApiKey: '',              // optional YouTube Data API v3 key for audience stats
    ytPollSec: 30,             // how often the backend asks YouTube (1 quota unit per 50 feeds)
  };
  const LIMITS = {
    checkIntervalSec: [1, 30],
    driftThresholdSec: [1, 60],
    hardReloadMin: [0, 1440],
    bandwidthMbps: [0, 10000],
    loadConcurrency: [1, 6],
    scrollColumns: [1, 4],
    cardPct: [20, 45],
    ytPollSec: [15, 300],
  };
  const FEED_QUALITIES = ['large', 'hd720', 'hd1080'];
  const OFFSCREEN_RELEASE_MS = 60000; // a feed scrolled out of view keeps its quality this long, then drops to 480p

  // YouTube quality levels: frame width, and a typical live bitrate. The bitrate is an
  // ESTIMATE — embeds don't expose the real one — used for budgeting and the header readout.
  const QUALITY = {
    tiny: { label: '144p', width: 256, mbps: 0.15 },
    small: { label: '240p', width: 426, mbps: 0.35 },
    medium: { label: '360p', width: 640, mbps: 0.7 },
    large: { label: '480p', width: 854, mbps: 1.2 },
    hd720: { label: '720p', width: 1280, mbps: 2.8 },
    hd1080: { label: '1080p', width: 1920, mbps: 5 },
    hd1440: { label: '1440p', width: 2560, mbps: 10 },
    hd2160: { label: '2160p', width: 3840, mbps: 20 },
  };
  const QUALITY_ORDER = Object.keys(QUALITY);
  const rank = (q) => QUALITY_ORDER.indexOf(q);
  // Embeds settle at 480p however small the player is (measured), and ignore quality requests,
  // so the only lever is the player's render size: bigger renders pull higher quality.
  const EMBED_FLOOR = 'large';
  // Alternating hosts puts feeds in two browser processes instead of one, which halves the
  // player work queued on any one main thread when the wall runs 20–30 feeds.
  const HOSTS = ['https://www.youtube.com', 'https://www.youtube-nocookie.com'];

  const BUDGET_HEADROOM = 0.8;        // boosts must fit in 80% of the stated bandwidth
  const CONGESTION_WINDOW_MS = 60000; // stalls on several feeds inside this window = our link, not theirs
  const CONGESTION_MIN_FEEDS = 3;     // ...at least this many feeds, or 20% of the wall
  const SHED_GAP_MS = 90000;          // min gap between shedding priority boosts
  const RESTORE_CALM_MS = 300000;     // calm needed before restoring one boost
  const LOAD_SLOT_MS = 15000;         // a starting feed holds a load slot until it plays, fails or this passes
  const MAX_AUTO_JUMPS_PER_TICK = 2;  // spread live-edge catch-ups after a wall-wide blip
  const BUFFER_LOW_S = 4;             // buffer health below this reads red: a live feed is about to stall
  const STALL_FLAG_MS = 60000;        // a stall stays flagged red this long after it ends, so a 1 s blip isn't missed
  const HISTORY_MS = 300000;          // feed stats sparklines cover the last 5 minutes
  const NERDS_MIN_RENDER_PX = 560;    // YouTube's stats panel is ~510px wide inside the player
  const SIDE_MIN_PX = 120;            // spare width beside the 16:9 video needed for the side panel
  const CATCHUP_RATE = 1.25;          // close small drift by playing faster instead of a visible jump
  const CATCHUP_MAX_DRIFT_S = 15;     // further behind than this: jump
  const CATCHUP_MAX_MS = 60000;       // a catch-up that hasn't finished by now becomes a jump
  const FROZEN_MS = 12000;            // "playing" but the playhead hasn't moved: the player froze
  const REBASELINE_LOG_GAP_MS = 120000;

  // Performance governor: thresholds sustained for PERF_SUSTAIN_MS change the wall's level.
  const PERF_BUSY_CPU = 85;
  const PERF_OVERLOADED_CPU = 95;
  const PERF_BUSY_MEM = 93;           // past this Windows pages to disk, which stutters video
  const PERF_SUSTAIN_MS = 8000;
  const PERF_SHED_GAP_MS = 30000;
  const PERF_RESTORE_CALM_MS = 60000;
  const REFRESH_DEFER_MS = 120000;    // a busy laptop postpones scheduled refreshes by this...
  const REFRESH_DEFER_MAX_MS = 600000; // ...up to this much in total
  const BACKEND_STALE_MS = 8000;

  const VIDEO_ID = /^[\w-]{11}$/;
  const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const SETTLE_MS = 6000;            // ignore latency samples right after playback (re)starts
  const SAMPLE_WINDOW = 5;           // latency is the median of this many samples
  const EDGE_SEEK_AHEAD_S = 3600;    // seeking past the live edge clamps to it
  const MAX_LAG_S = 90;              // lag above this is never a sane baseline; always jump
  const RESYNC_COOLDOWN_MS = 15000;  // min gap between automatic jumps on one tile
  const RESYNC_ESCALATE = 3;         // this many jumps inside RESYNC_WINDOW_MS -> hard refresh
  const RESYNC_WINDOW_MS = 120000;
  const STUCK_BUFFER_MS = 15000;     // buffering longer than this -> hard refresh
  const READY_TIMEOUT_MS = 30000;    // player never reported ready -> hard refresh
  const PAUSE_RESUME_MS = 5000;      // a monitor wall should never sit paused
  const IDLE_KICK_MS = 5000;         // ready but not playing -> nudge playVideo() once
  const RETRY_MIN_MS = 20000;        // offline / error retry backoff
  const RETRY_MAX_MS = 120000;
  // Everything else keeps retrying: an ended, upcoming or briefly private stream can come back.
  const FATAL_ERRORS = new Set([2]);
  const ERROR_TEXT = {
    2: 'Invalid video ID',
    5: 'Player error',
    100: 'Not found or private',
    101: 'Unavailable or embed blocked',
    150: 'Unavailable or embed blocked',
    153: 'Missing referrer — open via http://localhost',
  };
  // Short codes for the fixed-width status chip; the full text is the chip's tooltip.
  const ERROR_CODE = { 2: 'Bad ID', 5: 'Error', 100: 'Not found', 101: 'Blocked', 150: 'Blocked', 153: 'Referrer' };
  const STUCK_BUFFER_MAX_MS = 120000; // repeated stuck-buffer refreshes back off up to this

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  const store = {
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    saveLocal() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, streams }));
      } catch {
        // storage unavailable: the backend copy (if any) still has it
      }
    },
    // This browser's copy, plus the backend's, which every window and profile shares.
    save() {
      store.saveLocal();
      clearTimeout(store.pushTimer);
      store.pushTimer = setTimeout(pushWall, 400);
    },
  };

  const settings = { ...DEFAULT_SETTINGS };
  const streams = [];
  function applyWall(data) {
    Object.assign(settings, DEFAULT_SETTINGS, data?.settings || {});
    for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
      settings[key] = clamp(Number(settings[key]), lo, hi, DEFAULT_SETTINGS[key]);
    }
    if (!['hd720', 'hd1080'].includes(settings.priorityQuality)) settings.priorityQuality = DEFAULT_SETTINGS.priorityQuality;
    if (!['scroll', 'fit'].includes(settings.layoutMode)) settings.layoutMode = DEFAULT_SETTINGS.layoutMode;
    if (!FEED_QUALITIES.includes(settings.feedQuality)) settings.feedQuality = DEFAULT_SETTINGS.feedQuality;
    if (typeof settings.ytApiKey !== 'string') settings.ytApiKey = '';
    const list = Array.isArray(data?.streams) ? data.streams : [];
    streams.splice(0, streams.length, ...list.filter((s) => s && s.id && s.source?.kind === 'video' && VIDEO_ID.test(s.source.id)));
  }
  applyWall(store.load());

  // ---- The backend's copy of the wall --------------------------------------------
  const clientId = uid();
  let wallVersion = 0;
  let backendWall = false; // the backend answered, so saves go to it

  async function loadServerWall() {
    if (location.protocol === 'file:') return;
    try {
      const res = await fetch('/api/wall', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!res.ok) return;
      const body = await res.json();
      backendWall = true;
      if (body.wall) {
        applyWall(body.wall);
        wallVersion = body.version;
        store.saveLocal();
      } else if (streams.length) {
        await pushWall(); // first run with a backend: move this browser's wall to it
      }
    } catch {
      // backend offline: run from this browser's copy
    }
  }

  async function pushWall() {
    if (!backendWall) return;
    try {
      const res = await fetch('/api/wall', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify({ wall: { settings, streams }, clientId }),
      });
      if (res.ok) wallVersion = (await res.json()).version;
    } catch {
      // kept locally; the next save tries again
    }
  }

  const tiles = new Map(); // stream.id -> Tile
  const events = [];
  const loadQueue = []; // tiles waiting for a load slot, priority feeds first
  const wall = {
    stallLog: [],        // { t, id } for stalls during playback, newest last
    boostCap: Infinity,  // max priority boosts allowed; lowered while the link is congested
    lastCapChangeAt: 0,
    lastCongestedAt: 0,
    congested: false,
    autoJumpsLeft: 0,
  };
  const ytStats = new Map(); // video id -> audience stats from the YouTube Data API (via the backend)
  let ytStatsError = '';
  let ytStatsAt = 0;
  let ytState = null;        // the backend's last YouTube report: status, quota, wall totals
  let ytChecking = false;    // a new key was saved and the backend hasn't answered yet
  let backendYoutube = null; // false: the running backend predates YouTube polling (restart it)
  let viewerSeries = { id: null, series: [] }; // audience history for the inspected feed
  let inspected = null;      // tile whose feed stats sheet is open
  // Backend telemetry (CPU, memory, real network throughput, GPU engines) over SSE.
  const backend = { connected: false, latest: null, at: 0 };
  let cpuPressure = null;    // Compute Pressure API state for this browser: nominal…critical
  let decodeHere = null;     // 'hardware' | 'software' for this window, from MediaCapabilities
  const managedWindow = new URLSearchParams(location.search).get('wall') === 'managed';
  const perf = {
    level: 'ok',             // 'ok' | 'busy' | 'overloaded'
    reason: '',
    hotSince: 0,
    lastHotAt: 0,
    cap: Infinity,           // max priority boosts the laptop can carry right now
    lastCapChangeAt: 0,
  };
  let solo = null;
  let ytReady = false;
  let loopTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $grid = $('#grid');
  const $empty = $('#empty');
  const $readout = {
    playing: $('#r-playing'), latency: $('#r-latency'), load: $('#r-load'), issues: $('#r-issues'),
    bwNow: $('#r-bw-now'), cpu: $('#r-cpu'),
  };
  const $addPanel = $('#add-panel');
  const $addToggle = $('#add-toggle');
  const $liveBadge = $('#live-badge');
  const $form = $('#add-form');
  const $source = $('#source');
  const $label = $('#label');
  const $formError = $('#form-error');
  const $banner = $('#banner');
  const $drawer = $('#drawer');
  const $settingsToggle = $('#settings-toggle');
  const $log = $('#log');
  const $dialog = $('#dialog');
  const $feedSheet = $('#feed-sheet');
  const tileTemplate = $('#tile-template');

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi, fallback) {
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setTone(el, tone) {
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
  }

  // The level YouTube settles on for a player this many CSS pixels wide.
  function qualityForWidth(cssPx) {
    const px = cssPx * (window.devicePixelRatio || 1);
    for (const q of QUALITY_ORDER.slice(rank(EMBED_FLOOR))) if (QUALITY[q].width >= px) return q;
    return QUALITY_ORDER[QUALITY_ORDER.length - 1];
  }

  // Seconds as a clock reading: 1:23:45, or 4:05 under an hour.
  function fmtClock(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // Time of day for an ISO timestamp, e.g. 07:31 PM.
  const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function fmtCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function parseSource(raw) {
    const s = raw.trim();
    if (VIDEO_ID.test(s)) return { kind: 'video', id: s };
    let url;
    try {
      url = new URL(s.includes('://') ? s : `https://${s}`);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return VIDEO_ID.test(id) ? { kind: 'video', id } : null;
    }
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return { kind: 'video', id: v };
    const [first, second = ''] = url.pathname.split('/').filter(Boolean);
    if (['live', 'embed', 'shorts', 'v'].includes(first) && second !== 'live_stream' && VIDEO_ID.test(second)) {
      return { kind: 'video', id: second };
    }
    return null;
  }

  function embedSrc(source, host) {
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '1',
      mute: '1',
      playsinline: '1',
      controls: '0',
      rel: '0',
      iv_load_policy: '3',
      disablekb: '1',
      origin: location.origin,
    });
    return `${host}/embed/${source.id}?${params}`;
  }

  function logEvent(tile, text, level = 'info') {
    events.unshift({ t: new Date(), id: tile?.stream.id, who: tile ? tile.stream.label : 'Wall', text, level });
    if (events.length > 300) events.length = 300;
    if (tile) tile.lastEvent = { t: Date.now(), text, level };
    renderLog();
  }

  function renderLog() {
    if ($drawer.hidden) return;
    $log.replaceChildren(...logItems(events));
  }

  function logItems(list) {
    return list.map((e) => {
      const li = document.createElement('li');
      li.dataset.level = e.level;
      const time = document.createElement('time');
      time.textContent = e.t.toLocaleTimeString();
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = e.who;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = e.text;
      li.append(time, who, what);
      return li;
    });
  }

  function toggleFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  }

  // Confirmation dialog. Resolves to the input value (when `input` is given), true, or null on cancel.
  function ask({ title, body = '', confirm, variant = 'default', input }) {
    const $title = $dialog.querySelector('#dialog-title');
    const $body = $dialog.querySelector('#dialog-body');
    const $input = $dialog.querySelector('#dialog-input');
    const $confirm = $dialog.querySelector('#dialog-confirm');
    $title.textContent = title;
    $body.textContent = body;
    $confirm.textContent = confirm;
    $confirm.className = `btn${variant === 'default' ? '' : ` btn-${variant}`}`;
    $input.hidden = input == null;
    $input.required = input != null;
    if (input != null) {
      $input.value = input.value || '';
      $input.placeholder = input.placeholder || '';
      $input.setAttribute('aria-label', input.label || title);
    }
    $dialog.returnValue = '';
    $dialog.showModal();
    if (input != null) $input.select();
    else $confirm.focus();
    return new Promise((resolve) => {
      $dialog.addEventListener('close', () => {
        if ($dialog.returnValue !== 'confirm') return resolve(null);
        resolve(input != null ? $input.value.trim() : true);
      }, { once: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Tile: one monitored stream
  // ---------------------------------------------------------------------------
  // One observer for every tile: a tile refits when it changes size (grid re-layout,
  // window resize, fullscreen).
  const tileOf = new WeakMap();
  const tileObserver = new ResizeObserver((entries) => {
    for (const e of entries) tileOf.get(e.target)?.fit();
  });
  // Which tiles are on screen in the scrolling wall: on-screen feeds get the scroll-mode
  // quality; one scrolled away drops back after OFFSCREEN_RELEASE_MS (allocate re-checks then).
  let releaseTimer = 0;
  const viewObserver = new IntersectionObserver((entries) => {
    const now = Date.now();
    for (const e of entries) {
      const t = tileOf.get(e.target);
      if (!t) continue;
      if (t.inView && !e.isIntersecting) t.leftViewAt = now;
      t.inView = e.isIntersecting;
    }
    if (!ytReady) return;
    allocate();
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(allocate, OFFSCREEN_RELEASE_MS + 500);
  }, { root: $grid });
  // Info bar heights, from the stylesheet so CSS and the layout maths can't disagree.
  const rootPx = (name, fallback) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;
  const BAR_FULL_PX = rootPx('--bar-full', 51);
  const BAR_SLIM_PX = rootPx('--bar-slim', 33);
  const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  // Exact below 100,000 so small counts read precisely; 1.2M style above so they fit the panel.
  const fmtCount = (v) => (v == null || v === '' ? '—'
    : Number(v) < 100000 ? Number(v).toLocaleString('en-US') : compactNumber.format(Number(v)));

  class Tile {
    constructor(stream) {
      this.stream = stream;
      this.stats = { stalls: 0, stallMs: 0, resyncs: 0, reloads: 0, catchups: 0, rebaselines: 0, lastStallAt: 0 };
      this.deferredMs = 0;          // scheduled refresh postponed while the laptop is busy
      this.lastRebaselineLogAt = 0;
      this.player = null;
      this.gen = 0;
      this.retryDelay = RETRY_MIN_MS;
      this.nextReloadAt = Infinity;
      this.mounted = false;
      this.queued = false;
      this.boosted = false;
      this.heldReason = '';
      this.stuckStrikes = 0; // survives refreshes so a feed that keeps sticking backs off
      this.addedAt = Date.now();
      this.history = [];     // { t, lag, buf } samples for the feed stats sparklines
      this.ttff = null;      // time to first frame on the latest load, ms
      this.lastError = null; // { code, text, at } — survives refreshes for the stats sheet
      this.lastEvent = null;
      this.focused = false;  // lifted beside the feed sheet with YouTube's stats panel open
      this.gridWidth = 0;    // tile width while in the grid; the render width focus keeps
      this.sideOn = false;   // side panel showing in the spare width beside the video
      this.inView = true;    // on screen (scroll mode); the view observer corrects it on first layout
      this.leftViewAt = 0;
      // Balance feeds across the two embed hosts (one browser process each).
      const onFirst = [...tiles.values()].filter((t) => t.host === HOSTS[0]).length;
      this.host = onFirst <= tiles.size - onFirst ? HOSTS[0] : HOSTS[1];
      this.build();
      this.reset();
    }

    build() {
      this.el = tileTemplate.content.firstElementChild.cloneNode(true);
      this.frame = this.el.querySelector('.frame');
      this.$status = this.el.querySelector('.status');
      this.$statusText = this.el.querySelector('.status-text');
      this.$label = this.el.querySelector('.label');
      this.$resync = this.el.querySelector('[data-act="resync"]');
      this.$prio = this.el.querySelector('[data-act="priority"]');
      this.$prioTag = this.el.querySelector('.prio-tag');
      this.$stat = {};
      this.el.querySelectorAll('[data-stat]').forEach((n) => { this.$stat[n.dataset.stat] = n; });
      this.$label.textContent = this.stream.label;
      this.$sideEl = this.el.querySelector('.side');
      this.$side = {
        status: this.el.querySelector('.side-status'),
        state: this.el.querySelector('.side-state'),
        for: this.el.querySelector('.side-for'),
        detail: this.el.querySelector('.side-detail'),
        tag: this.el.querySelector('.side-yt-tag'),
        note: this.el.querySelector('.side-note'),
      };
      this.$play = {};
      this.el.querySelectorAll('[data-play]').forEach((n) => { this.$play[n.dataset.play] = n; });
      this.$vital = {}; // the Lag and Drift labels, which read Time and Length for a recording
      this.el.querySelectorAll('[data-vital]').forEach((n) => { this.$vital[n.dataset.vital] = n.querySelector('dt'); });
      this.el.querySelectorAll('[data-yt]').forEach((n) => { this.$side[n.dataset.yt] = n; });
      this.$drops = [...this.el.querySelectorAll('.side [data-drop]')]
        .sort((a, b) => a.dataset.drop - b.dataset.drop);
      tileOf.set(this.el, this);
      tileObserver.observe(this.el);
      viewObserver.observe(this.el);
      this.$side.note.addEventListener('click', () => {
        if (!this.$side.note.hasAttribute('data-link')) return;
        setDrawer(true);
        $drawer.querySelector('[data-setting="ytApiKey"]')?.focus();
      });

      this.el.querySelector('.shield').addEventListener('click', () => toggleSolo(this));
      this.el.querySelector('.tile-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'priority') togglePriority(this);
        else if (act === 'resync') this.resync('manual');
        else if (act === 'reload') this.reload('manual', 'info', true);
        else if (act === 'full') toggleFullscreen(this.el);
        else if (act === 'remove') removeTile(this);
      });
      this.el.querySelector('[data-act="stats"]').addEventListener('click', () => {
        if (inspected === this) closeFeedSheet();
        else openFeedSheet(this);
      });
      this.$label.addEventListener('dblclick', async () => {
        const name = await ask({
          title: 'Rename feed',
          body: `Source ${this.stream.source.id}. The label shows on the tile and in the event log.`,
          confirm: 'Save label',
          input: { value: this.stream.label, placeholder: 'e.g. Lobby 4 POV', label: 'Feed label' },
        });
        if (name) this.setLabel(name, false);
      });
    }

    setLabel(label, auto) {
      this.stream.label = label;
      this.stream.autoLabel = auto;
      this.$label.textContent = label;
      this.frame.querySelector('iframe')?.setAttribute('title', label);
      store.save();
    }

    reset() {
      const now = Date.now();
      this.ready = false;
      this.loadedAt = now;
      this.ps = PS.UNSTARTED;
      this.stateSince = now;
      this.playingSince = null;
      this.bufferingSince = null;
      this.countingStall = false;
      this.ignoreStallUntil = 0;
      this.samples = [];
      this.baseline = Infinity;
      this.latency = null;
      this.drift = null;
      this.isLive = null;
      this.kicked = false;
      this.lastResyncAt = 0;
      this.recentResyncs = [];
      this.error = null;
      this.errorAt = 0;
      this.fatal = false;
      this.playedOnce = false;
      this.quality = null;
      this.buffer = null;
      this.dvrWindow = null;
      this.liveFor = null;
      this.catchUp = null;          // { since, from } while playing faster to close drift
      this.preJumpLag = null;       // lag before our last jump, to check the jump helped
      this.lastCurrent = null;      // playhead position, to spot a frozen player
      this.lastAdvanceAt = now;
    }

    mount() {
      const gen = ++this.gen;
      const iframe = document.createElement('iframe');
      iframe.src = embedSrc(this.stream.source, this.host);
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.title = this.stream.label;
      this.frame.replaceChildren(iframe);
      this.mounted = true;
      this.loadedAt = Date.now();
      this.applySize();
      const live = () => gen === this.gen;
      this.player = new YT.Player(iframe, {
        events: {
          onReady: () => live() && this.onReady(),
          onStateChange: (e) => live() && this.onState(e.data),
          onError: (e) => live() && this.onError(e.data),
        },
      });
    }

    unmount() {
      this.gen++;
      try {
        this.player?.destroy();
      } catch {
        // player was half-initialised; the iframe is removed below anyway
      }
      this.player = null;
      this.mounted = false;
      this.frame.replaceChildren();
    }

    // Holding a load slot: started but not yet playing or failed.
    isLoading(now) {
      return this.mounted && !this.playedOnce && !this.error && now - this.loadedAt < LOAD_SLOT_MS;
    }

    naturalQuality() {
      return qualityForWidth(this.focused ? this.gridWidth : this.frame.clientWidth);
    }

    // What a boost raises this feed to: the priority ceiling, or in scroll mode the quality
    // on-screen feeds stream at (whichever is higher for a priority feed).
    boostQuality() {
      if (settings.layoutMode !== 'scroll') return settings.priorityQuality;
      const q = settings.feedQuality;
      return this.stream.priority && rank(settings.priorityQuality) > rank(q) ? settings.priorityQuality : q;
    }

    // Priority feeds always want a boost. In scroll mode so do feeds on screen, and a feed
    // scrolled away keeps its boost for a minute so scrolling past doesn't force refreshes.
    wantsBoost(now = Date.now()) {
      if (this.stream.priority) return true;
      if (settings.layoutMode !== 'scroll') return false;
      return this.inView || now - this.leftViewAt < OFFSCREEN_RELEASE_MS;
    }

    targetQuality(boost = this.boosted) {
      const natural = this.naturalQuality();
      const q = this.boostQuality();
      return boost && rank(q) > rank(natural) ? q : natural;
    }

    // Estimated Mbps this feed is pulling: the level the player reports, else the planned one.
    estMbps() {
      if (!this.mounted || this.error) return 0;
      return QUALITY[this.quality || this.targetQuality()].mbps;
    }

    // A tile wider than its 16:9 video moves the video left and fills the spare width with
    // the side card, which takes over the info bar's stats (the bar slims to the name row).
    // Decided from the tile's own size with the slim bar, so switching the card on never
    // changes the size that decided it.
    fit() {
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      const spare = w - ((h - BAR_SLIM_PX) * 16) / 9;
      const on = settings.showStats && !this.focused && spare >= SIDE_MIN_PX;
      if (on !== this.sideOn) {
        this.sideOn = on;
        this.el.classList.toggle('side-on', on);
        this.render();
      }
      if (on) this.trimSide();
      this.applySize();
    }

    // Every row in the card is one line of fixed height, so whether they all fit depends only
    // on the card's size: hide whole rows, lowest priority first, until nothing is cut off.
    trimSide() {
      const side = this.$sideEl;
      for (const el of this.$drops) el.hidden = false;
      for (const el of this.$drops) {
        if (side.scrollHeight <= side.clientHeight) break;
        el.hidden = true;
      }
    }

    // YouTube sizes quality to the player's render size, so the render width is the lever:
    // a boosted player renders at its target resolution and is scaled down into the tile;
    // a focused (inspected) player keeps its grid render width and is scaled up, so
    // enlarging it to read YouTube's stats panel doesn't pull a higher bitrate.
    applySize() {
      const iframe = this.frame.firstElementChild;
      const w = this.frame.clientWidth;
      const h = this.frame.clientHeight;
      if (!this.focused) this.gridWidth = w;
      if (!iframe) return;
      let renderW = this.boosted ? QUALITY[this.boostQuality()].width / (window.devicePixelRatio || 1) : 0;
      if (this.focused) renderW = Math.max(renderW, this.gridWidth, NERDS_MIN_RENDER_PX);
      else if (renderW <= w) renderW = 0;
      if (!w || !h || !renderW || Math.abs(renderW - w) < 1) {
        iframe.style.width = iframe.style.height = iframe.style.transform = '';
        return;
      }
      const scale = w / renderW;
      iframe.style.width = `${renderW}px`;
      iframe.style.height = `${h / scale}px`;
      iframe.style.transform = `scale(${scale})`;
    }

    setBoost(on, heldReason = '') {
      this.heldReason = on ? '' : heldReason;
      if (on === this.boosted) return;
      this.boosted = on;
      this.applySize();
      if (on) {
        // On-screen boosts in scroll mode come and go with scrolling; only log priority ones.
        if (this.mounted && this.stream.priority) logEvent(this, `Priority boost on (up to ${QUALITY[this.boostQuality()].label})`);
        return;
      }
      // Players don't step down when shrunk, so releasing bandwidth takes a refresh.
      if (this.mounted && this.quality && rank(this.quality) > rank(this.naturalQuality())) {
        this.reload(`releasing bandwidth${heldReason ? `: ${heldReason}` : ''}`);
      }
    }

    scheduleReload(offsetMs) {
      const ms = settings.hardReloadMin * 60000;
      this.nextReloadAt = ms > 0 ? Date.now() + (offsetMs ?? ms) : Infinity;
    }

    onReady() {
      this.ready = true;
      const p = this.player;
      if (solo === this) {
        p.unMute();
        p.setVolume(100);
      } else {
        p.mute();
      }
      p.playVideo();
      const title = p.getVideoData?.()?.title;
      if (title && this.stream.autoLabel) this.setLabel(title, true);
      if (this.focused) p.showVideoInfo?.(); // a refresh closes YouTube's stats panel; reopen it
      this.hideCaptions();
      this.render();
    }

    // Muted embeds switch auto-captions on, and they sit over the game HUD. The captions
    // module loads with playback, so this runs on ready and again once playing.
    hideCaptions() {
      try {
        this.player?.unloadModule?.('captions');
        this.player?.unloadModule?.('cc');
      } catch {
        // not proxied on this player build; captions stay as YouTube set them
      }
    }

    // Buffer health and live-edge state from the player's progress report. Undocumented
    // (playerInfo.progressState), so every field is checked before use.
    readProgress() {
      const ps = this.player?.playerInfo?.progressState;
      if (!ps || !Number.isFinite(ps.loaded) || !Number.isFinite(ps.current)) return;
      // On long-running streams `loaded` is counted from `offset` while `current` is absolute.
      let ahead = ps.loaded - ps.current;
      if (ahead < 0 && Number.isFinite(ps.offset)) ahead = ps.loaded + ps.offset - ps.current;
      this.buffer = ahead >= 0 && ahead < 600 ? ahead : null;
      this.dvrWindow = Number.isFinite(ps.seekableEnd) && Number.isFinite(ps.seekableStart)
        ? ps.seekableEnd - ps.seekableStart : null;
      this.liveFor = Number.isFinite(ps.duration) ? ps.duration : null;
      if (ps.current !== this.lastCurrent) {
        this.lastCurrent = ps.current;
        this.lastAdvanceAt = Date.now();
      }
    }

    // ---- Catching up without visible jumps -------------------------------------------
    // The edge itself moved (a jump didn't get any closer): accept the current lag as the
    // new reference instead of jumping again.
    rebaseline(reason) {
      this.baseline = this.latency;
      this.drift = 0;
      this.stats.rebaselines++;
      const now = Date.now();
      if (now - this.lastRebaselineLogAt > REBASELINE_LOG_GAP_MS) {
        this.lastRebaselineLogAt = now;
        logEvent(this, `Live edge moved, holding at ${this.latency.toFixed(1)}s lag (${reason})`);
      }
    }

    startCatchUp(now) {
      this.catchUp = { since: now, from: this.drift };
      this.lastResyncAt = now;
      this.stats.catchups++;
      try {
        this.player.setPlaybackRate(CATCHUP_RATE);
      } catch {
        this.catchUp = null;
        return false;
      }
      logEvent(this, `Catching up +${this.drift.toFixed(1)}s at ${CATCHUP_RATE}× (no jump)`);
      return true;
    }

    endCatchUp(note) {
      if (!this.catchUp) return;
      const took = Math.round((Date.now() - this.catchUp.since) / 1000);
      this.catchUp = null;
      try {
        this.player?.setPlaybackRate(1);
      } catch {
        // player is gone; a new one starts at normal speed
      }
      if (note) logEvent(this, `${note} after ${took}s`);
    }

    onState(s) {
      const now = Date.now();
      const prev = this.ps;
      if (prev === PS.BUFFERING && this.bufferingSince) {
        if (this.countingStall) {
          this.stats.stallMs += now - this.bufferingSince;
          this.stats.lastStallAt = now; // the red flag holds for STALL_FLAG_MS from here
        }
        this.bufferingSince = null;
        this.countingStall = false;
      }
      if (s === PS.BUFFERING) {
        // Playing faster ran into the end of what's downloaded: that's the edge for now.
        if (this.catchUp) this.endCatchUp('Caught up to the buffered edge');
        this.bufferingSince = now;
        // Only a stall *during* playback counts; initial load and our own jumps don't.
        this.countingStall = prev === PS.PLAYING && now > this.ignoreStallUntil;
        if (this.countingStall) {
          this.stats.stalls++;
          this.stats.lastStallAt = now;
          wall.stallLog.push({ t: now, id: this.stream.id });
        }
      }
      if (s === PS.PLAYING && prev !== PS.PLAYING) {
        this.playingSince = now;
        this.samples = [];
        this.retryDelay = RETRY_MIN_MS;
        this.error = null;
        if (!this.playedOnce) {
          this.playedOnce = true;
          this.ttff = now - this.loadedAt;
          setTimeout(pumpQueue, 0); // free the load slot for the next feed
        }
        this.hideCaptions();
      }
      this.ps = s;
      this.stateSince = now;
      this.render();
    }

    onError(code) {
      this.error = code;
      this.errorAt = Date.now();
      this.fatal = FATAL_ERRORS.has(code);
      this.lastError = { code, text: ERROR_TEXT[code] || 'Player error', at: this.errorAt };
      logEvent(this, `${ERROR_TEXT[code] || 'Player error'} (code ${code})`, 'bad');
      setTimeout(pumpQueue, 0);
      this.render();
    }

    tick(now) {
      if (this.fatal || this.queued || !this.mounted) return this.render();
      if (now >= this.nextReloadAt) {
        // A reload is a CPU and network spike; on a busy laptop, wait for it to settle.
        if (perf.level !== 'ok' && this.deferredMs < REFRESH_DEFER_MAX_MS) {
          this.nextReloadAt = now + REFRESH_DEFER_MS;
          this.deferredMs += REFRESH_DEFER_MS;
          logEvent(this, `Scheduled refresh postponed 2 min: laptop ${perf.level}`);
        } else {
          return this.reload('scheduled refresh');
        }
      }
      if (!this.ready) {
        if (now - this.loadedAt > READY_TIMEOUT_MS) this.reload('player did not respond');
        return this.render();
      }

      const s = this.ps;
      const stuckLimit = Math.min(STUCK_BUFFER_MS * 2 ** this.stuckStrikes, STUCK_BUFFER_MAX_MS);
      if (s === PS.BUFFERING && now - this.bufferingSince > stuckLimit) {
        this.stuckStrikes++;
        return this.reload(`stuck buffering for ${Math.round((now - this.bufferingSince) / 1000)}s`, 'bad');
      }
      if (s === PS.PLAYING && now - this.playingSince > 60000) this.stuckStrikes = 0;
      if (s === PS.PAUSED && now - this.stateSince > PAUSE_RESUME_MS) this.player.playVideo();

      const idle = s === PS.UNSTARTED || s === PS.CUED || s === PS.ENDED;
      if (idle && !this.error && !this.kicked && now - this.stateSince > IDLE_KICK_MS) {
        this.kicked = true; // autoplay sometimes doesn't take when several players load at once
        this.player.playVideo();
      }
      const since = this.error ? this.errorAt : this.stateSince;
      if ((this.error || idle) && now - since > this.retryDelay) {
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
        return this.reload(this.error ? `retry after error ${this.error}` : 'not playing, retrying');
      }

      this.readProgress();
      // A crashed or hung player keeps reporting "playing" while its picture stands still.
      if (s === PS.PLAYING && !document.hidden && this.lastCurrent != null
        && now - this.lastAdvanceAt > FROZEN_MS && now - this.playingSince > FROZEN_MS) {
        return this.reload(`picture froze for ${Math.round((now - this.lastAdvanceAt) / 1000)}s`, 'warn');
      }
      if (s === PS.PLAYING) {
        const q = this.player.getPlaybackQuality?.();
        if (q in QUALITY) this.quality = q;
        this.measure(now);
      }
      this.history.push({ t: now, lag: this.latency, buf: s === PS.PLAYING || s === PS.BUFFERING ? this.buffer : null });
      while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift();
      this.render();
    }

    // Wall-clock time (epoch seconds) of the frame on screen. Undocumented but present on
    // live streams; getDuration() is frozen on live, so it can't be used for lag.
    mediaTime() {
      const t = this.player.getMediaReferenceTime?.();
      return Number.isFinite(t) && t > 1e9 ? t : null;
    }

    measure(now) {
      const mediaTime = this.mediaTime();
      if (this.isLive === null) {
        const data = this.player.getVideoData?.();
        this.isLive = typeof data?.isLive === 'boolean' ? data.isLive : mediaTime != null;
      }
      if (!this.isLive || mediaTime == null) {
        this.latency = null;
        this.drift = null;
        return;
      }
      if (now - this.playingSince < SETTLE_MS) return;

      this.samples.push(now / 1000 - mediaTime);
      if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
      this.latency = median(this.samples);
      // A player that comes back far behind (or a bogus reading) must not become the
      // baseline, or drift reads 0 and the tile is never pulled back to live.
      const sane = this.latency <= MAX_LAG_S;
      // A jump that didn't get closer means the edge moved; don't keep jumping at it.
      if (this.preJumpLag != null && this.samples.length >= 3) {
        if (sane && this.latency > this.preJumpLag - 1) {
          this.recentResyncs.pop();
          this.rebaseline(`a jump only reached ${this.latency.toFixed(1)}s`);
        }
        this.preJumpLag = null;
      }
      if (this.samples.length >= 3 && sane) this.baseline = Math.min(this.baseline, this.latency);
      this.drift = Number.isFinite(this.baseline) ? this.latency - this.baseline : null;

      if (this.catchUp) {
        if (this.drift != null && this.drift < 1) this.endCatchUp('Caught up smoothly');
        else if (now - this.catchUp.since > CATCHUP_MAX_MS) {
          this.endCatchUp('Catch-up too slow, jumping');
          this.resync(this.lagText());
        }
        return;
      }

      const behind = !sane || (this.drift != null && this.drift > settings.driftThresholdSec);
      if (!behind) return;
      // Not trusting the player's isAtLiveHead here: it still reads true 8s behind the edge.
      if (!settings.autoResync || now - this.lastResyncAt < RESYNC_COOLDOWN_MS) return;
      if (wall.autoJumpsLeft <= 0) return; // another feed took this tick's slot; try next tick
      wall.autoJumpsLeft--;

      const rates = this.player.getAvailablePlaybackRates?.() || [];
      if (sane && this.drift <= CATCHUP_MAX_DRIFT_S && rates.includes(CATCHUP_RATE) && this.startCatchUp(now)) return;

      this.recentResyncs = this.recentResyncs.filter((t) => now - t < RESYNC_WINDOW_MS);
      if (this.recentResyncs.length >= RESYNC_ESCALATE) {
        this.reload(`still ${this.lagText()} after ${this.recentResyncs.length} jumps`, 'warn');
      } else {
        this.resync(this.lagText());
      }
    }

    lagText() {
      return this.drift != null && this.latency <= MAX_LAG_S
        ? `+${this.drift.toFixed(1)}s behind`
        : `${Math.round(this.latency)}s behind real time`;
    }

    resync(reason) {
      if (!this.player || !this.ready || this.error || this.isLive === false) return;
      const now = Date.now();
      if (this.catchUp) this.endCatchUp();
      this.preJumpLag = this.latency;
      this.ignoreStallUntil = now + 8000;
      this.player.seekTo(this.player.getCurrentTime() + EDGE_SEEK_AHEAD_S, true);
      this.lastResyncAt = now;
      this.recentResyncs.push(now);
      this.samples = [];
      this.playingSince = now;
      this.stats.resyncs++;
      logEvent(this, `Jumped to live edge (${reason})`);
      this.pulse('resync');
      this.render();
    }

    reload(reason, level = 'info', front = false) {
      this.stats.reloads++;
      this.deferredMs = 0;
      logEvent(this, `Refreshed player (${reason})`, level);
      this.unmount();
      this.reset();
      requestMount(this, front);
      this.scheduleReload();
      this.pulse(level === 'bad' ? 'alarm' : 'reload');
      this.render();
    }

    pulse(kind) {
      const cls = `pulse-${kind}`;
      this.el.classList.remove('pulse-resync', 'pulse-reload', 'pulse-alarm');
      void this.el.offsetWidth; // restart the animation
      this.el.classList.add(cls);
      clearTimeout(this.pulseTimer);
      this.pulseTimer = setTimeout(() => this.el.classList.remove(cls), 900);
    }

    // [chip code, tone, full description]
    status() {
      if (this.error) {
        return [ERROR_CODE[this.error] || 'Error', 'bad', `${ERROR_TEXT[this.error] || 'Player error'} (code ${this.error})`];
      }
      if (this.queued) return [`Queued ${loadQueue.indexOf(this) + 1}`, 'idle', 'Waiting for a load slot'];
      if (!this.ready) return ['Loading', 'idle', 'Player is starting'];
      // YouTube's own word on the broadcast (Data API) sharpens what the player alone can say.
      const yt = this.ytInfo();
      const ended = yt?.endedAt ? `Broadcast ended at ${clockTime(yt.endedAt)}` : '';
      switch (this.ps) {
        case PS.PLAYING:
          if (this.catchUp) return ['Catch-up', 'ok', `Playing at ${CATCHUP_RATE}× to close +${(this.catchUp.from || 0).toFixed(1)}s of drift`];
          if (this.isLive) return ['Live', 'ok', 'Playing live'];
          if (ended) return ['Ended', 'warn', `${ended} · playing the recording`];
          return ['Playing', 'ok', yt?.startedAt ? 'Playing the recording of a broadcast' : 'Playing a video, not a live stream'];
        // A live broadcast that isn't moving is a red flag, never amber.
        case PS.BUFFERING: return ['Buffering', 'bad', 'Buffering: the picture has stopped'];
        case PS.PAUSED: return ['Paused', 'warn', 'Paused — resuming automatically'];
        case PS.ENDED: return ended ? ['Ended', 'warn', `${ended} · retrying in case it restarts`] : ['Ended', 'idle', 'Stream ended — retrying in case it restarts'];
        default:
          if (yt?.broadcast === 'upcoming') return ['Scheduled', 'idle', yt.scheduledAt ? `Scheduled to start at ${clockTime(yt.scheduledAt)}` : 'Scheduled, not live yet'];
          return ['Waiting', 'idle', 'Waiting for the stream to start'];
      }
    }

    // What the YouTube Data API reports for this video, when there's a key and an answer.
    ytInfo() {
      if (!settings.ytApiKey.trim()) return null;
      const yt = ytStats.get(this.stream.source.id);
      return yt && !yt.missing ? yt : null;
    }

    // A recording (not live): where the playhead is and how long it runs, in place of lag and drift.
    playhead() {
      if (this.isLive !== false || !this.ready || !this.player) return null;
      try {
        return { at: this.player.getCurrentTime(), length: this.player.getDuration() || this.ytInfo()?.lengthSec || null };
      } catch {
        return null;
      }
    }

    render() {
      const now = Date.now();
      const [text, tone, detail] = this.status();
      setText(this.$statusText, text);
      this.$status.dataset.tone = tone;
      this.$status.title = detail;
      this.el.classList.toggle('alarm', tone === 'bad');
      this.el.classList.toggle('solo', solo === this);
      this.$resync.hidden = this.isLive === false;

      const prio = !!this.stream.priority;
      this.el.classList.toggle('priority', prio);
      this.el.classList.toggle('held', prio && !this.boosted);
      this.$prio.setAttribute('aria-pressed', String(prio));
      setText(this.$prioTag, prio && !this.boosted ? 'Priority · held' : 'Priority');
      this.$prioTag.title = prio && !this.boosted
        ? `Boost held: ${this.heldReason || 'waiting'}`
        : `Loads first · streams up to ${QUALITY[settings.priorityQuality].label}`;

      this.el.classList.toggle('inspected', inspected === this);
      if (this.sideOn) {
        this.renderSide(now);
        return;
      }
      // Info bar: every tile shows the same readings in the same order; '—' where one doesn't apply.
      const r = this.readings(now);
      const rec = this.isLive === false;
      const labels = { latency: rec ? 'TIME' : 'LAG', buffer: 'BUF', drift: rec ? 'LENGTH' : 'DRIFT', quality: 'Q', stalls: 'STALLS', jumps: 'JUMPS', reloads: 'REFRESHES', refresh: 'NEXT REFRESH' };
      for (const [key, [value, tone]] of Object.entries(r)) {
        setText(this.$stat[key], `${labels[key]} ${key === 'refresh' ? value.toUpperCase() : value}`);
        setTone(this.$stat[key], tone);
      }
    }

    // Stalling now, or stalled within the last minute.
    stallFlagged(now) {
      return (this.countingStall && !!this.bufferingSince)
        || (this.stats.lastStallAt > 0 && now - this.stats.lastStallAt < STALL_FLAG_MS);
    }

    // The measured readings shown in the info bar or the side card: [text, tone] each.
    readings(now) {
      const buf = this.ready && (this.ps === PS.PLAYING || this.ps === PS.BUFFERING) ? this.buffer : null;
      const d = this.drift == null ? null : Math.max(0, this.drift);
      const t = settings.driftThresholdSec;
      const ongoing = this.countingStall && this.bufferingSince ? now - this.bufferingSince : 0;
      const ph = this.playhead();
      return {
        latency: ph ? [fmtClock(ph.at), ''] : [this.latency == null ? '—' : `${this.latency.toFixed(1)}s`, ''],
        // A thin buffer on a live broadcast is about to stall: red, not amber.
        buffer: [buf == null ? '—' : `${buf.toFixed(1)}s`, buf != null && buf < BUFFER_LOW_S ? 'bad' : ''],
        drift: ph ? [fmtClock(ph.length), ''] : [d == null ? '—' : `+${d.toFixed(1)}s`, d == null ? '' : d < t / 2 ? 'ok' : d < t ? 'warn' : 'bad'],
        quality: [this.quality ? QUALITY[this.quality].label : '—', ''],
        stalls: [`${this.stats.stalls} · ${((this.stats.stallMs + ongoing) / 1000).toFixed(1)}s`, this.stallFlagged(now) ? 'bad' : ''],
        jumps: [String(this.stats.resyncs), ''],
        reloads: [String(this.stats.reloads), ''],
        refresh: [Number.isFinite(this.nextReloadAt) ? fmtCountdown(this.nextReloadAt - now) : 'Off', ''],
      };
    }

    // Side card: the status in large type with how long it has lasted and what it means,
    // the measured readings, then the audience numbers YouTube reports (Data API key needed).
    renderSide(now) {
      if (!this.sideOn) return;
      const p = this.$side;
      const [text, tone, detail] = this.status();
      setText(p.state, text);
      p.status.dataset.tone = tone;
      p.status.title = detail;
      const since = this.error ? this.errorAt : this.catchUp ? this.catchUp.since : this.stateSince;
      setText(p.for, this.queued ? '' : fmtDuration(now - since));
      setText(p.detail, detail);
      p.detail.title = detail;

      // Live: lag and drift. A recording: where the playhead is and how long it runs.
      const rec = this.playhead() != null;
      setText(this.$vital.latency, rec ? 'Time' : 'Lag');
      setText(this.$vital.drift, rec ? 'Length' : 'Drift');
      for (const [key, [value, valueTone]] of Object.entries(this.readings(now))) {
        setText(this.$play[key], value);
        setTone(this.$play[key], valueTone);
      }

      // YouTube: every block shows a number, or says plainly why there isn't one.
      const hasKey = !!settings.ytApiKey.trim();
      const entry = hasKey ? ytStats.get(this.stream.source.id) : null;
      const yt = entry && !entry.missing ? entry : null;
      const ended = !!yt?.endedAt;
      const upcoming = yt?.broadcast === 'upcoming';
      const liveNow = yt?.broadcast === 'live';
      const a = yt?.analysis || {};
      setText(p.tag, yt ? 'Measured' : 'N·A');

      let viewers = '—';
      let word = '';
      if (yt?.viewers != null) viewers = fmtCount(yt.viewers);
      else if (ended) word = 'Ended';
      else if (upcoming) word = 'Not live yet';
      else if (liveNow) word = 'Hidden or 0';
      else if (yt) word = 'Not live';
      setText(p.viewers, word || viewers);
      if (word) p.viewers.dataset.kind = 'word';
      else delete p.viewers.dataset.kind;
      p.viewers.title = yt?.viewers != null ? `${fmtInt(yt.viewers)} watching now`
        : liveNow ? 'YouTube leaves the count out when nobody else is watching or the channel hides it'
          : word ? `No live viewers: ${word.toLowerCase()}` : 'Not reported';
      setText(p.viewersProv, yt ? (yt.viewers != null ? 'Measured' : 'N·A') : '');
      // Delta: the sign colours itself (up ok, down danger), as the SKWAD metric does.
      const pct = yt?.viewers != null ? a.trendPct : null;
      setText(p.trend, pct == null ? '' : `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%`);
      setTone(p.trend, pct > 0 ? 'ok' : pct < 0 ? 'bad' : '');
      p.trend.title = pct == null ? '' : `Change in viewers over the last ${a.trendMins} min`;

      setText(p.peak, fmtCount(a.peak));
      p.peak.title = a.peak != null ? `Peak ${fmtInt(a.peak)} at ${clockTime(a.peakAt)}, since tracking began` : 'No viewer counts recorded yet';
      // No viewer counts behind it (an ended or hidden-count stream): Peak gives up its space.
      const peakCell = p.peak.closest('.m');
      if (peakCell.hasAttribute('data-empty') !== (a.peak == null)) {
        peakCell.toggleAttribute('data-empty', a.peak == null);
        this.trimSide();
      }
      setText(p.likes, yt?.likes != null ? fmtCount(yt.likes) : yt ? 'Hidden' : '—');
      p.likes.title = yt?.likes != null ? fmtInt(yt.likes) : 'The channel hides likes';
      setText(p.views, yt?.views != null ? fmtCount(yt.views) : '—');
      p.views.title = yt?.views != null ? fmtInt(yt.views) : 'Not reported';
      const start = yt?.startedAt ? Date.parse(yt.startedAt) : NaN;
      setText(p.uptimeLabel, ended ? 'Ran for' : upcoming ? 'Starts' : 'Live for');
      setText(p.uptime, upcoming && yt.scheduledAt ? clockTime(yt.scheduledAt)
        : Number.isFinite(start) ? fmtDuration((ended ? Date.parse(yt.endedAt) : now) - start) : '—');
      setText(p.comments, yt?.comments != null ? fmtCount(yt.comments) : yt ? 'Off' : '—');
      setText(p.subscribers, yt?.subscribers != null ? fmtCount(yt.subscribers) : yt ? 'Hidden' : '—');
      const access = yt ? [
        yt.privacy ? yt.privacy[0].toUpperCase() + yt.privacy.slice(1) : null,
        yt.embeddable === false ? 'No embed' : yt.embeddable ? 'Embed ok' : null,
        yt.definition ? yt.definition.toUpperCase() : null,
      ].filter(Boolean).join(' · ') : '';
      setText(p.access, access || '—');
      // Embedding off or a private video: this wall can't show it. That's an outage, so red.
      setTone(p.access, yt && (yt.embeddable === false || yt.privacy === 'private') ? 'bad' : '');

      let note = '';
      let noteTone = '';
      if (!hasKey) note = 'Add a YouTube API key in Settings for viewers and likes';
      else if (ytStatsError) [note, noteTone] = ['YouTube API error: see Settings', 'bad'];
      else if (!entry) note = 'Waiting for YouTube…';
      else if (entry.missing) [note, noteTone] = ['YouTube has no public video with this ID', 'bad'];
      else if (ended) [note, noteTone] = [`Broadcast ended at ${clockTime(yt.endedAt)}`, 'warn'];
      else if (upcoming) note = yt.scheduledAt ? `Scheduled for ${new Date(yt.scheduledAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'Scheduled, not live yet';
      else note = `Updated ${fmtDuration(now - ytStatsAt)} ago · every ${settings.ytPollSec} s`;
      setText(p.note, note);
      p.note.title = ytStatsError || '';
      p.note.toggleAttribute('data-link', !hasKey);
      if (noteTone) p.note.dataset.tone = noteTone;
      else delete p.note.dataset.tone;
    }  }

  // ---------------------------------------------------------------------------
  // Wall
  // ---------------------------------------------------------------------------
  function addTile(stream) {
    const tile = new Tile(stream);
    tiles.set(stream.id, tile);
    $grid.append(tile.el);
    updateLayout();
    if (ytReady) {
      allocate();
      requestMount(tile);
      tile.scheduleReload();
    }
    tile.render();
    return tile;
  }

  // ---------------------------------------------------------------------------
  // Loading: feeds start a few at a time, priority first, so startup and refresh
  // bursts never ask the link for 20–30 initial buffers at once.
  // ---------------------------------------------------------------------------
  function requestMount(tile, front = false) {
    if (!ytReady) return; // boot queues everything once the API is ready
    const at = loadQueue.indexOf(tile);
    if (at >= 0) loadQueue.splice(at, 1);
    tile.queued = true;
    if (front) {
      loadQueue.unshift(tile);
    } else {
      const firstStandard = tile.stream.priority ? loadQueue.findIndex((t) => !t.stream.priority) : -1;
      if (firstStandard < 0) loadQueue.push(tile);
      else loadQueue.splice(firstStandard, 0, tile);
    }
    pumpQueue();
  }

  function pumpQueue() {
    const now = Date.now();
    let loading = 0;
    for (const t of tiles.values()) if (t.isLoading(now)) loading++;
    // Starting a player is the heaviest moment for CPU; a busy laptop starts one at a time.
    const limit = perf.level === 'ok' ? settings.loadConcurrency : 1;
    while (loading < limit && loadQueue.length) {
      const t = loadQueue.shift();
      t.queued = false;
      if (!tiles.has(t.stream.id)) continue;
      t.mount();
      loading++;
    }
    for (const t of loadQueue) t.render(); // queue positions moved
  }

  // ---------------------------------------------------------------------------
  // Bandwidth: standard feeds sit at the embed floor. Boosts go to priority feeds and, in
  // scroll mode, to the feeds on screen: priority first, then wall order, while the
  // estimate fits the stated bandwidth, the link is calm and the laptop keeps up.
  // ---------------------------------------------------------------------------
  function allocate() {
    const now = Date.now();
    const list = [...tiles.values()];
    const wanting = list.filter((t) => t.wantsBoost(now));
    wanting.sort((a, b) => Number(!!b.stream.priority) - Number(!!a.stream.priority));
    const budget = settings.bandwidthMbps * BUDGET_HEADROOM;
    let planned = 0;
    for (const t of list) if (!wanting.includes(t)) planned += QUALITY[t.targetQuality(false)].mbps;
    let granted = 0;
    for (const t of wanting) {
      const boosted = QUALITY[t.targetQuality(true)].mbps;
      const base = QUALITY[t.targetQuality(false)].mbps;
      let held = '';
      if (granted >= perf.cap) held = `laptop ${perf.level === 'ok' ? 'recovering' : perf.level}, boost shed`;
      else if (granted >= wall.boostCap) held = 'link congested, boost shed';
      else if (budget && planned + boosted > budget) held = `would exceed 80% of ${settings.bandwidthMbps} Mbps`;
      if (held) {
        planned += base;
      } else {
        planned += boosted;
        granted++;
      }
      t.setBoost(!held, held);
    }
    for (const t of list) {
      if (t.boosted && !wanting.includes(t)) t.setBoost(false, settings.layoutMode === 'scroll' ? 'scrolled out of view' : 'priority removed');
    }
  }

  // Several feeds stalling inside a minute points at our link rather than one source.
  // Shed one priority boost at a time while that lasts; restore one after 5 calm minutes.
  function updateCongestion(now) {
    wall.stallLog = wall.stallLog.filter((e) => now - e.t < CONGESTION_WINDOW_MS);
    const stalledFeeds = new Set(wall.stallLog.map((e) => e.id)).size;
    const congested = stalledFeeds >= Math.max(CONGESTION_MIN_FEEDS, Math.ceil(tiles.size * 0.2));
    const boosted = [...tiles.values()].filter((t) => t.boosted).length;
    if (congested) {
      if (!wall.congested) logEvent(null, `Link congested: ${stalledFeeds} feeds stalled within a minute`, 'bad');
      wall.lastCongestedAt = now;
      if (boosted > 0 && now - wall.lastCapChangeAt > SHED_GAP_MS) {
        wall.boostCap = boosted - 1;
        wall.lastCapChangeAt = now;
        logEvent(null, `Shed one priority boost to free bandwidth (${wall.boostCap} kept)`, 'warn');
      }
    } else if (Number.isFinite(wall.boostCap)
      && now - wall.lastCongestedAt > RESTORE_CALM_MS && now - wall.lastCapChangeAt > RESTORE_CALM_MS) {
      const wanting = [...tiles.values()].filter((t) => t.wantsBoost(now)).length;
      wall.boostCap = wall.boostCap + 1 >= wanting ? Infinity : wall.boostCap + 1;
      wall.lastCapChangeAt = now;
      logEvent(null, 'Link calm for 5 min: restoring one priority boost');
    }
    wall.congested = congested;
  }

  // ---------------------------------------------------------------------------
  // Feed stats sheet: everything we measure plus what YouTube reports for one feed
  // ---------------------------------------------------------------------------
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  const fmtInt = (v) => (v == null || v === '' ? null : Number(v).toLocaleString('en-US'));

  function openFeedSheet(tile) {
    if (!$drawer.hidden) setDrawer(false);
    if (inspected && inspected !== tile && inspected.focused) setFocus(inspected, false);
    const prev = inspected;
    inspected = tile;
    $feedSheet.hidden = false;
    prev?.render();
    tile.render();
    renderFeedSheet();
    if (settings.ytApiKey.trim()) loadViewerHistory(tile);
  }

  function closeFeedSheet() {
    const tile = inspected;
    if (!tile) return;
    if (tile.focused) setFocus(tile, false);
    inspected = null;
    $feedSheet.hidden = true;
    tile.render();
  }

  // Lift the player beside the sheet and open YouTube's own stats panel inside it.
  function setFocus(tile, on) {
    tile.focused = on;
    tile.el.classList.toggle('focused', on);
    tile.fit();
    try {
      if (tile.ready && tile.player) {
        if (on) tile.player.showVideoInfo();
        else tile.player.hideVideoInfo();
      }
    } catch {
      // older player builds may not proxy these; the sheet still works
    }
    if (inspected === tile) renderFeedSheet();
  }

  function fillKv(dl, rows) {
    dl.replaceChildren(...rows.flatMap(([key, value, tone, tag]) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value ?? '—';
      if (tone) dd.dataset.tone = tone;
      if (tag) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = tag;
        dd.append(t);
      }
      return [dt, dd];
    }));
  }

  // Sparkline over the last `span` ms; gaps where the value was unknown. `fit` scales the
  // y axis to the data's own range (audience swings are small next to the total).
  function drawSpark(svg, samples, { ceil = 0, threshold, span = HISTORY_MS, fit = false, label = (v) => `${v.toFixed(1)}s` } = {}) {
    const W = 300;
    const H = 44;
    const now = Date.now();
    const known = samples.filter((p) => p.v != null);
    const max = Math.max(ceil, ...known.map((p) => p.v)) || 1;
    const min = fit && known.length ? Math.min(...known.map((p) => p.v)) : 0;
    const range = max - min || 1;
    const x = (t) => (W - ((now - t) / span) * W).toFixed(1);
    const y = (v) => (H - 3 - ((Math.min(v, max) - min) / range) * (H - 6)).toFixed(1);
    const NS = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const parts = [];
    let run = [];
    for (const p of [...samples, { v: null }]) {
      if (p.v != null) run.push(p);
      else if (run.length) {
        parts.push(run);
        run = [];
      }
    }
    const nodes = [];
    if (threshold != null && threshold < max) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'threshold');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', String(W));
      line.setAttribute('y1', y(threshold));
      line.setAttribute('y2', y(threshold));
      nodes.push(line);
    }
    for (const seg of parts) {
      const pts = seg.map((p) => `${x(p.t)},${y(p.v)}`);
      const area = document.createElementNS(NS, 'path');
      area.setAttribute('class', 'area');
      area.setAttribute('d', `M${x(seg[0].t)},${H} L${pts.join(' L')} L${x(seg[seg.length - 1].t)},${H} Z`);
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('class', 'line');
      line.setAttribute('points', pts.join(' '));
      nodes.push(area, line);
    }
    svg.replaceChildren(...nodes);
    if (!known.length) return '';
    const vals = known.map((p) => p.v);
    return `min ${label(Math.min(...vals))} · max ${label(Math.max(...vals))}`;
  }

  function renderFeedSheet() {
    const t = inspected;
    if (!t || $feedSheet.hidden) return;
    const now = Date.now();
    const data = (t.ready && t.player?.getVideoData?.()) || {};
    const [, tone, detail] = t.status();
    const host = new URL(t.host).hostname.replace(/^www\./, '');

    setText($('#fs-eyebrow'), `Feed stats · ${host}`);
    setText($('#fs-label'), t.stream.label);
    setText($('#fs-sub'), [data.title, data.author].filter(Boolean).join(' · ') || t.stream.source.id);
    $('#fs-open').href = `https://www.youtube.com/watch?v=${t.stream.source.id}`;
    const $nerds = $('#fs-nerds');
    $nerds.setAttribute('aria-pressed', String(t.focused));
    setText($nerds, t.focused ? 'Hide YouTube stats' : 'Show YouTube stats');

    const buf = t.ready && (t.ps === PS.PLAYING || t.ps === PS.BUFFERING) ? t.buffer : null;
    const ongoing = t.countingStall && t.bufferingSince ? now - t.bufferingSince : 0;
    const hoursOnWall = (now - t.addedAt) / 3600000;
    const t2 = settings.driftThresholdSec;
    fillKv($('#fs-health'), [
      ['Status', detail, tone === 'idle' ? '' : tone],
      ['Lag behind real time', t.latency == null ? null : `${t.latency.toFixed(1)}s`],
      ['Buffer health', buf == null ? null : `${buf.toFixed(1)}s ahead`,
        buf == null ? '' : buf < BUFFER_LOW_S ? 'bad' : 'ok'],
      ['Drift from best lag', t.drift == null ? null : `+${Math.max(0, t.drift).toFixed(1)}s (best ${t.baseline.toFixed(1)}s)`,
        t.drift == null ? '' : t.drift < t2 / 2 ? '' : t.drift < t2 ? 'warn' : 'bad'],
      ['Stalls', `${t.stats.stalls} · ${((t.stats.stallMs + ongoing) / 1000).toFixed(1)}s total`, t.stallFlagged(now) ? 'bad' : ''],
      ['Last stall', ongoing ? 'Now' : t.stats.lastStallAt ? `${fmtDuration(now - t.stats.lastStallAt)} ago` : 'None',
        t.stallFlagged(now) ? 'bad' : ''],
      ['Stall rate', hoursOnWall > 0.05 ? `${(t.stats.stalls / hoursOnWall).toFixed(1)} per hour` : null],
      ['Smooth catch-ups', `${t.stats.catchups} at ${CATCHUP_RATE}×`],
      ['Jumps to live', String(t.stats.resyncs)],
      ['Live edge moved', `${t.stats.rebaselines}×`],
      ['Refreshes', String(t.stats.reloads)],
      ['Next refresh', Number.isFinite(t.nextReloadAt) ? `in ${fmtCountdown(t.nextReloadAt - now)}` : 'Off'],
      ['Time to first frame', t.ttff == null ? null : `${(t.ttff / 1000).toFixed(1)}s`],
      ['Up since last refresh', t.mounted ? fmtDuration(now - t.loadedAt) : null],
      ['On the wall for', fmtDuration(now - t.addedAt)],
      ['Last error', t.lastError ? `${t.lastError.text} (${t.lastError.code}) · ${fmtDuration(now - t.lastError.at)} ago` : 'None',
        t.lastError && t.error ? 'bad' : ''],
    ]);
    setText($('#fs-buf-range'), drawSpark($('#fs-spark-buf'), t.history.map((p) => ({ t: p.t, v: p.buf })), { ceil: 10, threshold: BUFFER_LOW_S }));
    setText($('#fs-lag-range'), drawSpark($('#fs-spark-lag'), t.history.map((p) => ({ t: p.t, v: p.lag })), { ceil: 5 }));

    const levels = (t.ready && t.player?.getAvailableQualityLevels?.()) || [];
    const best = levels.find((q) => q in QUALITY);
    const stalledFeeds = new Set(wall.stallLog.map((e) => e.id)).size;
    fillKv($('#fs-network'), [
      ['Streaming now', t.quality ? QUALITY[t.quality].label : null],
      ['Best the source offers', best ? QUALITY[best].label : null],
      ['Render target', `${QUALITY[t.targetQuality()].label} · ${t.boosted ? (t.stream.priority ? 'priority boost' : 'on screen') : 'tile size'}`],
      ['Bitrate', t.mounted && !t.error ? `${t.estMbps().toFixed(1)} Mbps` : null, '', 'Estimated'],
      ['Priority', !t.stream.priority ? 'Off' : t.boosted ? 'Boosted' : `Held · ${t.heldReason || 'waiting'}`,
        t.stream.priority && !t.boosted ? 'warn' : ''],
      ['Embed host', host],
      ['Load', t.queued ? `Queued #${loadQueue.indexOf(t) + 1}` : t.mounted ? 'Loaded' : 'Not loaded'],
      ['Wall link', wall.congested ? `Congested · ${stalledFeeds} feeds stalled in 1 min`
        : Number.isFinite(wall.boostCap) ? `Recovering · ${wall.boostCap} boosts allowed` : 'Calm',
      wall.congested ? 'bad' : Number.isFinite(wall.boostCap) ? 'warn' : 'ok'],
    ]);

    fillKv($('#fs-stream'), [
      ['Title', data.title || null],
      ['Channel', data.author || null],
      ['Video ID', t.stream.source.id],
      ['Type', t.isLive == null ? null : t.isLive ? 'Live stream' : 'Video'],
      ['Live for', t.isLive && t.liveFor ? fmtDuration(t.liveFor * 1000) : null],
      ['Replay window', t.isLive && t.dvrWindow != null ? (data.allowLiveDvr === false ? 'DVR off' : fmtDuration(t.dvrWindow * 1000)) : null],
      ['Playback ID (CPN)', data.cpn || null],
    ]);

    renderAnalytics(t, now);
    $('#fs-log').replaceChildren(...logItems(events.filter((e) => e.id === t.stream.id).slice(0, 12)));
  }

  // YouTube analytics for one feed: what YouTube reports now, plus the backend's audience
  // history (peak, average, lowest, trend, growth per hour) since it started tracking.
  function renderAnalytics(t, now) {
    const id = t.stream.source.id;
    const ytEntry = ytStats.get(id);
    const yt = ytEntry?.missing ? null : ytEntry;
    const a = yt?.analysis || {};
    const hasKey = !!settings.ytApiKey.trim();
    $('#fs-key-form').hidden = hasKey;
    $('#fs-viewers-fig').hidden = !hasKey;
    setText($('#fs-aud-tag'), hasKey && yt ? 'Measured' : 'N·A');
    const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const rate = (v) => (v == null ? '' : ` · ${v >= 0 ? '+' : '−'}${fmtCount(Math.abs(v))}/h`);
    const trend = a.trendPct == null ? '' : ` · ${a.trendPct > 0 ? '+' : a.trendPct < 0 ? '−' : '±'}${Math.abs(a.trendPct)}% in ${a.trendMins} min`;
    fillKv($('#fs-audience'), hasKey ? [
      ['Watching now', yt?.viewers != null ? `${fmtInt(yt.viewers)}${trend}`
        : yt?.endedAt ? 'Ended: the broadcast is over' : yt?.broadcast === 'live' ? 'Hidden or 0: YouTube leaves it out' : null],
      ['Peak', a.peak != null ? `${fmtInt(a.peak)} at ${time(a.peakAt)}` : null],
      ['Average', fmtInt(a.avg)],
      ['Lowest', fmtInt(a.low)],
      ['Likes', yt?.likes != null ? `${fmtInt(yt.likes)}${rate(a.likesPerHour)}` : null],
      ['Views', yt?.views != null ? `${fmtInt(yt.views)}${rate(a.viewsPerHour)}` : null],
      ['Like rate', yt?.likes != null && yt?.views ? `${((yt.likes / yt.views) * 100).toFixed(2)}% of views` : null],
      ['Comments', yt?.comments != null ? fmtInt(yt.comments) : yt ? 'Off or hidden' : null],
      ['Went live', yt?.startedAt ? `${time(yt.startedAt)} · ${fmtDuration((yt.endedAt ? Date.parse(yt.endedAt) : now) - Date.parse(yt.startedAt))}${yt.endedAt ? ' (ended)' : ''}` : null],
      ['Scheduled for', yt?.scheduledAt && !yt.startedAt ? new Date(yt.scheduledAt).toLocaleString() : null],
      ['Channel', yt?.channelTitle ? `${yt.channelTitle}${yt.subscribers != null ? ` · ${fmtCount(yt.subscribers)} subscribers` : ''}` : null],
      ['Visibility', yt?.privacy ? yt.privacy[0].toUpperCase() + yt.privacy.slice(1) : null, yt?.privacy === 'private' ? 'bad' : ''],
      ['Embedding', yt?.embeddable == null ? null : yt.embeddable ? 'Allowed' : 'Off: this wall cannot play it', yt?.embeddable === false ? 'bad' : ''],
      ['Definition', yt?.definition ? yt.definition.toUpperCase() : null],
      ['Live chat', yt?.chat == null ? null : yt.chat ? 'On' : 'Off'],
      ['Recording length', yt?.lengthSec ? fmtClock(yt.lengthSec) : null],
      ['Tracked since', a.trackedSince ? `${time(a.trackedSince)} · ${a.samples} readings` : null],
    ] : []);

    const series = viewerSeries.id === id ? viewerSeries.series : [];
    const span = Math.max(10 * 60000, series.length ? now - series[0][0] : 0);
    setText($('#fs-viewers-range'), drawSpark($('#fs-spark-viewers'), series.map((p) => ({ t: p[0], v: p[1] })), { span, fit: true, label: fmtCount }));
    setText($('#fs-viewers-span'), series.length ? `last ${fmtDuration(span)}` : 'no readings yet');

    setText($('#fs-aud-hint'), !hasKey
      ? 'Paste a YouTube Data API key to see live viewers, likes, views and comments for every feed, with peak, average and trend. Without one nothing here is shown; nothing is guessed.'
      : ytState?.status === 'error' ? `YouTube Data API: ${ytState.error}`
        : ytEntry?.missing ? 'YouTube returned nothing for this ID: the video is deleted, private or mistyped.'
          : yt ? `Reported by YouTube · updated ${fmtDuration(now - ytStatsAt)} ago · polled once a minute by the backend`
            : 'Waiting for the first YouTube Data API response.');
  }

  async function loadViewerHistory(tile) {
    const id = tile.stream.source.id;
    try {
      const res = await fetch(`/api/youtube/history?id=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      viewerSeries = { id, series: (await res.json()).series || [] };
      if (inspected === tile) renderFeedSheet();
    } catch {
      // backend offline: the chart stays as it was
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube Data API (optional): the backend polls once a minute for every window and
  // keeps the audience history; this page shows what it reports.
  // ---------------------------------------------------------------------------
  function applyYouTube(state) {
    ytState = state;
    ytChecking = false;
    backendYoutube = true;
    ytStats.clear();
    for (const [id, v] of Object.entries(state.videos || {})) ytStats.set(id, v);
    ytStatsAt = state.updatedAt || 0;
    const err = state.status === 'error' ? state.error : '';
    if (err && err !== ytStatsError) logEvent(null, `YouTube Data API: ${err}`, 'warn');
    ytStatsError = err;
    updateSummary();
    renderYtStatus();
    const now = Date.now();
    for (const t of tiles.values()) t.renderSide(now);
    if (inspected) loadViewerHistory(inspected); // re-renders the sheet with the new reading
  }

  // Saved from Settings (Save key / Enter) or the Stats sheet. An empty key turns stats off.
  function saveYtKey(raw) {
    settings.ytApiKey = String(raw || '').trim();
    store.save(); // hands the key to the backend, which checks it with YouTube within seconds
    applySetting('ytApiKey');
    if (backendYoutube !== true) probeYouTubeBackend();
  }

  // Does the running backend poll YouTube? One started before that existed answers 404,
  // and would otherwise leave the key on "Checking…" forever.
  async function probeYouTubeBackend() {
    try {
      const res = await fetch('/api/youtube', { cache: 'no-store' });
      backendYoutube = res.ok;
      if (res.ok && !ytState) applyYouTube(await res.json());
    } catch {
      // backend offline: the status line says so
    }
    renderYtStatus();
  }

  // The key's state under the input in Settings: working, checking, or exactly what's wrong.
  function renderYtStatus() {
    const $s = $('#yt-status');
    const hasKey = !!settings.ytApiKey.trim();
    let text;
    let tone = '';
    if (!hasKey) text = 'No key: audience numbers are off.';
    else if (backendYoutube === false) {
      [text, tone] = ['Key saved, but the running backend is older than YouTube support. Close the black "IXG Wall backend" window, then start the wall again (Start IXG Wall.cmd or the exe).', 'bad'];
    } else if (!backend.connected) [text, tone] = ['Backend offline: the backend checks the key and polls YouTube.', 'warn'];
    else if (ytChecking || !ytState || ytState.status === 'off') text = 'Checking the key with YouTube…';
    else if (ytState.status === 'error') [text, tone] = [ytState.error, 'bad'];
    else {
      const n = Object.keys(ytState.videos || {}).length;
      // videos.list: 1 unit per 50 feeds per poll; channels.list: 1 unit every 10 minutes.
      const perDay = Math.ceil(86400 / settings.ytPollSec) * Math.max(1, Math.ceil(n / 50)) + 144;
      text = `Working · ${n} video${n === 1 ? '' : 's'} · updated ${fmtDuration(Date.now() - ytState.updatedAt)} ago · every ${settings.ytPollSec} s ≈ ${fmtInt(perDay)} of ${fmtInt(ytState.units.limit)} quota units a day · ${fmtInt(ytState.units.used)} used today`;
      tone = perDay > ytState.units.limit ? 'warn' : 'ok';
      if (tone === 'warn') text += ' · this rate runs out before the day ends: poll less often';
    }
    setText($s, text);
    setTone($s, tone);
  }
  // ---------------------------------------------------------------------------
  // Performance governor: keeps the laptop below the point where video starts to stutter.
  // Inputs: backend CPU/memory and the browser's own CPU pressure signal. Actions, while
  // busy: shed priority boosts one at a time, start feeds one at a time, postpone
  // scheduled refreshes. Everything comes back one step per calm minute.
  // ---------------------------------------------------------------------------
  const backendFresh = () => backend.connected && Date.now() - backend.at < BACKEND_STALE_MS;

  function updatePerf(now) {
    const t = backendFresh() ? backend.latest : null;
    const reasons = [];
    if (t?.cpu != null && t.cpu >= PERF_BUSY_CPU) reasons.push(`CPU ${Math.round(t.cpu)}%`);
    if (t?.memUsedPct != null && t.memUsedPct >= PERF_BUSY_MEM) reasons.push(`memory ${Math.round(t.memUsedPct)}%`);
    if (cpuPressure === 'serious' || cpuPressure === 'critical') reasons.push(`CPU pressure ${cpuPressure}`);
    const severe = (t?.cpu != null && t.cpu >= PERF_OVERLOADED_CPU) || cpuPressure === 'critical';
    perf.hotSince = reasons.length ? perf.hotSince || now : 0;
    const level = perf.hotSince && now - perf.hotSince >= PERF_SUSTAIN_MS ? (severe ? 'overloaded' : 'busy') : 'ok';
    if (level !== perf.level) {
      logEvent(null, level === 'ok' ? 'Laptop load back to normal' : `Laptop ${level}: ${reasons.join(', ')}`, level === 'ok' ? 'info' : 'warn');
    }
    perf.level = level;
    perf.reason = reasons.join(', ');
    const boosted = [...tiles.values()].filter((x) => x.boosted).length;
    if (level !== 'ok') {
      perf.lastHotAt = now;
      if (boosted > 0 && now - perf.lastCapChangeAt > PERF_SHED_GAP_MS) {
        perf.cap = level === 'overloaded' ? 0 : boosted - 1;
        perf.lastCapChangeAt = now;
        logEvent(null, perf.cap === 0 ? 'Dropped all priority boosts to free CPU' : `Shed one priority boost to free CPU (${perf.cap} kept)`, 'warn');
      }
    } else if (Number.isFinite(perf.cap)
      && now - perf.lastHotAt > PERF_RESTORE_CALM_MS && now - perf.lastCapChangeAt > PERF_RESTORE_CALM_MS) {
      const wanting = [...tiles.values()].filter((x) => x.wantsBoost(now)).length;
      perf.cap = perf.cap + 1 >= wanting ? Infinity : perf.cap + 1;
      perf.lastCapChangeAt = now;
      logEvent(null, 'Laptop calm for a minute: restoring one priority boost');
    }
  }

  function connectBackend() {
    if (location.protocol === 'file:' || !window.EventSource) return;
    const source = new EventSource('/api/telemetry');
    source.onmessage = (e) => {
      try {
        backend.latest = JSON.parse(e.data);
        backend.connected = true;
        backend.at = Date.now();
      } catch {
        return;
      }
      updateSummary();
      renderPerf();
      if (!$drawer.hidden) renderYtStatus();
    };
    // (Re)connected, possibly to a newly started backend: does this one poll YouTube?
    source.onopen = () => probeYouTubeBackend();
    source.addEventListener('youtube', (e) => {
      try { applyYouTube(JSON.parse(e.data)); } catch { /* malformed event: keep the last report */ }
    });
    // Another window saved the wall: offer to load it rather than silently diverge.
    source.addEventListener('wall', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.clientId === clientId || data.version <= wallVersion) return;
      const reload = document.createElement('button');
      reload.className = 'btn btn-outline btn-xs';
      reload.textContent = 'Reload wall';
      reload.addEventListener('click', () => location.reload());
      $banner.replaceChildren('The wall was changed in another window. ', reload);
      $banner.hidden = false;
    });
    source.onerror = () => { // EventSource reconnects on its own
      backend.connected = false;
      updateSummary();
      renderPerf();
    };
  }

  async function watchPressure() {
    if (!('PressureObserver' in window)) return;
    try {
      const observer = new PressureObserver((records) => {
        cpuPressure = records[records.length - 1]?.state || cpuPressure;
      });
      await observer.observe('cpu', { sampleInterval: 2000 });
    } catch {
      // not permitted in this context; the backend's CPU reading still drives the governor
    }
  }

  // Is this window decoding video on the GPU? Hardware decode reports as power-efficient.
  async function detectDecode() {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: { contentType: 'video/mp4; codecs="avc1.4d401f"', width: 854, height: 480, bitrate: 1200000, framerate: 30 },
      });
      decodeHere = info.powerEfficient ? 'hardware' : 'software';
    } catch {
      decodeHere = null;
    }
    renderPerf();
  }

  async function wallBrowserAction(body) {
    const res = await fetch('/api/wall-browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function renderPerf() {
    if ($drawer.hidden) return;
    const t = backendFresh() ? backend.latest : null;
    const b = t?.browser;
    const pct = (v) => (v == null ? null : `${Math.round(v)}%`);
    const toneFor = (v, warn, bad) => (v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
    fillKv($('#perf-kv'), [
      ['Wall status', perf.level === 'ok' ? 'Normal' : `${perf.level === 'busy' ? 'Busy' : 'Overloaded'} · ${perf.reason}`,
        perf.level === 'ok' ? 'ok' : perf.level === 'busy' ? 'warn' : 'bad'],
      ['CPU', t ? `${pct(t.cpu)} of ${t.cores} threads` : null, toneFor(t?.cpu, 75, PERF_BUSY_CPU)],
      ['CPU pressure (browser)', cpuPressure || ('PressureObserver' in window ? 'Waiting' : 'Not available'),
        cpuPressure === 'critical' ? 'bad' : cpuPressure === 'serious' ? 'warn' : ''],
      ['Memory', t ? `${pct(t.memUsedPct)} of ${t.memTotalGB} GB` : null, toneFor(t?.memUsedPct, 85, PERF_BUSY_MEM)],
      ['Download now', t?.rxMbps != null ? `${t.rxMbps.toFixed(1)} Mbps` : null],
      ['Upload now', t?.txMbps != null ? `${t.txMbps.toFixed(1)} Mbps` : null],
      ['Network adapter', t?.nic || null],
      ['Browser video engine', pct(t?.videoEngine), toneFor(t?.videoEngine, 70, 90)],
      ['Browser GPU 3D', pct(t?.gpu3d), toneFor(t?.gpu3d, 70, 90)],
      ['Decoding in this window', decodeHere ? (decodeHere === 'hardware' ? 'Hardware (GPU)' : 'Software (CPU)') : null],
      ['Managed wall window', !b?.supported ? 'No Chrome or Edge found'
        : b.running ? `Running · ${b.browser} · ${b.decode} decode${b.uptimeSec != null ? ` · up ${fmtDuration(b.uptimeSec * 1000)}` : ''}${b.restarts ? ` · ${b.restarts} restarts` : ''}`
          : `Not running${b.lastExit ? ` · last ${b.lastExit.note}` : ''}`,
      b?.running ? 'ok' : ''],
      ['This window', managedWindow ? 'Managed wall window' : 'Ordinary browser tab'],
      ['Backend', backendFresh() ? `Connected · ${t.agent === 'ok' ? 'all counters' : t.agent === 'unsupported' ? 'CPU and memory only' : 'counters starting'}` : 'Offline: run npm run wall',
        backendFresh() ? '' : 'warn'],
    ]);
    const $mode = $('#decode-mode');
    if (b?.decode && document.activeElement !== $mode) $mode.value = b.decode;
    $mode.disabled = !t || !b?.supported;
    const $launch = $('#wall-launch');
    $launch.hidden = !!b?.running;
    $launch.disabled = !t || !b?.supported;
  }

  function togglePriority(tile) {
    tile.stream.priority = !tile.stream.priority;
    store.save();
    logEvent(tile, tile.stream.priority ? 'Marked priority' : 'Priority removed');
    if (!tile.stream.priority && Number.isFinite(wall.boostCap)) {
      wall.boostCap = Math.min(wall.boostCap, [...tiles.values()].filter((t) => t.stream.priority).length);
    }
    allocate();
    // A queued feed moves up (or back) in line with its new priority.
    if (tile.queued) requestMount(tile);
    tile.render();
  }

  async function removeTile(tile) {
    const ok = await ask({
      title: `Remove ${tile.stream.label} from the wall?`,
      body: 'The player stops and its telemetry is discarded. Paste the URL again to bring it back.',
      confirm: 'Remove feed',
      variant: 'destructive',
    });
    if (!ok || !tiles.has(tile.stream.id)) return;
    if (inspected === tile) closeFeedSheet();
    tile.unmount();
    tileObserver.unobserve(tile.el);
    viewObserver.unobserve(tile.el);
    tile.el.remove();
    tiles.delete(tile.stream.id);
    const queued = loadQueue.indexOf(tile);
    if (queued >= 0) loadQueue.splice(queued, 1);
    const idx = streams.indexOf(tile.stream);
    if (idx >= 0) streams.splice(idx, 1);
    if (solo === tile) solo = null;
    store.save();
    logEvent(null, `Removed ${tile.stream.label}`);
    updateLayout();
    allocate();
    pumpQueue();
    updateSummary();
  }

  function toggleSolo(tile) {
    solo = solo === tile ? null : tile;
    for (const t of tiles.values()) {
      if (t.ready && t.player) {
        if (t === solo) {
          t.player.unMute();
          t.player.setVolume(100);
        } else {
          t.player.mute();
        }
      }
      t.render();
    }
  }

  // Spread scheduled refreshes evenly so tiles never all blank together.
  function restagger() {
    const ms = settings.hardReloadMin * 60000;
    const list = [...tiles.values()];
    list.forEach((t, i) => t.scheduleReload(ms > 0 ? (ms * (i + 1)) / list.length : undefined));
  }

  // Pick the column count that gives each 16:9 video the most visible area, allowing for
  // the info bar under every video (slim when a tile has room for the side card).
  function videoWidthIn(tileW, tileH) {
    const withSide = ((tileH - BAR_SLIM_PX) * 16) / 9;
    if (settings.showStats && tileW - withSide >= SIDE_MIN_PX) return withSide;
    const bar = settings.showStats ? BAR_FULL_PX : BAR_SLIM_PX;
    return Math.min(tileW, (Math.max(0, tileH - bar) * 16) / 9);
  }

  const GRID_GAP_PX = 2; // .grid gap

  // The wall's geometry for n feeds in a W×H area. Fit mode squeezes every feed on screen
  // (column count chosen for the biggest video). Scroll mode keeps every tile one fixed,
  // legible size, a 16:9 video beside its stats card, and the wall scrolls for the rest.
  function computeLayout(W, H, n) {
    if (settings.layoutMode === 'scroll') {
      const cols = settings.scrollColumns;
      const tileW = (W - (cols - 1) * GRID_GAP_PX) / cols;
      const card = settings.showStats ? Math.max(SIDE_MIN_PX + 40, Math.round((tileW * settings.cardPct) / 100)) : 0;
      const videoW = tileW - card;
      const videoH = (videoW * 9) / 16;
      const tileH = Math.round(videoH + BAR_SLIM_PX);
      const rowsOnScreen = Math.max(1, Math.floor((H + GRID_GAP_PX) / (tileH + GRID_GAP_PX)));
      return { mode: 'scroll', cols, rows: Math.max(1, Math.ceil(n / cols)), tileW, tileH, card, videoW, videoH, onScreen: Math.min(n, rowsOnScreen * cols) };
    }
    let cols = 1;
    if (settings.layout !== 'auto') {
      cols = Math.min(n, Number(settings.layout) || 1);
    } else {
      let best = 0;
      for (let c = 1; c <= n; c++) {
        const w = videoWidthIn(W / c, H / Math.ceil(n / c));
        if (w > best + 0.5) {
          best = w;
          cols = c;
        }
      }
    }
    const rows = Math.ceil(n / cols);
    const tileW = (W - (cols - 1) * GRID_GAP_PX) / cols;
    const tileH = (H - (rows - 1) * GRID_GAP_PX) / rows;
    const videoW = videoWidthIn(tileW, tileH);
    const sideOn = settings.showStats && tileW - ((tileH - BAR_SLIM_PX) * 16) / 9 >= SIDE_MIN_PX;
    return { mode: 'fit', cols, rows, tileW, tileH, card: sideOn ? tileW - videoW : 0, videoW, videoH: (videoW * 9) / 16, onScreen: n };
  }

  function updateLayout() {
    const n = tiles.size;
    document.body.style.setProperty('--wall-top', `${Math.round($grid.getBoundingClientRect().top)}px`);
    document.body.style.setProperty('--sheet-top', `${document.querySelector('.topbar').offsetHeight}px`);
    $empty.hidden = n > 0;
    renderLayoutPreview();
    if (!n) return;
    const L = computeLayout($grid.clientWidth || 16, $grid.clientHeight || 9, n);
    $grid.classList.toggle('scroll', L.mode === 'scroll');
    $grid.style.setProperty('--cols', L.cols);
    $grid.style.setProperty('--rows', L.rows);
    $grid.style.setProperty('--tile-h', `${L.tileH}px`);
    for (const t of tiles.values()) t.applySize();
  }

  // Settings → Layout: a to-scale miniature of the wall as configured. Each tile shows its
  // video and stats card; tiles past the bottom of the screen are faded under a fold line.
  function renderLayoutPreview() {
    const $box = $('#layout-preview');
    if (!$box || $drawer.hidden) return;
    const W = $grid.clientWidth || 1600;
    const H = $grid.clientHeight || 860;
    const n = tiles.size || 6;
    const L = computeLayout(W, H, n);
    const s = $box.clientWidth / W;
    const step = L.tileH + GRID_GAP_PX;
    const shown = Math.min(n, L.mode === 'scroll' ? L.onScreen + L.cols : n); // one row past the fold
    const boxH = L.mode === 'scroll' ? Math.min(Math.ceil(shown / L.cols) * step, H + step * 0.6) : H;
    $box.style.height = `${Math.round(boxH * s)}px`;
    $box.style.setProperty('--fold', `${Math.round(H * s)}px`);
    $box.classList.toggle('scrolls', L.mode === 'scroll' && n > L.onScreen);
    const px = (v) => `${(v * s).toFixed(1)}px`;
    const items = [];
    for (let i = 0; i < shown; i++) {
      const col = i % L.cols;
      const row = Math.floor(i / L.cols);
      const el = document.createElement('div');
      el.className = 'lp-tile';
      el.style.left = px(col * (L.tileW + GRID_GAP_PX));
      el.style.top = px(row * step);
      el.style.width = px(L.tileW);
      el.style.height = px(L.tileH);
      if ((row + 1) * step - GRID_GAP_PX > H + 1) el.classList.add('below');
      const video = document.createElement('div');
      video.className = 'lp-video';
      video.style.width = px(L.videoW);
      video.style.height = px(L.mode === 'scroll' ? L.videoH : L.tileH - (L.card ? BAR_SLIM_PX : settings.showStats ? BAR_FULL_PX : BAR_SLIM_PX));
      el.append(video);
      if (L.card) {
        const card = document.createElement('div');
        card.className = 'lp-card';
        card.style.width = px(L.card);
        card.style.height = video.style.height;
        el.append(card);
      }
      items.push(el);
    }
    $box.replaceChildren(...items);

    const q = L.mode === 'scroll' ? QUALITY[settings.feedQuality].label : null;
    const size = `${Math.round(L.videoW)} × ${Math.round(L.videoH)} px video${L.card ? ` · ${Math.round(L.card)} px stats card` : ''}`;
    setText($('#layout-summary'), L.mode === 'scroll'
      ? `${tiles.size ? `${L.onScreen} of ${n} feeds on screen${n > L.onScreen ? `, scroll for ${n - L.onScreen} more` : ''}` : `${L.onScreen} feeds fit on screen`} · ${size} · on-screen feeds stream at ${q}`
      : `All ${n} feeds on screen in ${L.cols} column${L.cols === 1 ? '' : 's'} · ${size} · 480p unless priority`);
    for (const el of $drawer.querySelectorAll('[data-layout-mode]')) el.hidden = el.dataset.layoutMode !== settings.layoutMode;
    setText($('#card-pct-out'), `${settings.cardPct}%`);
  }
  function updateSummary() {
    const list = [...tiles.values()];
    const playing = list.filter((t) => t.ready && t.ps === PS.PLAYING);
    const issues = list.filter((t) => t.error || t.ps === PS.BUFFERING || t.ps === PS.PAUSED).length;
    const lags = playing.map((t) => t.latency).filter((v) => v != null);
    $readout.playing.textContent = `${playing.length}/${list.length}`;
    // Red when any feed is buffering or failed; amber only while feeds are still starting.
    $readout.playing.dataset.tone = list.some((t) => t.error || t.ps === PS.BUFFERING) ? 'bad'
      : playing.length < list.length ? 'warn' : '';
    $readout.latency.textContent = lags.length ? `${median(lags).toFixed(1)}s` : '—';
    $readout.issues.textContent = String(issues);
    // Errors and buffering are red; only paused feeds (which resume themselves) are amber.
    $readout.issues.dataset.tone = list.some((t) => t.error || t.ps === PS.BUFFERING) ? 'bad' : issues ? 'warn' : '';
    const load = list.reduce((sum, t) => sum + t.estMbps(), 0);
    const budget = settings.bandwidthMbps;
    setText($readout.load, list.length ? `${load.toFixed(1)}${budget ? `/${budget}` : ''} Mbps` : '—');
    $readout.load.dataset.tone = budget && load > budget ? 'bad'
      : wall.congested || Number.isFinite(wall.boostCap) || (budget && load > budget * BUDGET_HEADROOM) ? 'warn' : '';
    $readout.load.parentElement.title = wall.congested ? 'Several feeds are stalling together: the link looks congested'
      : Number.isFinite(wall.boostCap) ? `Priority boosts limited to ${wall.boostCap} until the link stays calm`
        : 'What the feeds should be pulling: typical live bitrates for each feed\'s current quality';

    // Measured by the backend: the laptop's real download right now, and its CPU.
    const t = backendFresh() ? backend.latest : null;
    setText($readout.bwNow, t?.rxMbps != null ? `${t.rxMbps.toFixed(1)} Mbps` : '—');
    $readout.bwNow.dataset.tone = budget && t?.rxMbps > budget ? 'bad' : budget && t?.rxMbps > budget * BUDGET_HEADROOM ? 'warn' : '';
    $readout.bwNow.parentElement.title = t
      ? `Download right now on ${t.nic || 'the busiest adapter'} · whole laptop, measured by the backend`
      : 'Backend offline: start the wall with npm run wall to measure real bandwidth';
    setText($readout.cpu, t?.cpu != null ? `${Math.round(t.cpu)}%` : '—');
    $readout.cpu.dataset.tone = perf.level === 'overloaded' ? 'bad' : perf.level === 'busy' || t?.cpu >= 75 ? 'warn' : '';
    $readout.cpu.parentElement.title = t
      ? `Whole-laptop CPU across ${t.cores} threads${cpuPressure ? ` · browser CPU pressure: ${cpuPressure}` : ''}${perf.level !== 'ok' ? ` · ${perf.level}: ${perf.reason}` : ''}`
      : 'Backend offline';
    const viewerCounts = [...new Set(list.map((t) => t.stream.source.id))]
      .map((id) => ytStats.get(id)?.viewers).filter((v) => v != null);
    $('#r-ccv-wrap').hidden = !settings.ytApiKey.trim() || !viewerCounts.length;
    $('#r-ccv').textContent = viewerCounts.reduce((sum, v) => sum + Number(v), 0).toLocaleString('en-US');
    const total = ytState?.total;
    $('#r-ccv-wrap').title = total?.peak != null
      ? `Watching across all feeds, reported by YouTube · peak ${fmtInt(total.peak)} at ${new Date(total.peakAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · average ${fmtInt(total.avg)}`
      : 'Watching across all feeds, reported by YouTube';
    // A stale LIVE is a lie: the badge shows only while a live feed is actually playing.
    $liveBadge.hidden = !playing.some((t) => t.isLive);
  }

  function restartLoop() {
    clearInterval(loopTimer);
    loopTimer = setInterval(() => {
      const now = Date.now();
      wall.autoJumpsLeft = MAX_AUTO_JUMPS_PER_TICK;
      updateCongestion(now);
      updatePerf(now);
      allocate();
      pumpQueue();
      for (const t of tiles.values()) {
        try {
          t.tick(now);
        } catch (err) {
          console.error(err);
        }
      }
      updateSummary();
      renderFeedSheet();
    }, settings.checkIntervalSec * 1000);
  }

  // The player API, retried until it loads: a dropped connection at startup must not leave
  // every feed on "Loading" until someone reloads the page. Retries back off to once a minute.
  function loadYouTubeApi() {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      let attempt = 0;
      let timer = 0;
      let failing = false;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        if (failing) {
          $banner.hidden = true;
          logEvent(null, 'YouTube player loaded');
        }
        resolve();
      };
      const fail = () => {
        clearTimeout(timer);
        failing = true;
        const delay = Math.min(60, 5 * 2 ** attempt++);
        const retry = document.createElement('button');
        retry.className = 'btn btn-outline btn-xs';
        retry.textContent = 'Try again';
        retry.addEventListener('click', load);
        $banner.replaceChildren(`Could not load the YouTube player: no connection to YouTube. Trying again automatically in ${delay} s. `, retry);
        $banner.hidden = false;
        timer = setTimeout(load, delay * 1000);
      };
      function load() {
        clearTimeout(timer);
        document.querySelector('script[data-yt-api]')?.remove();
        // A half-loaded attempt leaves a YT stub that stops the script loading the player again.
        // (Assigned, not deleted: the loader declares YT with var, and strict mode can't delete it.)
        if (window.YT && !window.YT.Player) window.YT = undefined;
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.dataset.ytApi = '';
        script.onerror = fail;
        // The loader can arrive while the player code it fetches next doesn't.
        script.onload = () => { timer = setTimeout(() => { if (!(window.YT && window.YT.Player)) fail(); }, 20000); };
        document.head.append(script);
      }
      load();
    });
  }

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------
  function showFormError(msg) {
    $formError.textContent = msg;
    $formError.hidden = !msg;
    if (msg) $source.setAttribute('aria-invalid', 'true');
    else $source.removeAttribute('aria-invalid');
  }

  // ---- Add feeds: a popover that takes one URL or a whole list ----------------------
  function setAddPanel(open) {
    $addPanel.hidden = !open;
    $addToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      showFormError('');
      updateAddButton();
      $source.focus();
    }
  }

  const sourceTokens = () => $source.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  function updateAddButton() {
    const n = sourceTokens().length;
    $('#add-submit').textContent = n > 1 ? `Add ${n} feeds` : 'Add feed';
    $label.disabled = n > 1;
  }

  $addToggle.addEventListener('click', () => setAddPanel($addPanel.hidden));
  $('#add-cancel').addEventListener('click', () => setAddPanel(false));
  document.addEventListener('pointerdown', (e) => {
    if (!$addPanel.hidden && !$addPanel.contains(e.target) && !$addToggle.contains(e.target)) setAddPanel(false);
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tokens = sourceTokens();
    const onWall = new Set(streams.map((s) => s.source.id));
    const valid = [];
    const rejected = [];
    for (const raw of tokens) {
      if (/youtube\.com\/(@|channel\/|c\/)|^@|^UC[\w-]{22}$/i.test(raw)) {
        rejected.push([raw, 'channel link: open the live stream and copy its own URL']);
        continue;
      }
      const source = parseSource(raw);
      if (!source) rejected.push([raw, 'not a YouTube video URL or 11-character ID']);
      else if (onWall.has(source.id) || valid.some((v) => v.id === source.id)) rejected.push([raw, 'already on the wall']);
      else valid.push(source);
    }
    const label = valid.length === 1 ? $label.value.trim() : '';
    for (const source of valid) {
      const stream = { id: uid(), source, label: label || `Stream ${streams.length + 1}`, autoLabel: !label };
      streams.push(stream);
      const tile = addTile(stream);
      logEvent(tile, `Added (${source.id})`);
    }
    if (valid.length) store.save(); // the backend polls YouTube for the new feeds within seconds
    if (!rejected.length) {
      $source.value = '';
      $label.value = '';
      setAddPanel(false);
      return;
    }
    // Keep only the lines that need fixing, and say why each one was skipped.
    $source.value = rejected.map(([raw]) => raw).join('\n');
    updateAddButton();
    showFormError(`${valid.length ? `Added ${valid.length}. ` : ''}Skipped ${rejected.length}:\n`
      + rejected.map(([raw, why]) => `${raw.length > 48 ? `${raw.slice(0, 45)}…` : raw} — ${why}`).join('\n'));
  });

  $source.addEventListener('input', () => {
    if (!$formError.hidden) showFormError('');
    updateAddButton();
  });
  $source.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $form.requestSubmit();
  });

  $('#resync-all').addEventListener('click', () => {
    for (const t of tiles.values()) if (t.isLive) t.resync('manual, all');
  });

  // The load queue staggers these, priority feeds first.
  $('#reload-all').addEventListener('click', () => {
    for (const t of tiles.values()) t.reload('manual, all');
  });

  $('#wall-full').addEventListener('click', () => toggleFullscreen(document.documentElement));

  function setDrawer(open) {
    if (open && inspected) closeFeedSheet();
    $drawer.hidden = !open;
    $settingsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      renderLog();
      renderPerf();
      renderYtStatus();
      renderLayoutPreview();
    }
  }
  $settingsToggle.addEventListener('click', () => setDrawer($drawer.hidden));
  $('#drawer-close').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $dialog.open) return;
    if (!$addPanel.hidden) setAddPanel(false);
    else if (inspected) closeFeedSheet();
    else if (!$drawer.hidden) setDrawer(false);
  });

  $('#decode-mode').addEventListener('change', async (e) => {
    const decode = e.target.value;
    const ok = await ask({
      title: `Switch the wall to ${decode} decoding?`,
      body: managedWindow
        ? 'This window closes and reopens with the new setting. Feeds reload, priority first.'
        : 'The managed wall window restarts with the new setting. This tab is not affected.',
      confirm: 'Restart wall window',
    });
    if (!ok) {
      renderPerf();
      return;
    }
    try {
      await wallBrowserAction({ action: 'relaunch', decode });
      logEvent(null, `Wall window restarting with ${decode} decoding`);
    } catch (err) {
      logEvent(null, `Could not restart the wall window: ${err.message}`, 'bad');
    }
  });

  $('#wall-launch').addEventListener('click', async () => {
    try {
      await wallBrowserAction({ action: 'launch' });
      logEvent(null, 'Opened the managed wall window');
    } catch (err) {
      logEvent(null, `Could not open the wall window: ${err.message}`, 'bad');
    }
  });
  $('#fs-close').addEventListener('click', closeFeedSheet);
  $('#fs-nerds').addEventListener('click', () => {
    if (inspected) setFocus(inspected, !inspected.focused);
  });
  $('#log-clear').addEventListener('click', () => {
    events.length = 0;
    renderLog();
  });

  function applySetting(key) {
    if (key === 'checkIntervalSec' && ytReady) restartLoop();
    if (key === 'hardReloadMin') restagger();
    if (['layout', 'layoutMode', 'scrollColumns', 'cardPct', 'feedQuality'].includes(key)) {
      updateLayout();
      if (ytReady) allocate();
    }
    if (key === 'feedQuality' || key === 'layoutMode') {
      // Lowering what on-screen feeds stream at takes a refresh; raising it applies live.
      for (const t of tiles.values()) {
        if (t.quality && rank(t.quality) > rank(t.targetQuality())) t.reload('layout quality lowered');
      }
    }
    if (key === 'showStats') {
      document.body.classList.toggle('hide-stats', !settings.showStats);
      updateLayout();
      for (const t of tiles.values()) t.fit();
    }
    if (key === 'loadConcurrency') pumpQueue();
    if (key === 'ytApiKey') {
      // Saving the wall hands the key to the backend, which checks it within seconds.
      settings.ytApiKey = String(settings.ytApiKey).trim();
      syncSettingInputs();
      ytStats.clear();
      ytStatsError = '';
      ytChecking = !!settings.ytApiKey;
      renderYtStatus();
      updateSummary();
      renderFeedSheet();
    }
    if (key === 'bandwidthMbps') allocate();
    if (key === 'ytPollSec') renderYtStatus(); // saving the wall hands the new interval to the backend
    if (key === 'priorityQuality') {
      for (const t of tiles.values()) {
        t.applySize();
        // Lowering the ceiling takes a refresh; raising it applies live.
        if (t.boosted && t.quality && rank(t.quality) > rank(t.targetQuality())) t.reload('priority ceiling lowered');
      }
      allocate();
    }
    for (const t of tiles.values()) t.render();
  }

  function syncSettingInputs() {
    $drawer.querySelectorAll('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = settings[key];
      else input.value = settings[key];
    });
    $('#yt-key-input').value = settings.ytApiKey;
  }

  // YouTube API key: saved with the Save key button or Enter, not on every keystroke.
  $('#yt-key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveYtKey($('#yt-key-input').value);
  });
  $('#yt-key-show').addEventListener('click', (e) => {
    const input = $('#yt-key-input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  $drawer.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    input.addEventListener('change', () => {
      let v = input.type === 'checkbox' ? input.checked : input.value;
      if (key in LIMITS) {
        const [lo, hi] = LIMITS[key];
        v = clamp(Number(v), lo, hi, settings[key]);
        input.value = v;
      }
      settings[key] = v;
      store.save();
      applySetting(key);
    });
  });

  new ResizeObserver(updateLayout).observe($grid);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (location.protocol === 'file:') {
    $banner.textContent = 'YouTube blocks embeds on pages opened as files. Double-click "Start IXG Wall.cmd" (or run npm run wall) instead.';
    $banner.hidden = false;
  }

  const ytApi = loadYouTubeApi(); // fetch the player API while the wall loads
  loadServerWall().then(() => {
    syncSettingInputs();
    document.body.classList.toggle('hide-stats', !settings.showStats);
    streams.forEach(addTile);
    updateLayout();
    updateSummary();
    connectBackend(); // also brings the YouTube numbers, polled by the backend
    $('#fs-key-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = $('#fs-key').value.trim();
      if (!key) return;
      $('#fs-key').value = '';
      saveYtKey(key);
    });
    watchPressure();
    detectDecode();
    return ytApi;
  })
    .then(() => {
      ytReady = true;
      allocate();
      for (const t of tiles.values()) requestMount(t);
      restagger();
      restartLoop();
    })
    .catch((err) => {
      $banner.textContent = err.message;
      $banner.hidden = false;
    });
})();
