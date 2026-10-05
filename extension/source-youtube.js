// Capture Source Screenshot: YouTube. Everything YouTube-specific lives here; the generic
// workflow (capture.js) only calls these. Another platform is one more file shaped like this.
//
// probe() runs inside the source page. It reads what the page itself shows, finding each
// piece by several routes (layout selectors, then semantic text), so one YouTube redesign
// doesn't break it: the player, title, channel, LIVE state, and the "N watching now" line.
const IXGYouTube = {
  name: 'YouTube',

  handles: (request) => request?.platform === 'youtube' && /^[\w-]{11}$/.test(request.videoId || ''),

  // English UI, so the "watching" line reads the same on every computer.
  url: (request) => `https://www.youtube.com/watch?v=${request.videoId}&hl=en`,

  // Runs in the source page (serialised by capture.js). Returns plain data only.
  probe: function youTubeProbe() {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const shown = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const pick = (selectors) => {
      for (const s of selectors) for (const el of document.querySelectorAll(s)) if (shown(el) && clean(el.textContent)) return el;
      return null;
    };
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    };
    // The smallest visible element whose own text matches: the count itself, not its section.
    const smallest = (scope, re) => {
      let best = null;
      for (const el of scope.querySelectorAll('*')) {
        if (el.children.length > 2) continue;
        const t = clean(el.textContent);
        if (t.length > 160 || !re.test(t) || !shown(el)) continue;
        if (!best || t.length < best.t.length) best = { el, t };
      }
      return best;
    };

    const out = { href: location.href, readyState: document.readyState };
    if (/^consent\./.test(location.hostname)) {
      out.blocked = 'YouTube asked for cookie consent in this browser: open YouTube once in it and accept';
      return out;
    }
    // YouTube's own word when there's nothing to play: by its error elements, or by the
    // words it shows where the player would be.
    const error = pick(['yt-playability-error-supported-renderers #reason', '#error-screen #reason', 'yt-playability-error-supported-renderers',
      '#error-screen', '.ytp-error-content-wrap-reason', '.ytp-error']);
    const said = error ? { t: clean(error.textContent) } : smallest(document.querySelector('#player, ytd-player, #player-container, #page-manager') || document.body,
      /video unavailable|not available|private video|has been removed|isn't available|does not exist|no longer available/i);
    if (said) out.unavailable = said.t.slice(0, 160);

    const player = [...document.querySelectorAll('#movie_player, ytd-player #container, ytd-player, video')].find((el) => shown(el) && el.querySelector?.('video') !== null || shown(el) && el.tagName === 'VIDEO');
    out.player = box(player);

    const title = pick(['ytd-watch-metadata #title h1', 'ytd-watch-metadata h1', '#above-the-fold #title', 'h1.title']);
    out.title = title ? clean(title.textContent) : clean(document.querySelector('meta[name="title"]')?.content) || null;
    out.titleBox = box(title);

    const channel = pick(['ytd-watch-metadata ytd-channel-name a', 'ytd-watch-metadata ytd-channel-name', '#owner ytd-channel-name a',
      'ytd-video-owner-renderer ytd-channel-name', '#upload-info ytd-channel-name']);
    const author = clean(document.querySelector('[itemprop="author"] [itemprop="name"]')?.getAttribute('content'));
    out.channel = channel ? clean(channel.textContent) : author || null;
    out.channelBox = box(channel?.closest('#owner, ytd-video-owner-renderer') || channel);

    // The page's own words for the audience. YouTube draws a live count as rolling digit
    // columns (their text is 0–9 each), and keeps the plain "2,553 watching now" in a
    // hidden tooltip beside them and in the player's overlay: the number is read from
    // those, visible or not, and the picture is cropped around the visible row.
    const anyText = (scope, re) => {
      let best = null;
      for (const el of scope.querySelectorAll('*')) {
        if (el.children.length > 6) continue;
        const t = clean(el.textContent);
        if (t.length > 200 || !re.test(t)) continue;
        if (!best || t.length < best.t.length) best = { el, t };
      }
      return best;
    };
    const info = document.querySelector('ytd-watch-info-text');
    const metadata = document.querySelector('ytd-watch-metadata') || document.querySelector('#above-the-fold') || document.body;
    const countRe = /(\d[\d,.]*\s*[KMB]?)\s+watching\b/i;
    let count = null;
    for (const scope of [info, metadata, document.querySelector('.ytp-overlay-top-left'), document.querySelector('yt-player-overlay-video-details-renderer')]) {
      const found = scope && anyText(scope, countRe);
      if (found) { count = countRe.exec(found.t)[1].replace(/\s+/g, ''); break; }
    }
    out.viewersText = count;
    const row = [info, document.querySelector('#view-count')?.closest('ytd-watch-info-text, #info-container, #info'), document.querySelector('#view-count')].find(shown);
    out.countBox = count ? box(row) : null;
    const viewsRe = /(\d[\d,.]*\s*[KMB]?)\s+views?\b/i;
    const views = (info && anyText(info, viewsRe)) || anyText(metadata, viewsRe);
    out.viewsText = views ? views.t : null;
    out.viewsBox = views ? box(row || views.el) : null;

    // LIVE: the player's badge, the page's broadcast metadata, or a live count on screen.
    const badge = document.querySelector('.ytp-live-badge');
    const liveMeta = document.querySelector('meta[itemprop="isLiveBroadcast"]')?.content === 'True';
    const ended = !!document.querySelector('meta[itemprop="endDate"]');
    out.live = out.viewersText || (badge && shown(badge)) || (liveMeta && !ended) ? true
      : out.viewsText || ended || (!liveMeta && out.title) ? false : null;
    return out;
  },

  // Stage 1: the player and the page's identity are on screen.
  sourceReady: (s) => !!(s.player && s.title && s.channel),
  // Stage 2: a live broadcast's viewer count (a recording has none to wait for).
  wantsCount: (s) => s.live !== false,
  countReady: (s) => !!s.viewersText,

  // Player, title, channel and the count line, as one block.
  parts: (s) => [s.player, s.titleBox, s.channelBox, s.countBox || s.viewsBox].filter(Boolean),

  facts: (s) => ({ account: s.channel, title: s.title, live: s.live, ccv: s.viewersText }),
};

if (typeof module !== 'undefined') module.exports = { IXGYouTube };
