'use strict';

(() => {
  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'ixg-multiviewer:v1'; // the app's name before it became IXG Wall; kept so saved walls carry over
  const DEFAULT_SETTINGS = {
    checkIntervalSec: 2,
    driftThresholdSec: 4,
    hardReloadMin: 0,              // a feed that plays is left alone; see Hard-refresh in Settings
    autoResync: true,
    showStats: true,
    layoutMode: 'scroll',      // scroll: fixed columns, big tiles, scroll for more | fit: every feed on screen | preset: a PIP layout
    layoutPreset: 'quad',      // the preset layout in use (LAYOUT_PRESETS id, or 'custom')
    customLayout: null,        // { cols, rows, cells: [[col, row, colSpan, rowSpan]] } from the layout builder
    scrollColumns: 2,
    feedQuality: 'hd1080',     // what on-screen feeds stream at in scroll mode
    cardPct: 32,               // stats card's share of the tile width in scroll mode
    layout: 'auto',            // columns in fit mode
    bandwidthMbps: 0,          // 0 = unknown: boosts are governed by stall feedback alone
    priorityQuality: 'hd1080',
    loadConcurrency: 2,
    ytPollSec: 30,             // how often the backend asks YouTube (1 quota unit per 50 feeds)
    syncFeeds: true,           // hold every live feed at one shared delay
    syncMarginSec: 1,          // sync target = slowest feed's edge delay + this
    memLimitMB: 500,           // managed wall window's tab over this: offload memory (0 = off)
    offloadEveryMin: 60,       // where memory can't be measured, offload this often (0 = off)
    timelineSpanMin: 15,       // how much of each stream the timelines show (0 = all YouTube keeps)
    autoCapture: true,         // source screenshots at each feed's CCV peaks and when it ends (Feed Meter)
    autoCaptureMin: 2,         // at most one CCV-peak screenshot per feed this often (2 or 4 in Settings)
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
    syncMarginSec: [0, 10],
    memLimitMB: [0, 16000],
    offloadEveryMin: [0, 1440],
    autoCaptureMin: [1, 60],
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
  // Sync: every live feed carries the same input, so the wall holds all of them at one delay.
  // Target = the slowest feed's edge delay + a margin; feeds ahead are held back (YouTube's
  // live rewind), feeds behind catch up. Small offsets close by playing 0.75× / 1.25×.
  const SYNC_TOLERANCE_S = 0.3;       // within this of the target counts as in sync
  // Further off than this: seek instead of changing speed. Seeks land on YouTube's segment
  // boundaries (measured: up to ~7 s short), so what a seek leaves over is closed by speed.
  const SYNC_NUDGE_MAX_S = 10;
  const SYNC_MAX_SPREAD_S = 15;       // a feed whose edge delay is this far past the others isn't allowed to drag them
  const SYNC_RETARGET_S = 0.5;        // the target only moves for a change bigger than this
  const SYNC_SLOW_RATE = 0.75;
  const SYNC_COOLDOWN_MS = 4000;      // after a correction, let the samples settle before the next
  const CATCHUP_RATE = 1.25;          // close small drift by playing faster instead of a visible jump
  const CATCHUP_MAX_DRIFT_S = 15;     // further behind than this: jump
  const CATCHUP_MAX_MS = 60000;       // a catch-up that hasn't finished by now becomes a jump
  const FROZEN_MS = 12000;            // "playing" but the playhead hasn't moved: the player froze
  const REBASELINE_LOG_GAP_MS = 120000;
  // Timelines: each feed's seek bar, and the wall's, which moves every live feed to the same
  // moment by YouTube's stamp on the frame (measured: position + a constant = the stamp, and
  // live rewind keeps up to 12 h). The sync controller then holds them there.
  const TIMELINE_SPANS = [5, 15, 60, 240, 0];
  const TIMELINE_LIVE_S = 2;          // dropped within this of the live edge: back to live
  const TIMELINE_STEP_S = 10;         // the wall timeline's back and forward buttons

  // Preset layouts (PIP): boxes that fill the screen, as on a broadcast multiviewer. Each is
  // drawn on its own small grid of `cols` × `rows` (cells are [col, row, colSpan, rowSpan]),
  // optionally with weighted rows; on screen every one maps onto a LAYOUT_UNITS × LAYOUT_UNITS
  // grid, since 1, 2, 3, 4 and 6 all divide 12. Feed 1 takes the biggest box; feeds past the
  // last box carry on below, so none stops being monitored.
  const LAYOUT_UNITS = 12;
  const evenCells = (cols, rows) => Array.from({ length: cols * rows }, (_, i) => [i % cols, Math.floor(i / cols), 1, 1]);
  const LAYOUT_PRESETS = [
    // The quick row under the wall
    { id: 'single', name: 'One feed', cols: 1, rows: 1, cells: evenCells(1, 1), quick: true },
    { id: 'stack-2', name: 'Two, stacked', cols: 1, rows: 2, cells: evenCells(1, 2), quick: true },
    { id: 'side-2', name: 'Two, side by side', cols: 2, rows: 1, cells: evenCells(2, 1), quick: true },
    { id: '2-over-1', name: 'Two over one wide', cols: 2, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 2, 1]], quick: true },
    { id: '2-beside-tall', name: 'Two beside one tall', cols: 2, rows: 2, cells: [[0, 0, 1, 1], [0, 1, 1, 1], [1, 0, 1, 2]], quick: true },
    { id: 'quad', name: 'Four (2 × 2)', cols: 2, rows: 2, cells: evenCells(2, 2), quick: true },
    // More layouts, in the order of the panel
    { id: '1-over-2', name: 'One wide over two', cols: 2, rows: 2, cells: [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
    { id: 'tall-beside-2', name: 'One tall beside two', cols: 2, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]] },
    { id: '3-over-1', name: 'Three over one wide', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 3, 1]] },
    { id: '1-over-3', name: 'One wide over three', cols: 3, rows: 2, cells: [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: '2-1-over-3', name: 'Wide and one over three', cols: 3, rows: 2, cells: [[0, 0, 2, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: '3-over-1-2', name: 'Three over one and wide', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 2, 1]] },
    { id: '2-beside-big', name: 'Two beside one big', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [0, 1, 1, 1], [1, 0, 2, 2]] },
    { id: 'big-beside-2', name: 'One big beside two', cols: 3, rows: 2, cells: [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1]] },
    { id: 'tall-beside-4', name: 'One tall beside four', cols: 3, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 1, 1], [2, 0, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'grid-3x2', name: 'Six (3 × 2)', cols: 3, rows: 2, cells: evenCells(3, 2) },
    { id: 'tall-center', name: 'One tall between four', cols: 3, rows: 2, cells: [[0, 0, 1, 1], [0, 1, 1, 1], [1, 0, 1, 2], [2, 0, 1, 1], [2, 1, 1, 1]] },
    { id: 'offset-2-2', name: 'Two wide, offset', cols: 3, rows: 2, cells: [[0, 0, 2, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 2, 1]] },
    { id: 'tall-wide-2', name: 'One tall, one wide, two', cols: 3, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 2, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'columns-3', name: 'Three columns', cols: 3, rows: 1, cells: evenCells(3, 1) },
    { id: 'rows-3', name: 'Three rows', cols: 1, rows: 3, cells: evenCells(1, 3) },
    { id: 'rows-3-split', name: 'Three rows, middle split', cols: 3, rows: 3, cells: [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 2, 1], [0, 2, 3, 1]] },
    { id: 'big-over-strip', name: 'One big over a strip', cols: 1, rows: 2, rowW: [3, 1], cells: evenCells(1, 2) },
    { id: 'tall-beside-3-rows', name: 'One tall beside three rows', cols: 3, rows: 3, cells: [[0, 0, 1, 3], [1, 0, 2, 1], [1, 1, 2, 1], [1, 2, 2, 1]] },
    { id: 'big-strip-tall', name: 'One big, a strip and one tall', cols: 3, rows: 3, cells: [[0, 0, 2, 2], [0, 2, 2, 1], [2, 0, 1, 3]] },
    { id: 'strip-over-3', name: 'A strip over three columns', cols: 3, rows: 2, rowW: [1, 3], cells: [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'big-over-3', name: 'One big over three', cols: 3, rows: 2, rowW: [2, 1], cells: [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'grid-3x3', name: 'Nine (3 × 3)', cols: 3, rows: 3, cells: evenCells(3, 3) },
    { id: '1-over-6', name: 'One wide over six', cols: 3, rows: 3, cells: [[0, 0, 3, 1], ...evenCells(3, 2).map(([c, r]) => [c, r + 1, 1, 1])] },
    { id: '6-over-1', name: 'Six over one wide', cols: 3, rows: 3, cells: [...evenCells(3, 2), [0, 2, 3, 1]] },
    { id: '2-big-over-8', name: 'Two big over eight', cols: 4, rows: 4, cells: [[0, 0, 2, 2], [2, 0, 2, 2], ...evenCells(4, 2).map(([c, r]) => [c, r + 2, 1, 1])] },
    { id: '8-over-2-big', name: 'Eight over two big', cols: 4, rows: 4, cells: [...evenCells(4, 2), [0, 2, 2, 2], [2, 2, 2, 2]] },
    { id: 'diagonal-2-big', name: 'Two big, corner to corner', cols: 4, rows: 4, cells: [[0, 0, 2, 2], [2, 0, 1, 1], [3, 0, 1, 1], [2, 1, 1, 1], [3, 1, 1, 1], [0, 2, 1, 1], [1, 2, 1, 1], [0, 3, 1, 1], [1, 3, 1, 1], [2, 2, 2, 2]] },
    { id: 'grid-4x4', name: 'Sixteen (4 × 4)', cols: 4, rows: 4, cells: evenCells(4, 4) },
  ];
  const CUSTOM_SIZES = [1, 2, 3, 4, 6]; // the builder's grid sizes: each divides LAYOUT_UNITS

  // Scroll mode and preset layouts give feeds on screen the chosen quality; fit mode keeps them at 480p.
  const onScreenQuality = () => settings.layoutMode === 'scroll' || settings.layoutMode === 'preset';

  // A saved custom layout, or null if it isn't a usable one: boxes inside the grid, not
  // overlapping, at least one.
  function validCustomLayout(c) {
    if (!c || !CUSTOM_SIZES.includes(c.cols) || !CUSTOM_SIZES.includes(c.rows) || !Array.isArray(c.cells)) return null;
    const used = new Set();
    const cells = [];
    for (const cell of c.cells.slice(0, c.cols * c.rows)) {
      if (!Array.isArray(cell) || cell.length !== 4 || !cell.every(Number.isInteger)) return null;
      const [x, y, w, h] = cell;
      if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > c.cols || y + h > c.rows) return null;
      for (let i = x; i < x + w; i++) {
        for (let j = y; j < y + h; j++) {
          if (used.has(`${i},${j}`)) return null;
          used.add(`${i},${j}`);
        }
      }
      cells.push([x, y, w, h]);
    }
    return cells.length ? { cols: c.cols, rows: c.rows, cells } : null;
  }

  // A layout's boxes in LAYOUT_UNITS, biggest first (then top to bottom, left to right):
  // that's the order feeds fill them, so feed 1 is always the main picture.
  function layoutUnits(layout) {
    const edges = (n, weights = Array(n).fill(1)) => {
      const total = weights.reduce((a, b) => a + b, 0);
      let run = 0;
      return [0, ...weights.map((w) => Math.round(((run += w) * LAYOUT_UNITS) / total))];
    };
    const xs = edges(layout.cols, layout.colW);
    const ys = edges(layout.rows, layout.rowW);
    return layout.cells
      .map(([c, r, w, h]) => [xs[c], ys[r], xs[c + w] - xs[c], ys[r + h] - ys[r]])
      .sort((a, b) => b[2] * b[3] - a[2] * a[3] || a[1] - b[1] || a[0] - b[0]);
  }

  // A page with fewer feeds than boxes: m feeds spread over the whole page instead of
  // leaving boxes empty. Rows get as equal a share as possible (5 feeds: 3 over 2), and
  // every row count divides 12, so the boxes land on whole units.
  function fillUnits(m) {
    const cols = m <= 1 ? 1 : m <= 4 ? 2 : m <= 9 ? 3 : 4;
    const rows = Math.ceil(m / cols);
    const rowH = LAYOUT_UNITS / rows;
    const units = [];
    for (let r = 0, y = 0; r < rows; r++, y += rowH) {
      const count = Math.floor(m / rows) + (r < m % rows ? 1 : 0);
      const w = LAYOUT_UNITS / count;
      for (let c = 0; c < count; c++) units.push([c * w, y, w, rowH]);
    }
    return units;
  }

  // A later page with fewer feeds than an even grid's boxes: m feeds in boxes of the grid's
  // own size [x, y, w, h], row after row; the last row's boxes widen to fill the width, and
  // the rows below the last are left out, so the page is only as tall as its feeds.
  function packUnits([, , w, h], m) {
    const cols = Math.max(1, Math.round(LAYOUT_UNITS / w));
    const units = [];
    for (let r = 0, y = 0; r * cols < m; r++, y += h) {
      const count = Math.min(cols, m - r * cols);
      for (let c = 0; c < count; c++) {
        const x0 = Math.round((c * LAYOUT_UNITS) / count);
        units.push([x0, y, Math.round(((c + 1) * LAYOUT_UNITS) / count) - x0, h]);
      }
    }
    return units;
  }

  // Presets whose boxes are all the same size (2 × 2, 3 × 3 …), as opposed to PIP shapes.
  const evenLayout = (units) => units.every(([, , w, h]) => w === units[0][2] && h === units[0][3]);

  // Performance governor: thresholds sustained for PERF_SUSTAIN_MS change the wall's level.
  const PERF_BUSY_CPU = 85;
  const PERF_OVERLOADED_CPU = 95;
  const PERF_BUSY_MEM = 93;           // past this Windows pages to disk, which stutters video
  const PERF_SUSTAIN_MS = 8000;
  const PERF_SHED_GAP_MS = 30000;
  const PERF_RESTORE_CALM_MS = 60000;
  const REFRESH_DEFER_MS = 120000;    // a busy laptop postpones scheduled refreshes by this...
  const REFRESH_DEFER_MAX_MS = 600000; // ...up to this much in total
  // Memory offload. The players of one YouTube site share one browser process, and that
  // process keeps what they build up: refreshing a player loads the new one into the same
  // process (measured: no smaller afterwards). A process gives its memory back only when it
  // ends, which Chrome does ~11 s after its last player closes (measured); a player opened
  // before then reuses it. So an offload moves the feeds one at a time onto the other site,
  // waits for the emptied process to end, and does the same the other way: every feed
  // restarts twice, each like a normal refresh, and both processes start fresh.
  const OFFLOAD_EMPTY_WAIT_MS = 20000; // after a site's last player closes, before reopening any there
  const OFFLOAD_MOVE_MIN_MS = 3000;    // at least this between two feeds' restarts
  const OFFLOAD_MOVE_MAX_MS = 15000;   // don't wait longer than this for a moved feed to start
  // The managed wall window's tab (the page and its players) is measured by the laptop
  // backend from Windows; a page can't read its own tab's memory. There, an offload starts
  // when the tab passes settings.memLimitMB; elsewhere, every settings.offloadEveryMin.
  const MEM_SETTLE_MS = 30000;        // measure this long after an offload ends
  const MEM_RELEASED_AT = 0.95;       // an offload worked if the tab is under 95% of the limit
  const MEM_RETRY_MS = 30 * 60000;    // after an offload that couldn't get under the limit
  const MEM_GROWTH_MB = 100;          // ...or once the tab grows this far past where it ended
  const BACKEND_STALE_MS = 8000;
  // IXG Wall Feed Meter (Chrome extension, extension/): reports from inside each player.
  const METER_STALE_MS = 8000;        // a report older than this no longer describes the feed
  const METER_HELLO_GAP_MS = 5000;    // how often a feed without reports asks again
  const HEADROOM_LOW = 1.2;           // connection under 1.2× the bitrate: stalls are coming

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
  const STARVED_CHECK_MS = 5 * 60000; // encoder sends nothing (YouTube says so): try the player again this often
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
    153: 'Missing referrer — YouTube needs the page address; open the wall over http(s), not as a file',
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, session, streams, savedSessions }));
      } catch {
        // storage unavailable: the backend copy (if any) still has it
      }
    },
    // This browser's copy, plus the backend's, which every window and profile shares.
    save() {
      if (merging) return; // taking another window's changes: nothing of ours to save
      store.saveLocal();
      clearTimeout(store.pushTimer);
      store.pushTimer = setTimeout(pushWall, 400);
    },
  };

  const settings = { ...DEFAULT_SETTINGS };
  // Sessions: `streams` are the active session's feeds, the only ones that load. Earlier
  // sessions keep their feeds in `savedSessions` until someone reopens one.
  const streams = [];
  let session = null;          // { id, name, startedAt }
  const savedSessions = [];    // [{ id, name, startedAt, endedAt, streams }], newest first
  const MAX_SAVED_SESSIONS = 50;
  const validStream = (s) => s && s.id && s.source?.kind === 'video' && VIDEO_ID.test(s.source.id);
  // Sessions are stamped in UTC (startedAt, endedAt) with the browser's time zone, and always
  // shown in local time: "Sat, 4 Oct 2026, 15:42 GMT+5:30".
  const LOCAL_ZONE = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
  })();
  function localStamp(iso, { zone = false, short = false, timeOnly = false } = {}) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '—';
    const opts = timeOnly ? { hour: '2-digit', minute: '2-digit' }
      : short ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    if (zone) opts.timeZoneName = 'short';
    return d.toLocaleString([], opts);
  }
  const newSession = (name) => {
    const startedAt = new Date().toISOString();
    return { id: uid(), name: name || `Session ${localStamp(startedAt)}`, startedAt, timeZone: LOCAL_ZONE };
  };

  function applyWall(data) {
    Object.assign(settings, DEFAULT_SETTINGS, data?.settings || {});
    for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
      settings[key] = clamp(Number(settings[key]), lo, hi, DEFAULT_SETTINGS[key]);
    }
    if (!['hd720', 'hd1080'].includes(settings.priorityQuality)) settings.priorityQuality = DEFAULT_SETTINGS.priorityQuality;
    if (!['scroll', 'fit', 'preset'].includes(settings.layoutMode)) settings.layoutMode = DEFAULT_SETTINGS.layoutMode;
    settings.customLayout = validCustomLayout(settings.customLayout);
    if (!(settings.layoutPreset === 'custom' ? settings.customLayout : LAYOUT_PRESETS.some((p) => p.id === settings.layoutPreset))) {
      settings.layoutPreset = DEFAULT_SETTINGS.layoutPreset;
    }
    if (!FEED_QUALITIES.includes(settings.feedQuality)) settings.feedQuality = DEFAULT_SETTINGS.feedQuality;
    settings.timelineSpanMin = Number(settings.timelineSpanMin);
    if (!TIMELINE_SPANS.includes(settings.timelineSpanMin)) settings.timelineSpanMin = DEFAULT_SETTINGS.timelineSpanMin;
    delete settings.ytApiKey; // walls saved before the key moved to the server carried it here
    const list = (Array.isArray(data?.streams) ? data.streams : []).filter(validStream);
    const saved = (Array.isArray(data?.savedSessions) ? data.savedSessions : [])
      .filter((s) => s && s.id && typeof s.name === 'string' && Array.isArray(s.streams))
      .map((s) => ({ ...s, streams: s.streams.filter(validStream) }));
    if (data?.session?.id) {
      session = {
        id: data.session.id,
        name: String(data.session.name || 'Session'),
        startedAt: data.session.startedAt || null,
        timeZone: data.session.timeZone || null,
      };
      streams.splice(0, streams.length, ...list);
    } else {
      // A wall from before sessions (this browser's copy, with the backend offline): as the
      // server does, its feeds become a saved session and the wall starts empty.
      if (list.length) saved.unshift({ ...newSession('Before sessions'), endedAt: new Date().toISOString(), streams: list });
      session = newSession();
      streams.length = 0;
    }
    savedSessions.splice(0, savedSessions.length, ...saved.slice(0, MAX_SAVED_SESSIONS));
  }
  applyWall(store.load());

  // ---- The server: what it is, and its copy of the wall -------------------------------
  // Hosted (a website) the server isn't the machine showing the wall: no laptop readouts or
  // wall window, and a sign-in. The YouTube key stays on the server; pages only learn
  // whether one is set (and its last 4 characters).
  // role: 'admin' (the wall password, or no sign-in at all) or 'user' (a user link). A user
  // gets the YouTube numbers but not the key, the OAuth client or the channel sign-ins.
  const server = { hosted: false, auth: false, role: 'admin', linkName: null, ytKey: { set: false, source: null, last4: '' } };
  const hasYtKey = () => !!server.ytKey?.set;
  const isAdmin = () => server.role !== 'user';

  function toSignIn() {
    const here = location.pathname + location.search;
    location.assign(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
  }

  // fetch() for the wall's own API: a lapsed sign-in sends the page to the sign-in screen.
  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) toSignIn();
    return res;
  }

  async function loadServerConfig() {
    if (location.protocol === 'file:') return;
    try {
      const res = await api('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (res.ok) Object.assign(server, await res.json()); // an older backend answers 404: laptop defaults
    } catch {
      // backend offline: laptop defaults
    }
    document.body.classList.toggle('hosted', server.hosted);
    document.body.classList.toggle('role-user', !isAdmin());
    $('#sign-out').hidden = !server.auth;
    // Who this window is signed in as, beside the Settings title.
    const $chip = $('#role-chip');
    $chip.hidden = !server.auth;
    setText($chip, isAdmin() ? 'Admin' : 'User');
    $chip.title = isAdmin() ? 'Signed in with the wall password' : `Signed in with the user link "${server.linkName || 'user'}"`;
    // Shown on every wall, so it can be found: without a password it says why links are off.
    $('#links-settings').hidden = !isAdmin();
    $('#link-form').hidden = !server.auth;
    $('#links-off').hidden = server.auth;
    if (server.auth && isAdmin()) loadLinks();
    setText($('#perf-title'), server.hosted ? 'This computer & rendering' : 'Laptop & rendering');
  }

  const clientId = uid();
  let wallVersion = 0;
  let backendWall = false; // the backend answered, so saves go to it
  let merging = false;     // another window's wall is being taken in (store.save is quiet)

  async function loadServerWall() {
    if (location.protocol === 'file:') return;
    try {
      const res = await api('/api/wall', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
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
      const res = await api('/api/wall', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify({ wall: { settings, session, streams, savedSessions }, clientId }),
      });
      if (res.ok) wallVersion = (await res.json()).version;
    } catch {
      // kept locally; the next save tries again
    }
  }

  // Another window saved the wall: take its changes in place, no reload. Players are keyed
  // by feed id, so feeds it added start, feeds it removed stop, and renames, reordering,
  // priority and settings apply while every other player plays on. A session switch
  // rebuilds the wall, as this window's own switch would.
  async function pullRemoteWall() {
    let body;
    try {
      const res = await api('/api/wall', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      body = await res.json();
    } catch {
      return false;
    }
    if (!body?.wall || body.version <= wallVersion) return true;
    merging = true;
    try {
      const before = { settings: { ...settings }, session, streams: streams.slice() };
      applyWall(body.wall);
      wallVersion = body.version;
      const changes = [];
      if (session.id !== before.session?.id) {
        teardownTiles();
        streams.forEach(addTile);
        changes.push(`session ${session.name}`);
      } else {
        // Keep the tiles' own stream objects: a tile is its stream's home.
        const kept = new Set();
        streams.forEach((s, i) => {
          const t = tiles.get(s.id);
          if (!t) return;
          kept.add(s.id);
          if (t.stream.source.id !== s.source.id) {
            t.changeSource(s.source);
            changes.push(`${s.label}: new link`);
          }
          if (t.stream.label !== s.label) {
            t.setLabel(s.label, !!s.autoLabel);
            changes.push(`renamed ${s.label}`);
          }
          if (!!t.stream.priority !== !!s.priority) {
            t.stream.priority = !!s.priority;
            changes.push(`${s.label}: priority ${s.priority ? 'on' : 'off'}`);
          }
          streams[i] = t.stream;
        });
        for (const [id, t] of [...tiles]) {
          if (kept.has(id)) continue;
          if (inspected === t) closeFeedSheet();
          t.unmount();
          tileObserver.unobserve(t.el);
          viewObserver.unobserve(t.el);
          t.el.remove();
          tiles.delete(id);
          const queued = loadQueue.indexOf(t);
          if (queued >= 0) loadQueue.splice(queued, 1);
          if (solo === t) solo = null;
          changes.push(`removed ${t.stream.label}`);
        }
        for (const s of streams) if (!tiles.has(s.id)) { addTile(s); changes.push(`added ${s.label}`); }
        const was = before.streams.map((s) => s.id).join();
        if (!changes.length && was !== streams.map((s) => s.id).join()) changes.push('feeds reordered');
      }
      for (const key of Object.keys(settings)) {
        if (JSON.stringify(settings[key]) === JSON.stringify(before.settings[key])) continue;
        applySetting(key);
        changes.push(`setting ${key}`);
      }
      syncSettingInputs();
      store.saveLocal();
      updateLayout();
      allocate();
      pumpQueue();
      updateSummary();
      renderSession();
      if (changes.length) logEvent(null, `Taken from another window: ${changes.slice(0, 6).join(', ')}${changes.length > 6 ? ` and ${changes.length - 6} more` : ''}`);
    } finally {
      merging = false;
    }
    return true;
  }

  // The wall's sync group, worked out every loop (updateSync).
  const sync = {
    target: null,          // seconds of delay every member is held at
    setBy: null,           // the tile whose edge delay sets it
    members: new Set(),
    excluded: new Map(),   // tile -> why it isn't synced
    spread: null,          // max − min delay across members right now
  };
  // The wall's timeline. Live (delay null) the sync controller sets its own target; moved back,
  // every live feed that can rewind is held this many seconds behind real time. Paused, they
  // stop at one stamp. Not saved: each window has its own, and a reloaded wall starts live.
  const timeline = {
    delay: null,
    paused: null,          // { stamp, tiles } while paused from the wall timeline
    liveDelay: null,       // where "live" sits on the wall timeline, in seconds of delay
  };
  const tiles = new Map(); // stream.id -> Tile
  const events = [];
  const activeAlerts = new Map(); // feed id -> the current alert and when it began
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
  let ytKeyError = '';       // why the last key save failed
  let backendYoutube = null; // false: the running backend predates YouTube polling (restart it)
  let viewerSeries = { id: null, series: [] }; // audience history for the inspected feed
  let inspected = null;      // tile whose feed stats sheet is open
  // Backend telemetry (CPU, memory, real network throughput, GPU engines) over SSE.
  const backend = { connected: false, latest: null, at: 0 };
  let cpuPressure = null;    // Compute Pressure API state for this browser: nominal…critical
  let decodeHere = null;     // 'hardware' | 'software' for this window, from MediaCapabilities
  const managedWindow = new URLSearchParams(location.search).get('wall') === 'managed';
  // Whether Chrome lets the players start audio for the Feed Meter's levels: after a click or
  // key on this page (the players are allowed autoplay, so the gesture counts for them), or
  // in the managed wall window, started without that rule. The meter waits for this.
  const audioAllowed = () => managedWindow || !!navigator.userActivation?.hasBeenActive;
  if (!managedWindow) {
    // Told once, on the first gesture the browser counts (Esc or a touch that scrolls don't).
    const GESTURES = ['pointerdown', 'pointerup', 'click', 'keydown'];
    const tellMeters = () => {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      for (const type of GESTURES) window.removeEventListener(type, tellMeters, { capture: true });
      for (const t of tiles.values()) {
        try { t.frame.querySelector('iframe')?.contentWindow?.postMessage({ type: 'ixg-wall-audio', v: 1 }, t.host); } catch { /* being replaced */ }
      }
    };
    for (const type of GESTURES) window.addEventListener(type, tellMeters, { capture: true, passive: true });
  }
  const perf = {
    level: 'ok',             // 'ok' | 'busy' | 'overloaded'
    reason: '',
    hotSince: 0,
    lastHotAt: 0,
    cap: Infinity,           // max priority boosts the laptop can carry right now
    lastCapChangeAt: 0,
  };
  const offload = {
    run: null,               // the offload in progress: its planned moves and where it's up to
    lastAt: Date.now(),      // when the last one finished (the page's start counts as fresh)
  };
  const memGuard = {
    release: null,           // { startMB } while an offload the limit started is under way
    floorMB: null,           // where the last offload that couldn't get under the limit ended
    retryAt: 0,
  };
  let solo = null;
  let ytReady = false;
  let loopTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $grid = $('#grid');
  const $empty = $('#empty');
  const $readout = {
    playing: $('#r-playing'), latency: $('#r-latency'), load: $('#r-load'),
    bwNow: $('#r-bw-now'), cpu: $('#r-cpu'), getting: $('#r-getting'),
  };
  const $addPanel = $('#add-panel');
  const $addToggle = $('#add-toggle');
  const $liveBadge = $('#live-badge');
  const $form = $('#add-form');
  const $source = $('#source');
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
  // A signed offset in seconds: +1.2s, −0.4s, ±0.0s.
  function fmtSigned(sec) {
    const v = Math.round(sec * 10) / 10;
    return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}s`;
  }

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
  // Time of day, to the second, of YouTube's stamp on a frame (epoch seconds).
  const stampClock = (stamp) => new Date(stamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function fmtCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // Link parsing and reading links out of pasted messages live in links.js.
  const { parseSource, readMessage, CHANNEL_LINK } = window.IXGLinks;

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

  function logEvent(tile, text, level = 'info', at = null) {
    events.unshift({ t: at ? new Date(at) : new Date(), id: tile?.stream.id, who: tile ? tile.stream.label : 'Wall', text, level });
    if (events.length > 300) events.length = 300;
    if (tile) tile.lastEvent = { t: Date.now(), text, level };
    renderLog();
  }

  function renderLog() {
    if ($('#wall-stats-panel').hidden) return;
    $log.replaceChildren(...logItems(events));
  }

  // Record state changes once, including short interruptions between health checks.
  // The active list stays separate from history, so clearing the log can't hide a fault.
  function syncWallAlerts() {
    for (const [id, tile] of tiles) {
      // A broadcast YouTube says is over has ended, not failed: logged once, never an alert.
      const over = tile.broadcastEnded();
      if (over && !tile.endedSeen) logEvent(tile, `Stream ended${over.at ? ` at ${clockTime(over.at)}` : ''}: YouTube says the broadcast is over`, 'warn');
      tile.endedSeen = !!over;
      // Paused from the wall timeline is an operator's choice, not a fault. An encoder that
      // stopped sending is one alert however often the held player changes state.
      const paused = tile.ps === PS.PAUSED && !tile.heldPaused();
      const starved = !over && !!ingestStoppedAt(tile.stream.source.id);
      const key = tile.error ? `error:${tile.error}` : starved ? 'no-ingest' : tile.ps === PS.BUFFERING && !over ? 'buffering' : paused ? 'paused' : null;
      if (!key) continue;
      const [label, level, text] = tile.status();
      const previous = activeAlerts.get(id);
      if (previous?.key === key) {
        previous.who = tile.stream.label;
        previous.label = label;
        previous.text = text;
        continue;
      }
      activeAlerts.set(id, { key, label, t: new Date(), who: tile.stream.label, text, level });
      logEvent(tile, text, level);
    }
    for (const [id, alert] of activeAlerts) {
      const tile = tiles.get(id);
      if (tile && (tile.error || (!tile.endedSeen && ingestStoppedAt(tile.stream.source.id)) || (tile.ps === PS.BUFFERING && !tile.endedSeen) || (tile.ps === PS.PAUSED && !tile.heldPaused()))) continue;
      activeAlerts.delete(id);
      const outcome = !tile ? 'feed removed from the wall' : tile.ps === PS.PLAYING ? 'playback resumed'
        : tile.endedSeen ? 'YouTube ended the broadcast' : 'player restarted or changed state';
      logEvent(tile || { stream: { id, label: alert.who } }, `${alert.label} alert cleared: ${outcome}.`);
    }
    renderActiveAlerts();
  }

  function renderActiveAlerts() {
    if ($('#wall-stats-panel').hidden) return;
    $('#alerts-empty').hidden = activeAlerts.size > 0;
    $('#active-alerts').replaceChildren(...logItems([...activeAlerts.values()].sort((a, b) => b.t - a.t)));
  }

  function logItems(list) {
    return list.map((e) => {
      const li = document.createElement('li');
      li.dataset.level = e.level;
      const time = document.createElement('time');
      time.textContent = e.t.toLocaleTimeString();
      time.dateTime = e.t.toISOString();
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
    // Enter in the field confirms. (Left to the form, it would press the first button: Cancel.)
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      $dialog.close('confirm');
    };
    if (input != null) $input.addEventListener('keydown', onKey);
    $dialog.returnValue = '';
    $dialog.showModal();
    if (input != null) $input.select();
    else $confirm.focus();
    return new Promise((resolve) => {
      $dialog.addEventListener('close', () => {
        $input.removeEventListener('keydown', onKey);
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
  }, { root: null }); // Page scrolling: visibility is relative to the browser viewport.
  // Info bar heights, from the stylesheet so CSS and the layout maths can't disagree.
  const rootPx = (name, fallback) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;
  const BAR_FULL_PX = rootPx('--bar-full', 51);
  const BAR_SLIM_PX = rootPx('--bar-slim', 33);
  const AUDIO_METER_PX = rootPx('--audio-meter-w', 44);
  const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  // Exact below 100,000 so small counts read precisely; 1.2M style above so they fit the panel.
  const fmtCount = (v) => (v == null || v === '' ? '—'
    : Number(v) < 100000 ? Number(v).toLocaleString('en-US') : compactNumber.format(Number(v)));

  class Tile {
    constructor(stream) {
      this.stream = stream;
      this.stats = { stalls: 0, stallMs: 0, resyncs: 0, reloads: 0, catchups: 0, rebaselines: 0, syncs: 0, lastStallAt: 0 };
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
      this.starvedSince = null; // when the encoder was first seen sending nothing (survives refreshes)
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
      this.own = null;       // { delay } once moved on its own timeline; survives refreshes
      // Balance feeds across the two embed hosts (one browser process each). During a memory
      // offload, a new feed joins the site feeds are moving to, not the one being emptied.
      const onFirst = [...tiles.values()].filter((t) => t.host === HOSTS[0]).length;
      this.host = offload.run?.target || (onFirst <= tiles.size - onFirst ? HOSTS[0] : HOSTS[1]);
      this.build();
      this.reset();
    }

    build() {
      this.el = tileTemplate.content.firstElementChild.cloneNode(true);
      this.frame = this.el.querySelector('.frame');
      this.$status = this.el.querySelector('.status');
      this.$statusText = this.el.querySelector('.status-text');
      this.$label = this.el.querySelector('.label');
      this.$audio = this.el.querySelector('.audio-meter');
      this.$audioBars = [...this.$audio.querySelectorAll('.audio-channel')];
      this.$audioState = this.$audio.querySelector('.audio-meter-state');
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
      this.$vital = {}; // the Delay and Behind edge / Sync labels, which read Time and Length for a recording
      this.el.querySelectorAll('[data-vital]').forEach((n) => { this.$vital[n.dataset.vital] = n.querySelector('dt'); });
      this.el.querySelectorAll('[data-yt]').forEach((n) => { this.$side[n.dataset.yt] = n; });
      this.$drops = [...this.el.querySelectorAll('.side [data-drop]')]
        .sort((a, b) => a.dataset.drop - b.dataset.drop);
      this.$tl = this.el.querySelector('.tile-tl');
      this.$shift = this.el.querySelector('.shift-tag');
      scrubber(this.$tl, {
        describe: (p) => this.describeAt(p),
        commit: (p) => {
          const v = this.timelineView();
          if (v) this.seekBar(v.left + p * (v.right - v.left));
        },
      });
      tileOf.set(this.el, this);
      tileObserver.observe(this.el);
      viewObserver.observe(this.el);
      this.$side.note.addEventListener('click', () => {
        if (!this.$side.note.hasAttribute('data-link') || !isAdmin()) return;
        setDrawer(true);
        $('#yt-key-input')?.focus();
      });

      this.el.querySelector('.shield').addEventListener('click', () => {
        if (!this.justDragged) toggleSolo(this);
      });
      this.el.querySelector('.tile-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'main') makeMain(this);
        else if (act === 'priority') togglePriority(this);
        else if (act === 'resync') this.resync('manual');
        else if (act === 'reload') this.reload('manual', 'info', true);
        else if (act === 'link') changeLink(this);
        else if (act === 'full') toggleFullscreen(this.el);
        else if (act === 'remove') removeTile(this);
      });
      this.el.querySelector('[data-act="stats"]').addEventListener('click', () => {
        if (inspected === this) closeFeedSheet();
        else openFeedSheet(this);
      });
      // Press anywhere on a feed and move it to drag the whole box to a new place on the wall
      // (feedDrag). A press that doesn't move stays a click: on the picture, it picks the audio.
      this.el.addEventListener('pointerdown', (e) => feedDragPress(this, e));
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

    // Point this feed at another video. It keeps its place, priority and any label an
    // operator gave it; telemetry starts over, since it described the old stream.
    changeSource(source) {
      const from = this.stream.source.id;
      this.stream.source = source;
      // A label taken from YouTube's title belonged to the old video: the new title replaces it on load.
      if (this.stream.autoLabel) this.setLabel(source.id, true);
      else store.save(); // the backend polls YouTube for the new video within seconds
      this.stats = { stalls: 0, stallMs: 0, resyncs: 0, reloads: 0, catchups: 0, rebaselines: 0, syncs: 0, lastStallAt: 0 };
      this.history = [];
      this.ttff = null;
      this.lastError = null;
      this.stuckStrikes = 0;
      this.starvedSince = null;
      this.retryDelay = RETRY_MIN_MS;
      this.deferredMs = 0;
      this.own = null; // a position on the old stream means nothing on the new one
      logEvent(this, `Link changed: ${from} → ${source.id}`);
      this.unmount();
      this.reset();
      requestMount(this, true);
      this.scheduleReload();
      this.pulse('reload');
      this.render();
      if (inspected === this) {
        renderFeedSheet();
        if (hasYtKey()) loadViewerHistory(this);
      }
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
      this.span = null;             // the live seek bar: { start, end, at, k, t } in player seconds
      this.catchUp = null;          // { since, from } while playing faster to close drift
      clearTimeout(this.nudgeTimer);
      this.nudge = null;            // { since, off, rate } while changing speed to reach the sync target
      this.lastSyncActAt = 0;
      this.preJumpLag = null;       // lag before our last jump, to check the jump helped
      this.lastCurrent = null;      // playhead position, to spot a frozen player
      this.lastAdvanceAt = now;
      this.meter = null;            // the Feed Meter extension's latest report for this player
      this.audio = null;
      this.lastHelloAt = 0;
    }

    mount() {
      const gen = ++this.gen;
      const iframe = document.createElement('iframe');
      iframe.src = embedSrc(this.stream.source, this.host);
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.title = this.stream.label;
      iframe.addEventListener('load', () => this.helloMeter());
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
      clearTimeout(this.nudgeTimer);
      this.nudge = null;
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

    // The Feed Meter extension (1.1+) is in this player and sets its quality when asked.
    // Then the wall sets every feed's quality directly; without it, quality follows the
    // player's render size, the only lever a page has.
    meterSetsQuality(now = Date.now()) {
      return !!this.meterNow(now)?.setsQuality;
    }

    // What a boost raises this feed to: the priority ceiling, or the quality feeds stream at
    // (whichever is higher for a priority feed). Without the Feed Meter, that quality only
    // applies to feeds on screen in scroll mode.
    boostQuality() {
      if (!onScreenQuality() && !this.meterSetsQuality()) return settings.priorityQuality;
      const q = settings.feedQuality;
      return this.stream.priority && rank(settings.priorityQuality) > rank(q) ? settings.priorityQuality : q;
    }

    // With the Feed Meter, every feed wants the chosen quality. Without it, priority feeds
    // do, and in scroll mode so do feeds on screen; a feed scrolled away keeps its boost for
    // a minute so scrolling past doesn't force refreshes.
    wantsBoost(now = Date.now()) {
      if (this.stream.priority || this.meterSetsQuality(now)) return true;
      if (!onScreenQuality()) return false;
      return this.inView || now - this.leftViewAt < OFFSCREEN_RELEASE_MS;
    }

    // With the Feed Meter: the chosen quality, or 480p while the link or laptop holds it back.
    // Without: the render size's quality, raised by a boost.
    targetQuality(boost = this.boosted) {
      const q = this.boostQuality();
      if (this.meterSetsQuality()) return boost ? q : EMBED_FLOOR;
      const natural = this.naturalQuality();
      return boost && rank(q) > rank(natural) ? q : natural;
    }

    // Asks the Feed Meter to hold this player at its target quality, until its reports show
    // it's holding that level (a reloaded player starts with no target and is asked again).
    sendQuality(now) {
      const m = this.meterNow(now);
      if (!m?.setsQuality) return;
      const want = this.targetQuality();
      if (m.qualityTarget === want || now - (this.qualitySentAt || 0) < 3000) return;
      this.qualitySentAt = now;
      try {
        this.frame.querySelector('iframe')?.contentWindow?.postMessage({ type: 'ixg-wall-quality', v: 1, quality: want }, this.host);
      } catch {
        // the frame is being replaced
      }
    }

    // Estimated Mbps this feed is pulling: the level the player reports, else the planned one.
    estMbps() {
      if (!this.mounted || this.error) return 0;
      return QUALITY[this.quality || this.targetQuality()].mbps;
    }

    // The Feed Meter extension's latest report for this player, while it is recent.
    meterNow(now = Date.now()) {
      return this.meter && now - this.meter.at < METER_STALE_MS ? this.meter : null;
    }

    // Asks the Feed Meter in this player (if installed) to report to this page.
    helloMeter() {
      this.lastHelloAt = Date.now();
      try {
        this.frame.querySelector('iframe')?.contentWindow?.postMessage({ type: 'ixg-wall-hello', v: 1, audio: audioAllowed() }, this.host);
      } catch {
        // the frame is being replaced
      }
    }

    // Mbps this feed streams at, and whether that's measured or estimated.
    bitrate(now = Date.now()) {
      const m = this.meterNow(now);
      if (m?.bitrateMbps != null) return { mbps: m.bitrateMbps, measured: true };
      return { mbps: this.estMbps(), measured: false };
    }

    // The player's connection speed over the stream's bitrate: below HEADROOM_LOW it can't keep up.
    headroom(now = Date.now()) {
      const m = this.meterNow(now);
      return m?.connectionMbps != null && m?.bitrateMbps ? m.connectionMbps / m.bitrateMbps : null;
    }

    // What the player streams: 1080p60 from the meter, else YouTube's quality level.
    qualityLabel(now = Date.now()) {
      const m = this.meterNow(now);
      if (m?.height) return `${m.height}p${m.fps && m.fps > 30 ? m.fps : ''}`;
      return this.quality ? QUALITY[this.quality].label : null;
    }

    // A tile wider than its 16:9 video moves the video left and fills the spare width with
    // the side card, which takes over the info bar's stats (the bar slims to the name row).
    // Decided from the tile's own size with the slim bar, so switching the card on never
    // changes the size that decided it.
    fit() {
      const w = this.el.clientWidth;
      const h = this.el.clientHeight;
      const spare = w - AUDIO_METER_PX - ((h - BAR_SLIM_PX) * 16) / 9;
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
      const iframe = this.frame.querySelector('iframe');
      const w = this.frame.clientWidth;
      const h = this.frame.clientHeight;
      if (!this.focused) this.gridWidth = w;
      if (!iframe) return;
      // The Feed Meter sets quality directly, so the player renders at its tile size.
      let renderW = this.boosted && !this.meterSetsQuality() ? QUALITY[this.boostQuality()].width / (window.devicePixelRatio || 1) : 0;
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
      // Players don't step down when shrunk, so releasing bandwidth takes a refresh, unless
      // the Feed Meter sets the quality: then the lower level is simply sent (sendQuality).
      if (this.meterSetsQuality()) return;
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
      // The seek bar, in the player's seconds (measured: seekableStart/End and current share
      // getCurrentTime's scale; seekableEnd is the live edge). k turns a position into
      // YouTube's real-time stamp on that frame: the same for every position in a stream.
      const stamp = Number.isFinite(ps.ingestionTime) && ps.ingestionTime > 1e9 ? ps.ingestionTime : null;
      this.span = Number.isFinite(ps.seekableStart) && Number.isFinite(ps.seekableEnd) && ps.seekableEnd > ps.seekableStart
        ? { start: ps.seekableStart, end: Math.max(ps.seekableEnd, ps.current), at: ps.current, k: stamp == null ? null : stamp - ps.current, t: Date.now() }
        : null;
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
      if (s !== PS.PLAYING && this.nudge) this.endNudge();
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
      syncWallAlerts();
      this.render();
    }

    onError(code) {
      this.endNudge();
      this.error = code;
      this.errorAt = Date.now();
      this.fatal = FATAL_ERRORS.has(code);
      this.lastError = { code, text: ERROR_TEXT[code] || 'Player error', at: this.errorAt };
      syncWallAlerts();
      setTimeout(pumpQueue, 0);
      this.render();
    }

    tick(now) {
      if (this.fatal || this.queued || !this.mounted) return this.render();
      // The meter may have loaded after the player, or the wall reloaded: keep asking.
      if (!this.meterNow(now) && now - this.lastHelloAt > METER_HELLO_GAP_MS) this.helloMeter();
      this.sendQuality(now);
      // A refresh would start a paused feed again at live: it waits until the wall plays.
      if (now >= this.nextReloadAt && (this.heldPaused() || this.starvedSince)) this.nextReloadAt = now + REFRESH_DEFER_MS;
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
      const idle = s === PS.UNSTARTED || s === PS.CUED || s === PS.ENDED;
      // YouTube has the broadcast on air but the encoder sends nothing (the channel sign-in
      // says so): the player can only buffer or end, and a refresh can't help. Hold it: no
      // refresh loop, one check every few minutes, and a restart the moment ingest resumes.
      const starvedAt = ingestStoppedAt(this.stream.source.id);
      if (starvedAt) {
        if (!this.starvedSince) {
          this.starvedSince = now;
          logEvent(this, 'No video arriving from the encoder: holding this player, checking every 5 min and the moment ingest resumes', 'warn');
        }
        if (now - this.starvedSince > STARVED_CHECK_MS && (s === PS.BUFFERING || idle)) {
          this.starvedSince = now;
          return this.reload('checking for video again');
        }
      } else if (this.starvedSince) {
        this.starvedSince = null;
        if (s !== PS.PLAYING) return this.reload('the encoder is sending again');
      }

      const stuckLimit = Math.min(STUCK_BUFFER_MS * 2 ** this.stuckStrikes, STUCK_BUFFER_MAX_MS);
      if (s === PS.BUFFERING && now - this.bufferingSince > stuckLimit && !starvedAt) {
        this.stuckStrikes++;
        return this.reload(`stuck buffering for ${Math.round((now - this.bufferingSince) / 1000)}s`, 'bad');
      }
      if (s === PS.PLAYING && now - this.playingSince > 60000) this.stuckStrikes = 0;
      if (s === PS.PAUSED && now - this.stateSince > PAUSE_RESUME_MS && !this.heldPaused()) this.player.playVideo();

      if (idle && !this.error && !this.kicked && now - this.stateSince > IDLE_KICK_MS) {
        this.kicked = true; // autoplay sometimes doesn't take when several players load at once
        this.player.playVideo();
      }
      const since = this.error ? this.errorAt : this.stateSince;
      if ((this.error || (idle && !starvedAt)) && now - since > this.retryDelay) {
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

      // Moved on its own timeline: held at that delay, however far back, never pulled to live.
      if (this.own) return this.keepInSync(now, this.own.delay);
      // In the wall's sync group the target is the shared delay, not this feed's own edge. With
      // the wall timeline moved back, that delay is far past MAX_LAG_S by design.
      if ((sane || wallShifted()) && sync.target != null && sync.members.has(this)) return this.keepInSync(now);

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

    // ---- Sync: hold this feed at the wall's shared delay ------------------------------
    // Seconds off the sync target: + late (more delay than the others), − early. Null when
    // this feed isn't in the sync group.
    syncOffset() {
      if (this.latency == null) return null;
      if (this.own) return this.latency - this.own.delay;
      return sync.target != null && sync.members.has(this) ? this.latency - sync.target : null;
    }

    // ---- Timeline: this feed's seek bar, and following the wall's ----------------------
    // Held behind live on purpose: on its own timeline, or following the wall's.
    held() {
      return !!this.own || (wallShifted() && sync.members.has(this));
    }

    // Paused from the wall timeline: it stays paused until the wall plays again.
    heldPaused() {
      return !!timeline.paused?.tiles.has(this);
    }

    // The seek bar's ends and the playhead, in the player's seconds. Live: what YouTube keeps,
    // ending at the live edge, cut to the wall's span. A recording: the whole video.
    timelineView() {
      if (!this.ready || !this.player || this.error) return null;
      if (this.isLive === false) {
        const ph = this.playhead();
        return ph?.length ? { live: false, left: 0, right: ph.length, at: Math.min(ph.at, ph.length) } : null;
      }
      const s = this.span;
      if (!s || !this.isLive) return null;
      let at = s.at;
      try {
        at = this.player.getCurrentTime();
      } catch {
        // between players: the last tick's position
      }
      // At the head YouTube reports the edge as the playhead; it moves on in real time.
      let right = Math.max(s.end, at);
      // Paused, YouTube stops moving the edge (measured), but live goes on: work it out from
      // the stamp and this feed's edge delay.
      if (this.ps === PS.PAUSED && s.k != null && Number.isFinite(this.baseline)) right = Math.max(right, Date.now() / 1000 - s.k - this.baseline);
      const want = settings.timelineSpanMin * 60;
      let left = want ? Math.max(s.start, right - want) : s.start;
      if (at < left + 5) left = Math.max(s.start, at - 30); // moved back past the span: show where it is
      return { live: true, left, right, at, k: s.k };
    }

    // Seconds behind its own live edge, while held there on purpose.
    behindLive() {
      if (!this.held()) return null;
      const v = this.timelineView();
      return v?.live ? Math.max(0, v.right - v.at) : null;
    }

    // What a point on the seek bar means, for the hover label.
    describeAt(p) {
      const v = this.timelineView();
      if (!v) return null;
      const pos = v.left + p * (v.right - v.left);
      if (!v.live) return `${fmtClock(pos)} / ${fmtClock(v.right)}`;
      const back = v.right - pos;
      const when = v.k != null ? ` · ${stampClock(pos + v.k)}` : '';
      return back < TIMELINE_LIVE_S ? `Live${when}` : `−${fmtClock(back)}${when}`;
    }

    // A click or drag on this feed's seek bar. A recording just seeks. A live feed moves onto
    // its own timeline and is held at that delay until it's dropped at live or jumped live.
    seekBar(pos) {
      if (!this.player || !this.ready || this.error) return;
      const now = Date.now();
      if (timeline.paused?.tiles.delete(this)) this.player.playVideo();
      const v = this.timelineView();
      if (!v?.live) {
        this.player.seekTo(pos, true);
        logEvent(this, `Timeline: to ${fmtClock(pos)}`);
        this.render();
        return;
      }
      if (v.right - pos < TIMELINE_LIVE_S || v.k == null) {
        this.resync('timeline: back to live');
        return;
      }
      this.own = { delay: now / 1000 - (pos + v.k) };
      updateSync(); // it leaves the wall's group
      this.endNudge();
      this.endCatchUp();
      this.preJumpLag = null;
      this.ignoreStallUntil = now + 8000;
      this.player.seekTo(pos, true);
      this.samples = [];
      this.playingSince = now;
      this.lastSyncActAt = now;
      logEvent(this, `Timeline: ${fmtClock(v.right - pos)} behind live, on its own timeline (${stampClock(pos + v.k)})`);
      this.pulse('resync');
      this.render();
    }

    // Moves the playhead to the frame YouTube stamped at this real time (epoch seconds).
    seekStamp(stamp, now) {
      if (!this.player || !this.ready || this.error) return false;
      const media = this.mediaTime();
      if (media == null) return false;
      this.endNudge();
      this.endCatchUp();
      this.preJumpLag = null;
      this.ignoreStallUntil = now + 8000;
      this.player.seekTo(this.player.getCurrentTime() + (stamp - media), true);
      this.samples = [];
      this.playingSince = now;
      this.lastSyncActAt = now;
      this.pulse('resync');
      return true;
    }

    renderTimeline() {
      const v = this.timelineView();
      this.$tl.hidden = !v;
      const back = this.behindLive();
      this.$shift.hidden = back == null;
      if (!v) return;
      this.$tl.style.setProperty('--at', String(clamp((v.at - v.left) / (v.right - v.left), 0, 1, 1)));
      this.$tl.dataset.state = v.live && !this.broadcastEnded() ? 'live' : 'ended';
      if (back != null) {
        setText(this.$shift, `${this.own ? 'Own ' : ''}−${fmtClock(back)}`);
        this.$shift.title = this.own
          ? 'Moved on its own seek bar: it stays this far behind live. Jump live on the feed to rejoin the wall'
          : 'Following the wall timeline';
      }
    }

    // Whether YouTube lets this broadcast be played behind its live edge (live rewind / DVR).
    allowsRewind() {
      return this.player?.getVideoData?.()?.allowLiveDvr;
    }

    keepInSync(now, target = sync.target) {
      if (this.catchUp) this.endCatchUp();
      if (this.nudge) return; // a speed nudge is running; it ends on its own
      const off = this.latency - target;
      // A feed refreshed while held back restarts at live: one sample is enough to see that.
      const enough = this.samples.length >= 3 || (this.held() && this.samples.length >= 1 && Math.abs(off) > SYNC_NUDGE_MAX_S);
      if (!enough || now - this.lastSyncActAt < SYNC_COOLDOWN_MS) return;
      if (Math.abs(off) <= SYNC_TOLERANCE_S || !settings.autoResync) return;
      const rate = off > 0 ? CATCHUP_RATE : SYNC_SLOW_RATE;
      const rates = this.player.getAvailablePlaybackRates?.() || [];
      if (Math.abs(off) <= SYNC_NUDGE_MAX_S && rates.includes(rate)) {
        this.startNudge(off, rate, now);
        return;
      }
      if (wall.autoJumpsLeft <= 0) return; // spread big corrections over ticks
      wall.autoJumpsLeft--;
      this.syncSeek(off, now, target);
    }

    // 1.25× gains 0.25 s of delay back per second; 0.75× gives 0.25 s away. The timer ends the
    // nudge exactly when the offset is closed, whatever the health-check interval.
    startNudge(off, rate, now) {
      try {
        this.player.setPlaybackRate(rate);
      } catch {
        return;
      }
      this.nudge = { since: now, off, rate };
      this.lastSyncActAt = now;
      this.stats.syncs++;
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.endNudge(), (Math.abs(off) / Math.abs(rate - 1)) * 1000);
      if (Math.abs(off) >= 1) logEvent(this, `Sync: ${off > 0 ? 'catching up' : 'easing back'} ${Math.abs(off).toFixed(1)}s at ${rate}×`);
    }

    endNudge() {
      clearTimeout(this.nudgeTimer);
      if (!this.nudge) return;
      this.nudge = null;
      try {
        this.player?.setPlaybackRate(1);
      } catch {
        // player is gone; a new one starts at normal speed
      }
      this.samples = []; // measure afresh at normal speed
      this.lastSyncActAt = Date.now();
    }

    // Late: forward (clamps at the live edge). Early: back into YouTube's live rewind.
    syncSeek(off, now, target = sync.target) {
      if (!this.player || !this.ready || this.error) return;
      this.endNudge();
      this.endCatchUp();
      // A sync seek aims behind the live edge, so its result cannot establish a new edge.
      this.preJumpLag = null;
      this.ignoreStallUntil = now + 8000;
      this.player.seekTo(this.player.getCurrentTime() + off, true);
      this.samples = [];
      // YouTube snaps seeks to segments. Keep the last measured delay until it reports
      // where it actually landed; a requested position isn't a measurement.
      this.playingSince = now;
      this.lastSyncActAt = now;
      this.stats.syncs++;
      logEvent(this, this.own
        ? `Timeline: ${off > 0 ? 'jumped forward' : 'went back'} ${Math.abs(off).toFixed(1)}s to its own position`
        : `Sync: ${off > 0 ? 'jumped forward' : 'held back'} ${Math.abs(off).toFixed(1)}s to the wall's ${target.toFixed(1)}s delay`);
      this.pulse('resync');
    }

    lagText() {
      return this.drift != null && this.latency <= MAX_LAG_S
        ? `+${this.drift.toFixed(1)}s behind edge`
        : `${Math.round(this.latency)}s delay`;
    }

    resync(reason) {
      // Off its own timeline: back to the wall (live, or where the wall timeline is).
      if (this.own) {
        this.own = null;
        updateSync();
      }
      if (!this.player || !this.ready || this.error || this.isLive === false) return;
      const now = Date.now();
      // In the sync group "live" means the wall's shared delay, not this feed's own edge.
      if (sync.target != null && sync.members.has(this) && this.latency != null) {
        this.endNudge();
        this.syncSeek(this.latency - sync.target, now);
        return;
      }
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

    reload(reason, level = 'info', front = false, { log = true } = {}) {
      this.stats.reloads++;
      this.deferredMs = 0;
      if (log) logEvent(this, `Refreshed player (${reason})`, level);
      timeline.paused?.tiles.delete(this); // it restarts playing; the wall picks it up when it plays
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
      // YouTube's own word on the broadcast (Data API, or the channel sign-in once the
      // encoder stops) sharpens what the player alone can say.
      const yt = this.ytInfo();
      const over = this.broadcastEnded();
      const ended = over ? `Broadcast ended${over.at ? ` at ${clockTime(over.at)}` : ''}` : '';
      const quietAt = ingestStoppedAt(this.stream.source.id);
      const noIngest = quietAt ? ['No ingest', 'bad', `The encoder stopped sending to YouTube at ${clockTime(quietAt)}, and YouTube still has the broadcast live: the fault is at the encoder, not this PC. The player is held, checked every 5 min and restarted the moment ingest resumes`] : null;
      switch (this.ps) {
        case PS.PLAYING:
          if (this.nudge) {
            return ['Syncing', 'ok', `Playing at ${this.nudge.rate}× to ${this.nudge.off > 0 ? 'catch up' : 'ease back'} ${Math.abs(this.nudge.off).toFixed(1)}s to the wall's sync delay`];
          }
          if (this.catchUp) return ['Catch-up', 'ok', `Playing at ${CATCHUP_RATE}× to release +${(this.catchUp.from || 0).toFixed(1)}s of build-up behind the live edge`];
          if (this.isLive && this.held()) {
            const back = this.behindLive();
            return ['Rewind', 'ok', `Playing ${back == null ? '' : `${fmtClock(back)} `}behind live, ${this.own ? 'on its own timeline: Jump live to rejoin the wall' : 'following the wall timeline'}`];
          }
          if (this.isLive) {
            const off = this.syncOffset();
            return ['Live', 'ok', off == null ? 'Playing live' : `Playing live, ${Math.abs(off) <= SYNC_TOLERANCE_S ? 'in sync with the wall' : `${fmtSigned(off)} off the wall's sync delay`}`];
          }
          if (ended) return ['Ended', 'warn', `${ended} · playing the recording`];
          return ['Playing', 'ok', yt?.startedAt ? 'Playing the recording of a broadcast' : 'Playing a video, not a live stream'];
        // A live broadcast that isn't moving is a red flag, never amber; one YouTube says is
        // over has simply ended.
        case PS.BUFFERING:
          if (ended) return ['Ended', 'warn', `${ended}: the stream is over`];
          if (noIngest) return noIngest;
          return this.countingStall
            ? ['Rebuffering', 'bad', 'Rebuffering: this PC\'s player ran out of downloaded video and stopped. Every second adds to Behind edge']
            : ['Buffering', 'bad', 'Buffering: loading video after a start or a jump; the picture has stopped'];
        case PS.PAUSED: return this.heldPaused()
          ? ['Paused', 'idle', 'Paused from the wall timeline: press play there to resume']
          : ['Paused', 'warn', 'Paused — resuming automatically'];
        case PS.ENDED:
          if (noIngest) return noIngest;
          if (ended) return ['Ended', 'warn', `${ended} · retrying in case it restarts`];
          // YouTube still lists it live: the player ran out of video, the broadcast isn't over.
          if (yt?.broadcast === 'live') return ['Live · no video', 'warn', 'YouTube has this broadcast live, but the player got no more video. Retrying; sign the channel in (Settings → YouTube API) to see the encoder\'s side'];
          return ['Ended', 'idle', 'Stream ended — retrying in case it restarts'];
        default:
          if (ended) return ['Ended', 'warn', `${ended}: the stream is over`];
          if (noIngest) return noIngest;
          if (yt?.broadcast === 'upcoming') return ['Scheduled', 'idle', yt.scheduledAt ? `Scheduled to start at ${clockTime(yt.scheduledAt)}` : 'Scheduled, not live yet'];
          return ['Waiting', 'idle', 'Waiting for the stream to start'];
      }
    }

    // What the YouTube Data API reports for this video, when there's a key and an answer.
    ytInfo() {
      if (!hasYtKey()) return null;
      const yt = ytStats.get(this.stream.source.id);
      return yt && !yt.missing ? yt : null;
    }

    // { at } once YouTube says the broadcast is over, else null (see broadcastOver).
    broadcastEnded() {
      return broadcastOver(this.stream.source.id);
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
      this.renderAudio(now);
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
      this.renderTimeline();
      if (this.sideOn) {
        this.renderSide(now);
        return;
      }
      // Info bar: every tile shows the same readings in the same order; '—' where one doesn't apply.
      const r = this.readings(now);
      const rec = this.isLive === false;
      const synced = this.syncOffset() != null;
      const labels = { latency: rec ? 'TIME' : 'DELAY', buffer: 'BUFFER', drift: rec ? 'LENGTH' : synced ? 'SYNC' : 'BEHIND', quality: 'Q', bitrate: 'RATE', stalls: 'REBUFFERS', jumps: 'JUMPS', reloads: 'REFRESHES', refresh: 'NEXT REFRESH' };
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
      const off = this.syncOffset();
      const offAbs = off == null ? null : Math.abs(off);
      return {
        // Delay: YouTube's stamp on the frame → this screen.
        latency: ph ? [fmtClock(ph.at), ''] : [this.latency == null ? '—' : `${this.latency.toFixed(1)}s`, ''],
        // Buffer ahead: downloaded here, not yet shown. Thin on a live broadcast means a stall is coming: red.
        buffer: [buf == null ? '—' : `${buf.toFixed(1)}s`, buf != null && buf < BUFFER_LOW_S ? 'bad' : ''],
        // In the sync group: the offset from the wall's shared delay. Otherwise: build-up behind the live edge.
        drift: ph ? [fmtClock(ph.length), '']
          : off != null ? [fmtSigned(off), offAbs <= SYNC_TOLERANCE_S ? 'ok' : offAbs <= 1 ? 'warn' : 'bad']
            : [d == null ? '—' : `+${d.toFixed(1)}s`, d == null ? '' : d < t / 2 ? 'ok' : d < t ? 'warn' : 'bad'],
        quality: [this.qualityLabel(now) || '—', ''],
        // Measured by the Feed Meter; red when the connection can't keep up with it.
        bitrate: (() => {
          const m = this.meterNow(now);
          const h = this.headroom(now);
          return [m?.bitrateMbps != null ? `${m.bitrateMbps.toFixed(1)} Mbps` : '—', h != null && h < HEADROOM_LOW ? 'bad' : ''];
        })(),
        stalls: [`${this.stats.stalls} · ${((this.stats.stallMs + ongoing) / 1000).toFixed(1)}s`, this.stallFlagged(now) ? 'bad' : ''],
        jumps: [String(this.stats.resyncs), ''],
        reloads: [String(this.stats.reloads), ''],
        refresh: [Number.isFinite(this.nextReloadAt) ? fmtCountdown(this.nextReloadAt - now) : 'Off', ''],
      };
    }

    // Side card: the status in large type with how long it has lasted and what it means,
    // the measured readings, then the audience numbers YouTube reports (Data API key needed).
    renderAudio(now = Date.now()) {
      const fresh = this.audio && now - this.audio.at < 1500 ? this.audio : null;
      // A completed broadcast can still have an actively playing recording.
      // The player report describes current audio; broadcast status describes its live run.
      const ended = !!this.broadcastEnded() && !this.mounted;
      const state = ended ? 'ended' : fresh?.status || 'unavailable';
      const channels = state === 'ok' ? fresh.channels : [];
      this.$audio.dataset.state = state;
      for (let i = 0; i < this.$audioBars.length; i++) {
        const value = channels[i];
        this.$audioBars[i].style.setProperty('--audio-level', String(value ? (value.rmsDb + 60) / 60 : 0));
        this.$audioBars[i].style.setProperty('--audio-peak', String(value ? (value.peakDb + 60) / 60 : 0));
      }
      const labels = { ended: 'End', idle: 'Idle', waiting: 'Wait', suspended: 'Enable', 'no-audio': 'None', unsupported: 'N/A', unavailable: 'N/A' };
      const peak = channels.length ? Math.max(...channels.map((c) => c.peakDb)) : null;
      setText(this.$audioState, peak == null ? labels[state] || 'N/A' : peak <= -60 ? '<−60' : peak.toFixed(0));
      const detail = channels.length
        ? `Audio levels (dBFS, before playback mute): L ${channels[0].rmsDb.toFixed(1)} RMS / ${channels[0].peakDb.toFixed(1)} peak; R ${channels[1].rmsDb.toFixed(1)} RMS / ${channels[1].peakDb.toFixed(1)} peak`
        : state === 'ended' ? 'Broadcast ended and no player is running'
          : state === 'suspended' ? 'Audio levels start after a click or key press anywhere on the wall (a browser rule), or straight away in the managed wall window.'
            : state === 'idle' ? 'Player paused: no current audio levels'
              : state === 'no-audio' ? 'No audio track available in this player'
                : 'Audio levels unavailable. Install or update IXG Wall Feed Meter 1.2.0, then refresh this feed.';
      this.$audio.title = detail;
      this.$audio.setAttribute('aria-label', `${this.stream.label}: ${detail}`);
    }

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
      const synced = this.syncOffset() != null;
      setText(this.$vital.latency, rec ? 'Time' : 'Delay');
      setText(this.$vital.drift, rec ? 'Length' : synced ? 'Sync' : 'Behind edge');
      this.$vital.drift.parentElement.title = this.own
        ? `Offset from the position this feed was moved to on its own seek bar (${this.own.delay.toFixed(1)}s delay)`
        : synced
        ? `Offset from the wall's sync delay (${sync.target.toFixed(1)}s): + has more delay than the others, − less. Green within ±${SYNC_TOLERANCE_S}s`
        : 'Behind edge: how far this PC\'s player sits behind the newest video YouTube has. Build-up the wall releases by catching up, jumping or refreshing';
      for (const [key, [value, valueTone]] of Object.entries(this.readings(now))) {
        setText(this.$play[key], value);
        setTone(this.$play[key], valueTone);
      }

      // YouTube: every block shows a number, or says plainly why there isn't one.
      const hasKey = hasYtKey();
      const entry = hasKey ? ytStats.get(this.stream.source.id) : null;
      const yt = entry && !entry.missing ? entry : null;
      const over = this.broadcastEnded();
      const ended = !!over;
      const upcoming = yt?.broadcast === 'upcoming';
      const liveNow = yt?.broadcast === 'live';
      const a = yt?.analysis || {};
      setText(p.tag, yt ? 'Measured' : 'N·A');

      const audience = audienceMetric(yt, ended);
      setText(p.audienceLabel, audience.label);

      let viewers = '—';
      let word = '';
      if (audience.value != null) viewers = fmtCount(audience.value);
      else if (ended) word = 'Not reported';
      else if (upcoming) word = 'Not live yet';
      else if (liveNow) word = 'Hidden or 0';
      else if (yt) word = 'Not live';
      setText(p.viewers, word || viewers);
      if (word) p.viewers.dataset.kind = 'word';
      else delete p.viewers.dataset.kind;
      p.viewers.title = audience.value != null ? `${fmtInt(audience.value)} ${ended ? 'total views' : 'watching now'}`
        : ended ? 'YouTube has not reported total views for this ended broadcast'
          : liveNow ? 'YouTube leaves the count out when nobody else is watching or the channel hides it'
          : word ? `No live viewers: ${word.toLowerCase()}` : 'Not reported';
      setText(p.viewersProv, yt ? (audience.value != null ? 'Measured' : 'N·A') : '');
      // Delta: the sign colours itself (up ok, down danger), as the SKWAD metric does.
      const pct = !ended && audience.value != null ? a.trendPct : null;
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
      const viewsCell = p.views.closest('.m');
      if (viewsCell.hasAttribute('data-empty') !== ended) {
        viewsCell.toggleAttribute('data-empty', ended);
        this.trimSide();
      }
      const start = yt?.startedAt ? Date.parse(yt.startedAt) : NaN;
      setText(p.uptimeLabel, ended ? 'Ran for' : upcoming ? 'Starts' : 'Live for');
      setText(p.uptime, upcoming && yt.scheduledAt ? clockTime(yt.scheduledAt)
        : Number.isFinite(start) ? fmtDuration((ended && over.at ? over.at : now) - start) : '—');
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
      // Encoder → YouTube, from the channel sign-in.
      const ing = ingestInfo(this.stream.source.id);
      setText(p.ingest, ing.text);
      setTone(p.ingest, ing.tone);
      p.ingest.title = ing.detail;

      let note = '';
      let noteTone = '';
      if (!hasKey) note = isAdmin() ? 'Add a YouTube API key in Settings for viewers and likes' : server.linkYoutube === false ? 'Your link was made without YouTube numbers' : 'YouTube numbers aren\'t set up on this wall';
      else if (ytStatsError) [note, noteTone] = ['YouTube API error: see Settings', 'bad'];
      else if (!entry) note = 'Waiting for YouTube…';
      else if (entry.missing) [note, noteTone] = ['YouTube has no public video with this ID', 'bad'];
      else if (ended) [note, noteTone] = [`Broadcast ended${over.at ? ` at ${clockTime(over.at)}` : ''}`, 'warn'];
      else if (upcoming) note = yt.scheduledAt ? `Scheduled for ${new Date(yt.scheduledAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'Scheduled, not live yet';
      else note = `Updated ${fmtDuration(now - ytStatsAt)} ago · every ${settings.ytPollSec} s`;
      setText(p.note, note);
      p.note.title = ytStatsError || '';
      p.note.toggleAttribute('data-link', !hasKey && isAdmin());
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
      if (t.boosted && !wanting.includes(t)) t.setBoost(false, onScreenQuality() ? 'scrolled out of view' : 'priority removed');
    }
  }

  // Several feeds stalling inside a minute points at our link rather than one source.
  // Shed one priority boost at a time while that lasts; restore one after 5 calm minutes.
  // Works out the wall's sync group and target. Every live feed that has found its edge
  // delay takes part, except one whose edge is so far behind the rest that syncing to it would
  // delay the whole wall, and one that would need holding back with YouTube's rewind turned off.
  function updateSync() {
    const before = new Set(sync.members);
    const previousTarget = sync.target;
    sync.members.clear();
    sync.excluded.clear();
    sync.spread = null;
    const nowS = Date.now() / 1000;
    const measured = [...tiles.values()].filter((t) => t.mounted && !t.error && t.isLive && Number.isFinite(t.baseline) && t.latency != null);
    for (const t of measured) if (t.own) sync.excluded.set(t, 'moved on its own seek bar; Jump live on the feed to rejoin the wall');
    const free = measured.filter((t) => !t.own);
    // Where "live" sits on the wall timeline: the delay sync holds live feeds at (the slowest
    // edge + the margin), or with sync off the middle of the feeds' own edges.
    const mid = free.length ? median(free.map((t) => t.baseline)) : null;
    const near = free.filter((t) => t.baseline - mid <= SYNC_MAX_SPREAD_S);
    timeline.liveDelay = !near.length ? null : settings.syncFeeds && near.length >= 2
      ? Math.max(...near.map((t) => t.baseline)) + settings.syncMarginSec
      : median(near.map((t) => t.baseline));

    // Moved back on the wall timeline: every feed that can rewind that far follows, sync or not.
    if (wallShifted()) {
      sync.target = timeline.paused ? nowS - timeline.paused.stamp : timeline.delay;
      sync.setBy = null;
      for (const t of free) {
        // How far back YouTube keeps this stream, in seconds of delay.
        const reach = t.span?.k != null ? nowS - (t.span.start + t.span.k) : Infinity;
        if (t.allowsRewind() === false) sync.excluded.set(t, 'YouTube\'s live rewind (DVR) is off for this broadcast, so it stays live');
        else if (timeline.paused && !timeline.paused.tiles.has(t)) sync.excluded.set(t, 'it started after the wall was paused; it follows once the wall plays');
        else if (reach < sync.target - SYNC_TOLERANCE_S) sync.excluded.set(t, `YouTube keeps only the last ${fmtClock(reach)} of it, so it can't go back that far`);
        else if (t.baseline > sync.target + SYNC_TOLERANCE_S) sync.excluded.set(t, `its own live edge is ${(t.baseline - sync.target).toFixed(1)}s later than the wall timeline`);
        else sync.members.add(t);
      }
      measureSyncSpread();
      for (const t of tiles.values()) {
        if (!settings.autoResync || previousTarget !== sync.target || (before.has(t) && !sync.members.has(t))) t.endNudge();
      }
      return;
    }

    const ready = settings.syncFeeds ? free : [];
    let candidates = [];
    if (ready.length >= 2) {
      const mid = median(ready.map((t) => t.baseline));
      candidates = ready.filter((t) => {
        const over = t.baseline - mid;
        if (over <= SYNC_MAX_SPREAD_S) return true;
        sync.excluded.set(t, `its edge delay is ${Math.round(over)} s more than the other feeds; syncing to it would delay the whole wall`);
        return false;
      });
    }
    if (candidates.length >= 2) {
      const slowest = candidates.reduce((a, b) => (b.baseline > a.baseline ? b : a));
      const target = slowest.baseline + settings.syncMarginSec;
      // Hold the target steady: chasing every 0.1 s wobble would keep feeds changing speed.
      if (sync.target == null || Math.abs(target - sync.target) > SYNC_RETARGET_S || !tiles.has(sync.setBy?.stream.id)) {
        sync.target = target;
      }
      sync.setBy = slowest;
      for (const t of candidates) {
        const needsHoldingBack = t.baseline < sync.target - SYNC_TOLERANCE_S;
        if (needsHoldingBack && t.allowsRewind() === false) {
          sync.excluded.set(t, 'YouTube\'s live rewind (DVR) is off for this broadcast, so it can\'t be held back');
        } else {
          sync.members.add(t);
        }
      }
    }
    if (sync.members.size < 2) {
      sync.members.clear();
      sync.target = null;
      sync.setBy = null;
    }
    measureSyncSpread();
    // A feed that left the group goes back to its own live edge.
    // Timed nudges were calculated for the old target. Stop them before correcting
    // toward a new one, or they keep pushing a feed in the wrong direction.
    for (const t of tiles.values()) {
      if (!settings.autoResync || previousTarget !== sync.target || (before.has(t) && !sync.members.has(t))) t.endNudge();
    }
  }

  // How far apart the synced feeds are; measured again after each round of corrections.
  function measureSyncSpread() {
    const delays = [...sync.members].map((t) => t.latency).filter((v) => v != null);
    sync.spread = sync.target != null && delays.length >= 2 ? Math.max(...delays) - Math.min(...delays) : null;
  }

  // The wall timeline is off live: moved back, or paused.
  function wallShifted() {
    return timeline.delay != null || !!timeline.paused;
  }

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
    if (hasYtKey()) loadViewerHistory(tile);
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
    const off = t.syncOffset();
    const excludedWhy = sync.excluded.get(t);
    const behindHeld = off != null && t.drift != null;
    fillKv($('#fs-health'), [
      ['Status', detail, tone === 'idle' ? '' : tone],
      // Delay = Edge delay (YouTube's side) + Behind edge (this PC).
      ['Delay · whole chain', t.latency == null ? null : `${t.latency.toFixed(1)}s from YouTube's stamp to this screen`],
      ['Edge delay · YouTube side', Number.isFinite(t.baseline) ? `${t.baseline.toFixed(1)}s, the least this feed can have` : null],
      ['Behind edge · this PC', t.drift == null ? null
        : `+${Math.max(0, t.drift).toFixed(1)}s${behindHeld ? ', held there to stay in sync' : ''}`,
      t.drift == null || behindHeld ? '' : t.drift < t2 / 2 ? '' : t.drift < t2 ? 'warn' : 'bad'],
      ['Sync · wall', off != null
        ? `${fmtSigned(off)} from ${t.own ? 'its own timeline position' : `the wall's ${sync.target.toFixed(1)}s`}${Math.abs(off) <= SYNC_TOLERANCE_S ? ' · in sync' : ''}`
        : !settings.syncFeeds ? 'Off' : excludedWhy ? `Not synced: ${excludedWhy}` : t.isLive ? 'Waiting for a second live feed to sync with' : 'Not live',
      off == null ? (excludedWhy ? 'warn' : '') : Math.abs(off) <= SYNC_TOLERANCE_S ? 'ok' : Math.abs(off) <= 1 ? 'warn' : 'bad'],
      ['Buffer ahead · this PC', buf == null ? null : `${buf.toFixed(1)}s downloaded, waiting to play`,
        buf == null ? '' : buf < BUFFER_LOW_S ? 'bad' : 'ok'],
      ['Rebuffering · this PC', `${t.stats.stalls} times · ${((t.stats.stallMs + ongoing) / 1000).toFixed(1)}s stopped`, t.stallFlagged(now) ? 'bad' : ''],
      ['Last rebuffer', ongoing ? 'Now' : t.stats.lastStallAt ? `${fmtDuration(now - t.stats.lastStallAt)} ago` : 'None',
        t.stallFlagged(now) ? 'bad' : ''],
      ['Rebuffers per hour', hoursOnWall > 0.05 ? (t.stats.stalls / hoursOnWall).toFixed(1) : null],
      ['Sync corrections', String(t.stats.syncs)],
      ['Build-up released', `${t.stats.catchups} catch-ups at ${CATCHUP_RATE}× · ${t.stats.resyncs} jumps`],
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
    const m = t.meterNow(now);
    const rate = t.bitrate(now);
    const head = t.headroom(now);
    const dropPct = m?.framesTotal ? (m.framesDropped / m.framesTotal) * 100 : null;
    fillKv($('#fs-network'), [
      ['Streaming now', t.qualityLabel(now), '', m?.height ? 'Measured' : ''],
      ['Bitrate', t.mounted && !t.error ? `${rate.mbps.toFixed(1)} Mbps` : null, head != null && head < HEADROOM_LOW ? 'bad' : '',
        rate.measured ? 'Measured' : 'Estimated'],
      ['Receiving', m?.receivedMbps != null ? `${m.receivedMbps.toFixed(1)} Mbps over the last 30 s` : null, '', m ? 'Measured' : 'N·A'],
      ['Connection speed', m?.connectionMbps != null
        ? `${m.connectionMbps.toFixed(1)} Mbps${head != null ? ` · ${head.toFixed(1)}× the bitrate` : ''}` : null,
      head == null ? '' : head < HEADROOM_LOW ? 'bad' : head < 2 ? 'warn' : 'ok', m ? 'Measured' : 'N·A'],
      ['Latency mode', m?.latencyMode ? LATENCY_MODE_TEXT[m.latencyMode] : m?.latencyModeText || null, m?.latencyMode === 'normal' ? 'warn' : ''],
      ['Dropped frames', dropPct == null ? null : `${fmtInt(m.framesDropped)} of ${fmtInt(m.framesTotal)} (${dropPct.toFixed(1)}%)`,
        dropPct == null ? '' : dropPct >= 1 ? 'bad' : dropPct > 0.1 ? 'warn' : ''],
      ['Formats', m?.codecs || null],
      ['Feed Meter', m ? `Reporting · extension ${meterSeen.version || ''}`.trim()
        : meterActive() ? 'Installed, no report from this player yet' : 'Not installed in this browser: bitrate is estimated',
      m ? 'ok' : 'warn'],
      ['Best the source offers', best ? QUALITY[best].label : null],
      t.meterSetsQuality(now)
        ? ['Quality target', `${QUALITY[t.targetQuality()].label} · set by Feed Meter${t.boosted ? '' : ` · held: ${t.heldReason || 'waiting'}`}${t.meter.qualityApplied && t.meter.qualityApplied !== t.targetQuality() ? ` · stream offers ${QUALITY[t.meter.qualityApplied].label}` : ''}`, t.boosted ? '' : 'warn']
        : ['Render target', `${QUALITY[t.targetQuality()].label} · ${t.boosted ? (t.stream.priority ? 'priority boost' : 'on screen') : 'tile size'}`],
      ['Priority', !t.stream.priority ? 'Off' : t.boosted ? 'Boosted' : `Held · ${t.heldReason || 'waiting'}`,
        t.stream.priority && !t.boosted ? 'warn' : ''],
      ['Embed host', host],
      ['Load', t.queued ? `Queued #${loadQueue.indexOf(t) + 1}` : t.mounted ? 'Loaded' : 'Not loaded'],
      ['Wall link', wall.congested ? `Congested · ${stalledFeeds} feeds stalled in 1 min`
        : Number.isFinite(wall.boostCap) ? `Recovering · ${wall.boostCap} boosts allowed` : 'Calm',
      wall.congested ? 'bad' : Number.isFinite(wall.boostCap) ? 'warn' : 'ok'],
    ]);

    const ing = ingestInfo(t.stream.source.id);
    const iv = ing.v;
    const SEVERITY = { error: ['YouTube error', 'bad'], warning: ['YouTube warning', 'warn'], info: ['YouTube note', ''] };
    fillKv($('#fs-ingest'), [
      ['Health', ing.text, ing.tone, iv?.health ? 'Measured' : 'N·A'],
      ['Stream status', iv?.streamStatus || null],
      ['Broadcast', iv?.broadcast ? `${iv.broadcast}${iv.endedAt ? ` · ended ${clockTime(iv.endedAt)}` : ''}` : null],
      ...(iv?.quietSince ? [['Encoder stopped', clockTime(iv.quietSince), ingestStoppedAt(t.stream.source.id) ? 'bad' : '']] : []),
      ...(iv?.checkedAt ? [['YouTube asked', `${fmtDuration(Math.max(0, now - iv.checkedAt))} ago`]] : []),
      ['Resolution', iv?.resolution || null],
      ['Frame rate', iv?.frameRate || null],
      ['Ingestion', iv?.ingestion ? iv.ingestion.toUpperCase() : null],
      ['Health updated', iv?.healthAt ? `${fmtDuration(Math.max(0, now - iv.healthAt))} ago` : null],
      ...(iv?.issues || []).map((x) => [...(SEVERITY[x.severity] || ['YouTube note', '']).slice(0, 1), x.description || x.reason,
        (SEVERITY[x.severity] || [])[1] || '']),
    ]);
    setText($('#fs-ingest-hint'), ing.detail);

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

  // Live audience and accumulated views are separate metrics, never added together.
  function audienceMetric(yt, ended = false) {
    const over = ended || !!yt?.endedAt;
    return { label: over ? 'Views' : 'CCV', value: over ? yt?.views ?? null : yt?.broadcast === 'live' ? yt.viewers ?? null : null };
  }

  function wallAudience(list) {
    const reports = [...new Set(list.map((t) => t.stream.source.id))]
      .map((id) => ({ yt: ytStats.get(id), ended: !!broadcastOver(id) }))
      .filter(({ yt }) => yt && !yt.missing);
    const live = reports.filter(({ yt, ended }) => !ended && yt.broadcast === 'live');
    const ended = reports.filter((v) => v.ended || v.yt.endedAt);
    const chosen = live.length ? live : ended;
    const values = chosen.map((v) => audienceMetric(v.yt, v.ended).value).filter((v) => v != null);
    return {
      label: live.length || !ended.length ? 'CCV' : 'Views',
      value: values.length ? values.reduce((sum, v) => sum + Number(v), 0) : null,
      reported: values.length,
      feeds: chosen.length,
    };
  }

  // YouTube analytics for one feed: what YouTube reports now, plus the backend's audience
  // history (peak, average, lowest, trend, growth per hour) since it started tracking.
  function renderAnalytics(t, now) {
    const id = t.stream.source.id;
    const ytEntry = ytStats.get(id);
    const yt = ytEntry?.missing ? null : ytEntry;
    const a = yt?.analysis || {};
    const hasKey = hasYtKey();
    const ended = !!t.broadcastEnded();
    const audience = audienceMetric(yt, ended);
    $('#fs-key-form').hidden = hasKey;
    $('#fs-viewers-fig').hidden = !hasKey;
    setText($('#fs-aud-tag'), hasKey && yt ? 'Measured' : 'N·A');
    const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const rate = (v) => (v == null ? '' : ` · ${v >= 0 ? '+' : '−'}${fmtCount(Math.abs(v))}/h`);
    const trend = a.trendPct == null ? '' : ` · ${a.trendPct > 0 ? '+' : a.trendPct < 0 ? '−' : '±'}${Math.abs(a.trendPct)}% in ${a.trendMins} min`;
    fillKv($('#fs-audience'), hasKey ? [
      [audience.label, audience.value != null ? `${fmtInt(audience.value)}${ended ? '' : trend}`
        : ended ? 'Not reported' : yt?.broadcast === 'live' ? 'Hidden or 0: YouTube leaves it out' : null],
      ['Peak', a.peak != null ? `${fmtInt(a.peak)} at ${time(a.peakAt)}` : null],
      ['Average', fmtInt(a.avg)],
      ['Lowest', fmtInt(a.low)],
      ['Likes', yt?.likes != null ? `${fmtInt(yt.likes)}${rate(a.likesPerHour)}` : null],
      ...(!ended ? [['Views', yt?.views != null ? `${fmtInt(yt.views)}${rate(a.viewsPerHour)}` : null]] : []),
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
      ? isAdmin() ? 'Paste a YouTube Data API key to see live viewers, likes, views and comments for every feed, with peak, average and trend. Without one nothing here is shown; nothing is guessed.'
        : server.linkYoutube === false ? 'Your link was made without YouTube numbers: the wall\'s admin can make one that ships them. Nothing here is guessed.' : 'YouTube numbers aren\'t set up on this wall: the wall\'s admin can turn them on. Nothing here is guessed.'
      : ytState?.status === 'error' ? `YouTube Data API: ${ytState.error}`
        : ytEntry?.missing ? 'YouTube returned nothing for this ID: the video is deleted, private or mistyped.'
          : yt ? `Reported by YouTube · updated ${fmtDuration(now - ytStatsAt)} ago · polled once a minute by the backend`
            : 'Waiting for the first YouTube Data API response.');
  }

  async function loadViewerHistory(tile) {
    const id = tile.stream.source.id;
    try {
      const res = await api(`/api/youtube/history?id=${encodeURIComponent(id)}`);
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
    if (state.key) {
      const was = server.ytKey;
      server.ytKey = state.key; // another window may have saved or removed the key
      if (was.set !== state.key.set || was.last4 !== state.key.last4) syncSettingInputs();
    }
    ytStats.clear();
    for (const [id, v] of Object.entries(state.videos || {})) ytStats.set(id, v);
    ingestState = state.ingest || null;
    renderIngestSettings();
    ytStatsAt = state.updatedAt || 0;
    const err = state.status === 'error' ? state.error : '';
    if (err && err !== ytStatsError) logEvent(null, `YouTube Data API: ${err}`, 'warn');
    ytStatsError = err;
    updateSummary();
    renderYtStatus();
    const now = Date.now();
    for (const t of tiles.values()) t.renderSide(now);
    if (inspected) loadViewerHistory(inspected); // re-renders the sheet with the new reading
    takeAutoCapture(); // a CCV peak or an ended stream the backend queued
    // The backend's record of what it queued, dropped, saved or failed: into this window's
    // event log, except what this window did itself (already logged as it happened).
    if (state.captureLogBoot && state.captureLogBoot !== captureLogBoot) {
      // A restarted backend numbers its record afresh: read it from the start.
      captureLogBoot = state.captureLogBoot;
      captureLogSeen = 0;
    }
    const entries = Array.isArray(state.captureLog) ? state.captureLog.filter((e) => e && e.seq > captureLogSeen) : [];
    for (const e of entries) {
      captureLogSeen = Math.max(captureLogSeen, e.seq);
      if (e.client && e.client === clientId) continue;
      const tile = [...tiles.values()].find((t) => t.stream.source.id === e.id);
      logEvent(tile || { stream: { id: null, label: String(e.label || e.id || 'Feed').slice(0, 80) } }, String(e.text || '').slice(0, 400), ['info', 'warn', 'bad'].includes(e.level) ? e.level : 'info', e.t);
    }
  }

  // Saved from Settings (Save key / Enter) or the Stats sheet. An empty key turns stats off.
  // The key goes to the server, which keeps it and checks it with YouTube within seconds;
  // it is never stored in this page or the wall.
  async function saveYtKey(raw) {
    const key = String(raw || '').trim();
    ytKeyError = '';
    try {
      const res = await api('/api/youtube/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.ytKey) server.ytKey = body.ytKey;
      if (!res.ok) {
        ytKeyError = res.status === 404
          ? 'The running backend is older than this page: close the black "IXG Wall backend" window, then start the wall again.'
          : body.error || `Could not save the key (HTTP ${res.status}).`;
      }
    } catch {
      ytKeyError = 'Backend offline: the key could not be saved.';
    }
    if (!ytKeyError) {
      $('#yt-key-input').value = '';
      $('#fs-key').value = '';
    }
    onYtKeyChanged();
    return !ytKeyError;
  }

  function onYtKeyChanged() {
    syncSettingInputs();
    ytStats.clear();
    ytStatsError = '';
    ytChecking = hasYtKey() && !ytKeyError;
    renderYtStatus();
    updateSummary();
    renderFeedSheet();
    const now = Date.now();
    for (const t of tiles.values()) t.renderSide(now);
  }

  // Does the running backend poll YouTube? One started before that existed answers 404,
  // and would otherwise leave the key on "Checking…" forever.
  async function probeYouTubeBackend() {
    try {
      const res = await api('/api/youtube', { cache: 'no-store' });
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
    const hasKey = hasYtKey();
    let text;
    let tone = '';
    if (ytKeyError) [text, tone] = [ytKeyError, 'bad'];
    else if (!hasKey) text = 'No key: audience numbers are off.';
    else if (backendYoutube === false) {
      [text, tone] = ['Key saved, but the running backend is older than YouTube support. Close the black "IXG Wall backend" window, then start the wall again (Start IXG Wall.cmd or npm run wall).', 'bad'];
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

  // This computer's CPU and memory: the backend's Windows counters on a laptop wall, else
  // what the Feed Meter (1.4+) reads through Chrome, which is how a website wall gets them.
  // The wall asks one of its players every loop; the courier relays (extension/courier.js).
  const pc = { at: 0, cpu: null, cores: null, memUsedPct: null, memTotalGB: null };
  function machine() {
    const t = backendFresh() && !server.hosted ? backend.latest : null;
    if (t && (t.cpu != null || t.memUsedPct != null)) return { cpu: t.cpu, cores: t.cores, memUsedPct: t.memUsedPct, memTotalGB: t.memTotalGB, source: 'backend' };
    if (Date.now() - pc.at < 6000 && (pc.cpu != null || pc.memUsedPct != null)) return { ...pc, source: 'meter' };
    return null;
  }
  function pollMachine() {
    if (!meterActive()) return;
    const c = courierFrame();
    if (c) c.win.postMessage({ type: 'ixg-wall-pc', v: 1 }, c.origin);
  }

  function updatePerf(now) {
    const t = machine();
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

  // ---------------------------------------------------------------------------
  // Memory offload: gives the players' memory back by moving every feed onto fresh browser
  // processes (see OFFLOAD_* above). Started when the managed wall window's measured tab
  // passes settings.memLimitMB, on a timer where memory can't be measured, or by hand.
  // ---------------------------------------------------------------------------
  // The wall window's tab memory in MB, or null where it can't be measured.
  function wallTabMemory() {
    if (!managedWindow || !backendFresh()) return null;
    const mb = backend.latest?.wallMem?.tabMB;
    return Number.isFinite(mb) ? mb : null;
  }

  // Plans the moves: site A's feeds over to B (A's process ends), then every feed onto a
  // fresh A (B's process ends), then B's own feeds back to a fresh B, as balanced as before.
  // The feed being listened to moves last in each step.
  function startOffload(reason, now = Date.now()) {
    if (offload.run || !tiles.size) return false;
    const [a, b] = HOSTS;
    const order = (list) => list.sort((x, y) => (x === solo) - (y === solo));
    const all = [...tiles.values()];
    const onA = order(all.filter((t) => t.host === a));
    const onB = order(all.filter((t) => t.host === b));
    const actions = [];
    const step = (list, to) => {
      if (!list.length) return;
      if (actions.length) actions.push({ wait: OFFLOAD_EMPTY_WAIT_MS }); // let the emptied process end
      for (const tile of list) actions.push({ tile, to });
    };
    step(onA, b);
    step(order([...onA, ...onB]), a);
    step(onB, b);
    offload.run = { reason, startedAt: now, actions, step: 0, waitUntil: 0, moving: null, movedAt: 0, moves: 0, target: null };
    logEvent(null, `Offloading memory (${reason}): moving each feed to a fresh browser process, one at a time`);
    renderOffloadButton();
    return true;
  }

  // One move at a time: the next feed restarts once the last one is playing again.
  function updateOffload(now) {
    const run = offload.run;
    if (!run || now < run.waitUntil) return;
    const m = run.moving;
    if (m) {
      const starting = tiles.has(m.stream.id) && (m.queued || (m.mounted && !m.playedOnce && !m.error));
      if (now - run.movedAt < OFFLOAD_MOVE_MIN_MS || (starting && now - run.movedAt < OFFLOAD_MOVE_MAX_MS)) return;
      run.moving = null;
    }
    while (run.step < run.actions.length) {
      const action = run.actions[run.step++];
      if (action.wait) {
        run.waitUntil = now + action.wait;
        return;
      }
      const t = action.tile;
      run.target = action.to; // feeds added meanwhile start here, not on the site being emptied
      if (!tiles.has(t.stream.id) || t.host === action.to) continue;
      t.host = action.to;
      if (!t.mounted) continue; // queued or not loaded: it starts on its new site when it loads
      t.reload('offloading memory to a fresh browser process', 'info', true, { log: false });
      run.moving = t;
      run.movedAt = now;
      run.moves++;
      return;
    }
    offload.run = null;
    offload.lastAt = now;
    logEvent(null, `Memory offloaded: every feed now plays in a fresh browser process (${run.moves} restarts over ${fmtDuration(now - run.startedAt)})`);
    renderOffloadButton();
  }

  // Where the tab can't be measured (an ordinary tab, a hosted wall), offload on a timer.
  function updateOffloadTimer(now) {
    const every = settings.offloadEveryMin;
    if (offload.run || !every || wallTabMemory() != null) return;
    if (now - offload.lastAt >= every * 60000) startOffload(`every ${every} min`, now);
  }

  // In the managed wall window: offload when the measured tab passes the limit, then check
  // the offload got it under. If it didn't, the feeds need that much: say so and wait.
  function updateMemoryGuard(now) {
    const limit = settings.memLimitMB;
    const mb = wallTabMemory();
    const g = memGuard;
    if (!limit || mb == null) {
      g.release = null;
      return;
    }
    if (offload.run || now - offload.lastAt < MEM_SETTLE_MS) return; // let the measurement catch up
    if (g.release) {
      if (mb <= limit * MEM_RELEASED_AT) {
        logEvent(null, `Memory released: wall tab at ${fmtInt(mb)} MB, down from ${fmtInt(g.release.startMB)} MB`);
        Object.assign(g, { release: null, floorMB: null, retryAt: 0 });
      } else {
        const feeds = feedCount(tiles.size);
        logEvent(null, `Wall tab still at ${fmtInt(mb)} MB after offloading (from ${fmtInt(g.release.startMB)} MB): ${feeds} need about this much, over the ${fmtInt(limit)} MB limit. Raise the limit in Settings or show fewer feeds. Trying again in 30 min, or sooner if it passes ${fmtInt(mb + MEM_GROWTH_MB)} MB.`, 'warn');
        Object.assign(g, { release: null, floorMB: mb, retryAt: now + MEM_RETRY_MS });
      }
      return;
    }
    const grown = g.floorMB != null && mb >= g.floorMB + MEM_GROWTH_MB;
    if (mb <= limit || (now < g.retryAt && !grown)) return;
    if (startOffload(`wall tab at ${fmtInt(mb)} MB, over the ${fmtInt(limit)} MB limit`, now)) g.release = { startMB: mb };
  }

  // [text, tone] for Settings → Laptop & rendering.
  function memoryReadout() {
    const limit = settings.memLimitMB;
    const mb = wallTabMemory();
    const run = offload.run;
    const doing = run ? ` · offloading: ${run.moves} restarts so far` : '';
    if (mb == null) {
      const every = settings.offloadEveryMin;
      const next = every && !run ? ` · next offload in ${fmtCountdown(offload.lastAt + every * 60000 - Date.now())}` : '';
      const why = managedWindow ? 'Waiting for the backend to measure this window'
        : server.hosted ? 'A web page can\'t read its tab\'s memory' : 'Not measurable in an ordinary tab (open the managed wall window)';
      return [`${why}${doing}${next}`, ''];
    }
    const stuck = !run && memGuard.floorMB != null && Date.now() < memGuard.retryAt;
    const state = doing || (stuck ? ' · these feeds need more than the limit' : '');
    const tone = !limit ? '' : mb > limit ? (stuck ? 'warn' : 'bad') : mb > limit * 0.85 ? 'warn' : 'ok';
    return [`${fmtInt(mb)} MB${limit ? ` of ${fmtInt(limit)} MB limit` : ' · limit off'}${state}`, tone];
  }

  function renderOffloadButton() {
    const btn = $('#offload-now');
    if (!btn) return;
    btn.disabled = !!offload.run || !tiles.size;
    btn.textContent = offload.run ? `Offloading… ${offload.run.moves} restarts` : 'Offload memory now';
  }
  $('#offload-now').addEventListener('click', () => startOffload('requested in Settings'));

  // ---------------------------------------------------------------------------
  // Channel sign-in: how each feed's encoder stream arrives at YouTube (health, resolution,
  // frame rate, YouTube's warnings). Anyone's OAuth client; any number of channels sign in,
  // and each feed is read through the channel that owns it. The backend holds the client,
  // the sign-ins and the polling (backend/google-credentials.js, youtube-ingest.js).
  // ---------------------------------------------------------------------------
  let ingestState = null;
  let ingestError = '';          // why the last settings action failed
  let ingestEditingClient = false;
  const INGEST_HEALTH = {
    good: ['Good', 'ok'],
    ok: ['OK', 'warn'],          // YouTube: usable, with minor problems
    bad: ['Bad', 'bad'],
    noData: ['No data', 'bad'],  // nothing arriving from the encoder
    revoked: ['Revoked', 'bad'],
  };
  // Broadcast lifecycles in which YouTube has the stream on air.
  const ON_AIR = new Set(['live', 'liveStarting', 'testing', 'testStarting']);

  // YouTube's word that a feed's broadcast is over: the Data API's end time, or the owning
  // channel's sign-in reporting it complete (asked as soon as the encoder stops; see
  // youtube-ingest.js). { at: ms or null }, or null while it's on air or unknown.
  function broadcastOver(id) {
    const yt = hasYtKey() ? ytStats.get(id) : null;
    if (yt?.endedAt && !yt.missing) return { at: Date.parse(yt.endedAt) };
    const v = ingestState?.videos?.[id];
    if (v?.owned && v.broadcast === 'complete') return { at: v.endedAt ? Date.parse(v.endedAt) : null };
    return null;
  }

  // When the encoder stopped sending while YouTube still has the broadcast on air (an outage
  // upstream of this PC), or null.
  function ingestStoppedAt(id) {
    const v = ingestState?.videos?.[id];
    return v?.owned && v.quietSince && ON_AIR.has(v.broadcast) && !broadcastOver(id) ? v.quietSince : null;
  }

  // { text, tone, detail, v } for one feed's ingest, or why there's nothing to show.
  function ingestInfo(id) {
    const s = ingestState;
    // A user's page knows nothing of the channel sign-ins, so it doesn't send them there.
    if (!s?.signedIn) {
      return { text: '—', tone: '', v: null, detail: isAdmin() ? 'Sign in with the channel that streams this feed in Settings → YouTube API to see how its encoder stream arrives at YouTube'
        : server.linkYoutube === false ? 'Your link was made without ingest health' : 'Ingest health isn\'t set up on this wall: the wall\'s admin can turn it on' };
    }
    const v = s.videos?.[id];
    if (!v) return { text: '—', tone: '', detail: s.status === 'error' ? `Channel sign-in: ${s.error}` : 'Waiting for YouTube…', v: null };
    if (!v.owned && !isAdmin()) return { text: 'N·A', tone: '', detail: 'YouTube doesn\'t share ingest health for this broadcast with this wall', v };
    if (!v.owned) {
      const titles = (s.channels || []).filter((c) => !c.expired).map((c) => c.title).join(', ');
      return { text: 'Not signed in', tone: '', detail: `None of the signed-in channels (${titles}) owns this broadcast, so YouTube won't share its ingest. Sign in with the channel that streams it in Settings → YouTube API.`, v };
    }
    const channel = (s.channels || []).find((c) => c.id === v.channelId);
    if (channel?.expired) {
      return { text: 'Sign-in expired', tone: 'warn', detail: `${channel.title}'s sign-in expired or was withdrawn: sign in again in Settings → YouTube API`, v };
    }
    const via = channel ? ` · via ${channel.title}` : '';
    if (!v.streamId) return { text: 'No stream bound', tone: 'warn', detail: `This broadcast has no encoder stream attached in YouTube Studio${via}`, v };
    // An ended broadcast or an idle stream has no data by design: not an alarm. A broadcast
    // still on air with nothing arriving is.
    const stoppedAt = v.quietSince ? ` at ${clockTime(v.quietSince)}` : '';
    const checked = v.checkedAt ? ` (asked ${clockTime(v.checkedAt)})` : '';
    const over = broadcastOver(id);
    if (over) {
      return { text: 'Ended', tone: '', detail: `YouTube ended this broadcast${over.at ? ` at ${clockTime(over.at)}` : ''}${v.quietSince ? `; its encoder stopped sending${stoppedAt}` : ''}${via}`, v };
    }
    if (ingestStoppedAt(id)) {
      return { text: 'Stopped', tone: 'bad', detail: `The encoder stopped sending${stoppedAt}, but YouTube still has the broadcast live${checked}: fix it at the encoder${via}`, v };
    }
    if (v.streamStatus === 'inactive') return { text: 'Inactive', tone: '', detail: `The encoder isn't sending to this stream${via}`, v };
    const [word, tone] = INGEST_HEALTH[v.health] || [v.streamStatus || '—', ''];
    const format = [v.resolution, v.frameRate].filter((x) => x && x !== 'variable').join(' ');
    const issues = (v.issues || []).map((x) => x.description || x.reason).filter(Boolean);
    return {
      text: `${word}${format ? ` · ${format}` : ''}`,
      tone,
      detail: `${issues.length ? `YouTube reports: ${issues.join(' · ')}` : 'YouTube reports no problems with this encoder stream'}${via}`,
      v,
    };
  }

  // Quota the channel sign-ins use a day, from the OAuth client's Google Cloud project: each
  // poll reads every channel's streams (1 unit per channel with feeds), and every few
  // minutes each channel is asked which feeds it owns (1 unit per 50 feeds).
  function ingestUnitsPerDay(s, feeds) {
    const live = (s.channels || []).filter((c) => !c.expired);
    const polls = Math.ceil(86400 / settings.ytPollSec);
    const lookups = Math.ceil(86400000 / (s.ownersEveryMs || 300000));
    return polls * live.filter((c) => c.feeds > 0).length + lookups * live.length * Math.max(1, Math.ceil(feeds / 50));
  }

  function renderIngestChannels(channels) {
    const $list = $('#ingest-channels');
    $list.hidden = !channels.length;
    $list.replaceChildren(...channels.map((c) => {
      const li = document.createElement('li');
      li.className = 'session-row';
      const info = document.createElement('div');
      info.className = 'session-info';
      const name = document.createElement('span');
      name.className = 'session-row-name';
      name.textContent = c.title;
      const meta = document.createElement('span');
      meta.className = 'session-row-meta';
      const [word, tone] = c.expired ? ['Sign-in expired', 'warn']
        : c.status === 'error' ? [`Problem: ${c.error}`, 'bad']
          : c.status === 'ok' ? [`${feedCount(c.feeds)} on the wall`, c.feeds ? 'ok' : '']
            : ['Checking…', ''];
      meta.textContent = word;
      meta.dataset.tone = tone;
      meta.title = `Signed in ${localStamp(c.savedAt, { zone: true })}`;
      info.append(name, meta);
      const again = document.createElement('button');
      again.className = 'btn btn-outline btn-xs';
      again.textContent = 'Sign in again';
      again.hidden = !(c.expired || c.status === 'error');
      again.addEventListener('click', openIngestSignIn);
      const out = document.createElement('button');
      out.className = 'btn btn-ghost btn-xs';
      out.textContent = 'Sign out';
      out.setAttribute('aria-label', `Sign out ${c.title}`);
      out.addEventListener('click', async () => {
        const ok = await ask({
          title: `Sign out ${c.title}?`,
          body: 'Ingest health stops for this channel\'s feeds in every window, and the wall\'s access is withdrawn from its Google account. Other signed-in channels carry on.',
          confirm: 'Sign out',
          variant: 'destructive',
        });
        if (ok) ingestAction('/api/youtube/oauth/signout', { channelId: c.id });
      });
      li.append(info, again, out);
      return li;
    }));
  }

  function renderIngestSettings() {
    const s = ingestState;
    const $s = $('#ingest-status');
    const show = (sel, on) => { $(sel).hidden = !on; };
    if (!s || !Array.isArray(s.channels)) {
      setText($s, 'The running backend is older than this page: restart it.');
      setTone($s, 'warn');
      ['#ingest-client-form', '#ingest-signin', '#ingest-client-check', '#ingest-client-change', '#ingest-channels'].forEach((sel) => show(sel, false));
      return;
    }
    const clientSet = !!s.client?.set;
    const fromEnv = s.client?.source === 'env';
    const editing = !fromEnv && (!clientSet || ingestEditingClient);
    const check = s.client?.check;
    const channels = s.channels;
    show('#ingest-client-form', editing);
    show('#ingest-signin', clientSet && !editing);
    setText($('#ingest-signin'), channels.length ? 'Add another channel' : 'Sign in with Google');
    show('#ingest-client-check', clientSet && !editing && !!check && check.status !== 'ok');
    show('#ingest-client-change', clientSet && !editing && !fromEnv);
    setText($('#ingest-redirect'), s.redirectUri || '');
    renderIngestChannels(channels);
    const ids = [...new Set([...tiles.values()].map((t) => t.stream.source.id))];
    const owned = ids.filter((id) => s.videos?.[id]?.owned).length;
    let text;
    let tone = '';
    if (ingestError) [text, tone] = [ingestError, 'bad'];
    else if (!clientSet) text = 'Not set up: add a Google OAuth client below (one-time; from any Google Cloud project).';
    // What Google said about the client: what to fix before anyone can sign in.
    else if (check && check.status !== 'ok') [text, tone] = [check.message, check.status === 'unchecked' ? 'warn' : 'bad'];
    else if (!channels.length) {
      const where = s.signInFrom && !onServerComputer() ? ` Channels sign in from the server's own computer, at ${s.signInFrom}.` : '';
      text = `Ready: sign in with the Google account of each channel the feeds stream to.${where}${s.error ? ` Last problem: ${s.error}` : ''}`;
    }
    else if (!s.signedIn) [text, tone] = ['Every channel\'s sign-in expired: sign in again.', 'warn'];
    else if (s.status === 'error') [text, tone] = [s.error, 'bad'];
    else if (s.status !== 'ok') text = 'Checking the feeds…';
    else {
      const perDay = ingestUnitsPerDay(s, ids.length);
      text = `Ingest health for ${owned} of ${ids.length} feeds · updated ${fmtDuration(Date.now() - s.updatedAt)} ago · ≈ ${fmtInt(perDay)} quota units a day from the OAuth client's project`;
      tone = owned || !ids.length ? 'ok' : 'warn';
      if (!owned && ids.length) text += ' · none of the wall\'s feeds belong to the signed-in channels';
      if (s.error) [text, tone] = [`${text} · ${s.error}`, 'warn'];
    }
    setText($s, text);
    setTone($s, tone);
  }

  async function ingestAction(url, body) {
    ingestError = '';
    try {
      const res = await api(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) ingestError = res.status === 404 ? 'The running backend is older than channel sign-in: restart it.' : data.error || `HTTP ${res.status}`;
      else if (data.ingest) ingestState = data.ingest;
    } catch {
      ingestError = 'Backend offline.';
    }
    renderIngestSettings();
    return !ingestError;
  }

  // Google checks the client before the server saves it; a refused one keeps the form open.
  $('#ingest-client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = $('#ingest-client-id').value.trim();
    const clientSecret = $('#ingest-client-secret').value.trim();
    const current = ingestState?.client?.clientId;
    if (current && clientId && clientId !== current && ingestState.channels?.length) {
      const ok = await ask({
        title: 'Use a different OAuth client?',
        body: 'Every channel signed in with the current client is signed out, since its sign-in belongs to that client. Each channel then signs in again.',
        confirm: 'Change client',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    setText($('#ingest-status'), 'Checking the client with Google…');
    setTone($('#ingest-status'), '');
    const ok = await ingestAction('/api/youtube/oauth/client', { clientId, clientSecret });
    if (ok) {
      ingestEditingClient = false;
      $('#ingest-client-secret').value = '';
      renderIngestSettings();
    }
  });
  $('#ingest-client-change').addEventListener('click', () => {
    ingestEditingClient = true;
    $('#ingest-client-id').value = ingestState?.client?.clientId || '';
    renderIngestSettings();
  });
  $('#ingest-client-check').addEventListener('click', () => {
    setText($('#ingest-status'), 'Checking the client with Google…');
    setTone($('#ingest-status'), '');
    ingestAction('/api/youtube/oauth/check');
  });
  // Google's sign-in runs in a popup so the wall keeps playing; its last page tells us it's done.
  // Each sign-in adds a channel, or renews one whose sign-in expired.
  const onServerComputer = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  function openIngestSignIn() {
    ingestError = '';
    // Google returns sign-ins only to https or localhost: on a plain-http network address the
    // channel signs in from the server's own computer, and every window shares that sign-in.
    const from = ingestState?.signInFrom;
    if (from && !onServerComputer()) {
      ingestError = `Google only returns sign-ins to https addresses or localhost, not to ${location.origin}. On the computer running this wall, open ${from}, sign in to the wall, and sign the channel in there: every window, this one included, then gets its ingest health.`;
      renderIngestSettings();
      return;
    }
    const popup = window.open('/api/youtube/oauth/start', 'ixg-oauth', 'popup,width=520,height=720');
    if (!popup) {
      ingestError = 'The browser blocked the sign-in window: allow pop-ups for this page and try again.';
      renderIngestSettings();
    }
  }
  $('#ingest-signin').addEventListener('click', openIngestSignIn);
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'ixg-oauth-done') return;
    probeYouTubeBackend(); // brings the new sign-in state
  });

  // ---------------------------------------------------------------------------
  // IXG Wall Feed Meter: the Chrome extension in extension/ reports from inside each player
  // every 2 s (see extension/meter.js). Reports are only taken from the tile's own player
  // frame, and every field is checked, since it comes from another site's frame.
  // ---------------------------------------------------------------------------
  const meterSeen = { at: 0, version: null };
  const finite = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const shortText = (v) => (typeof v === 'string' ? v.slice(0, 120) : null);

  function audioReport(d) {
    const states = ['ok', 'waiting', 'idle', 'suspended', 'no-audio', 'unsupported', 'unavailable'];
    const status = states.includes(d.status) ? d.status : 'unavailable';
    const validDb = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -60 && v <= 0;
    const channels = status === 'ok' && Array.isArray(d.channels) && d.channels.length === 2
      && d.channels.every((c) => c && validDb(c.rmsDb) && validDb(c.peakDb) && c.peakDb >= c.rmsDb)
      ? d.channels.map((c) => ({ rmsDb: c.rmsDb, peakDb: c.peakDb })) : [];
    return { at: Date.now(), status: status === 'ok' && !channels.length ? 'unavailable' : status, channels };
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !['ixg-meter', 'ixg-audio'].includes(d.type) || d.v !== 1) return;
    for (const t of tiles.values()) {
      if (e.source !== t.frame.querySelector('iframe')?.contentWindow || e.origin !== t.host) continue;
      if (d.videoId && d.videoId !== t.stream.source.id) return; // a report from before a link change
      if (d.type === 'ixg-audio') {
        t.audio = audioReport(d);
        t.renderAudio();
        return;
      }
      const setQualityBefore = !!t.meter?.setsQuality;
      t.meter = {
        at: Date.now(),
        bitrateMbps: finite(d.bitrateMbps, 1000),
        receivedMbps: finite(d.receivedMbps, 10000),
        connectionMbps: finite(d.connectionMbps, 100000),
        bufferS: finite(d.bufferS, 3600),
        width: finite(d.width, 10000),
        height: finite(d.height, 10000),
        fps: finite(d.fps, 240),
        videoFormat: shortText(d.videoFormat),
        audioFormat: shortText(d.audioFormat),
        codecs: shortText(d.codecs),
        latencyMode: ['normal', 'low', 'ultra-low'].includes(d.latencyMode) ? d.latencyMode : null,
        latencyModeText: shortText(d.latencyModeText),
        framesTotal: finite(d.framesTotal, 1e12),
        framesDropped: finite(d.framesDropped, 1e12),
        // Feed Meter 1.1+: sets the player's quality when asked (see Tile.sendQuality).
        setsQuality: Array.isArray(d.controls) && d.controls.includes('quality'),
        qualityTarget: QUALITY_ORDER.includes(d.qualityTarget) ? d.qualityTarget : null,
        qualityApplied: QUALITY_ORDER.includes(d.qualityApplied) ? d.qualityApplied : null,
      };
      meterSeen.at = Date.now();
      meterSeen.version = shortText(d.meter);
      // The meter now sets this feed's quality: stop sizing the player for it, and ask.
      if (t.meter.setsQuality !== setQualityBefore) {
        t.applySize();
        t.sendQuality(Date.now());
      }
      return;
    }
  });

  const meterActive = () => meterInstall.installed || Date.now() - meterSeen.at < 15000;

  // ---- Install check: before feeds start, make sure this browser has the Feed Meter ----
  // The extension's manifest is web-accessible under a fixed ID (its key is in the manifest),
  // so a page can see whether it's installed. Browsers only install extensions from their
  // store, by IT policy, or by hand in developer mode, so the prompt walks through that,
  // checks every few seconds, and lets the wall continue the moment the extension appears.
  const METER_SNOOZE_KEY = 'ixg-wall:meter-prompt-snoozed-until';
  const meterInstall = { installed: false, version: null };
  const isEdge = () => /Edg\//.test(navigator.userAgent);
  // Phones and tablets can't add browser extensions, Chrome or not (an iPad reports itself as a Mac).
  const isMobile = () => navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Desktop Chrome or Edge: the browsers the Feed Meter installs in.
  const isChromium = () => !isMobile() && (!!navigator.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))
    || /Chrome\/|Edg\//.test(navigator.userAgent));
  function newerVersion(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  }

  async function detectMeter() {
    const ids = server.extension?.ids || [];
    if (!ids.length || !isChromium()) return null;
    for (const id of ids) {
      try {
        const res = await fetch(`chrome-extension://${id}/manifest.json`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
        const manifest = await res.json();
        return { id, version: manifest.version || null };
      } catch {
        // not installed under this ID
      }
    }
    return null;
  }

  function meterSnoozed() {
    try {
      return Number(localStorage.getItem(METER_SNOOZE_KEY)) > Date.now();
    } catch {
      return false;
    }
  }

  function onMeterFound(found) {
    meterInstall.installed = true;
    meterInstall.version = found.version;
    meterSeen.version = meterSeen.version || found.version;
    const latest = server.extension?.version;
    if (latest && found.version && newerVersion(latest, found.version)) {
      const how = document.createElement('button');
      how.className = 'btn btn-outline btn-xs';
      how.textContent = 'How to update';
      how.addEventListener('click', () => showMeterDialog({ update: true, installed: found.version }));
      $banner.replaceChildren(`This browser has Feed Meter ${found.version}; the wall now ships ${latest}. `, how);
      $banner.hidden = false;
    }
  }

  // Resolves when the wall may start its feeds. A browser that can't run the extension
  // (a phone, a tablet, Firefox, Safari) is never held up by a prompt it can't complete:
  // its bandwidth numbers are marked Estimated instead.
  async function ensureFeedMeter() {
    if (!server.extension || location.protocol === 'file:') return; // an older backend ships no extension
    if (!isChromium()) return;
    const found = await detectMeter();
    if (found) return onMeterFound(found);
    if (meterSnoozed()) return;
    await showMeterDialog();
  }

  function showMeterDialog({ update = false, installed = null } = {}) {
    const $d = $('#meter-dialog');
    if ($d.open) return Promise.resolve('open');
    const ext = server.extension;
    const supported = isChromium();
    const pageUrl = isEdge() ? 'edge://extensions' : 'chrome://extensions';
    setText($('#meter-title'), update ? 'Update the IXG Wall Feed Meter' : supported ? 'Install the IXG Wall Feed Meter' : 'The Feed Meter needs Chrome or Edge');
    setText($('#meter-why'), update
      ? `This browser has version ${installed}; the wall ships ${ext.version}. Download the new one, replace the folder you loaded before, then press the reload arrow on the extension's card in ${pageUrl}.`
      : supported
        ? 'This browser extension measures each feed\'s audio levels, real bitrate, data received, connection speed, latency mode and dropped frames. Without it audio meters are unavailable and bandwidth numbers are estimates. It takes a minute, once per browser.'
        : 'This browser can show the wall, but it can\'t run the extension that measures each feed. Audio meters are unavailable and bandwidth numbers are estimates. Open the wall in Chrome or Edge for measured readings.');
    $('#meter-store').hidden = !supported || update || !ext.storeUrl;
    if (ext.storeUrl) $('#meter-store-link').href = ext.storeUrl;
    $('#meter-steps').hidden = !supported;
    $('#meter-download').href = ext.download;
    setText($('#meter-ext-url'), pageUrl);
    setText($('#meter-copy'), 'Copy address');
    $('#meter-check').hidden = !supported;
    $('#meter-snooze-row').hidden = update;
    setText($('#meter-skip'), update ? 'Later' : 'Continue without it');
    setText($('#meter-status'), supported ? 'Waiting for the extension · checking every few seconds' : '');

    return new Promise((resolve) => {
      const off = new AbortController();
      let timer = 0;
      let checking = false;
      const finish = (why) => {
        clearInterval(timer);
        off.abort();
        if ($d.open) $d.close();
        resolve(why);
      };
      const check = async () => {
        if (checking) return;
        checking = true;
        const found = await detectMeter();
        checking = false;
        if (found && (!update || !newerVersion(ext.version, found.version))) {
          onMeterFound(found);
          if (update) $banner.hidden = true;
          logEvent(null, `Feed Meter ${found.version} found in this browser`);
          finish('found');
        } else {
          setText($('#meter-status'), found ? `Still version ${found.version} · checking every few seconds`
            : 'Not found yet · checking every few seconds');
        }
      };
      const skip = () => {
        if ($('#meter-snooze').checked) {
          try { localStorage.setItem(METER_SNOOZE_KEY, String(Date.now() + 24 * 3600e3)); } catch { /* not remembered */ }
        }
        if (!update) logEvent(null, 'Continuing without the Feed Meter: bitrate is estimated', 'warn');
        finish('skipped');
      };
      $('#meter-check').addEventListener('click', check, { signal: off.signal });
      $('#meter-skip').addEventListener('click', skip, { signal: off.signal });
      $d.addEventListener('cancel', (e) => { e.preventDefault(); skip(); }, { signal: off.signal }); // Escape
      $('#meter-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pageUrl);
          setText($('#meter-copy'), 'Copied');
        } catch {
          setText($('#meter-copy'), 'Select and copy it');
        }
      }, { signal: off.signal });
      $d.showModal();
      if (supported) timer = setInterval(check, 3000);
    });
  }
  // Settings: install it any time, even after 'Don't ask for 24 hours'.
  $('#meter-install').addEventListener('click', () => {
    try { localStorage.removeItem(METER_SNOOZE_KEY); } catch { /* nothing remembered */ }
    showMeterDialog();
  });

  const LATENCY_MODE_TEXT = {
    normal: 'Normal: YouTube\'s slowest mode; Low or Ultra-low cut the delay',
    low: 'Low latency',
    'ultra-low': 'Ultra-low latency',
  };

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
    // Another window saved the wall: take its changes in place (pullRemoteWall). Only if
    // that can't be done is a reload offered. A drag in progress finishes first.
    source.addEventListener('wall', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.clientId === clientId || data.version <= wallVersion) return;
      while (feedDrag) await new Promise((r) => setTimeout(r, 300));
      if (await pullRemoteWall()) return;
      const reload = document.createElement('button');
      reload.className = 'btn btn-outline btn-xs';
      reload.textContent = 'Reload wall';
      reload.addEventListener('click', () => location.reload());
      $banner.replaceChildren('The wall was changed in another window and couldn\'t be loaded here. ', reload);
      $banner.hidden = false;
    });
    source.onerror = () => { // EventSource reconnects on its own
      backend.connected = false;
      updateSummary();
      renderPerf();
      // ...but can't see why it was refused: a lapsed sign-in must go to the sign-in page.
      if (server.auth && Date.now() - lastAuthProbe > 10000) {
        lastAuthProbe = Date.now();
        api('/api/config', { cache: 'no-store' }).catch(() => {});
      }
    };
  }
  let lastAuthProbe = 0;

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
    const res = await api('/api/wall-browser', {
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
    renderOffloadButton();
    $('#meter-install').hidden = !server.extension || meterActive() || !isChromium();
    const t = backendFresh() ? backend.latest : null;
    const b = t?.browser;
    const pct = (v) => (v == null ? null : `${Math.round(v)}%`);
    const toneFor = (v, warn, bad) => (v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
    const mounted = [...tiles.values()].filter((x) => x.mounted && !x.error);
    const reporting = mounted.filter((x) => x.meterNow()).length;
    const meterRow = ['Feed Meter extension', meterActive()
      ? `Active${meterSeen.version ? ` · v${meterSeen.version}` : ''} · ${reporting} of ${mounted.length} feeds reporting`
      : isChromium() ? 'Not detected in this browser: per-feed bitrate is estimated. Install Feed Meter, below'
        : `Not available ${isMobile() ? 'on phones and tablets' : 'in this browser (Chrome or Edge on a computer only)'}: per-feed bitrate is estimated`,
    meterActive() ? (reporting < mounted.length ? 'warn' : 'ok') : 'warn'];
    // Hosted, the server isn't this computer: what the browser and the Feed Meter can tell.
    const m = machine();
    // Rows nothing here can measure are left out rather than shown as — or Not available.
    const measured = (rows) => rows.filter((r) => r && r[1] != null && r[1] !== 'Not available');
    if (server.hosted) {
      fillKv($('#perf-kv'), measured([
        meterRow,
        ['CPU', m?.cpu != null ? `${pct(m.cpu)} of ${m.cores} threads` : null, toneFor(m?.cpu, 75, PERF_BUSY_CPU)],
        ['Memory', m?.memUsedPct != null ? `${pct(m.memUsedPct)} of ${m.memTotalGB} GB` : null, toneFor(m?.memUsedPct, 85, PERF_BUSY_MEM)],
        ['Wall tab memory', ...memoryReadout()],
        ['Wall status', perf.level === 'ok' ? 'Normal' : `${perf.level === 'busy' ? 'Busy' : 'Overloaded'} · ${perf.reason}`,
          perf.level === 'ok' ? 'ok' : perf.level === 'busy' ? 'warn' : 'bad'],
        ['CPU pressure (browser)', cpuPressure || ('PressureObserver' in window ? 'Waiting' : 'Not available'),
          cpuPressure === 'critical' ? 'bad' : cpuPressure === 'serious' ? 'warn' : ''],
        ['Decoding in this window', decodeHere ? (decodeHere === 'hardware' ? 'Hardware (GPU)' : 'Software (CPU)') : null],
        ['Server', backendFresh() ? 'Connected' : 'Offline: can\'t reach the wall server', backendFresh() ? '' : 'warn'],
      ]));
      return;
    }
    fillKv($('#perf-kv'), measured([
      ['Wall status', perf.level === 'ok' ? 'Normal' : `${perf.level === 'busy' ? 'Busy' : 'Overloaded'} · ${perf.reason}`,
        perf.level === 'ok' ? 'ok' : perf.level === 'busy' ? 'warn' : 'bad'],
      ['CPU', m?.cpu != null ? `${pct(m.cpu)} of ${m.cores} threads${m.source === 'meter' ? ' · Feed Meter' : ''}` : null, toneFor(m?.cpu, 75, PERF_BUSY_CPU)],
      ['CPU pressure (browser)', cpuPressure || ('PressureObserver' in window ? 'Waiting' : 'Not available'),
        cpuPressure === 'critical' ? 'bad' : cpuPressure === 'serious' ? 'warn' : ''],
      ['Memory', m?.memUsedPct != null ? `${pct(m.memUsedPct)} of ${m.memTotalGB} GB${m.source === 'meter' ? ' · Feed Meter' : ''}` : null, toneFor(m?.memUsedPct, 85, PERF_BUSY_MEM)],
      ['Wall tab memory', ...memoryReadout()],
      meterRow,
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
    ]));
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

  // Swap a feed's YouTube link in place, e.g. the next day's stream for the same slot.
  // An unusable link reopens the dialog with the reason, keeping what was typed.
  async function changeLink(tile) {
    if (!isAdmin()) return; // a new link is a new feed: admins only
    let value = `https://youtube.com/live/${tile.stream.source.id}`;
    let problem = '';
    for (;;) {
      const raw = await ask({
        title: `Change link · ${tile.stream.label}`,
        body: problem
          ? `Can't use that link: ${problem}`
          : 'Paste the new YouTube live URL or video ID. The feed keeps its place on the wall, its label and priority; its stats start over.',
        confirm: 'Change link',
        input: { value, placeholder: 'Paste a YouTube live URL or video ID', label: 'YouTube live URL or video ID' },
      });
      if (!raw || !tiles.has(tile.stream.id)) return;
      value = raw;
      const source = CHANNEL_LINK.test(raw) ? null : parseSource(raw);
      const other = source && [...tiles.values()].find((t) => t !== tile && t.stream.source.id === source.id);
      if (CHANNEL_LINK.test(raw)) problem = 'it is a channel link. Open the live stream and copy its own URL.';
      else if (!source) problem = 'it is not a YouTube video URL or 11-character video ID.';
      else if (other) problem = `that video is already on the wall as ${other.stream.label}.`;
      else {
        if (source.id !== tile.stream.source.id) tile.changeSource(source);
        return;
      }
    }
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
    tileW = Math.max(1, tileW - AUDIO_METER_PX);
    const withSide = ((tileH - BAR_SLIM_PX) * 16) / 9;
    if (settings.showStats && tileW - withSide >= SIDE_MIN_PX) return withSide;
    const bar = settings.showStats ? BAR_FULL_PX : BAR_SLIM_PX;
    return Math.min(tileW, (Math.max(0, tileH - bar) * 16) / 9);
  }

  const GRID_GAP_PX = rootPx('--grid-gap', 6); // .grid gap, from the stylesheet

  // The wall's geometry for n feeds in a W×H area. Fit mode squeezes every feed on screen
  // (column count chosen for the biggest video). Scroll mode keeps every tile one fixed,
  // legible size, a 16:9 video beside its stats card, and the wall scrolls for the rest.
  function scrollGeometry(W, H, n) {
    const cols = settings.scrollColumns;
    const tileW = (W - (cols - 1) * GRID_GAP_PX) / cols;
    const wantedCard = settings.showStats ? Math.max(SIDE_MIN_PX + 40, Math.round((tileW * settings.cardPct) / 100)) : 0;
    const availableCard = Math.min(wantedCard, Math.max(0, tileW - AUDIO_METER_PX - 80));
    const card = availableCard >= SIDE_MIN_PX ? availableCard : 0;
    const videoW = Math.max(1, tileW - AUDIO_METER_PX - card);
    const videoH = (videoW * 9) / 16;
    const tileH = Math.round(videoH + BAR_SLIM_PX);
    const rowsOnScreen = Math.max(1, Math.floor((H + GRID_GAP_PX) / (tileH + GRID_GAP_PX)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const contentH = rows * tileH + (rows - 1) * GRID_GAP_PX;
    return { mode: 'scroll', cols, rows, tileW, tileH, card, videoW, videoH, contentH, onScreen: Math.min(n, rowsOnScreen * cols) };
  }

  // The preset layout in use: a built-in one, or the custom one from the builder.
  function activeLayout() {
    if (settings.layoutPreset === 'custom' && settings.customLayout) return { id: 'custom', name: 'Custom layout', ...settings.customLayout };
    return LAYOUT_PRESETS.find((p) => p.id === settings.layoutPreset) || LAYOUT_PRESETS.find((p) => p.id === DEFAULT_SETTINGS.layoutPreset);
  }

  function computeLayout(W, H, n) {
    if (settings.layoutMode === 'scroll') return scrollGeometry(W, H, n);
    // A preset: its boxes fill the screen on a 12 × 12 grid, and it repeats a screen at a
    // time for every feed: with 2 × 2 and 10 feeds, three pages. A part-filled last page is
    // as tall as its feeds need, not a whole screen: an even grid keeps its box size and
    // widens its last row (the third page above: 2 side by side, half a screen high); a PIP
    // shape keeps its first boxes, cut below the lowest. A wall that is one part-filled page
    // spreads its feeds over the screen instead, since there's nothing below to scroll to.
    if (settings.layoutMode === 'preset') {
      const units = layoutUnits(activeLayout());
      const pages = Math.max(1, Math.ceil(n / units.length));
      const leftover = n % units.length;
      const even = evenLayout(units);
      const tail = !leftover ? null
        : pages === 1 ? (even ? fillUnits(leftover) : null)
          : even ? packUnits(units[0], leftover) : units.slice(0, leftover);
      const lastRows = tail && pages > 1 ? Math.max(...tail.map(([, y, , h]) => y + h)) : LAYOUT_UNITS;
      const unitW = (W - (LAYOUT_UNITS - 1) * GRID_GAP_PX) / LAYOUT_UNITS;
      const unitH = (H - (LAYOUT_UNITS - 1) * GRID_GAP_PX) / LAYOUT_UNITS;
      const boxes = units.map(([x, y, w, h]) => ({
        x: x * (unitW + GRID_GAP_PX), y: y * (unitH + GRID_GAP_PX), w: w * unitW + (w - 1) * GRID_GAP_PX, h: h * unitH + (h - 1) * GRID_GAP_PX,
      }));
      const totalRows = LAYOUT_UNITS * (pages - 1) + lastRows;
      const contentH = totalRows * unitH + (totalRows - 1) * GRID_GAP_PX;
      return { mode: 'preset', units, tail, boxes, unitH, pages, totalRows, contentH, onScreen: Math.min(n, boxes.length) };
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
    const sideOn = settings.showStats && tileW - AUDIO_METER_PX - ((tileH - BAR_SLIM_PX) * 16) / 9 >= SIDE_MIN_PX;
    return { mode: 'fit', cols, rows, tileW, tileH, card: sideOn ? tileW - AUDIO_METER_PX - videoW : 0, videoW, videoH: (videoW * 9) / 16, onScreen: n };
  }

  function updateLayout() {
    const n = tiles.size;
    $('#clear-wall').disabled = n === 0;
    const top = document.querySelector('.topbar').offsetHeight;
    document.body.style.setProperty('--wall-top', `${top + $banner.offsetHeight}px`);
    document.body.style.setProperty('--sheet-top', `${top}px`);
    document.body.classList.toggle('document-wall', settings.layoutMode !== 'fit');
    const H = wallViewportHeight();
    document.body.style.setProperty('--wall-viewport-h', `${H}px`);
    $empty.hidden = n > 0;
    renderLayoutPreview();
    if (!n) {
      document.body.style.setProperty('--wall-content-h', '0px');
      currentLayout = null;
      return;
    }
    // Measure the viewport separately: using the growing grid's height would make
    // preset pages grow again on every ResizeObserver callback.
    const L = computeLayout($grid.clientWidth || 16, H, n);
    document.body.style.setProperty('--wall-content-h', `${L.contentH || H}px`);
    $grid.classList.toggle('scroll', L.mode === 'scroll');
    $grid.classList.toggle('preset', L.mode === 'preset');
    if (L.mode === 'preset') {
      $grid.style.setProperty('--unit-h', `${L.unitH}px`);
      $grid.style.setProperty('--units-total', String(L.totalRows));
    } else {
      $grid.style.setProperty('--cols', L.cols);
      $grid.style.setProperty('--rows', L.rows);
      $grid.style.setProperty('--tile-h', `${L.tileH}px`);
    }
    currentLayout = L;
    placeTiles(L, feedDrag ? feedDrag.order : streams);
    for (const t of tiles.values()) t.applySize();
    renderLayoutBar();
  }

  let currentLayout = null; // the last computeLayout() result updateLayout applied

  function wallViewportHeight() {
    return Math.max(1, window.innerHeight - document.querySelector('.topbar').offsetHeight
      - $banner.offsetHeight - $transport.offsetHeight);
  }

  // Feeds take their places in wall order. CSS order and grid placement move them on screen
  // without moving them in the page: a YouTube player moved in the page reloads.
  function placeTiles(L, order = streams) {
    order.forEach((s, i) => {
      const t = tiles.get(s.id);
      if (!t) return;
      t.el.style.order = String(i);
      // Page by page: feed i takes box i % k on page i / k (k boxes a page), biggest first.
      // A part-filled last page has its own boxes (L.tail).
      const k = L.mode === 'preset' ? L.units.length : 0;
      const page = k ? Math.floor(i / k) : 0;
      const boxes = k && L.tail && page === L.pages - 1 ? L.tail : L.units;
      const box = k ? boxes[i % k] : null;
      const top = page * LAYOUT_UNITS;
      t.el.style.gridArea = box ? `${top + box[1] + 1} / ${box[0] + 1} / span ${box[3]} / span ${box[2]}` : '';
      // The first box of each page is where scrolling snaps to.
      t.el.classList.toggle('page-start', !!k && i % k === 0);
    });
  }

  // Into the biggest box of the page it's on, trading places with the feed there. (Outside a
  // preset, the wall's first place.)
  function makeMain(tile) {
    const k = settings.layoutMode === 'preset' ? layoutUnits(activeLayout()).length : streams.length;
    const i = streams.indexOf(tile.stream);
    const first = tiles.get(streams[i - (i % k)]?.id);
    if (first && first !== tile) swapFeeds(tile, first);
  }

  // ---- Dragging a feed to a new place ---------------------------------------------------
  // The box follows the pointer (a transform, so nothing re-lays-out), and the wall reorders
  // live under it: the others slide to make room (FLIP: measure, re-place, animate the
  // difference). Dropping saves the order. Players are only ever moved by CSS.
  const DRAG_START_PX = 6;          // a press that moves less than this stays a click
  const DRAG_EDGE_PX = 48;          // this close to the wall's top or bottom, it scrolls
  const SLIDE_MS = 180;
  let feedPress = null;             // { tile, x, y, id } between pointerdown and moving
  let feedDrag = null;              // { tile, order, grabX, grabY, x, y, scroll } while dragging

  function feedDragPress(tile, e) {
    if (e.button !== 0 || !e.isPrimary || feedDrag || tile.focused) return;
    // Controls on the box keep their own job.
    if (e.target.closest('button, a, input, select, textarea, .tl, .tile-actions')) return;
    feedPress = { tile, x: e.clientX, y: e.clientY, id: e.pointerId };
    window.addEventListener('pointermove', feedDragMove);
    window.addEventListener('pointerup', feedDragEnd);
    window.addEventListener('pointercancel', feedDragEnd);
  }

  // Where every feed sits now, for sliding them from there to their next place.
  const tileRects = () => new Map([...tiles.values()].map((t) => [t, t.el.getBoundingClientRect()]));

  function slideFrom(before, skip) {
    for (const [t, was] of before) {
      if (t === skip) continue;
      const now = t.el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      t.el.style.transition = 'none';
      t.el.style.transform = `translate(${dx}px, ${dy}px)`;
      void t.el.offsetWidth; // apply the start position before animating from it
      t.el.style.transition = `transform ${SLIDE_MS}ms var(--ease-swift)`;
      t.el.style.transform = '';
    }
  }

  // Keeps the dragged box under the pointer, wherever its grid place is now.
  function followPointer() {
    const d = feedDrag;
    const el = d.tile.el;
    el.style.transform = '';
    const home = el.getBoundingClientRect();
    el.style.transform = `translate(${d.x - d.grabX - home.left}px, ${d.y - d.grabY - home.top}px)`;
  }

  function feedDragMove(e) {
    if (feedPress && !feedDrag) {
      if (e.pointerId !== feedPress.id || Math.hypot(e.clientX - feedPress.x, e.clientY - feedPress.y) < DRAG_START_PX) return;
      const { tile } = feedPress;
      const r = tile.el.getBoundingClientRect();
      feedDrag = { tile, order: [...streams], grabX: feedPress.x - r.left, grabY: feedPress.y - r.top, x: e.clientX, y: e.clientY, scroll: 0 };
      feedPress = null;
      document.body.classList.add('dragging-feed');
      tile.el.classList.add('lifted');
      tile.el.style.transition = 'none';
      requestAnimationFrame(edgeScroll);
    }
    if (!feedDrag) return;
    e.preventDefault();
    feedDrag.x = e.clientX;
    feedDrag.y = e.clientY;
    reorderUnderPointer();
    followPointer();
  }

  // The feed under the pointer gives up its place: the dragged one goes there, and the ones
  // between shift along by one.
  function reorderUnderPointer() {
    const d = feedDrag;
    const over = [...tiles.values()].find((t) => {
      if (t === d.tile) return false;
      const r = t.el.getBoundingClientRect();
      return d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom;
    });
    if (!over) return;
    const from = d.order.indexOf(d.tile.stream);
    const to = d.order.indexOf(over.stream);
    if (from < 0 || to < 0 || from === to) return;
    const before = tileRects();
    d.order.splice(from, 1);
    d.order.splice(to, 0, d.tile.stream);
    placeTiles(currentLayout || computeLayout($grid.clientWidth, $grid.clientHeight, tiles.size), d.order);
    slideFrom(before, d.tile);
  }

  // Near the wall's top or bottom edge, scroll it (to reach other pages and rows).
  function edgeScroll() {
    const d = feedDrag;
    if (!d) return;
    const r = $grid.getBoundingClientRect();
    const pageScroll = document.body.classList.contains('document-wall');
    const top = Math.max(r.top, document.querySelector('.topbar').offsetHeight);
    const bottom = Math.min(r.bottom, window.innerHeight - $transport.offsetHeight);
    const speed = d.y < top + DRAG_EDGE_PX ? -(top + DRAG_EDGE_PX - d.y) : d.y > bottom - DRAG_EDGE_PX ? d.y - (bottom - DRAG_EDGE_PX) : 0;
    if (speed && (pageScroll || $grid.scrollHeight > $grid.clientHeight)) {
      const step = Math.max(-24, Math.min(24, speed / 2));
      if (pageScroll) window.scrollBy(0, step);
      else $grid.scrollTop += step;
      reorderUnderPointer();
      followPointer();
    }
    requestAnimationFrame(edgeScroll);
  }

  function feedDragEnd(e) {
    window.removeEventListener('pointermove', feedDragMove);
    window.removeEventListener('pointerup', feedDragEnd);
    window.removeEventListener('pointercancel', feedDragEnd);
    feedPress = null;
    const d = feedDrag;
    if (!d) return;
    feedDrag = null;
    const cancelled = e?.type === 'pointercancel' || e?.type === 'keydown';
    const el = d.tile.el;
    // A click follows the release: it mustn't also pick this feed's audio.
    d.tile.justDragged = true;
    setTimeout(() => { d.tile.justDragged = false; }, 0);
    document.body.classList.remove('dragging-feed');
    const changed = !cancelled && d.order.some((s, i) => s !== streams[i]);
    const before = tileRects();
    if (changed) {
      streams.splice(0, streams.length, ...d.order);
      store.save();
      const i = streams.indexOf(d.tile.stream);
      logEvent(d.tile, `Moved to place ${i + 1} of ${streams.length}`);
    }
    placeTiles(currentLayout || computeLayout($grid.clientWidth, $grid.clientHeight, tiles.size), streams);
    slideFrom(before, d.tile);
    // Settle the dragged box into its place.
    const now = el.getBoundingClientRect();
    el.style.transform = '';
    const home = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = `translate(${now.left - home.left}px, ${now.top - home.top}px)`;
    void el.offsetWidth;
    el.style.transition = `transform ${SLIDE_MS}ms var(--ease-swift)`;
    el.style.transform = '';
    setTimeout(() => el.classList.remove('lifted'), SLIDE_MS);
    renderLayoutPreview();
  }

  // Esc puts the feed back where it was.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && feedDrag) {
      e.stopImmediatePropagation();
      feedDrag.order = [...streams];
      feedDragEnd(e);
    }
  }, true);

  // Swaps two feeds' places on the wall: how a feed becomes the main one in a preset layout.
  function swapFeeds(a, b) {
    const i = streams.indexOf(a.stream);
    const j = streams.indexOf(b.stream);
    if (i < 0 || j < 0 || i === j) return;
    [streams[i], streams[j]] = [streams[j], streams[i]];
    store.save();
    updateLayout();
    logEvent(null, `Swapped places: ${a.stream.label} ↔ ${b.stream.label}`);
  }

  // Settings → Layout: a to-scale miniature of the wall as configured. Each tile shows its
  // video and stats card; tiles past the bottom of the screen are faded under a fold line.
  function renderLayoutPreview() {
    const $box = $('#layout-preview');
    if (!$box || $drawer.hidden) return;
    const W = $grid.clientWidth || 1600;
    const H = wallViewportHeight();
    const n = tiles.size || 6;
    const L = computeLayout(W, H, n);
    const s = $box.clientWidth / W;
    if (L.mode === 'preset') return renderPresetPreview($box, L, W, H, n, s);
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
      const audio = document.createElement('div');
      audio.className = 'lp-audio';
      audio.style.width = px(AUDIO_METER_PX);
      audio.style.height = px(L.videoH);
      el.append(audio);
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
    for (const el of $drawer.querySelectorAll('[data-layout-mode]')) el.hidden = !el.dataset.layoutMode.split(' ').includes(settings.layoutMode);
    setText($('#card-pct-out'), `${settings.cardPct}%`);
  }
  // The preset's boxes to scale, with the first row of feeds that carry on below the screen.
  function renderPresetPreview($box, L, W, H, n, s) {
    const px = (v) => `${(v * s).toFixed(1)}px`;
    const k = L.boxes.length;
    const more = L.pages > 1;
    const boxH = H + (more ? GRID_GAP_PX + H * 0.35 : 0);
    $box.style.height = `${Math.round(boxH * s)}px`;
    $box.style.setProperty('--fold', `${Math.round(H * s)}px`);
    $box.classList.toggle('scrolls', more);
    const tile = (x, y, w, h, dim) => {
      const el = document.createElement('div');
      el.className = `lp-tile${dim ? ' below' : ''}`;
      Object.assign(el.style, { left: px(x), top: px(y), width: px(w), height: px(h) });
      const video = document.createElement('div');
      video.className = 'lp-video';
      // The video keeps 16:9 inside its box; a wide box gives the rest to the stats card.
      const vw = Math.min(Math.max(1, w - AUDIO_METER_PX), ((h - BAR_SLIM_PX) * 16) / 9);
      const audio = document.createElement('div');
      audio.className = 'lp-audio';
      Object.assign(audio.style, { width: px(AUDIO_METER_PX), height: px((vw * 9) / 16) });
      el.append(audio);
      Object.assign(video.style, { width: px(vw), height: px((vw * 9) / 16) });
      el.append(video);
      if (settings.showStats && w - AUDIO_METER_PX - vw >= SIDE_MIN_PX) {
        const card = document.createElement('div');
        card.className = 'lp-card';
        Object.assign(card.style, { width: px(w - AUDIO_METER_PX - vw), height: video.style.height });
        el.append(card);
      }
      return el;
    };
    const items = L.boxes.map((b, i) => tile(b.x, b.y, b.w, b.h, i >= n));
    if (more) for (const b of L.boxes) items.push(tile(b.x, H + GRID_GAP_PX + b.y, b.w, b.h, true));
    $box.replaceChildren(...items);
    const layout = activeLayout();
    setText($('#layout-summary'), `${layout.name} · ${L.boxes.length} box${L.boxes.length === 1 ? '' : 'es'}`
      + (tiles.size ? ` · ${n} feed${n === 1 ? '' : 's'} on ${L.pages} page${L.pages === 1 ? '' : 's'} of ${k}${L.pages > 1 ? ', scroll for the rest' : ''}` : '')
      + ` · each page's first feed takes its biggest box · on-screen feeds stream at ${QUALITY[settings.feedQuality].label}`);
    for (const el of $drawer.querySelectorAll('[data-layout-mode]')) el.hidden = !el.dataset.layoutMode.split(' ').includes(settings.layoutMode);
    setText($('#card-pct-out'), `${settings.cardPct}%`);
  }

  // ---- Layout bar: the preset layouts, under the wall -----------------------------------
  // A layout's icon: its boxes, drawn to the screen's proportions.
  function layoutIcon(layout) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y, w, h] of layoutUnits(layout)) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x * 2 + 0.6));
      r.setAttribute('y', String((y * 4) / 3 + 0.6));
      r.setAttribute('width', String(w * 2 - 1.2));
      r.setAttribute('height', String((h * 4) / 3 - 1.2));
      r.setAttribute('rx', '0.6');
      svg.append(r);
    }
    return svg;
  }

  function layoutButton(layout) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'layout-btn';
    b.title = `${layout.name} · ${layout.cells.length} box${layout.cells.length === 1 ? '' : 'es'}`;
    b.setAttribute('aria-label', b.title);
    b.dataset.layout = layout.id;
    b.append(layoutIcon(layout));
    b.addEventListener('click', () => {
      setLayoutPanel(false);
      useLayout(layout.id);
    });
    return b;
  }

  function useLayout(id) {
    settings.layoutMode = 'preset';
    settings.layoutPreset = id;
    store.save();
    applySetting('layoutMode');
    syncSettingInputs();
  }

  const $layoutPanel = $('#layout-panel');
  $('#layout-quick').replaceChildren(...LAYOUT_PRESETS.filter((p) => p.quick).map(layoutButton));
  $('#layout-grid').replaceChildren(...LAYOUT_PRESETS.filter((p) => !p.quick).map(layoutButton));

  function renderLayoutBar() {
    const custom = settings.customLayout;
    const $custom = $('#layout-custom-use');
    $custom.hidden = !custom;
    if (custom) $custom.replaceChildren(layoutIcon(custom));
    for (const b of document.querySelectorAll('.layout-btn[data-layout]')) {
      b.setAttribute('aria-pressed', String(settings.layoutMode === 'preset' && settings.layoutPreset === b.dataset.layout));
    }
    $('#layout-more').setAttribute('aria-pressed', String(settings.layoutMode === 'preset' && !LAYOUT_PRESETS.find((p) => p.id === settings.layoutPreset)?.quick));
    $('#layout-scroll').setAttribute('aria-pressed', String(settings.layoutMode === 'scroll'));
    $('#layout-fit').setAttribute('aria-pressed', String(settings.layoutMode === 'fit'));
  }

  function setLayoutPanel(open) {
    $layoutPanel.hidden = !open;
    $('#layout-more').setAttribute('aria-expanded', String(open));
    if (open) renderLayoutBar();
  }
  $('#layout-more').addEventListener('click', () => setLayoutPanel($layoutPanel.hidden));
  $('#layout-custom-use').addEventListener('click', () => {
    setLayoutPanel(false);
    useLayout('custom');
  });
  for (const [id, mode] of [['#layout-scroll', 'scroll'], ['#layout-fit', 'fit']]) {
    $(id).addEventListener('click', () => {
      setLayoutPanel(false);
      settings.layoutMode = mode;
      store.save();
      applySetting('layoutMode');
      syncSettingInputs();
    });
  }
  // Clicking anywhere else closes the panel.
  document.addEventListener('pointerdown', (e) => {
    if (!$layoutPanel.hidden && !$layoutPanel.contains(e.target) && !e.target.closest('#layout-more')) setLayoutPanel(false);
  });

  // ---- Custom layout builder: draw boxes on a grid by dragging across it ------------------
  const builder = { cols: 3, rows: 3, cells: [], from: null, to: null };
  const $builder = $('#layout-builder');

  function openBuilder() {
    setLayoutPanel(false);
    const c = settings.customLayout;
    Object.assign(builder, c ? { cols: c.cols, rows: c.rows, cells: c.cells.map((x) => [...x]) } : { cols: 3, rows: 3, cells: [] }, { from: null, to: null });
    $('#lb-cols').value = String(builder.cols);
    $('#lb-rows').value = String(builder.rows);
    renderBuilder();
    $builder.showModal();
  }

  const cellAt = (x, y) => builder.cells.findIndex(([cx, cy, w, h]) => x >= cx && x < cx + w && y >= cy && y < cy + h);
  // The box being drawn: the rectangle between where the drag started and where it is.
  const dragBox = () => {
    if (!builder.from) return null;
    const [ax, ay] = builder.from;
    const [bx, by] = builder.to || builder.from;
    return [Math.min(ax, bx), Math.min(ay, by), Math.abs(ax - bx) + 1, Math.abs(ay - by) + 1];
  };
  const boxFree = ([x, y, w, h]) => {
    for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) if (cellAt(i, j) >= 0) return false;
    return true;
  };

  function renderBuilder() {
    const $c = $('#lb-canvas');
    $c.style.setProperty('--lb-cols', String(builder.cols));
    $c.style.setProperty('--lb-rows', String(builder.rows));
    const items = [];
    for (let y = 0; y < builder.rows; y++) {
      for (let x = 0; x < builder.cols; x++) {
        const cell = document.createElement('div');
        cell.className = 'lb-cell';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cell.style.gridArea = `${y + 1} / ${x + 1}`;
        items.push(cell);
      }
    }
    // Numbered in the order feeds fill them: biggest first.
    const order = layoutUnits({ cols: builder.cols, rows: builder.rows, cells: builder.cells });
    const scale = (v, n) => (v * n) / LAYOUT_UNITS;
    builder.cells.forEach(([x, y, w, h], i) => {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'lb-box';
      box.style.gridArea = `${y + 1} / ${x + 1} / span ${h} / span ${w}`;
      const n = order.findIndex(([ux, uy]) => scale(ux, builder.cols) === x && scale(uy, builder.rows) === y) + 1;
      box.textContent = String(n);
      box.title = 'Remove this box';
      box.setAttribute('aria-label', `Box ${n}: remove`);
      box.addEventListener('click', () => {
        builder.cells.splice(i, 1);
        renderBuilder();
      });
      items.push(box);
    });
    const d = dragBox();
    if (d) {
      const ghost = document.createElement('div');
      ghost.className = `lb-ghost${boxFree(d) ? '' : ' blocked'}`;
      ghost.style.gridArea = `${d[1] + 1} / ${d[0] + 1} / span ${d[3]} / span ${d[2]}`;
      items.push(ghost);
    }
    $c.replaceChildren(...items);
    const free = builder.cols * builder.rows - builder.cells.reduce((sum, [, , w, h]) => sum + w * h, 0);
    setText($('#lb-count'), builder.cells.length
      ? `${builder.cells.length} box${builder.cells.length === 1 ? '' : 'es'}${free ? ` · ${free} empty square${free === 1 ? '' : 's'} stay black` : ''} · numbers show the order feeds fill them`
      : 'Drag across the squares to draw the first box.');
    $('#lb-save').disabled = !builder.cells.length;
  }

  const $lbCanvas = $('#lb-canvas');
  const squareOf = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lb-cell');
    return el && $lbCanvas.contains(el) ? [Number(el.dataset.x), Number(el.dataset.y)] : null;
  };
  $lbCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.lb-box')) return;
    const at = squareOf(e);
    if (!at) return;
    e.preventDefault();
    $lbCanvas.setPointerCapture(e.pointerId);
    builder.from = at;
    builder.to = at;
    renderBuilder();
  });
  $lbCanvas.addEventListener('pointermove', (e) => {
    if (!builder.from) return;
    const at = squareOf(e);
    if (at && (at[0] !== builder.to[0] || at[1] !== builder.to[1])) {
      builder.to = at;
      renderBuilder();
    }
  });
  const endDraw = (keep) => {
    const d = dragBox();
    builder.from = null;
    builder.to = null;
    if (keep && d && boxFree(d)) builder.cells.push(d);
    renderBuilder();
  };
  $lbCanvas.addEventListener('pointerup', () => endDraw(true));
  $lbCanvas.addEventListener('pointercancel', () => endDraw(false));
  for (const key of ['cols', 'rows']) {
    $(`#lb-${key}`).addEventListener('change', (e) => {
      builder[key] = Number(e.target.value);
      // Boxes that no longer fit go; the rest stay.
      builder.cells = builder.cells.filter(([x, y, w, h]) => x + w <= builder.cols && y + h <= builder.rows);
      renderBuilder();
    });
  }
  $('#lb-clear').addEventListener('click', () => {
    builder.cells = [];
    renderBuilder();
  });
  $('#layout-custom').addEventListener('click', openBuilder);
  $builder.addEventListener('close', () => {
    if ($builder.returnValue !== 'save') return;
    const layout = validCustomLayout({ cols: builder.cols, rows: builder.rows, cells: builder.cells });
    if (!layout) return;
    settings.customLayout = layout;
    useLayout('custom');
    logEvent(null, `Custom layout: ${layout.cells.length} box${layout.cells.length === 1 ? '' : 'es'} on a ${layout.cols} × ${layout.rows} grid`);
  });

  function updateSummary() {
    const list = [...tiles.values()];
    const playing = list.filter((t) => t.ready && t.ps === PS.PLAYING);
    syncWallAlerts();
    const lags = playing.map((t) => t.latency).filter((v) => v != null);
    $readout.playing.textContent = `${playing.length}/${list.length}`;
    // Red when any feed is buffering or failed; amber only while feeds are still starting
    // or have ended (YouTube's word, so a finished broadcast isn't a fault).
    $readout.playing.dataset.tone = list.some((t) => t.error || (t.ps === PS.BUFFERING && !t.endedSeen)) ? 'bad'
      : playing.length < list.length ? 'warn' : '';
    $readout.latency.textContent = lags.length ? `${median(lags).toFixed(1)}s` : '—';
    $readout.latency.parentElement.title = 'Delay: median across playing live feeds, from YouTube\'s stamp on a frame to this screen (edge delay on YouTube\'s side + behind edge on this PC)';

    // Sync: how far apart the synced feeds are right now.
    const $sync = $('#r-sync');
    const members = [...sync.members];
    const inSync = members.filter((t) => Math.abs(t.syncOffset() ?? Infinity) <= SYNC_TOLERANCE_S).length;
    if (wallShifted()) {
      setText($sync, `${inSync}/${members.length}${sync.spread == null ? '' : ` · ${sync.spread.toFixed(1)}s`}`);
      setTone($sync, sync.spread == null || sync.spread <= SYNC_TOLERANCE_S * 2 ? 'ok' : sync.spread <= 2 ? 'warn' : 'bad');
    } else if (!settings.syncFeeds) {
      setText($sync, 'Off');
      setTone($sync, '');
    } else if (sync.target == null) {
      setText($sync, '—');
      setTone($sync, '');
    } else {
      setText($sync, `${inSync}/${members.length} · ${sync.spread.toFixed(1)}s`);
      setTone($sync, sync.spread <= SYNC_TOLERANCE_S * 2 ? 'ok' : sync.spread <= 2 ? 'warn' : 'bad');
    }
    const excluded = [...sync.excluded].map(([t, why]) => `${t.stream.label}: ${why}`);
    $sync.parentElement.title = wallShifted()
      ? `Wall timeline: ${inSync} of ${members.length} feeds within ±${SYNC_TOLERANCE_S}s of the moment it's on.${excluded.length ? ` Not following: ${excluded.join(' · ')}` : ''}`
      : !settings.syncFeeds ? 'Sync is off (Settings → Sync)'
      : sync.target == null ? 'Sync starts once two live feeds have found their edge delay'
        : `${inSync} of ${members.length} feeds within ±${SYNC_TOLERANCE_S}s of the wall's ${sync.target.toFixed(1)}s delay; `
          + `the synced feeds are ${sync.spread.toFixed(1)}s apart. The delay is set by ${sync.setBy?.stream.label} `
          + `(edge delay ${sync.setBy?.baseline.toFixed(1)}s + ${settings.syncMarginSec}s margin).`
          + (excluded.length ? ` Not synced: ${excluded.join(' · ')}` : '');
    // Bandwidth, per feed and for the wall. With the Feed Meter extension every number is
    // measured inside the players; without it "need" falls back to typical bitrates.
    const now = Date.now();
    const active = list.filter((t) => t.mounted && !t.error);
    const rates = active.map((t) => t.bitrate(now));
    const need = rates.reduce((sum, r) => sum + r.mbps, 0);
    const measuredNeed = rates.filter((r) => r.measured).length;
    const budget = settings.bandwidthMbps;
    setText($readout.load, active.length ? `${need.toFixed(1)}${budget ? `/${budget}` : ''} Mbps` : '—');
    setText($('#r-load-tag'), !active.length || measuredNeed === 0 ? 'Estimated' : measuredNeed === active.length ? 'Measured' : 'Partly measured');
    $readout.load.dataset.tone = budget && need > budget ? 'bad'
      : wall.congested || Number.isFinite(wall.boostCap) || (budget && need > budget * BUDGET_HEADROOM) ? 'warn' : '';
    $readout.load.parentElement.title = wall.congested ? 'Several feeds are stalling together: the link looks congested'
      : Number.isFinite(wall.boostCap) ? `Priority boosts limited to ${wall.boostCap} until the link stays calm`
        : `Bitrate of every feed added up${measuredNeed < active.length ? `: ${measuredNeed} of ${active.length} measured by the Feed Meter, the rest typical for their quality` : ', measured by the Feed Meter'}${budget ? ` · against your ${budget} Mbps link` : ''}`;

    const metered = active.map((t) => [t, t.meterNow(now)]).filter(([, m]) => m?.receivedMbps != null);
    const getting = metered.reduce((sum, [, m]) => sum + m.receivedMbps, 0);
    const short = metered.filter(([t]) => (t.headroom(now) ?? Infinity) < HEADROOM_LOW).map(([t]) => t.stream.label);
    setText($readout.getting, metered.length ? `${getting.toFixed(1)} Mbps` : '—');
    setText($('#r-getting-tag'), metered.length ? 'Measured' : 'N·A');
    $readout.getting.dataset.tone = short.length ? 'bad' : '';
    $readout.getting.parentElement.title = !metered.length
      ? (isChromium() ? 'Needs the IXG Wall Feed Meter extension in this browser: Settings → Install Feed Meter'
        : 'Needs the IXG Wall Feed Meter extension, which runs in Chrome or Edge on a computer')
      : `Video and audio actually received by ${metered.length} of ${active.length} feeds over the last 30 s`
        + (short.length ? ` · connection can't keep up on: ${short.join(', ')}` : ' · every feed\'s connection is ahead of its bitrate');

    // Measured by the backend: the laptop's whole download right now. On the website the
    // server isn't the computer showing the wall, and nothing in a browser can see the
    // computer's network, so it says N·A rather than show the server's.
    if (server.hosted) {
      setText($('#r-bw-now'), 'N·A');
      delete $('#r-bw-now').dataset.tone;
      setText($('#r-bw-now-tag'), 'N·A');
      setText($('#r-bw-now-desc'), 'Only the laptop wall can measure this computer\'s download: a website can\'t.');
      $('#r-bw-now-wrap').title = 'Start the wall with npm run wall (or Start IXG Wall.cmd) on this laptop to measure it';
    }
    const t = backendFresh() && !server.hosted ? backend.latest : null;
    if (!server.hosted) setText($readout.bwNow, t?.rxMbps != null ? `${t.rxMbps.toFixed(1)} Mbps` : '—');
    $readout.bwNow.dataset.tone = budget && t?.rxMbps > budget ? 'bad' : budget && t?.rxMbps > budget * BUDGET_HEADROOM ? 'warn' : '';
    const other = t?.rxMbps != null && metered.length === active.length && active.length ? Math.max(0, t.rxMbps - getting) : null;
    if (!server.hosted) $readout.bwNow.parentElement.title = !t
      ? 'Backend offline: start the wall with npm run wall to measure the PC\'s download'
      : `Whole PC download on ${t.nic || 'the busiest adapter'}, measured by the backend`
        + (other != null ? ` · feeds ${getting.toFixed(1)} Mbps, everything else on this PC ${other.toFixed(1)} Mbps` : '');
    // CPU: the backend's counters on a laptop wall, the Feed Meter's reading anywhere else.
    const m = machine();
    setText($readout.cpu, m?.cpu != null ? `${Math.round(m.cpu)}%` : server.hosted ? 'N·A' : '—');
    setText($('#r-cpu-tag'), m?.cpu != null ? 'Measured' : 'N·A');
    setText($('#r-cpu-desc'), m?.source === 'meter' ? 'Processor use across this computer, read by the Feed Meter.'
      : m ? 'Processor use across this computer.'
        : server.hosted ? 'Needs the Feed Meter 1.4 or newer in this browser to measure this computer.' : 'Processor use across this computer.');
    $readout.cpu.dataset.tone = perf.level === 'overloaded' ? 'bad' : perf.level === 'busy' || m?.cpu >= 75 ? 'warn' : '';
    $readout.cpu.parentElement.title = m
      ? `Whole-computer CPU across ${m.cores} threads, ${m.source === 'meter' ? 'read by the Feed Meter' : 'measured by the backend'}${cpuPressure ? ` · browser CPU pressure: ${cpuPressure}` : ''}${perf.level !== 'ok' ? ` · ${perf.level}: ${perf.reason}` : ''}`
      : server.hosted ? 'Install the Feed Meter 1.4 or newer (Settings → Install Feed Meter) to measure this computer' : 'Backend offline';
    // Memory: the same source. Past PERF_BUSY_MEM Windows pages to disk, which stutters video.
    const mem = m?.memUsedPct != null ? m : null;
    setText($('#r-mem'), mem ? `${Math.round(mem.memUsedPct)}%` : server.hosted ? 'N·A' : '—');
    setText($('#r-mem-tag'), mem ? 'Measured' : 'N·A');
    setText($('#r-mem-desc'), mem ? `${(mem.memTotalGB * mem.memUsedPct / 100).toFixed(1)} of ${mem.memTotalGB} GB in use across this computer${mem.source === 'meter' ? ', read by the Feed Meter' : ''}.`
      : server.hosted ? 'Needs the Feed Meter 1.4 or newer in this browser to measure this computer.' : 'Memory in use across this computer.');
    $('#r-mem').dataset.tone = mem?.memUsedPct >= PERF_BUSY_MEM ? 'bad' : mem?.memUsedPct >= 85 ? 'warn' : '';
    $('#r-mem-wrap').title = mem ? `Whole-computer memory, ${mem.source === 'meter' ? 'read by the Feed Meter' : 'measured by the backend'} · above ${PERF_BUSY_MEM}% Windows pages to disk and video stutters`
      : server.hosted ? 'Install the Feed Meter 1.4 or newer (Settings → Install Feed Meter) to measure this computer' : 'Backend offline';
    // Mixed walls show live CCV; a wall of ended broadcasts shows their total views.
    const audience = wallAudience(list);
    $('#r-ccv-wrap').hidden = !hasYtKey() || !list.length;
    setText($('#r-audience-label'), audience.label);
    $('#r-ccv-wrap').dataset.kind = audience.label === 'Views' ? 'views' : 'ccv';
    // Compact (1.7M, 20K) beside the tabs; the exact count is in the tooltip.
    setText($('#r-ccv'), audience.value == null ? '—' : audience.value < 1000 ? String(audience.value) : compactNumber.format(audience.value));
    const total = ytState?.total;
    const peak = audience.label === 'CCV' && total?.peak != null
      ? ` · peak ${fmtInt(total.peak)} at ${new Date(total.peakAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · average ${fmtInt(total.avg)}`
      : '';
    $('#r-ccv-wrap').title = audience.value != null
      ? `${fmtInt(audience.value)} ${audience.label === 'Views' ? 'total views across ended feeds' : 'watching across live feeds'}, reported by YouTube (${audience.reported}/${audience.feeds} counts available)${peak}`
      : audience.feeds ? `YouTube has not reported ${audience.label === 'Views' ? 'views for these ended feeds' : 'viewer counts for these live feeds'}${peak}`
        : 'Waiting for a live or ended broadcast from YouTube…';
    // A stale LIVE is a lie: the badge shows only while a live feed is actually playing.
    $liveBadge.hidden = !playing.some((t) => t.isLive);
    // A card nothing can measure here (N·A) is left out rather than shown empty.
    for (const card of document.querySelectorAll('.wall-stats-grid .metric')) {
      const tag = card.querySelector('.metric-label .tag');
      card.hidden = (tag?.textContent === 'N·A') || card.querySelector('.metric-value')?.textContent === 'N·A';
    }
    renderSessionChip();
    renderWallTimeline();
  }

  function restartLoop() {
    clearInterval(loopTimer);
    loopTimer = setInterval(() => {
      const now = Date.now();
      wall.autoJumpsLeft = MAX_AUTO_JUMPS_PER_TICK;
      pollMachine();
      updateCongestion(now);
      updateSync();
      updatePerf(now);
      updateMemoryGuard(now);
      updateOffloadTimer(now);
      updateOffload(now);
      allocate();
      pumpQueue();
      for (const t of tiles.values()) {
        try {
          t.tick(now);
        } catch (err) {
          console.error(err);
        }
      }
      measureSyncSpread(); // after this round's jumps, not before
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
  // User links (admins only): each one signs whoever opens it in as a user. The server keeps
  // them (secrets.json) and is the one that blocks users from the integrations.
  // ---------------------------------------------------------------------------
  let userLinkList = [];

  async function linksAction(url, body) {
    const $err = $('#link-error');
    $err.hidden = true;
    try {
      const res = await api(url, body ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
        body: JSON.stringify(body),
      } : { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 404 && !body ? 'The running backend is older than user links: restart it.' : data.error || `HTTP ${res.status}`);
      userLinkList = data.links || [];
      renderLinks();
      return true;
    } catch (err) {
      $err.textContent = err.message === 'Failed to fetch' ? 'Backend offline.' : err.message;
      $err.hidden = false;
      return false;
    }
  }

  const loadLinks = () => linksAction('/api/links');

  // Clipboard access needs https or localhost; on a plain-http office address the link is
  // selected so it can be copied by hand.
  async function copyText(text, input) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      input.focus();
      input.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
  }

  function renderLinks() {
    $('#link-list').replaceChildren(...userLinkList.map((l) => {
      const li = document.createElement('li');
      li.className = 'session-row';
      const info = document.createElement('div');
      info.className = 'session-info';
      const name = document.createElement('span');
      name.className = 'session-row-name';
      name.textContent = l.name;
      const meta = document.createElement('span');
      meta.className = 'session-row-meta';
      meta.textContent = [
        l.expired ? 'Expired' : l.expiresAt ? `Until ${localStamp(l.expiresAt, { short: true })}` : 'Until revoked',
        l.youtube ? 'YouTube numbers & ingest' : 'no YouTube data',
        l.lastUsedAt ? `opened ${fmtDuration(Date.now() - Date.parse(l.lastUsedAt))} ago` : 'not opened yet',
      ].join(' · ');
      meta.dataset.tone = l.expired ? 'warn' : '';
      meta.title = `Made ${localStamp(l.createdAt, { zone: true })}`;
      const url = document.createElement('input');
      url.className = 'input';
      url.readOnly = true;
      url.value = l.url;
      url.setAttribute('aria-label', `Link for ${l.name}`);
      url.addEventListener('focus', () => url.select());
      info.append(name, meta, url);
      const copy = document.createElement('button');
      copy.className = 'btn btn-outline btn-xs';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        const ok = await copyText(l.url, url);
        copy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      });
      const revoke = document.createElement('button');
      revoke.className = 'btn btn-ghost btn-xs';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke ${l.name}`);
      revoke.addEventListener('click', async () => {
        const ok = await ask({
          title: `Revoke "${l.name}"?`,
          body: 'The link stops working, and every browser that opened it is signed out on its next request. Generate a new link to let them back in.',
          confirm: 'Revoke link',
          variant: 'destructive',
        });
        if (ok) linksAction('/api/links/revoke', { id: l.id });
      });
      li.append(info, copy, revoke);
      return li;
    }));
  }

  $('#link-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#link-name').value.trim();
    if (!name) {
      $('#link-name').focus();
      return;
    }
    if (await linksAction('/api/links', { name, days: Number($('#link-days').value), youtube: $('#link-youtube').checked })) {
      $('#link-name').value = '';
      // The new link is last: copy it straight away, ready to share.
      const row = $('#link-list').lastElementChild;
      row?.querySelector('button')?.click();
      row?.scrollIntoView({ block: 'nearest' });
    }
  });

  // ---------------------------------------------------------------------------
  // Timelines: a seek bar on every feed, and one for the wall that moves every live feed to
  // the same moment. The sync controller holds them there (updateSync, Tile.keepInSync).
  // ---------------------------------------------------------------------------
  // A seek bar: hovering labels the moment under the pointer; a click, or a drag released,
  // seeks. Seeking 30 players on every pointer move would flood them, so a drag only previews.
  function scrubber(el, { describe, commit }) {
    const $tip = el.querySelector('.tl-tip');
    let dragging = false;
    const at = (e) => {
      const r = el.getBoundingClientRect();
      return r.width ? clamp((e.clientX - r.left) / r.width, 0, 1, 0) : 0;
    };
    const tip = (p) => {
      const text = describe(p);
      $tip.hidden = !text;
      if (!text) return false;
      $tip.textContent = text;
      // Kept inside the bar, so a label at either end isn't cut off by the tile's edge.
      const w = el.clientWidth;
      const half = $tip.offsetWidth / 2;
      $tip.style.left = `${clamp(p * w, half, Math.max(half, w - half), p * w)}px`;
      return true;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !tip(at(e))) return;
      e.preventDefault();
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      el.style.setProperty('--drag', String(at(e)));
    });
    el.addEventListener('pointermove', (e) => {
      const p = at(e);
      tip(p);
      if (dragging) el.style.setProperty('--drag', String(p));
    });
    const end = (e, apply) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (!el.matches(':hover')) $tip.hidden = true;
      if (apply) commit(at(e));
    };
    el.addEventListener('pointerup', (e) => end(e, true));
    el.addEventListener('pointercancel', (e) => end(e, false));
    el.addEventListener('pointerleave', () => {
      if (!dragging) $tip.hidden = true;
    });
  }

  // Live feeds the wall timeline can move: playing, measured, and allowed to rewind.
  function timelineFollowers() {
    return [...tiles.values()].filter((t) => t.ready && t.player && !t.error && t.isLive
      && !t.own && t.latency != null && t.allowsRewind() !== false);
  }

  // The wall timeline in seconds of delay: live is its right end, `span` seconds back its
  // left. `at` is where the wall is; `reach` how far back any feed's live rewind goes.
  function wallTimelineView(now = Date.now()) {
    const live = timeline.liveDelay;
    if (live == null) return null;
    const nowS = now / 1000;
    const reaches = timelineFollowers().filter((t) => t.span?.k != null).map((t) => nowS - (t.span.start + t.span.k) - live);
    if (!reaches.length) return null;
    const reach = Math.max(0, ...reaches);
    const at = timeline.paused ? nowS - timeline.paused.stamp : timeline.delay ?? live;
    const back = Math.max(0, at - live);
    const want = settings.timelineSpanMin * 60;
    const span = Math.max(want ? Math.min(want, reach) : reach, back + 30, 60);
    return { live, span, at, back, reach, nowS };
  }

  function describeWallAt(p) {
    const v = wallTimelineView();
    if (!v) return null;
    const delay = v.live + (1 - p) * v.span;
    const back = delay - v.live;
    if (back > v.reach + 1) return 'Before what YouTube keeps';
    return `${back < TIMELINE_LIVE_S ? 'Live' : `−${fmtClock(back)}`} · ${stampClock(v.nowS - delay)}`;
  }

  // Every feed that can follows the wall to this delay; feeds moved on their own seek bars
  // rejoin. Within TIMELINE_LIVE_S of live it's simply live again.
  function seekWall(delay) {
    const live = timeline.liveDelay;
    if (live == null) return;
    for (const t of tiles.values()) t.own = null;
    if (delay - live < TIMELINE_LIVE_S) {
      goLive();
      return;
    }
    const now = Date.now();
    const stamp = now / 1000 - delay;
    if (timeline.paused) timeline.paused.stamp = stamp;
    else timeline.delay = delay;
    updateSync();
    for (const t of sync.members) t.seekStamp(stamp, now);
    logEvent(null, `Wall timeline: ${fmtClock(delay - live)} behind live (${stampClock(stamp)}), ${sync.members.size} feed${sync.members.size === 1 ? '' : 's'} following`);
    renderTimelines();
  }

  function stepWall(sec) {
    const v = wallTimelineView();
    if (v) seekWall(Math.max(v.live, v.at - sec));
  }

  // Pauses every feed that can rewind, on one frame; the rest stay live.
  function pauseWall() {
    if (timeline.paused) return;
    const list = timelineFollowers().filter((t) => t.ps === PS.PLAYING || t.ps === PS.BUFFERING);
    const stamps = list.map((t) => t.mediaTime()).filter((v) => v != null);
    if (!stamps.length) return;
    const now = Date.now();
    const stamp = median(stamps);
    timeline.paused = { stamp, tiles: new Set(list) };
    for (const t of list) {
      t.endNudge();
      t.endCatchUp();
      try {
        t.player.pauseVideo();
        // Feeds that weren't in sync stop on the same frame as the rest.
        const media = t.mediaTime();
        if (media != null && Math.abs(media - stamp) > 1) t.seekStamp(stamp, now);
      } catch {
        // the player is being replaced; it starts live and follows once the wall plays
      }
    }
    updateSync();
    logEvent(null, `Wall timeline paused at ${stampClock(stamp)}, ${list.length} feed${list.length === 1 ? '' : 's'}`);
    renderTimelines();
  }

  function playWall() {
    const p = timeline.paused;
    if (!p) return;
    timeline.paused = null;
    timeline.delay = Date.now() / 1000 - p.stamp;
    for (const t of p.tiles) {
      if (!tiles.has(t.stream.id) || !t.player) continue;
      try {
        t.player.playVideo();
      } catch {
        // the player is being replaced
      }
    }
    updateSync();
    logEvent(null, `Wall timeline playing from ${stampClock(p.stamp)}, ${fmtClock(Math.max(0, timeline.delay - (timeline.liveDelay ?? 0)))} behind live`);
    renderTimelines();
  }

  // Back to live: every feed, including those moved on their own seek bars.
  function goLive() {
    const paused = timeline.paused;
    const shifted = wallShifted() || [...tiles.values()].some((t) => t.own);
    timeline.delay = null;
    timeline.paused = null;
    for (const t of tiles.values()) t.own = null;
    sync.target = null;
    updateSync();
    for (const t of tiles.values()) {
      if (paused?.tiles.has(t)) {
        try {
          t.player?.playVideo();
        } catch {
          // the player is being replaced; it starts live anyway
        }
      }
      if (t.isLive) t.resync(shifted ? 'timeline back to live' : 'manual, all');
    }
    if (shifted) logEvent(null, 'Wall timeline back to live');
    renderTimelines();
  }

  const $transport = $('#transport');
  const $wallTl = $('#tl-master');
  scrubber($wallTl, {
    describe: describeWallAt,
    commit: (p) => {
      const v = wallTimelineView();
      if (v) seekWall(v.live + Math.min((1 - p) * v.span, v.reach));
    },
  });

  function renderTimelines() {
    for (const t of tiles.values()) t.renderTimeline();
    renderWallTimeline();
  }

  function renderWallTimeline() {
    $transport.hidden = !tiles.size;
    if (!tiles.size) return;
    if (document.activeElement !== $span && $span.value !== String(settings.timelineSpanMin)) $span.value = String(settings.timelineSpanMin);
    const v = wallTimelineView();
    const paused = !!timeline.paused;
    const anyOwn = [...tiles.values()].some((t) => t.own);
    $wallTl.classList.toggle('is-off', !v);
    $wallTl.classList.toggle('is-live', !!v && !wallShifted());
    $wallTl.dataset.state = [...tiles.values()].some((t) => t.isLive && !t.broadcastEnded()) ? 'live' : 'ended';
    $wallTl.style.setProperty('--at', v ? String(clamp(1 - (v.at - v.live) / v.span, 0, 1, 1)) : '1');
    // Before what YouTube keeps: shaded, so the bar shows where a seek can't go.
    $wallTl.style.setProperty('--reach', v ? String(clamp(1 - v.reach / v.span, 0, 1, 0)) : '0');
    $wallTl.setAttribute('aria-valuetext', !v ? 'Waiting for live feeds' : v.back < TIMELINE_LIVE_S && !paused ? 'Live' : `${fmtClock(v.back)} behind live`);

    const $behind = $('#tl-behind');
    setText($behind, !v ? '—' : paused ? `−${fmtClock(v.back)}` : wallShifted() ? `−${fmtClock(v.back)}` : 'Live');
    $behind.dataset.state = !v ? '' : paused ? 'paused' : wallShifted() ? 'back' : 'live';
    setText($('#tl-clock'), v ? stampClock(v.nowS - v.at) : '');
    $('#tl-clock').title = 'YouTube\'s time stamp on the frame the wall is showing, in this computer\'s time zone';

    const $play = $('#tl-play');
    $play.disabled = !v;
    $play.setAttribute('aria-label', paused ? 'Play every feed' : 'Pause every feed');
    $play.title = paused ? 'Play every paused feed from here' : 'Pause every live feed that YouTube lets rewind, on the same frame';
    $play.querySelector('.i-pause').hidden = paused;
    $play.querySelector('.i-play').hidden = !paused;
    $('#tl-back').disabled = !v;
    $('#tl-fwd').disabled = !v || (!wallShifted());
    $('#tl-live').disabled = !wallShifted() && !anyOwn;

    const live = [...tiles.values()].filter((t) => t.isLive);
    const followers = timelineFollowers();
    const $follow = $('#tl-follow');
    if (!live.length) setText($follow, 'No live feeds');
    else if (wallShifted()) setText($follow, `${sync.members.size}/${live.length} following`);
    else setText($follow, `${followers.length}/${live.length} can rewind`);
    const notFollowing = [...sync.excluded].map(([t, why]) => `${t.stream.label}: ${why}`);
    $follow.title = wallShifted()
      ? `${sync.members.size} of ${live.length} live feeds follow the wall timeline.${notFollowing.length ? ` Not following: ${notFollowing.join(' · ')}` : ''}`
      : `${followers.length} of ${live.length} live feeds can be moved back: YouTube's live rewind (DVR) is on for them and they're playing.`;
  }

  $('#tl-play').addEventListener('click', () => (timeline.paused ? playWall() : pauseWall()));
  $('#tl-back').addEventListener('click', () => stepWall(-TIMELINE_STEP_S));
  $('#tl-fwd').addEventListener('click', () => stepWall(TIMELINE_STEP_S));
  $('#tl-live').addEventListener('click', goLive);
  $wallTl.addEventListener('keydown', (e) => {
    const v = wallTimelineView();
    if (!v) return;
    if (e.key === 'ArrowLeft') stepWall(-TIMELINE_STEP_S);
    else if (e.key === 'ArrowRight') stepWall(TIMELINE_STEP_S);
    else if (e.key === 'End') goLive();
    else if (e.key === 'Home') seekWall(v.live + Math.min(v.span, v.reach));
    else if (e.key === ' ' || e.key === 'k') timeline.paused ? playWall() : pauseWall();
    else return;
    e.preventDefault();
  });
  const $span = $('#tl-span');
  $span.value = String(settings.timelineSpanMin);
  $span.addEventListener('change', () => {
    settings.timelineSpanMin = Number($span.value);
    store.save();
    renderTimelines();
  });

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------
  const viewTabs = [...document.querySelectorAll('.wall-tab')];
  let feedPageScroll = 0;
  function showWallView(tab) {
    const feeds = tab.id === 'feeds-tab';
    const wasStats = document.body.classList.contains('wall-stats-view');
    if (!feeds && !wasStats) feedPageScroll = window.scrollY;
    document.body.classList.toggle('wall-stats-view', !feeds);
    if (feeds && wasStats) window.scrollTo(0, feedPageScroll);
    else if (!feeds) window.scrollTo(0, 0);
    for (const button of viewTabs) {
      const selected = button === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const panel = $('#feeds-panel');
    panel.classList.toggle('is-inactive', !feeds);
    panel.inert = !feeds;
    panel.setAttribute('aria-hidden', String(!feeds));
    $('#wall-stats-panel').hidden = feeds;
    // Hidden but still taking its height, so the players keep their size (see is-inactive).
    $transport.classList.toggle('is-inactive', !feeds);
    if (!feeds) {
      closeFeedSheet();
      syncWallAlerts();
      renderLog();
    }
  }
  viewTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => showWallView(tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % viewTabs.length;
      else if (event.key === 'ArrowLeft') next = (index + viewTabs.length - 1) % viewTabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = viewTabs.length - 1;
      else return;
      event.preventDefault();
      showWallView(viewTabs[next]);
      viewTabs[next].focus();
    });
  });

  function showFormError(msg) {
    $formError.textContent = msg;
    $formError.hidden = !msg;
    if (msg) $source.setAttribute('aria-invalid', 'true');
    else $source.removeAttribute('aria-invalid');
  }

  // ---- Add feeds: paste one link, a list, or a whole message ------------------------
  // The popover reads the YouTube links out of whatever is pasted (a Slack or WhatsApp
  // message, an email) and names each feed from the text beside its link. The preview lists
  // what it found; names can be edited and feeds unticked before they go on the wall.
  let addRows = [];           // { key, source, raw, label, state: new|dup|bad, why, include }
  const addEdits = new Map(); // key -> { label, include } as the operator set them; survives re-reading
  const addEdit = (key) => {
    if (!addEdits.has(key)) addEdits.set(key, {});
    return addEdits.get(key);
  };

  function setAddPanel(open) {
    $addPanel.hidden = !open;
    $addToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!$sessionPanel.hidden) setSessionPanel(false);
      showFormError('');
      readAddInput();
      $source.focus();
    }
  }

  function readAddInput() {
    const onWall = new Map(streams.map((s) => [s.source.id, s.label]));
    addRows = readMessage($source.value).map((f) => {
      const key = f.source ? f.source.id : `raw:${f.raw}`;
      const edit = addEdits.get(key) || {};
      let state = 'new';
      let why = '';
      if (!f.source) {
        state = 'bad';
        why = f.problem === 'channel' ? 'Channel link: open the live stream and copy its own URL' : 'Not a YouTube video link';
      } else if (onWall.has(f.source.id)) {
        state = 'dup';
        why = `Already on the wall as ${onWall.get(f.source.id)}`;
      }
      return { key, source: f.source, raw: f.raw, label: edit.label ?? f.label, state, why, include: state === 'new' && edit.include !== false };
    });
    renderAddPreview();
  }

  function addRowEl(r) {
    const li = document.createElement('li');
    li.className = 'add-row';
    li.dataset.state = r.state;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = r.include;
    check.disabled = r.state !== 'new';
    check.setAttribute('aria-label', `Add ${r.label || r.source?.id || r.raw}`);
    check.addEventListener('change', () => {
      r.include = check.checked;
      addEdit(r.key).include = check.checked;
      updateAddButton();
    });
    let name;
    if (r.state === 'new') {
      name = document.createElement('input');
      name.className = 'input add-label';
      name.value = r.label;
      name.placeholder = 'Name from YouTube';
      name.setAttribute('aria-label', `Name for ${r.source.id}`);
      name.addEventListener('input', () => {
        r.label = name.value;
        addEdit(r.key).label = name.value;
      });
    } else {
      name = document.createElement('span');
      name.className = 'add-name';
      name.textContent = r.label || '—';
    }
    const id = document.createElement('span');
    id.className = 'add-id';
    id.textContent = r.source ? r.source.id : r.raw.length > 32 ? `${r.raw.slice(0, 31)}…` : r.raw;
    id.title = r.raw;
    li.append(check, name, id);
    if (r.why) {
      const why = document.createElement('span');
      why.className = 'add-why';
      why.textContent = r.why;
      li.append(why);
    }
    return li;
  }

  function renderAddPreview() {
    const fresh = addRows.filter((r) => r.state === 'new').length;
    const skipped = addRows.length - fresh;
    $('#add-preview').hidden = !addRows.length;
    setText($('#add-found'), `${fresh} new feed${fresh === 1 ? '' : 's'} found${skipped ? ` · ${skipped} skipped` : ''}`);
    $('#add-list').replaceChildren(...addRows.map(addRowEl));
    updateAddButton();
  }

  function updateAddButton() {
    const n = addRows.filter((r) => r.include).length;
    $('#add-submit').textContent = n > 1 ? `Add ${n} feeds` : 'Add feed';
    $('#add-submit').disabled = !n;
  }

  $addToggle.addEventListener('click', () => setAddPanel($addPanel.hidden));
  $('#add-cancel').addEventListener('click', () => setAddPanel(false));
  document.addEventListener('pointerdown', (e) => {
    if (!$addPanel.hidden && !$addPanel.contains(e.target) && !$addToggle.contains(e.target)) setAddPanel(false);
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isAdmin()) return; // the server refuses a user's new feeds too
    readAddInput(); // the wall may have changed since the preview was drawn
    const picked = addRows.filter((r) => r.include);
    if (!picked.length) {
      showFormError(addRows.length
        ? 'Nothing new to add: every link is skipped or unticked.'
        : 'No YouTube links found. Paste live URLs, video IDs, or a message that contains them.');
      return;
    }
    for (const r of picked) {
      // A name from the message (or typed here) sticks; a blank one takes the YouTube title.
      const label = r.label.trim();
      const stream = {
        id: uid(), source: r.source, label: label || `Stream ${streams.length + 1}`, autoLabel: !label, addedAt: new Date().toISOString(),
      };
      streams.push(stream);
      const tile = addTile(stream);
      logEvent(tile, `Added (${r.source.id})`);
    }
    store.save(); // the backend polls YouTube for the new feeds within seconds
    $source.value = '';
    addEdits.clear();
    readAddInput();
    setAddPanel(false);
  });

  $source.addEventListener('input', () => {
    if (!$formError.hidden) showFormError('');
    readAddInput();
  });
  $source.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $form.requestSubmit();
  });

  // Also brings the wall timeline, and any feed moved on its own seek bar, back to live.
  $('#resync-all').addEventListener('click', goLive);

  // The load queue staggers these, priority feeds first.
  $('#reload-all').addEventListener('click', () => {
    for (const t of tiles.values()) t.reload('manual, all');
  });

  $('#clear-wall').addEventListener('click', async () => {
    if (!streams.length) return;
    const ok = await ask({
      title: 'Clear the entire wall?',
      body: 'Every player stops and all feeds are removed from the saved wall. Paste new links to add feeds again. Your settings are kept.',
      confirm: 'Clear wall',
      variant: 'destructive',
    });
    if (!ok) return;
    teardownTiles();
    streams.length = 0;
    store.saveLocal();
    clearTimeout(store.pushTimer);
    await pushWall();
    logEvent(null, 'Cleared all feeds from the wall');
    updateLayout();
    updateSummary();
    renderSession();
  });

  // Stops every player and takes every tile off the wall (the feeds' records are untouched).
  function teardownTiles() {
    closeFeedSheet();
    loadQueue.length = 0;
    for (const tile of tiles.values()) {
      tile.unmount();
      tileObserver.unobserve(tile.el);
      viewObserver.unobserve(tile.el);
      tile.el.remove();
    }
    tiles.clear();
    solo = null;
    wall.stallLog.length = 0;
    wall.boostCap = Infinity;
    wall.congested = false;
  }

  // ---- Sessions: each event's feeds kept apart ---------------------------------------
  // Only the active session's feeds load. Starting a new session or opening a saved one puts
  // the current feeds away in the saved list (an empty session isn't worth keeping).
  const $sessionPanel = $('#session-panel');
  const $sessionToggle = $('#session-toggle');
  const feedCount = (n) => `${n} feed${n === 1 ? '' : 's'}`;
  // "Sat, 4 Oct 2026, 15:42 → 18:10" (the end date only when it's another day).
  function sessionSpan(s) {
    if (!s.endedAt) return localStamp(s.startedAt);
    const sameDay = new Date(s.startedAt).toDateString() === new Date(s.endedAt).toDateString();
    return `${localStamp(s.startedAt)} → ${sameDay ? localStamp(s.endedAt, { timeOnly: true }) : localStamp(s.endedAt)}`;
  }

  function putAwayCurrent() {
    if (!streams.length) return;
    savedSessions.unshift({ ...session, endedAt: new Date().toISOString(), streams: streams.slice() });
    savedSessions.splice(MAX_SAVED_SESSIONS);
  }

  function switchTo(next, feeds, message) {
    putAwayCurrent();
    teardownTiles();
    session = next;
    streams.splice(0, streams.length, ...feeds);
    streams.forEach(addTile);
    store.save();
    logEvent(null, message);
    updateLayout();
    updateSummary();
    renderSession();
  }

  async function startSession(name) {
    if (streams.length) {
      const ok = await ask({
        title: `Start ${name}?`,
        body: `${session.name} (${feedCount(streams.length)}) is saved to the session list and its players stop. The wall starts empty.`,
        confirm: 'Start new session',
      });
      if (!ok) return false;
    }
    switchTo(newSession(name), [], `Started session ${name}`);
    return true;
  }

  async function openSession(id) {
    const s = savedSessions.find((x) => x.id === id);
    if (!s) return;
    const ok = await ask({
      title: `Open ${s.name}?`,
      body: `Loads its ${feedCount(s.streams.length)}.${streams.length ? ` ${session.name} (${feedCount(streams.length)}) is saved to the session list and its players stop.` : ''}`,
      confirm: 'Open session',
    });
    if (!ok || !savedSessions.includes(s)) return;
    savedSessions.splice(savedSessions.indexOf(s), 1);
    switchTo({ id: s.id, name: s.name, startedAt: s.startedAt, timeZone: s.timeZone || null }, s.streams.filter(validStream), `Opened session ${s.name}`);
    setSessionPanel(false);
  }

  async function deleteSession(id) {
    const s = savedSessions.find((x) => x.id === id);
    if (!s) return;
    const ok = await ask({
      title: `Delete ${s.name}?`,
      body: `Its ${feedCount(s.streams.length)} are forgotten. This can't be undone.`,
      confirm: 'Delete session',
      variant: 'destructive',
    });
    if (!ok || !savedSessions.includes(s)) return;
    savedSessions.splice(savedSessions.indexOf(s), 1);
    store.save();
    logEvent(null, `Deleted saved session ${s.name}`);
    renderSession();
  }

  // The header button: cheap, so the summary refresh keeps it current.
  function renderSessionChip() {
    setText($('#session-name'), session.name);
    setText($('#session-when'), localStamp(session.startedAt, { short: true }));
    $sessionToggle.title = `Session: ${session.name} · started ${localStamp(session.startedAt, { zone: true })} · ${feedCount(streams.length)} · ${savedSessions.length} saved`;
    const title = `${session.name} · IXG Wall`;
    if (document.title !== title) document.title = title;
  }

  function renderSession() {
    renderSessionChip();
    if ($sessionPanel.hidden) return;
    if (document.activeElement !== $('#session-name-input')) $('#session-name-input').value = session.name;
    setText($('#session-meta'), `Started ${localStamp(session.startedAt, { zone: true })} · ${feedCount(streams.length)} on the wall`);
    setText($('#session-saved-title'), savedSessions.length ? `Saved sessions · ${savedSessions.length}` : 'No saved sessions yet');
    $('#session-list').replaceChildren(...savedSessions.map((s) => {
      const li = document.createElement('li');
      li.className = 'session-row';
      const info = document.createElement('div');
      info.className = 'session-info';
      const name = document.createElement('span');
      name.className = 'session-row-name';
      name.textContent = s.name;
      const meta = document.createElement('span');
      meta.className = 'session-row-meta';
      meta.textContent = `${sessionSpan(s)} · ${feedCount(s.streams.length)}`;
      meta.title = `Started ${localStamp(s.startedAt, { zone: true })}${s.endedAt ? ` · saved ${localStamp(s.endedAt, { zone: true })}` : ''}`;
      const labels = document.createElement('span');
      labels.className = 'session-row-feeds';
      labels.textContent = s.streams.slice(0, 4).map((x) => x.label).join(' · ') + (s.streams.length > 4 ? ' …' : '');
      labels.title = s.streams.map((x) => `${x.label}${x.addedAt ? ` · added ${localStamp(x.addedAt, { short: true })}` : ''}`).join('\n');
      info.append(name, meta, labels);
      const open = document.createElement('button');
      open.className = 'btn btn-outline btn-xs';
      open.textContent = 'Open';
      open.addEventListener('click', () => openSession(s.id));
      const del = document.createElement('button');
      del.className = 'btn btn-ghost btn-xs';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete ${s.name}`);
      del.addEventListener('click', () => deleteSession(s.id));
      li.append(info, open, del);
      return li;
    }));
  }

  function setSessionPanel(open) {
    $sessionPanel.hidden = !open;
    $sessionToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      setAddPanel(false);
      renderSession();
    }
  }

  $sessionToggle.addEventListener('click', () => setSessionPanel($sessionPanel.hidden));
  document.addEventListener('pointerdown', (e) => {
    if (!$sessionPanel.hidden && !$sessionPanel.contains(e.target) && !$sessionToggle.contains(e.target)
      && !$dialog.contains(e.target)) setSessionPanel(false);
  });
  $('#session-rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#session-name-input').value.trim().slice(0, 80);
    if (!name || name === session.name) return;
    logEvent(null, `Renamed session ${session.name} to ${name}`);
    session.name = name;
    store.save();
    renderSession();
  });
  $('#session-new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#session-new-name').value.trim().slice(0, 80) || `Session ${localStamp(new Date().toISOString())}`;
    if (await startSession(name)) {
      $('#session-new-name').value = '';
      setSessionPanel(false);
    }
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
    else if (!$sessionPanel.hidden) setSessionPanel(false);
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
  $('#fs-link').addEventListener('click', () => {
    if (inspected) changeLink(inspected);
  });

  // ---- Capture Source Screenshot: evidence from the feed's own YouTube page (its player,
  // title, channel, LIVE state and watching-now count as YouTube shows them), taken by the
  // Feed Meter extension (extension/capture.js). The page can't reach the extension's
  // worker itself, so the request goes through one of the wall's players (courier.js).
  const CAPTURE_TIMEOUT_MS = 120000;
  let captureLogSeen = 0; // the backend's screenshot record, as far as this window has read it
  let captureLogBoot = null; // which run of the backend that record is from
  const shot = { job: null, tile: null, timer: 0, auto: null };
  const AUTO_REASON = { peak: 'CCV peak', end: 'stream ended' };
  // What the extension's failures mean for an automatic job: worth handing back (the
  // extension hiccuped) or not (the source itself is the problem). 'busy' (another screenshot
  // was being taken in this browser) is handed back too, but isn't counted as a try, and this
  // window leaves the queue alone for a while so the other capture can finish.
  const AUTO_RETRY = new Set(['extension']);
  const AUTO_BUSY_WAIT_MS = 20000;
  let autoBusyUntil = 0;
  const capturePost = (url, body) => api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-IXG-Wall': '1' },
    body: JSON.stringify(body),
  });

  // The sheet shows a manual capture, and an automatic one only while it's open on that feed:
  // moved to another feed, it shows nothing of the capture, not a stale progress line.
  function shotStatus(text, tone = '', forAuto = false) {
    const el = $('#fs-shot-status');
    if (forAuto && inspected !== shot.tile) {
      el.hidden = true;
      return;
    }
    setText(el, text);
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
    el.hidden = !text;
  }

  // Any mounted player carries the request; one the meter already reports from, for choice.
  function courierFrame() {
    const mounted = [...tiles.values()].filter((t) => t.mounted && t.frame.querySelector('iframe'));
    const t = mounted.find((x) => x.meterNow()) || mounted[0];
    return t ? { win: t.frame.querySelector('iframe').contentWindow, origin: t.host } : null;
  }

  // Why this page can't take a screenshot now, or '' when it can.
  function captureBlocker() {
    if (!meterActive()) return 'Needs the IXG Wall Feed Meter 1.3 or newer in this browser (Settings → Install Feed Meter)';
    if (meterSeen.version && newerVersion('1.3.0', meterSeen.version)) return `This browser has Feed Meter ${meterSeen.version}; screenshots need 1.3.0 or newer: update it`;
    if (!courierFrame()) return 'No player to send the request through: start a feed first';
    return '';
  }

  function endShot(text, tone, { retry = false, busy = false, outcome = '', detail = '' } = {}) {
    clearTimeout(shot.timer);
    const auto = shot.auto;
    shotStatus(text, tone, !!auto);
    shot.job = null;
    shot.tile = null;
    shot.auto = null;
    $('#fs-shot').disabled = false;
    if (auto) {
      if (busy) autoBusyUntil = Date.now() + AUTO_BUSY_WAIT_MS;
      capturePost('/api/capture/result', { job: auto.job, retry, busy, outcome, detail, client: clientId })
        .catch(() => { /* the backend offers it again once the claim runs out */ })
        .finally(() => setTimeout(takeAutoCapture, busy ? AUTO_BUSY_WAIT_MS + 1000 : 1000)); // the next one waiting, if any
    }
  }

  // tile: the feed on this wall; auto: the backend's job, when it's an automatic one.
  function startShot(tile, { videoId, label, auto = null }) {
    shot.job = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    shot.tile = tile;
    shot.auto = auto;
    $('#fs-shot').disabled = true;
    shotStatus(auto ? `Automatic screenshot (${AUTO_REASON[auto.reason]}): opening source…` : 'Opening source…', '', !!auto);
    const courier = courierFrame();
    // tag (Feed Meter 1.5): PEAK or END in the file name; older versions leave it out.
    courier.win.postMessage({ type: 'ixg-wall-capture', v: 1, job: shot.job, platform: 'youtube', videoId, label, tag: auto ? auto.reason.toUpperCase() : '' }, courier.origin);
    shot.timer = setTimeout(() => {
      logEvent(tile, `${auto ? 'Automatic source' : 'Source'} screenshot: no answer from the Feed Meter in 2 min`, 'bad');
      endShot('Screenshot capture failed: no answer from the Feed Meter. Reload the extension in chrome://extensions and try again', 'bad', { retry: true, outcome: 'failed', detail: 'no answer from the Feed Meter in 2 min' });
    }, CAPTURE_TIMEOUT_MS);
  }

  function captureSourceScreenshot(tile) {
    if (shot.job) return shotStatus(shot.auto ? `An automatic screenshot of ${shot.tile.stream.label} is being captured: wait for it to finish` : 'A screenshot is already being captured: wait for it to finish', 'bad');
    const blocker = captureBlocker();
    if (blocker) return shotStatus(blocker, 'bad');
    if (tile.stream.source.kind !== 'video' || !/^[\w-]{11}$/.test(tile.stream.source.id)) return shotStatus('Source URL unavailable for this feed', 'bad');
    startShot(tile, { videoId: tile.stream.source.id, label: tile.stream.label });
  }

  // ---- Automatic source screenshots: the backend queues them when a feed's CCV reaches a
  // new high or its broadcast ends (backend/auto-capture.js). An admin's page that can take
  // one claims it (the first claim wins, so one window takes each) and reports back.
  let autoClaiming = false;
  async function takeAutoCapture() {
    if (autoClaiming || shot.job || !isAdmin() || !settings.autoCapture || location.protocol === 'file:' || Date.now() < autoBusyUntil) return;
    const open = (ytState?.captures || []).filter((c) => c && /^[\w-]{11}$/.test(c.id));
    if (!open.length || captureBlocker()) return;
    autoClaiming = true;
    try {
      for (const c of open) {
        const res = await capturePost('/api/capture/claim', { job: c.job, client: clientId });
        if (!res.ok) continue; // another window took it, or it's no longer due
        const job = await res.json();
        const tile = [...tiles.values()].find((t) => t.stream.source.id === job.id) || { stream: { id: null, label: job.label || job.id } };
        if (shot.job || captureBlocker()) {
          // A manual capture or a lost player got here first: hand it straight back.
          const why = shot.job ? 'a manual capture was running' : captureBlocker();
          logEvent(tile, `Automatic source screenshot (${AUTO_REASON[job.reason] || job.reason}) handed back: ${why}`, 'warn');
          capturePost('/api/capture/result', { job: job.job, retry: true, detail: why, client: clientId }).catch(() => {});
          return;
        }
        logEvent(tile, `Automatic source screenshot: ${AUTO_REASON[job.reason] || job.reason}${job.ccv != null ? ` at ${fmtInt(job.ccv)} watching` : ''}`);
        startShot(tile, { videoId: job.id, label: tile.stream.label, auto: job });
        return;
      }
    } catch {
      // backend offline: the jobs wait there
    } finally {
      autoClaiming = false;
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'ixg-capture' || d.v !== 1 || !shot.job || d.job !== shot.job) return;
    if (![...tiles.values()].some((t) => e.source === t.frame.querySelector('iframe')?.contentWindow && e.origin === t.host)) return;
    const tile = shot.tile;
    const auto = !!shot.auto;
    const kind = auto ? `Automatic source screenshot (${AUTO_REASON[shot.auto.reason] || shot.auto.reason})` : 'Source screenshot';
    const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
    if (d.state === 'progress') return shotStatus(text(d.message) || 'Working…', '', auto);
    if (d.state === 'done') {
      const f = d.facts && typeof d.facts === 'object' ? d.facts : {};
      const what = [text(f.account, 60), f.live ? 'LIVE' : '', f.ccv ? `${text(f.ccv, 20)} watching` : 'CCV not shown'].filter(Boolean).join(' · ');
      logEvent(tile, `${kind} saved: ${text(d.file, 300)}${what ? ` (${what})` : ''}`);
      return endShot(`Screenshot saved: ${text(d.file, 300)}${d.note ? ` · ${text(d.note)}` : ''}`, 'ok', { outcome: 'saved', detail: `${text(d.file, 300)}${what ? ` (${what})` : ''}` });
    }
    if (d.state === 'failed') {
      const busy = auto && d.reason === 'busy';
      const retry = busy || (auto && AUTO_RETRY.has(d.reason));
      if (busy) logEvent(tile, `${kind}: the Feed Meter is taking another screenshot; this one waits its turn`, 'warn');
      else logEvent(tile, `${kind} failed: ${text(d.message) || 'unknown reason'}${retry ? '; will try again' : ''}`, 'bad');
      return endShot(text(d.message) || 'Screenshot capture failed', busy ? 'warn' : 'bad', { retry, busy, outcome: 'failed', detail: text(d.message) });
    }
  });

  $('#fs-shot').addEventListener('click', () => {
    if (inspected) captureSourceScreenshot(inspected);
  });

  // This computer's CPU and memory, answered by the Feed Meter through a player frame.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'ixg-pc' || d.v !== 1) return;
    if (![...tiles.values()].some((t) => e.source === t.frame.querySelector('iframe')?.contentWindow && e.origin === t.host)) return;
    pc.at = Date.now();
    pc.cpu = finite(d.cpu, 100);
    pc.cores = finite(d.cores, 4096);
    pc.memUsedPct = finite(d.memUsedPct, 100);
    pc.memTotalGB = finite(d.memTotalGB, 100000);
  });
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
    if (key === 'memLimitMB') Object.assign(memGuard, { release: null, floorMB: null, retryAt: 0 }); // judge afresh
    if (['layout', 'layoutMode', 'scrollColumns', 'cardPct', 'feedQuality'].includes(key)) {
      updateLayout();
      if (ytReady) allocate();
    }
    if (key === 'feedQuality' || key === 'layoutMode') {
      // Lowering what feeds stream at takes a refresh, except where the Feed Meter sets the
      // quality (it steps down live); raising it applies live.
      for (const t of tiles.values()) {
        if (t.meterSetsQuality()) t.sendQuality(Date.now());
        else if (t.quality && rank(t.quality) > rank(t.targetQuality())) t.reload('layout quality lowered');
      }
    }
    if (key === 'showStats') {
      document.body.classList.toggle('hide-stats', !settings.showStats);
      updateLayout();
      for (const t of tiles.values()) t.fit();
    }
    if (key === 'loadConcurrency') pumpQueue();
    if (key === 'autoResync' || key === 'syncFeeds' || key === 'syncMarginSec') {
      for (const t of tiles.values()) {
        t.endNudge();
        t.endCatchUp();
      }
      if (key !== 'autoResync') sync.target = null; // work the target out afresh with the new setting
      updateSync();
      updateSummary();
    }
    if (key === 'bandwidthMbps') allocate();
    if (key === 'autoCapture') takeAutoCapture();
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
    // The saved key never comes back from the server; the field only says whether there is one.
    const k = server.ytKey || {};
    const fromEnv = k.source === 'env';
    $('#yt-key-input').disabled = fromEnv;
    $('#yt-key-save').disabled = fromEnv;
    $('#yt-key-input').placeholder = fromEnv ? 'Set on the server' : k.set ? `Saved key …${k.last4}` : 'Paste a key, e.g. AIzaSy…';
    $('#yt-key-input').title = fromEnv ? 'The server sets this key (YOUTUBE_API_KEY), so it can\'t be changed here'
      : k.set ? 'Paste a new key to replace the saved one; save an empty field to remove it' : '';
  }

  // YouTube API key: saved with the Save key button or Enter, not on every keystroke.
  // Saving an empty field removes the key, so that asks first.
  $('#yt-key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = $('#yt-key-input').value.trim();
    if (!raw) {
      if (!hasYtKey()) return;
      const ok = await ask({
        title: 'Remove the YouTube API key?',
        body: 'Audience numbers stop in every window until a key is saved again.',
        confirm: 'Remove key',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    saveYtKey(raw);
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

  const wallSizeObserver = new ResizeObserver(updateLayout);
  for (const element of [$grid, document.querySelector('.topbar'), $transport, $banner]) wallSizeObserver.observe(element);
  window.addEventListener('resize', updateLayout);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (location.protocol === 'file:') {
    $banner.textContent = 'YouTube blocks embeds on pages opened as files. Double-click "Start IXG Wall.cmd" (or run npm run wall) instead.';
    $banner.hidden = false;
  }

  $('#sign-out').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'X-IXG-Wall': '1' } });
    } catch {
      // the server is unreachable; the sign-in page will say so
    }
    location.assign('/login');
  });

  const ytApi = loadYouTubeApi(); // fetch the player API while the wall loads
  loadServerConfig().then(loadServerWall).then(() => {
    syncSettingInputs();
    document.body.classList.toggle('hide-stats', !settings.showStats);
    streams.forEach(addTile);
    updateLayout();
    updateSummary();
    renderSession();
    connectBackend(); // also brings the YouTube numbers, polled by the backend
    $('#fs-key-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = $('#fs-key').value.trim();
      if (key) saveYtKey(key); // clears the field once the server has it
    });
    watchPressure();
    detectDecode();
    // Feeds start once the player API is loaded and the Feed Meter check is settled.
    return Promise.all([ytApi, ensureFeedMeter()]);
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
