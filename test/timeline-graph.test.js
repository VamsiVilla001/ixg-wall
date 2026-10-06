// Viewer counts along the timelines (public/app.js: drawViewerGraph, viewersAt): the readings
// in a bar's span land at the right x, the peak and low in view are marked, a gap in the
// readings is left open, and the hover finds the reading nearest the pointer.   npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('  const TL_GRAPH_H = ');
const end = source.indexOf('  // A seek bar: hovering labels the moment', start);
assert.ok(start >= 0 && end > start);

// A node that remembers its attributes and children, in place of the DOM.
function node(name) {
  return {
    name, attrs: {}, children: [], textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    replaceChildren(...kids) { this.children = kids; },
  };
}

function page({ pollMs = 60000 } = {}) {
  const context = vm.createContext({
    document: { createElementNS: (_, name) => node(name) },
    server: { linkYoutube: null }, location: { protocol: 'http:' }, ytStatsAt: 0, ytState: { pollMs },
    api: () => Promise.reject(new Error('no backend in this test')),
    clamp: (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback),
    fmtCount: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)),
    clockTime: (ms) => `T+${Math.round((ms - 1_700_000_000_000) / 60000)}m`,
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.api2 = { drawViewerGraph, viewersAt, TL_GRAPH_H };`, context);
  return context.api2;
}

const T0 = 1_700_000_000_000;
const MIN = 60000;

test('readings land at the bar\'s x for their time; the peak and low in view are marked', () => {
  const { drawViewerGraph, TL_GRAPH_H } = page({ pollMs: 3 * MIN }); // readings 5 min apart are no gap
  const svg = node('svg');
  const series = [[T0 - MIN, 999, 0, 0, 0], [T0, 100], [T0 + 5 * MIN, 300], [T0 + 10 * MIN, 200], [T0 + 11 * MIN, 5000]];
  const { move, from } = drawViewerGraph(svg, series, T0, T0 + 10 * MIN, 400);
  assert.equal(typeof move, 'function');
  assert.equal(from, T0);
  assert.equal(svg.children.filter((n) => n.attrs.class === 'untracked').length, 0, 'readings from the start of the bar: nothing untracked');
  assert.equal(svg.attrs.viewBox, `0 0 400 ${TL_GRAPH_H}`);
  const by = (name, cls) => svg.children.filter((n) => n.name === name && (!cls || n.attrs.class === cls));
  assert.equal(by('polyline').length, 1, 'one unbroken run');
  const xs = by('polyline')[0].attrs.points.split(' ').map((pt) => Number(pt.split(',')[0]));
  assert.deepEqual(xs, [0, 200, 400], 'before and after the span are left out');
  const labels = by('text').map((n) => [n.textContent, Number(n.attrs.x), n.attrs['text-anchor']]);
  assert.deepEqual(labels, [['▲ 300', 195, 'end'], ['▼ 100', 5, 'start']], 'labels sit on the roomier side of their point');
  const marks = by('circle', 'mark').map((n) => Number(n.attrs.cx));
  assert.deepEqual(marks, [200, 0]);
  // The peak sits higher on the graph than the low.
  const [peakY, lowY] = by('circle', 'mark').map((n) => Number(n.attrs.cy));
  assert.ok(peakY < lowY);
  assert.ok(peakY >= 9 && lowY <= TL_GRAPH_H - 3, 'both inside the graph, under the label room');
  // The cursor follows a reading, and hides without one.
  const cursor = by('line', 'cursor')[0];
  const dot = by('circle', 'cursor-dot')[0];
  move({ t: T0 + 5 * MIN, v: 300 });
  assert.equal(cursor.attrs.x1, '200.0');
  assert.equal(dot.attrs.visibility, 'visible');
  move(null);
  assert.equal(cursor.attrs.visibility, 'hidden');
});

test('a gap in the readings breaks the line; too few readings draw nothing', () => {
  const { drawViewerGraph } = page({ pollMs: 30000 });
  const svg = node('svg');
  const series = [[T0, 10], [T0 + MIN, 12], [T0 + 20 * MIN, 11], [T0 + 21 * MIN, 14]];
  drawViewerGraph(svg, series, T0, T0 + 21 * MIN, 420);
  assert.equal(svg.children.filter((n) => n.name === 'polyline').length, 2);
  assert.equal(svg.children.filter((n) => n.attrs.class === 'area').length, 2);
  // Readings taken 5 min apart under an earlier refresh setting, then 100 s apart: one run,
  // whatever the refresh is now. A lone reading between gaps is a dot.
  const uneven = [];
  for (let t = T0; t < T0 + 100 * MIN; t += 5 * MIN) uneven.push([t, 100]);
  for (let t = T0 + 100 * MIN; t <= T0 + 200 * MIN; t += 100000) uneven.push([t, 120]);
  uneven.push([T0 + 230 * MIN, 90]);
  drawViewerGraph(svg, uneven, T0, T0 + 230 * MIN, 1000);
  assert.equal(svg.children.filter((n) => n.name === 'polyline').length, 1, 'the 5-min stretch is drawn with the rest');
  assert.equal(svg.children.filter((n) => n.attrs.class === 'pt').length, 1, 'the lone last reading is a dot');
  assert.equal(drawViewerGraph(svg, [[T0, 10]], T0, T0 + MIN, 100), null);
  assert.deepEqual(svg.children, []);
  assert.equal(drawViewerGraph(svg, [[T0, 10], [T0 + MIN, null]], T0, T0 + MIN, 100), null, 'a null count is not a reading');
});

test('the stretch before the first reading is shaded and named, on the graph and in the hover', () => {
  const { drawViewerGraph, viewersAt } = page();
  const svg = node('svg');
  const series = [];
  for (let t = T0 + 40 * MIN; t <= T0 + 100 * MIN; t += MIN) series.push([t, 200 + (t / MIN) % 7]);
  const { from } = drawViewerGraph(svg, series, T0, T0 + 100 * MIN, 500);
  assert.equal(from, T0 + 40 * MIN);
  const shade = svg.children.find((n) => n.attrs.class === 'untracked');
  assert.equal(shade.attrs.width, '200.0', 'shaded up to the first reading');
  assert.equal(svg.children.find((n) => n.attrs.class === 'untracked-text').textContent, 'no readings before T+40m');
  assert.equal(viewersAt(series, T0 + 10 * MIN), null, 'the hover finds nothing there');
  // Too narrow for the words: the shade and its edge still show.
  drawViewerGraph(svg, series, T0, T0 + 100 * MIN, 300);
  assert.ok(svg.children.some((n) => n.attrs.class === 'untracked-edge'));
  assert.ok(!svg.children.some((n) => n.attrs.class === 'untracked-text'));
});

test('a flat line still gets a peak mark but no low, and the hover reads the nearest count within a few polls', () => {
  const { drawViewerGraph, viewersAt } = page({ pollMs: 60000 });
  const svg = node('svg');
  drawViewerGraph(svg, [[T0, 50], [T0 + MIN, 50], [T0 + 2 * MIN, 50]], T0, T0 + 2 * MIN, 300);
  assert.deepEqual(svg.children.filter((n) => n.name === 'text').map((n) => n.textContent), ['▲ 50']);
  const series = [[T0, 100], [T0 + MIN, null], [T0 + 2 * MIN, 120]];
  assert.deepEqual({ ...viewersAt(series, T0 + 0.4 * MIN) }, { d: 0.4 * MIN, t: T0, v: 100 });
  assert.equal(viewersAt(series, T0 + 1.2 * MIN).v, 120, 'the null reading is skipped');
  assert.equal(viewersAt(series, T0 + 30 * MIN), null, 'nothing within reach');
});
