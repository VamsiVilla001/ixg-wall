// Capture Source Screenshot (extension/capture.js, source-youtube.js): file names safe on
// Windows, the crop maths, and which requests the YouTube source takes. No browser needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fileName, union, cropRect, detectPlatform, SOURCES, FOLDER } = require('../extension/capture');
const { IXGYouTube } = require('../extension/source-youtube');

const when = new Date(2026, 9, 5, 20, 52, 15); // local time, as the operator's clock shows it

test('file names carry account, title, CCV and time, with Windows-safe characters', () => {
  assert.equal(fileName({ account: 'KRAFTON INDIA ESPORTS', title: 'BGMI FINALS', ccv: '124,382' }, when),
    'KRAFTON_INDIA_ESPORTS_BGMI_FINALS_124382CCV_2026-10-05_205215.png');
  assert.equal(fileName({ account: 'KRAFTON INDIA ESPORTS', title: 'BGMI FINALS', ccv: null }, when),
    'KRAFTON_INDIA_ESPORTS_BGMI_FINALS_CCV-NA_2026-10-05_205215.png');
  const messy = fileName({ account: ' Rubix: IXG / "Test" ', title: '[HINDI] BMSD 2026 | Day 2 #BGMILIVE <live?>', ccv: '1.2K' }, when);
  assert.equal(messy, 'Rubix_IXG_Test_[HINDI]_BMSD_2026_Day_2_#BGMILIVE_live_1.2KCCV_2026-10-05_205215.png');
  assert.doesNotMatch(messy, /[<>:"/\\|?*]/);
  assert.equal(fileName({}, when), 'Unknown_Unknown_CCV-NA_2026-10-05_205215.png');
  // Automatic ones say why; anything else in the tag is left out.
  assert.equal(fileName({ account: 'KRAFTON INDIA ESPORTS', title: 'BGMI FINALS', ccv: '124,382' }, when, 'PEAK'),
    'KRAFTON_INDIA_ESPORTS_BGMI_FINALS_124382CCV_PEAK_2026-10-05_205215.png');
  assert.equal(fileName({ account: 'KRAFTON INDIA ESPORTS', title: 'BGMI FINALS', ccv: null }, when, 'END'),
    'KRAFTON_INDIA_ESPORTS_BGMI_FINALS_CCV-NA_END_2026-10-05_205215.png');
  assert.equal(fileName({ account: 'A', title: 'B', ccv: '5' }, when, '../x'), 'A_B_5CCV_2026-10-05_205215.png');
  assert.ok(fileName({ account: 'a'.repeat(100), title: 'b'.repeat(200), ccv: '5' }, when).length < 140, 'long names are cut');
  assert.equal(FOLDER, 'IXG-Wall/Screenshots');
});

test('the crop is the padded block in the screenshot\'s pixels, clamped to the viewport', () => {
  const parts = [{ x: 100, y: 80, width: 800, height: 450 }, { x: 100, y: 540, width: 600, height: 40 }, null, { x: 100, y: 590, width: 300, height: 30 }];
  const block = union(parts);
  assert.deepEqual(block, { x: 100, y: 80, width: 800, height: 540 });
  // A 1600 × 1000 viewport captured at 2× device pixels, scrolled down 64 px.
  const crop = cropRect(block, { width: 1600, height: 1000, scrollX: 0, scrollY: 64 }, { width: 3200, height: 2000 });
  assert.deepEqual(crop, { x: 168, y: 0, width: 1664, height: 1144 });
  // Nothing found: the whole screenshot, never a sliver.
  assert.deepEqual(cropRect(null, { width: 1600, height: 1000, scrollX: 0, scrollY: 0 }, { width: 1600, height: 1000 }), { x: 0, y: 0, width: 1600, height: 1000 });
  assert.equal(union([null, { x: 0, y: 0, width: 0, height: 0 }]), null);
});

test('YouTube takes 11-character video ids only, and opens the English watch page', () => {
  assert.equal(SOURCES.length, 1);
  assert.equal(detectPlatform({ platform: 'youtube', videoId: 'aUyky8GpDmo' }), IXGYouTube);
  assert.equal(detectPlatform({ platform: 'youtube', videoId: 'javascript:1' }), null);
  assert.equal(detectPlatform({ platform: 'twitch', videoId: 'aUyky8GpDmo' }), null);
  assert.equal(IXGYouTube.url({ videoId: 'aUyky8GpDmo' }), 'https://www.youtube.com/watch?v=aUyky8GpDmo&hl=en');
  // What the stages wait for, and what the picture must hold.
  const live = { player: { x: 0, y: 0, width: 1, height: 1 }, title: 'T', channel: 'C', live: true, viewersText: '12,345', titleBox: {}, channelBox: {}, countBox: { x: 0, y: 2, width: 1, height: 1 } };
  assert.ok(IXGYouTube.sourceReady(live) && IXGYouTube.wantsCount(live) && IXGYouTube.countReady(live));
  assert.deepEqual(IXGYouTube.facts(live), { account: 'C', title: 'T', live: true, ccv: '12,345' });
  const recording = { ...live, live: false, viewersText: null };
  assert.equal(IXGYouTube.wantsCount(recording), false, 'a recording has no count to wait for');
  assert.equal(IXGYouTube.sourceReady({ ...live, channel: null }), false);
});

test('CPU is busy time over the interval between two readings, across every core', () => {
  const { cpuPercent } = require('../extension/capture');
  const at = (idle, total) => ({ usage: { idle, total, user: 0, kernel: 0 } });
  const prev = [at(1000, 2000), at(1000, 2000)];
  const next = [at(1200, 3000), at(1800, 3000)]; // core 1: 800 of 1000 busy; core 2: 200 of 1000
  assert.equal(cpuPercent(prev, next), 50);
  assert.equal(cpuPercent(null, next), null, 'nothing to compare the first reading with');
  assert.equal(cpuPercent(prev, prev), null, 'no time passed');
});
