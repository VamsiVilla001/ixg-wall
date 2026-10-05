// Exercise the real layout controller with a growing grid, without loading players.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function wall(mode = 'scroll') {
  const values = new Map();
  const classes = new Set();
  const classList = {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    contains(name) { return classes.has(name); },
  };
  const topbar = { offsetHeight: 44 };
  const elements = { 'clear-wall': {}, 'feeds-tab': {} };
  const tiles = new Map();
  const grid = { clientWidth: 1600, classList, style: { setProperty() {} } };
  // In the browser this grows after updateLayout writes the content height.
  Object.defineProperty(grid, 'clientHeight', { get: () => Math.max(812, parseFloat(values.get('--wall-content-h')) || 0) });
  const context = vm.createContext({
    document: { body: { classList, style: { setProperty: (k, v) => values.set(k, v) } }, querySelector: () => topbar },
    window: { innerHeight: 900 },
    $grid: grid, $empty: {}, $banner: { offsetHeight: 0 }, $transport: { offsetHeight: 44 },
    $: (selector) => elements[selector.slice(1)], tiles, streams: [], feedDrag: null,
    rootPx: () => 6, SIDE_MIN_PX: 120, BAR_SLIM_PX: 33, BAR_FULL_PX: 51, AUDIO_METER_PX: 44,
    renderLayoutPreview() {}, placeTiles() {}, renderLayoutBar() {},
  });
  vm.runInContext(`
    ${section('  const STORAGE_KEY', '  // State + persistence')}
    const settings = { ...DEFAULT_SETTINGS, layoutMode: '${mode}', layoutPreset: 'quad' };
    ${section('  function videoWidthIn(', '  // Feeds take their places')}
    globalThis.api = { settings, updateLayout, layout: () => currentLayout };
  `, context);
  return {
    ...context.api, context, grid, classes, values, topbar,
    feeds(count) {
      tiles.clear();
      for (let i = 0; i < count; i++) tiles.set(i, { applySize() {} });
      context.api.updateLayout();
      return context.api.layout();
    },
    height: () => parseFloat(values.get('--wall-content-h')),
  };
}

test('adding feed rows grows the page while video dimensions stay stable; removing rows shrinks it', () => {
  const w = wall();
  const first = w.feeds(2);
  const six = w.feeds(6);
  const twenty = w.feeds(20);
  assert.equal(first.tileH, six.tileH);
  assert.equal(six.tileH, twenty.tileH);
  assert.equal(six.videoW / six.videoH, 16 / 9);
  assert.ok(first.contentH < six.contentH && six.contentH < twenty.contentH);
  assert.equal(w.feeds(2).contentH, first.contentH);
  assert.ok(w.classes.has('document-wall'));
});

test('preset pages remain viewport sized after the document grows and repeated resize callbacks', () => {
  const w = wall('preset');
  const onePage = w.feeds(4);
  const threePages = w.feeds(10);
  assert.equal(threePages.pages, 3);
  assert.equal(threePages.unitH, onePage.unitH);
  // 4 + 4 + 2: the last page is only the one row its two feeds need.
  assert.equal(threePages.totalRows, 30);
  assert.ok(threePages.contentH > onePage.contentH * 2.5 && threePages.contentH < onePage.contentH * 3);
  for (let i = 0; i < 4; i++) {
    w.updateLayout();
    assert.equal(w.height(), threePages.contentH, 'growing grid must not feed back into page geometry');
  }
  assert.equal(w.feeds(4).contentH, onePage.contentH);
});

test('window height and wrapped controls update the visible canvas independently of the feed count', () => {
  const w = wall('preset');
  const original = w.feeds(10);
  w.context.window.innerHeight = 700;
  w.topbar.offsetHeight = 80;
  w.updateLayout();
  assert.equal(w.values.get('--wall-viewport-h'), '576px');
  assert.equal(w.layout().pages, original.pages);
  assert.ok(w.layout().unitH < original.unitH);
});

test('clearing the wall clears its extra height; Fit all retains a single viewport', () => {
  const w = wall();
  w.feeds(20);
  w.feeds(0);
  assert.equal(w.height(), 0);
  assert.equal(w.layout(), null);
  w.settings.layoutMode = 'fit';
  const fit = w.feeds(20);
  assert.equal(fit.onScreen, 20);
  assert.equal(w.height(), 812);
  assert.equal(w.classes.has('document-wall'), false);
});
