// Courier for Capture Source Screenshot. A wall page can't reach the extension's service
// worker itself, so it asks through one of its players: this script, in the player frame's
// isolated world (the only world with chrome.runtime; meter.js lives in the MAIN world with
// the player object), relays the request up to capture.js and the progress and result back.
// Only the page this player already reports to (after its ixg-wall-hello) is served.
(() => {
  'use strict';
  if (window.top === window) return;
  let wallOrigin = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.type === 'ixg-wall-hello') {
      wallOrigin = e.origin;
      return;
    }
    if (!wallOrigin || e.origin !== wallOrigin || e.data.v !== 1) return;
    // This computer's CPU and memory (capture.js reads them): the wall asks one player every 2 s.
    if (e.data.type === 'ixg-wall-pc') {
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'ixg-pc-request' })).then(
        (r) => { try { window.parent.postMessage({ type: 'ixg-pc', v: 1, ...(r || {}) }, wallOrigin); } catch { /* gone */ } },
        () => { try { window.parent.postMessage({ type: 'ixg-pc', v: 1, error: 'extension' }, wallOrigin); } catch { /* gone */ } },
      );
      return;
    }
    if (e.data.type !== 'ixg-wall-capture') return;
    const { job, platform, videoId, label, tag } = e.data;
    const reply = (m) => {
      try { window.parent.postMessage({ type: 'ixg-capture', v: 1, job, ...m }, wallOrigin); } catch { /* the wall went away */ }
    };
    let answer;
    try {
      answer = chrome.runtime.sendMessage({ type: 'ixg-capture-request', job, platform: String(platform || ''), videoId: String(videoId || ''), label: String(label || '').slice(0, 80), tag: String(tag || '').slice(0, 8) });
    } catch (err) {
      return reply({ state: 'failed', reason: 'extension', message: `Feed Meter can't take the request: ${err.message}. Reload the extension in chrome://extensions` });
    }
    answer.then(
      (r) => reply(r?.ok ? { state: 'done', file: r.file, facts: r.facts, note: r.note || '' } : { state: 'failed', reason: r?.reason || 'failed', message: r?.message || 'Screenshot capture failed' }),
      (err) => reply({ state: 'failed', reason: 'extension', message: `Feed Meter error: ${err.message}` }),
    );
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'ixg-capture-progress' || !wallOrigin) return;
    try { window.parent.postMessage({ type: 'ixg-capture', v: 1, job: m.job, state: 'progress', step: m.step, message: m.message }, wallOrigin); } catch { /* gone */ }
  });
})();
