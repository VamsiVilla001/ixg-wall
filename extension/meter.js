// IXG Wall Feed Meter. Runs inside each embedded YouTube player and reports what that player
// is really doing: bytes received, the real bitrate, the player's connection-speed estimate,
// buffer, resolution, latency mode, dropped frames. The wall page can't see any of this
// itself, because each player is an isolated cross-origin frame.
//
// It talks only to a page that asks: the wall sends { type: 'ixg-wall-hello' } into the
// player, and reports go back to that page's origin alone. Nothing is stored or sent anywhere else.
//
// It also sets the player's quality when that page asks ({ type: 'ixg-wall-quality' }), the
// way YouTube's own quality menu does. The page itself can't: embeds ignore quality requests
// and size quality to the player. Measured: a 400 px player held at 1080p, 720p or 480p, and
// moved between them within 15 s without a reload.
(() => {
  'use strict';
  if (window.top === window) return; // only players embedded in a page

  const VERSION = '1.4.0';
  const SAMPLE_MS = 2000;
  const WINDOW_MS = 30000;      // bitrate and data received are averaged over this
  const MIN_MEDIA_S = 4;        // media seconds needed in the window before a bitrate is given
  const QUALITIES = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160'];
  const REAPPLY_MS = 30000;     // the player not at the set quality after this: set it again

  let wallOrigin = null;
  let qualityTarget = null;     // what the wall asked for
  let qualityApplied = null;    // the level set: the target, or the nearest the stream offers
  let qualityAt = 0;
  let bytesTotal = 0;           // bytes of video and audio received from googlevideo
  let history = [];             // { t, bytes, end } one per sample, oldest first
  let audioGraph = null;
  let audioRetryAt = 0;
  let audioState = 'waiting';

  // Capture decoded audio without rerouting the player or changing mute/volume.
  // captureStream audio is pre-mute; the analyser branch never produces audible output.
  function closeAudio() {
    if (!audioGraph) return;
    audioGraph.source?.disconnect();
    for (const track of audioGraph.stream.getTracks()) track.stop();
    audioGraph.context.close().catch(() => {});
    audioGraph = null;
    audioRetryAt = 0;
    audioState = 'waiting';
  }

  function audioLevels(samples) {
    let square = 0;
    let peak = 0;
    for (const value of samples) {
      square += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const db = (v) => v > 0 ? Math.max(-60, Math.min(0, 20 * Math.log10(v))) : -60;
    return { rmsDb: db(Math.sqrt(square / samples.length)), peakDb: db(peak) };
  }

  function sampleAudio() {
    const video = document.querySelector('video');
    if (audioGraph && (audioGraph.video !== video || audioGraph.tracks.some((t) => t.readyState === 'ended'))) closeAudio();
    if (!video || video.readyState < 2) return { status: 'waiting', channels: [] };
    if (video.paused || video.ended) return { status: 'idle', channels: [] };
    if (!audioGraph && Date.now() >= audioRetryAt) {
      audioRetryAt = Date.now() + 5000;
      let stream;
      let context;
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!video.captureStream || !Audio) {
          audioState = 'unsupported';
          return { status: audioState, channels: [] };
        }
        stream = video.captureStream();
        for (const track of stream.getVideoTracks()) { stream.removeTrack(track); track.stop(); }
        const tracks = stream.getAudioTracks();
        if (!tracks.length) {
          for (const track of stream.getTracks()) track.stop();
          audioState = 'no-audio';
        } else {
          context = new Audio({ latencyHint: 'playback' });
          const source = context.createMediaStreamSource(stream);
          const splitter = context.createChannelSplitter(2);
          const silent = context.createGain();
          silent.gain.value = 0;
          silent.connect(context.destination);
          source.connect(splitter);
          const mono = tracks[0].getSettings?.().channelCount === 1;
          const analysers = [0, 1].map((channel) => {
            const analyser = context.createAnalyser();
            analyser.fftSize = 2048;
            splitter.connect(analyser, mono ? 0 : channel);
            analyser.connect(silent);
            return analyser;
          });
          audioGraph = { video, stream, tracks, context, source, analysers, buffers: analysers.map(() => new Float32Array(2048)), resumeAt: 0 };
        }
      } catch {
        for (const track of stream?.getTracks() || []) track.stop();
        context?.close().catch(() => {});
        audioState = 'unavailable';
      }
    }
    if (!audioGraph) return { status: audioState, channels: [] };
    const g = audioGraph;
    if (g.context.state !== 'running') {
      if (Date.now() >= g.resumeAt) {
        g.resumeAt = Date.now() + 5000;
        g.context.resume().catch(() => {});
      }
      return { status: 'suspended', channels: [] };
    }
    if (g.tracks.some((t) => t.muted)) return { status: 'unavailable', channels: [] };
    const channels = g.analysers.map((analyser, i) => {
      analyser.getFloatTimeDomainData(g.buffers[i]);
      return audioLevels(g.buffers[i]);
    });
    return { status: 'ok', channels };
  }

  function reportAudio() {
    if (!wallOrigin) return;
    try {
      window.parent.postMessage({ type: 'ixg-audio', v: 1, videoId: (location.pathname.match(/\/embed\/([\w-]{11})/) || [])[1] || null, ...sampleAudio() }, wallOrigin);
    } catch { /* unavailable browser APIs must never interrupt player telemetry */ }
  }

  for (const event of ['pointerdown', 'keydown']) window.addEventListener(event, () => {
    audioGraph?.context.resume().catch(() => {});
  }, { passive: true });
  window.addEventListener('pagehide', closeAudio);

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
      controls: ['quality'],
      qualityTarget,
      qualityApplied,
      quality: (() => { try { return player?.getPlaybackQuality?.() || null; } catch { return null; } })(),
    };
  }

  // Holds the player at the wall's quality: that level if the stream offers it, else the
  // nearest below (a 720p broadcast can't stream 1080p). Set again if YouTube drifts off it.
  function applyQuality(now) {
    const player = document.getElementById('movie_player');
    if (!qualityTarget || !player?.setPlaybackQualityRange) return;
    let levels = [];
    try { levels = (player.getAvailableQualityLevels?.() || []).filter((q) => QUALITIES.includes(q)); } catch { /* not ready */ }
    if (!levels.length) return; // not loaded yet: the next sample tries again
    const rank = (q) => QUALITIES.indexOf(q);
    levels.sort((a, b) => rank(b) - rank(a));
    const pick = levels.find((q) => rank(q) <= rank(qualityTarget)) || levels[levels.length - 1];
    let current = null;
    try { current = player.getPlaybackQuality?.(); } catch { /* not ready */ }
    if (pick === qualityApplied && (current === pick || now - qualityAt < REAPPLY_MS)) return;
    try {
      player.setPlaybackQualityRange(pick, pick);
      qualityApplied = pick;
      qualityAt = now;
    } catch {
      // the player is between videos; the next sample tries again
    }
  }

  function report() {
    if (!wallOrigin) return;
    applyQuality(Date.now());
    try {
      window.parent.postMessage(sample(), wallOrigin);
    } catch {
      // the wall navigated away; it will say hello again if it comes back
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    if (e.data?.type === 'ixg-wall-hello') {
      const first = !wallOrigin;
      wallOrigin = e.origin;
      if (first) {
        setInterval(report, SAMPLE_MS);
        setInterval(reportAudio, 100);
      }
      report();
      reportAudio();
    } else if (e.data?.type === 'ixg-wall-quality' && wallOrigin && e.origin === wallOrigin) {
      // Only from the page this player already reports to.
      qualityTarget = QUALITIES.includes(e.data.quality) ? e.data.quality : null;
      if (!qualityTarget) qualityApplied = null;
      report();
    }
  });
})();
