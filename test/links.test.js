// Reading YouTube links and feed names out of pasted messages (public/links.js).
//   npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMessage, parseSource } = require('../public/links.js');

const summary = (text) => readMessage(text).map((f) => [f.source?.id ?? f.problem, f.label]);

test('a name on the line above each link (the usual Slack list)', () => {
  const msg = `Hindi Test Main
https://youtube.com/live/x-qOOPXB_lg?feature=share

English Test Main
https://youtube.com/live/2QK4W5bngD0?feature=share

Map Test Backup
https://youtube.com/live/AIwSZ829Htk?feature=share`;
  assert.deepEqual(summary(msg), [
    ['x-qOOPXB_lg', 'Hindi Test Main'],
    ['2QK4W5bngD0', 'English Test Main'],
    ['AIwSZ829Htk', 'Map Test Backup'],
  ]);
});

test('a sentence above the list is not taken as a name', () => {
  const msg = `Hey team, here are the streams to be monitored today:
https://youtube.com/live/x-qOOPXB_lg
https://youtu.be/2QK4W5bngD0`;
  assert.deepEqual(summary(msg), [['x-qOOPXB_lg', ''], ['2QK4W5bngD0', '']]);
});

test('names on the same line, before or after the link, with chat formatting', () => {
  assert.deepEqual(summary('*Hindi Main:* https://youtube.com/live/x-qOOPXB_lg, English Main - https://www.youtube.com/watch?v=2QK4W5bngD0.'), [
    ['x-qOOPXB_lg', 'Hindi Main'],
    ['2QK4W5bngD0', 'English Main'],
  ]);
  assert.deepEqual(summary('https://youtube.com/live/x-qOOPXB_lg (Hindi) https://youtube.com/live/2QK4W5bngD0 (English)'), [
    ['x-qOOPXB_lg', 'Hindi'],
    ['2QK4W5bngD0', 'English'],
  ]);
  assert.deepEqual(summary('• 1. Map stream → https://youtube.com/live/QMQ3qGNeNZU'), [['QMQ3qGNeNZU', 'Map stream']]);
});

test("Slack's <url|text> markup counts once", () => {
  assert.deepEqual(summary('Hindi: <https://youtube.com/live/x-qOOPXB_lg?feature=share|youtube.com/live/x-qOOPXB_lg>'), [
    ['x-qOOPXB_lg', 'Hindi'],
  ]);
});

test('channel links and non-video YouTube pages are reported, duplicates merged', () => {
  const msg = `Lofi: https://www.youtube.com/@LofiGirl/live
Playlist https://www.youtube.com/playlist?list=PL123
Hindi https://youtube.com/live/x-qOOPXB_lg
again https://youtube.com/watch?v=x-qOOPXB_lg`;
  assert.deepEqual(summary(msg), [['channel', 'Lofi'], ['invalid', 'Playlist'], ['x-qOOPXB_lg', 'Hindi']]);
});

test('bare video IDs one per line still work; ordinary words do not', () => {
  assert.deepEqual(summary('x-qOOPXB_lg\n2QK4W5bngD0\nInformation'), [['x-qOOPXB_lg', ''], ['2QK4W5bngD0', '']]);
});

test('text with no links finds nothing', () => {
  assert.deepEqual(readMessage('Meeting at 5, see you there'), []);
  assert.deepEqual(readMessage(''), []);
});

test('parseSource still reads every URL form', () => {
  for (const raw of ['x-qOOPXB_lg', 'youtu.be/x-qOOPXB_lg', 'https://m.youtube.com/watch?v=x-qOOPXB_lg&t=3',
    'youtube.com/live/x-qOOPXB_lg?feature=share', 'https://www.youtube.com/embed/x-qOOPXB_lg']) {
    assert.equal(parseSource(raw)?.id, 'x-qOOPXB_lg', raw);
  }
  assert.equal(parseSource('https://www.youtube.com/embed/live_stream?channel=UC123'), null);
});
