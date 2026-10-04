// Reading YouTube links out of text: one URL, a list, or a whole pasted message (Slack,
// WhatsApp, email). Feeds are named from the words beside their link. Pure functions,
// shared by the page (window.IXGLinks, loaded before app.js) and the tests (require).
(function (root) {
  'use strict';

  const VIDEO_ID = /^[\w-]{11}$/;
  // Channel pages can't be embedded; the live stream's own URL is needed.
  const CHANNEL_LINK = /youtube\.com\/(@|channel\/|c\/)|^@|^UC[\w-]{22}$/i;
  // A YouTube address anywhere in running text. It stops at whitespace and at the characters
  // chat apps wrap links in: Slack's <url|text>, Markdown's (url), quotes.
  const LINK_IN_TEXT = /(?:https?:\/\/)?\b(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>|"'`()[\]]*/gi;
  const MAX_LABEL = 80;
  // A line above a link names it only if it's short; "Here are the streams to be monitored:"
  // is a sentence, not a feed name.
  const NAME_MAX_WORDS = 6;
  const NAME_MAX_CHARS = 60;
  const EDGE_JUNK = /^[\s:;,.!|=<>\-–—→]+|[\s:;,.!|=<>\-–—→]+$/g;

  // A YouTube video from a URL or an 11-character ID, or null.
  function parseSource(raw) {
    const s = String(raw).trim();
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

  // Message text around a link, made into a feed name: no chat formatting, bullets,
  // numbering, separators or wrapping brackets.
  function cleanLabel(text) {
    let s = String(text)
      .replace(/[*_~`]+/g, ' ')
      .replace(/^\s*(?:[-•·*>]+\s*|\d{1,2}[.)]\s+)+/, '')
      .replace(/\s+/g, ' ')
      .replace(EDGE_JUNK, '')
      .replace(/^[([{]\s*(.*?)\s*[)\]}]$/, '$1')
      .trim();
    if (s.length > MAX_LABEL) s = `${s.slice(0, MAX_LABEL - 1)}…`;
    return s;
  }

  function looksLikeName(line) {
    const s = cleanLabel(line);
    return !!s && s.length <= NAME_MAX_CHARS && s.split(' ').length <= NAME_MAX_WORDS && !s.endsWith('?');
  }

  // A line that is only a video ID. Real IDs mix in digits, - or _, or capitals after the first
  // letter; that keeps an ordinary 11-letter word ("Information") from reading as one.
  function bareId(line) {
    const s = line.trim();
    return VIDEO_ID.test(s) && /[\d_-]|.[A-Z]/.test(s) ? s : null;
  }

  // Every YouTube link in `text`, in order, once per video:
  //   { raw, source: { kind, id } | null, label, problem?: 'channel' | 'invalid' }
  // A link is named by the text before it on its line (or after it, when the line starts with
  // the link), or else by a short line of its own just above it.
  function readMessage(text) {
    const lines = String(text || '').split(/\r?\n/);
    const found = [];
    const byId = new Map();
    let usedUpTo = -1; // lines up to here belong to earlier links

    function add(raw, label) {
      const channel = CHANNEL_LINK.test(raw);
      const source = channel ? null : parseSource(raw);
      if (source) {
        const seen = byId.get(source.id);
        if (seen) {
          if (!seen.label && label) seen.label = label;
          return;
        }
        const entry = { raw, source, label };
        byId.set(source.id, entry);
        found.push(entry);
      } else if (!found.some((f) => f.raw === raw)) {
        found.push({ raw, source: null, label, problem: channel ? 'channel' : 'invalid' });
      }
    }

    lines.forEach((line, i) => {
      let links = [...line.matchAll(LINK_IN_TEXT)].map((m) => {
        const raw = m[0].replace(/[.,;:!?]+$/, ''); // the link ends a sentence
        return { raw, start: m.index, end: m.index + raw.length };
      });
      const id = links.length ? null : bareId(line);
      if (id) links = [{ raw: id, start: line.indexOf(id), end: line.indexOf(id) + id.length }];
      if (!links.length) return;

      const afterMode = !cleanLabel(line.slice(0, links[0].start));
      links.forEach((link, k) => {
        const from = afterMode ? link.end : k ? links[k - 1].end : 0;
        const to = afterMode ? (k + 1 < links.length ? links[k + 1].start : line.length) : link.start;
        let label = cleanLabel(line.slice(from, to));
        if (!label && links.length === 1) {
          let j = i - 1;
          while (j > usedUpTo && !lines[j].trim()) j--;
          if (j > usedUpTo && looksLikeName(lines[j])) label = cleanLabel(lines[j]);
        }
        add(link.raw, label);
      });
      usedUpTo = i;
    });
    return found;
  }

  const api = { VIDEO_ID, CHANNEL_LINK, parseSource, readMessage, cleanLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IXGLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
