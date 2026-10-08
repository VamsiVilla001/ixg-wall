// Slack posting (backend/slack.js) against a fake Slack, and the language-first screenshot
// names (backend/source-capture.js): anyone's bot token checked before it's saved, an invite
// link turned away with what to paste instead, the three-step file upload, retries Slack can
// get over and none it can't, and the token never reaching a page.   npm test
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'xoxb-1111-2222-goodtoken';
const slackFake = { calls: [], uploads: [], script: [] };
const server = http.createServer((req, res) => {
  let raw = [];
  req.on('data', (c) => raw.push(c));
  req.on('end', () => {
    raw = Buffer.concat(raw);
    const url = new URL(req.url, 'http://x');
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/upload/F1') {
      slackFake.uploads.push(raw);
      res.writeHead(200);
      return res.end(`OK - ${raw.length}`);
    }
    const method = url.pathname.replace('/api/', '');
    const p = Object.fromEntries(new URLSearchParams(raw.toString()));
    slackFake.calls.push({ method, p, auth: req.headers.authorization });
    const scripted = slackFake.script.shift();
    if (scripted) return json(scripted.status || 200, scripted.body, scripted.headers);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(200, { ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return json(200, { ok: true, team: 'Tesseract Esports', user: 'ixg-wall' });
    if (method === 'conversations.info') {
      if (p.channel === 'C0NOTHERE1') return json(200, { ok: false, error: 'channel_not_found' });
      return json(200, { ok: true, channel: { id: p.channel, name: 'bmsd-screenshots', is_member: p.channel !== 'C0OUTSIDE1' } });
    }
    if (method === 'files.getUploadURLExternal') return json(200, { ok: true, upload_url: `http://127.0.0.1:${server.address().port}/upload/F1`, file_id: 'F1' });
    if (method === 'files.completeUploadExternal') return json(200, { ok: true, files: [{ id: 'F1' }] });
    if (method === 'chat.postMessage') return json(200, { ok: true });
    json(404, { ok: false, error: 'unknown_method' });
  });
}).listen(0, '127.0.0.1');
const ready = new Promise((r) => server.once('listening', r)).then(() => {
  process.env.IXG_SLACK_API = `http://127.0.0.1:${server.address().port}/api`;
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ixg-wall-slack-'));
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The storage the poster uses, as secrets.js keeps it.
function fakeSecrets() {
  let saved = null;
  return {
    slack: () => saved,
    slackInfo: () => ({ set: !!saved, source: saved ? 'saved' : null, channelId: saved?.channelId || '', channelName: saved?.channelName || '', team: saved?.team || '', last4: saved ? saved.token.slice(-4) : '' }),
    setSlack: (s) => { saved = s; return true; },
  };
}

async function poster() {
  await ready;
  const { SlackPoster } = require('../backend/slack');
  return new SlackPoster({ secrets: fakeSecrets() });
}

test('the channel ID is read from an ID or a channel link; an invite link has none', () => {
  const { channelIdFrom } = require('../backend/slack');
  assert.equal(channelIdFrom('C0123ABCDEF'), 'C0123ABCDEF');
  assert.equal(channelIdFrom('https://app.slack.com/client/T0AAA1111/C0123ABCDEF'), 'C0123ABCDEF');
  assert.equal(channelIdFrom('https://tesseract.slack.com/archives/C0123ABCDEF/p1700000000'), 'C0123ABCDEF');
  assert.equal(channelIdFrom('https://join.slack.com/share/enQtMTIyNjYyMTA2MDUzMTYtNTY2'), null);
});

test('a token Slack refuses, or an invite link for a channel, is not saved, and says what to do', async () => {
  const slack = await poster();
  assert.match((await slack.save({ token: 'not-a-token', channel: 'C0123ABCDEF' })).error, /xoxb-/);
  const invite = await slack.save({ token: TOKEN, channel: 'https://join.slack.com/share/enQtMTIyNjYy' });
  assert.equal(invite.status, 400);
  assert.match(invite.error, /invite link only lets a person join.*Channel ID/);
  const bad = await slack.save({ token: 'xoxb-9999-wrong-token', channel: 'C0123ABCDEF' });
  assert.equal(bad.status, 400);
  assert.match(bad.error, /doesn't accept this token/);
  assert.match((await slack.save({ token: TOKEN, channel: 'C0NOTHERE1' })).error, /no channel with this ID/);
  assert.equal(slack.configured(), false, 'nothing refused was saved');
});

test('a good token is saved with the channel\'s name; the page sees the last 4 characters only', async () => {
  const slack = await poster();
  const ok = await slack.save({ token: TOKEN, channel: 'https://app.slack.com/client/T0AAA1111/C0123ABCDEF' });
  assert.equal(ok.status, 200);
  assert.equal(ok.check.status, 'ok');
  assert.match(ok.check.message, /#bmsd-screenshots/);
  const info = slack.info();
  assert.deepEqual([info.set, info.channelId, info.channelName, info.team, info.last4], [true, 'C0123ABCDEF', '#bmsd-screenshots', 'Tesseract Esports', 'oken']);
  assert.ok(!JSON.stringify(info).includes(TOKEN), 'never the token');

  const outside = await slack.save({ token: TOKEN, channel: 'C0OUTSIDE1' });
  assert.equal(outside.status, 200, 'saved: inviting the app is done in Slack');
  assert.match(outside.check.message, /\/invite/);
});

test('a screenshot goes up in three steps and is shared in the channel with its message', async () => {
  const slack = await poster();
  await slack.save({ token: TOKEN, channel: 'C0123ABCDEF' });
  const file = path.join(dir, '[Hindi] - BMSD 2026 Semi-Finals Day 1 - 154,337 PCV - 2026-10-08 15-52.png');
  fs.writeFileSync(file, Buffer.from('fake png bytes'));
  slackFake.calls.length = 0;
  slackFake.uploads.length = 0;
  const r = await slack.post({ file, title: path.basename(file, '.png'), comment: '*[Hindi] - …*\nNew PCV *154,337*' });
  assert.deepEqual(r, { ok: true, tries: 1 });
  assert.deepEqual(slackFake.calls.map((c) => c.method), ['files.getUploadURLExternal', 'files.completeUploadExternal']);
  assert.equal(slackFake.calls[0].p.filename, path.basename(file), 'named language first');
  assert.equal(slackFake.calls[0].p.length, String('fake png bytes'.length));
  assert.equal(slackFake.uploads[0].toString(), 'fake png bytes');
  const done = slackFake.calls[1].p;
  assert.equal(done.channel_id, 'C0123ABCDEF');
  assert.match(done.initial_comment, /New PCV \*154,337\*/);
  assert.deepEqual(JSON.parse(done.files), [{ id: 'F1', title: '[Hindi] - BMSD 2026 Semi-Finals Day 1 - 154,337 PCV - 2026-10-08 15-52' }]);
});

test('a note goes to the channel as a message, links kept as Slack links', async () => {
  const slack = await poster();
  await slack.save({ token: TOKEN, channel: 'C0123ABCDEF' });
  slackFake.calls.length = 0;
  const r = await slack.notify('2026-10-08 · Hindi Day 1 · 233,375 CCV · new PCV · <https://1drv.ms/x|Open in OneDrive>');
  assert.deepEqual(r, { ok: true, tries: 1 });
  assert.deepEqual(slackFake.calls.map((c) => c.method), ['chat.postMessage']);
  assert.equal(slackFake.calls[0].p.channel, 'C0123ABCDEF');
  assert.match(slackFake.calls[0].p.text, /^2026-10-08 · Hindi Day 1 · 233,375 CCV · new PCV · <https:\/\/1drv\.ms\/x\|Open in OneDrive>$/);
  assert.equal(slackFake.calls[0].p.unfurl_links, 'false', 'no preview box under the note');
});

test('Slack asking to slow down is waited out and tried again; the app not in the channel is not retried', async () => {
  const slack = await poster();
  await slack.save({ token: TOKEN, channel: 'C0123ABCDEF' });
  const file = path.join(dir, 'retry.png');
  fs.writeFileSync(file, 'x');
  const retries = [];
  slack.on('retry', (e) => retries.push(e.tries));
  slackFake.script.push({ status: 429, headers: { 'Retry-After': '0' }, body: { ok: false, error: 'ratelimited' } });
  assert.deepEqual(await slack.post({ file, comment: 'c' }), { ok: true, tries: 2 });
  assert.deepEqual(retries, [1]);

  slackFake.script.push({ body: { ok: true, upload_url: `http://127.0.0.1:${server.address().port}/upload/F1`, file_id: 'F1' } }, { body: { ok: false, error: 'not_in_channel' } });
  const no = await slack.post({ file, comment: 'c' });
  assert.equal(no.ok, false);
  assert.equal(no.tries, 1, 'waiting won\'t fix it');
  assert.match(no.error, /\/invite/);

  const gone = await slack.post({ file: path.join(dir, 'deleted.png'), comment: 'c' });
  assert.deepEqual([gone.ok, gone.tries], [false, 1]);
});

test('screenshot names start with the language, from the feed\'s tag or a language it names', () => {
  const { readableName, languageOf } = require('../backend/source-capture');
  const when = new Date(2026, 9, 8, 15, 52);
  const hindi = '[HINDI] BMSD 2026 | Semi-Finals | Day 1 #BGMILIVE';
  assert.equal(readableName({ label: hindi, facts: { title: hindi, ccv: '154,290' }, kind: 'peak', pcv: 154337 }, when),
    '[Hindi] - BMSD 2026 Semi-Finals Day 1 - 154,337 PCV - 2026-10-08 15-52.png', 'the sampled PCV, not the page\'s count');
  assert.equal(readableName({ label: 'English feed', facts: { title: '[ENGLISH] BMSD 2026 | Day 1', views: '543,460' }, kind: 'end' }, when),
    '[English] - BMSD 2026 Day 1 - 543,460 Views - END - 2026-10-08 15-52.png');
  assert.equal(readableName({ label: '[MAP STREAM]  BMSD 2026', facts: { title: '[MAP STREAM]  BMSD 2026', ccv: '1,790' } }, when),
    '[Map Stream] - BMSD 2026 - 1,790 CCV - 2026-10-08 15-52.png');
  assert.equal(readableName({ label: 'Hindi Main', facts: { title: 'Finals: day 2? <live>' } }, when),
    '[Hindi] - Finals day 2 live - CCV N-A - 2026-10-08 15-52.png', 'no characters Windows refuses');
  assert.equal(languageOf('Someone else', 'No language here'), 'Untagged');
});

test('screenshots go in Screenshots/<session>/<day>/<feed>/, the names as typed, safe on Windows', () => {
  const { sessionFolder, feedFolder, dayFolder, shotFolder, SourceCapture } = require('../backend/source-capture');
  assert.equal(dayFolder(new Date(2026, 9, 8, 23, 59)), '2026-10-08', 'the local day');
  assert.equal(shotFolder('BMSD 2026: Day 1', '[HINDI] Main | Day 1', '', new Date(2026, 9, 8, 16, 42)), path.join('BMSD 2026 Day 1', '2026-10-08', 'Hindi Day 1'));
  assert.equal(sessionFolder('BMSD 2026: Semi-Finals / Day 1'), 'BMSD 2026 Semi-Finals Day 1');
  assert.equal(sessionFolder(''), 'Untitled session');
  assert.equal(sessionFolder(undefined), 'Untitled session');
  const hindi = '[HINDI] BMSD 2026 | Semi-Finals | Day 1 #BGMILIVE';
  assert.equal(feedFolder(hindi), 'Hindi Day 1', 'short: the tag and the day');
  assert.equal(feedFolder('[MAP STREAM]  BMSD 2026 | Semi-Finals | Day 1 #BGMILIVE'), 'Map Stream Day 1');
  assert.equal(feedFolder('[ENGLISH] Grand Finals'), 'English', 'no day in the label');
  assert.equal(feedFolder('Someone else\'s stream'), 'Someone else\'s stream', 'no tag: the label as typed');
  assert.equal(feedFolder(hindi, '', [hindi, '[HINDI] Backup | Day 1']), hindi.replace(/ \| /g, ' '), 'two Hindi Day 1 feeds in a session: the whole labels keep them apart');
  assert.equal(feedFolder(hindi, '', [hindi, '[ENGLISH] Main | Day 1']), 'Hindi Day 1', 'a different language is no clash');
  assert.equal(feedFolder('', 'Pqmg2dcht_M'), 'Pqmg2dcht_M', 'an unlabelled feed: its video id');
  const sc = new SourceCapture({ browserPath: null, folder: path.join(dir, 'shots') });
  const file = sc.save(Buffer.from('png'), '[Hindi] - x - 1 CCV - 2026-10-08 15-52.png', shotFolder('BMSD 2026: Day 1', '[HINDI] Main | Day 1'));
  assert.equal(path.relative(path.join(dir, 'shots'), file), path.join('BMSD 2026 Day 1', dayFolder(), 'Hindi Day 1', '[Hindi] - x - 1 CCV - 2026-10-08 15-52.png'));
  const again = sc.save(Buffer.from('png'), '[Hindi] - x - 1 CCV - 2026-10-08 15-52.png', shotFolder('BMSD 2026: Day 1', '[HINDI] Main | Day 1'));
  assert.match(path.basename(again), / \(1\)\.png$/, 'a second file of the same name is kept, not overwritten');
});
