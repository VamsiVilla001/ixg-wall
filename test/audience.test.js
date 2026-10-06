const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('  function audienceMetric(');
const end = source.indexOf('  async function loadViewerHistory(', start);
assert.ok(start >= 0 && end > start);

function wall() {
  const reports = new Map();
  const ownerEnded = new Set();
  const elements = new Map();
  let rows = [];
  const context = vm.createContext({
    ytStats: reports,
    broadcastOver: (id) => ownerEnded.has(id) || reports.get(id)?.endedAt ? { at: 1 } : null,
    hasYtKey: () => true,
    $: (id) => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    setText: (el, text) => { el.textContent = text; },
    fillKv: (_, items) => { rows = items; },
    fmtInt: (v) => v == null ? null : String(v), fmtCount: String, fmtDuration: String, fmtClock: String,
    drawSpark: () => '', viewerSeries: { id: null, series: [] }, ytState: { status: 'ok' }, ytStatsAt: 0,
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.api = { audienceMetric, wallAudience, renderAnalytics };`, context);
  return {
    ...context.api, reports, ownerEnded,
    total(ids) { return context.api.wallAudience(ids.map((id) => ({ stream: { source: { id } } }))); },
    stats(id) {
      context.api.renderAnalytics({ stream: { source: { id } }, broadcastEnded: () => context.broadcastOver(id) }, 1000);
      return rows;
    },
  };
}

test('ended feeds use total views even when an old CCV count remains in the response', () => {
  const w = wall();
  w.reports.set('one', { broadcast: 'none', endedAt: '2026-10-05T12:54:00Z', views: 1300000, viewers: 200 });
  const metric = w.total(['one']);
  assert.equal(metric.label, 'Views');
  assert.equal(metric.value, 1300000);
  const rows = w.stats('one');
  assert.equal(rows[0][0], 'Views');
  assert.equal(rows[0][1], '1300000');
  assert.equal(rows.filter(([label]) => label === 'Views').length, 1);
});

test('live CCV switches to views on completion and back to CCV for a live response', () => {
  const w = wall();
  w.reports.set('one', { broadcast: 'live', viewers: 42, views: 1000 });
  assert.equal(w.total(['one']).label, 'CCV');
  assert.equal(w.total(['one']).value, 42);
  assert.equal(w.stats('one')[0][0], 'CCV');
  assert.equal(w.stats('one')[0][1], '42');
  w.reports.get('one').endedAt = '2026-10-05T12:54:00Z';
  assert.equal(w.total(['one']).label, 'Views');
  assert.equal(w.total(['one']).value, 1000);
  delete w.reports.get('one').endedAt;
  assert.equal(w.total(['one']).label, 'CCV');
  assert.equal(w.total(['one']).value, 42);
});

test('mixed walls count live CCV without adding ended views or duplicate video IDs', () => {
  const w = wall();
  w.reports.set('live', { broadcast: 'live', viewers: 15, views: 5000 });
  w.reports.set('ended', { broadcast: 'none', endedAt: '2026-10-05T12:54:00Z', viewers: 99, views: 8000 });
  const metric = w.total(['live', 'live', 'ended']);
  assert.equal(metric.label, 'CCV');
  assert.equal(metric.value, 15);
  assert.equal(metric.feeds, 1);
});

test('beside the CCV, views total every feed on the wall, live and ended, once per video', () => {
  const w = wall();
  w.reports.set('live', { broadcast: 'live', viewers: 15, views: 5000 });
  w.reports.set('ended', { broadcast: 'none', endedAt: '2026-10-05T12:54:00Z', views: 8000 });
  w.reports.set('hidden', { broadcast: 'live', viewers: 3, views: null });
  w.reports.set('gone', { missing: true });
  const metric = w.total(['live', 'live', 'ended', 'hidden', 'gone']);
  assert.equal(metric.label, 'CCV');
  assert.equal(metric.views, 13000);
  assert.equal(metric.viewsReported, 2);
  assert.equal(metric.viewsFeeds, 3);
  assert.equal(w.total(['hidden']).views, null, 'no counts: unavailable, not zero');
});

test('owner-confirmed completion uses views while the public broadcast response is still live', () => {
  const w = wall();
  w.reports.set('one', { broadcast: 'live', viewers: 99, views: 500 });
  w.ownerEnded.add('one');
  assert.equal(w.total(['one']).label, 'Views');
  assert.equal(w.total(['one']).value, 500);
});

test('unreported counts remain unavailable, explicit zero remains zero, and partial totals are identified', () => {
  const w = wall();
  w.reports.set('one', { broadcast: 'live', viewers: null });
  assert.equal(w.total(['one']).value, null);
  w.reports.get('one').viewers = 0;
  assert.equal(w.total(['one']).value, 0);
  w.reports.set('two', { broadcast: 'live', viewers: null });
  assert.equal(w.total(['one', 'two']).reported, 1);
  assert.equal(w.total(['one', 'two']).feeds, 2);
  w.reports.get('one').endedAt = '2026-10-05T12:54:00Z';
  w.reports.delete('two');
  assert.equal(w.total(['one']).label, 'Views');
  assert.equal(w.total(['one']).value, null);
  w.reports.get('one').views = 0;
  assert.equal(w.total(['one']).value, 0);
});

test('scheduled, missing, and unknown videos do not supply CCV or archived view totals', () => {
  const w = wall();
  w.reports.set('scheduled', { broadcast: 'upcoming', viewers: 12, views: 100 });
  w.reports.set('missing', { missing: true, views: 100 });
  const metric = w.total(['scheduled', 'missing', 'unknown']);
  assert.equal(metric.label, 'CCV');
  assert.equal(metric.value, null);
  assert.equal(metric.feeds, 0);
});
