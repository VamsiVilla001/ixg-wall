// The preset layouts and the custom layout check, from the page's own config. No DOM needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const from = source.indexOf('  const STORAGE_KEY');
const to = source.indexOf('  // State + persistence', from);
assert.ok(from >= 0 && to > from);
const context = vm.createContext({});
vm.runInContext(`${source.slice(from, to)}; globalThis.L = { LAYOUT_PRESETS, LAYOUT_UNITS, layoutUnits, fillUnits, packUnits, evenLayout, validCustomLayout, DEFAULT_SETTINGS };`, context);
const { LAYOUT_PRESETS, LAYOUT_UNITS, validCustomLayout, DEFAULT_SETTINGS, evenLayout } = context.L;
const fillUnits = (m) => JSON.parse(JSON.stringify(context.L.fillUnits(m)));
const packUnits = (box, m) => JSON.parse(JSON.stringify(context.L.packUnits(box, m)));
// Plain arrays: ones made inside the sandbox don't compare equal to this file's.
const layoutUnits = (layout) => JSON.parse(JSON.stringify(context.L.layoutUnits(layout)));

// Which of the 12 × 12 squares each box covers; fails on overlap or leaving the grid.
function cover(units) {
  const seen = new Set();
  for (const [x, y, w, h] of units) {
    for (const v of [x, y, w, h]) assert.ok(Number.isInteger(v), `not a whole square: ${[x, y, w, h]}`);
    assert.ok(w >= 1 && h >= 1 && x + w <= LAYOUT_UNITS && y + h <= LAYOUT_UNITS, `outside the grid: ${[x, y, w, h]}`);
    for (let i = x; i < x + w; i++) {
      for (let j = y; j < y + h; j++) {
        assert.ok(!seen.has(`${i},${j}`), `boxes overlap at ${i},${j}`);
        seen.add(`${i},${j}`);
      }
    }
  }
  return seen.size;
}

test('there are 34 presets: 6 quick ones and 28 more, with unique ids, as on the reference panel', () => {
  assert.equal(LAYOUT_PRESETS.length, 34);
  assert.equal(LAYOUT_PRESETS.filter((p) => p.quick).length, 6);
  assert.equal(new Set(LAYOUT_PRESETS.map((p) => p.id)).size, 34);
  assert.ok(LAYOUT_PRESETS.some((p) => p.id === DEFAULT_SETTINGS.layoutPreset));
});

test('every preset fills the screen exactly: whole squares, no overlaps, no gaps', () => {
  for (const p of LAYOUT_PRESETS) {
    const units = layoutUnits(p);
    assert.equal(units.length, p.cells.length, p.id);
    assert.equal(cover(units), LAYOUT_UNITS * LAYOUT_UNITS, `${p.id} leaves part of the screen empty`);
  }
});

test('feed 1 gets the biggest box, then top to bottom and left to right', () => {
  const units = layoutUnits(LAYOUT_PRESETS.find((p) => p.id === '2-beside-big'));
  assert.deepEqual(units, [[4, 0, 8, 12], [0, 0, 4, 6], [0, 6, 4, 6]]);
  const strip = layoutUnits(LAYOUT_PRESETS.find((p) => p.id === 'big-over-strip'));
  assert.deepEqual(strip, [[0, 0, 12, 9], [0, 9, 12, 3]]);
});

test('a part-filled last page spreads 1–15 leftover feeds over the whole page, on whole squares', () => {
  for (let m = 1; m <= 15; m++) {
    const units = fillUnits(m);
    assert.equal(units.length, m);
    assert.equal(cover(units), LAYOUT_UNITS * LAYOUT_UNITS, `${m} feeds leave part of the page empty`);
  }
  assert.deepEqual(fillUnits(2), [[0, 0, 6, 12], [6, 0, 6, 12]], 'two side by side, full height');
  assert.deepEqual(fillUnits(3), [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 12, 6]], 'two over one');
  assert.deepEqual(fillUnits(5), [[0, 0, 4, 6], [4, 0, 4, 6], [8, 0, 4, 6], [0, 6, 6, 6], [6, 6, 6, 6]], 'three over two');
});

test('a later part-filled page keeps the grid\'s box size and is only as tall as its feeds', () => {
  // 2 × 2 (boxes 6 × 6): 2 leftover sit side by side, half a page high; 1 widens to the full width.
  assert.deepEqual(packUnits([0, 0, 6, 6], 2), [[0, 0, 6, 6], [6, 0, 6, 6]]);
  assert.deepEqual(packUnits([0, 0, 6, 6], 3), [[0, 0, 6, 6], [6, 0, 6, 6], [0, 6, 12, 6]]);
  assert.deepEqual(packUnits([0, 0, 6, 6], 1), [[0, 0, 12, 6]]);
  // 3 × 3 (boxes 4 × 4) with 5: three over two, eight of twelve rows.
  assert.deepEqual(packUnits([0, 0, 4, 4], 5), [[0, 0, 4, 4], [4, 0, 4, 4], [8, 0, 4, 4], [0, 4, 6, 4], [6, 4, 6, 4]]);
  // Every count on every even grid: whole squares, no overlap, full rows, nothing below the last.
  for (const p of LAYOUT_PRESETS.filter((x) => evenLayout(layoutUnits(x)))) {
    const units = layoutUnits(p);
    for (let m = 1; m < units.length; m++) {
      const packed = packUnits(units[0], m);
      assert.equal(packed.length, m, p.id);
      const rows = Math.max(...packed.map(([, y, , h]) => y + h));
      assert.ok(rows <= LAYOUT_UNITS, p.id);
      assert.equal(cover(packed), LAYOUT_UNITS * rows, `${p.id} with ${m} leaves a gap`);
    }
  }
});

test('only even grids fill their last page; PIP shapes keep their boxes', () => {
  const even = ['single', 'stack-2', 'side-2', 'quad', 'grid-3x2', 'grid-3x3', 'grid-4x4', 'columns-3', 'rows-3'];
  for (const p of LAYOUT_PRESETS) {
    assert.equal(evenLayout(layoutUnits(p)), even.includes(p.id), p.id);
  }
});

test('a custom layout must stay inside its grid and not overlap; gaps are allowed', () => {
  const ok = validCustomLayout({ cols: 3, rows: 2, cells: [[0, 0, 2, 2], [2, 0, 1, 1]] });
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { cols: 3, rows: 2, cells: [[0, 0, 2, 2], [2, 0, 1, 1]] });
  assert.ok(cover(layoutUnits(ok)) < LAYOUT_UNITS * LAYOUT_UNITS);
  assert.equal(validCustomLayout({ cols: 3, rows: 2, cells: [[0, 0, 2, 2], [1, 1, 1, 1]] }), null, 'overlap');
  assert.equal(validCustomLayout({ cols: 3, rows: 2, cells: [[2, 0, 2, 1]] }), null, 'outside');
  assert.equal(validCustomLayout({ cols: 5, rows: 2, cells: [[0, 0, 1, 1]] }), null, '5 doesn\'t divide 12');
  assert.equal(validCustomLayout({ cols: 2, rows: 2, cells: [] }), null, 'no boxes');
  assert.equal(validCustomLayout(null), null);
});
