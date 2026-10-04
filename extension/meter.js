// IXG Wall Feed Meter. Runs inside each embedded YouTube player and reports what that player
// is really doing: bytes received, the real bitrate, the player's connection-speed estimate,
// buffer, resolution, latency mode, dropped frames. The wall page can't see any of this
// itself, because each player is an isolated cross-origin frame.
//
// It talks only to a page that asks: the wall sends { type: 'ixg-wall-hello' } into the
// player, and reports go back to that page's origin alone. Nothing is stored or sent anywhere else.
(() => {
  'use strict';
  if (window.top === window) return; // only players embedded in a page

  const VERSION = '1.0.0';
  const SAMPLE_MS = 2000;
  const WINDOW_MS = 30000;      // bitrate and data received are averaged over this
  const MIN_MEDIA_S = 4;        // media seconds needed in the window before a bitrate is given

  let wallOrigin = null;
  let bytesTotal = 0;           // bytes of video and audio received from googlevideo
  let history = [];             // { t, bytes, end } one per sample, oldest first

  // Each media response the player receives, with its size. googlevideo allows resource
  // timing (Timing-Allow-Origin), so the sizes are real.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name.includes('.googlevideo.com/')) bytesTotal += e.transferSize || e.encodedBodySize || 0;
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // no resource timing: bitrate and data received stay unknown
  }

  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  function latencyMode(text) {
    if (/ultra[\s-]*low/i.test(text)) return 'ultra-low';
    if (/low/i.test(text)) return 'low';
    if (/normal/i.test(text)) return 'normal';
    return null;
  }

  function sample() {
    const now = Date.now();
    const video = document.querySelector('video');
    const player = document.getElementById('movie_player');
    let nerds = {};
    let stats = {};
    try { nerds = player?.getStatsForNerds?.() || {}; } catch { /* player not ready */ }
    try { stats = player?.getVideoStats?.() || {}; } catch { /* player not ready */ }

    // End of the buffered range the playhead is in: how much media has been downloaded.
    let end = null;
    let ahead = null;
    if (video) {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.5 && video.buffered.end(i) >= video.currentTime) {
          end = video.buffered.end(i);
          ahead = end - video.currentTime;
        }
      }
    }

    // A seek or reload makes the buffered end jump: start the averages again.
    const last = history[history.length - 1];
    if (end == null || (last && (end < last.end - 1 || end - last.end > 30))) history = [];
    if (end != null) history.push({ t: now, bytes: bytesTotal, end });
    while (history.length > 2 && now - history[0].t > WINDOW_MS) history.shift();

    const first = history[0];
    const spanS = first ? (now - first.t) / 1000 : 0;
    const mediaS = first && end != null ? end - first.end : 0;
    const bytes = first ? bytesTotal - first.bytes : 0;
    // Bytes per second of media is the stream's real bitrate (video plus audio).
    const bitrateMbps = mediaS >= MIN_MEDIA_S && bytes > 0 ? (bytes * 8) / mediaS / 1e6 : null;
    const receivedMbps = spanS >= MIN_MEDIA_S ? (bytes * 8) / spanS / 1e6 : null;

    const res = /(\d+)x(\d+)@(\d+)/.exec(String(nerds.resolution || ''));
    const frames = video?.getVideoPlaybackQuality?.();
    const modeText = String(nerds.live_mode || '');
    return {
      type: 'ixg-meter',
      v: 1,
      meter: VERSION,
      videoId: (location.pathname.match(/\/embed\/([\w-]{11})/) || [])[1] || stats.docid || null,
      bitrateMbps,
      receivedMbps,
      connectionMbps: num(nerds.bandwidth_kbps) != null ? num(nerds.bandwidth_kbps) / 1000 : null,
      bufferS: ahead,
      width: video?.videoWidth || (res ? Number(res[1]) : null),
      height: video?.videoHeight || (res ? Number(res[2]) : null),
      fps: res ? Number(res[3]) : null,
      videoFormat: stats.fmt || null,
      audioFormat: stats.afmt || null,
      codecs: nerds.codecs || null,
      latencyMode: latencyMode(modeText),
      latencyModeText: modeText || null,
      liveLatencyS: num(nerds.live_latency_secs) || null,
      framesTotal: frames?.totalVideoFrames ?? null,
      framesDropped: frames?.droppedVideoFrames ?? null,
    };
  }

  function report() {
    if (!wallOrigin) return;
    try {
      window.parent.postMessage(sample(), wallOrigin);
    } catch {
      // the wall navigated away; it will say hello again if it comes back
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.data?.type !== 'ixg-wall-hello') return;
    const first = !wallOrigin;
    wallOrigin = e.origin;
    if (first) setInterval(report, SAMPLE_MS);
    report();
  });
})();
