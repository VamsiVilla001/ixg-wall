// Posts source screenshots to a Slack channel, as a Slack app's bot.
//
// A Slack invite link (join.slack.com/…) lets a person join a channel; it gives a program
// nothing. The wall posts with a bot token (xoxb-…) from a Slack app installed in the
// workspace, with the files:write scope, invited to the channel. The token can belong to
// anyone and is checked with Slack before it's saved; it stays on the server (secrets.js).
//
// Files go up the way Slack takes them since files.upload was retired: ask for an upload
// address (files.getUploadURLExternal), send the bytes there, then share the file in the
// channel with its message (files.completeUploadExternal). One post at a time; a failure
// Slack may get over (rate limit, network, its own error) is tried again, waiting longer
// each time, and one it won't (a revoked token, the bot not in the channel) is not.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const API = process.env.IXG_SLACK_API || 'https://slack.com/api';
const TOKEN_FORMAT = /^xox[bp]-[\w-]{10,250}$/;
const RETRY_WAITS_MS = [10000, 30000, 90000, 5 * 60000, 10 * 60000]; // then it's given up
const TIMEOUT_MS = 30000;
// Slack errors that waiting won't fix.
const FINAL = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission',
  'missing_scope', 'not_in_channel', 'channel_not_found', 'is_archived', 'restricted_action', 'file_missing']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The channel ID from what an operator pastes: C0123ABCD, or a link that carries it
// (app.slack.com/client/T…/C…, …slack.com/archives/C…). An invite link carries none.
function channelIdFrom(text) {
  const raw = String(text || '').trim();
  if (/^[CGD][A-Z0-9]{8,12}$/.test(raw)) return raw;
  const m = /(?:\/client\/T[A-Z0-9]+\/|\/archives\/)([CG][A-Z0-9]{8,12})\b/.exec(raw);
  return m ? m[1] : null;
}

// Slack's error codes, in words an operator can act on.
function explain(code, channel = 'the channel') {
  return {
    invalid_auth: 'Slack doesn\'t accept this token: copy the Bot User OAuth Token (xoxb-…) again from the app\'s OAuth & Permissions page',
    not_authed: 'No token was sent',
    account_inactive: 'The token belongs to a deactivated user or an uninstalled app: reinstall the app and copy its new token',
    token_revoked: 'This token was revoked: reinstall the app and copy its new token',
    token_expired: 'This token expired: reinstall the app and copy its new token',
    missing_scope: 'The app lacks a permission it needs: add the files:write and chat:write bot scopes, reinstall it, and copy the new token',
    not_in_channel: `The app isn't in ${channel}: in Slack, open the channel and type /invite @your-app`,
    channel_not_found: 'Slack has no channel with this ID that the app can see: check the ID, and invite the app to the channel',
    is_archived: `${channel} is archived`,
    ratelimited: 'Slack asked the wall to slow down',
  }[code] || `Slack said: ${code}`;
}

class SlackPoster extends EventEmitter {
  constructor({ secrets }) {
    super();
    this.secrets = secrets;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.check = null; // what Slack said when it was saved: { status, message, at }
  }

  configured() {
    return !!this.secrets.slack();
  }

  info() {
    return { ...this.secrets.slackInfo(), check: this.check, pending: this.pending };
  }

  // A Web API call. Returns Slack's body; throws { code, message, retryAfterMs } when it says no.
  async call(method, params, token = this.secrets.slack()?.token) {
    let res;
    try {
      res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error(`Couldn't reach Slack (${err.message})`), { code: 'network' });
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      throw Object.assign(new Error(explain('ratelimited')), { code: 'ratelimited', retryAfterMs: Number.isFinite(wait) ? wait * 1000 : null });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      const code = body.error || `http_${res.status}`;
      throw Object.assign(new Error(explain(code)), { code });
    }
    return body;
  }

  // Saves anyone's bot token and channel, or removes them with both empty. A token Slack
  // refuses, or a channel it doesn't know, isn't saved. Returns { status: HTTP code, error?, check? }.
  async save({ token, channel }) {
    if (this.secrets.slackInfo().source === 'env') {
      return { status: 409, error: 'This server sets Slack itself (SLACK_BOT_TOKEN), so it can\'t be changed here.' };
    }
    const t = String(token || '').trim();
    const c = String(channel || '').trim();
    if (!t && !c) {
      this.secrets.setSlack(null);
      this.check = null;
      this.emit('change');
      return { status: 200, check: null };
    }
    if (!TOKEN_FORMAT.test(t)) return { status: 400, error: 'That isn\'t a Slack token: use the app\'s Bot User OAuth Token, which starts xoxb-.' };
    const channelId = channelIdFrom(c);
    if (!channelId) {
      return {
        status: 400,
        error: /join\.slack\.com/.test(c)
          ? 'An invite link only lets a person join: paste the channel\'s ID instead (in Slack, open the channel name → About → Channel ID, C…).'
          : 'That isn\'t a Slack channel ID (C… or G…) or a link to a channel.',
      };
    }
    let who;
    try {
      who = await this.call('auth.test', {}, t);
    } catch (err) {
      return { status: 400, error: err.message };
    }
    let channelName = '';
    let check = { status: 'ok', message: `Slack accepted the token (${who.team || 'workspace'}). Screenshots go to ${channelId}.` };
    try {
      const { channel: ch } = await this.call('conversations.info', { channel: channelId }, t);
      channelName = ch?.name ? `#${ch.name}` : '';
      if (ch && ch.is_member === false) {
        check = { status: 'warn', message: explain('not_in_channel', channelName || channelId) };
      } else {
        check.message = `Slack accepted the token (${who.team || 'workspace'}). Screenshots go to ${channelName || channelId}.`;
      }
    } catch (err) {
      if (err.code === 'channel_not_found') return { status: 400, error: err.message };
      // Without channels:read the channel can't be looked at: saved, and the first post will tell.
      check = { status: 'unchecked', message: `Token accepted, but the channel couldn't be checked (${err.message}). Send a test to be sure.` };
    }
    this.secrets.setSlack({ token: t, channelId, channelName, team: who.team || '' });
    this.check = { ...check, at: Date.now() };
    this.emit('change');
    return { status: 200, check: this.check };
  }

  // Settings → Send test: a plain message, so the operator sees it arrive.
  async test() {
    const s = this.secrets.slack();
    if (!s) return { ok: false, message: 'Slack isn\'t set up.' };
    try {
      await this.call('chat.postMessage', { channel: s.channelId, text: 'IXG Wall is connected: source screenshots will be posted here.' });
      this.check = { status: 'ok', message: `Test message posted to ${s.channelName || s.channelId}.`, at: Date.now() };
      return { ok: true, message: this.check.message };
    } catch (err) {
      this.check = { status: 'bad', message: explain(err.code, s.channelName || s.channelId), at: Date.now() };
      return { ok: false, message: this.check.message };
    } finally {
      this.emit('change');
    }
  }

  // Queues a screenshot for the channel. Resolves { ok, tries, error? } once it's posted or given up.
  post({ file, title, comment }) {
    this.pending += 1;
    const run = this.queue.then(() => this.send({ file, title, comment })).finally(() => { this.pending -= 1; });
    this.queue = run.catch(() => {});
    return run;
  }

  async send({ file, title, comment }) {
    let tries = 0;
    for (;;) {
      tries += 1;
      const s = this.secrets.slack();
      if (!s) return { ok: false, tries, error: 'Slack isn\'t set up' };
      try {
        await this.upload(s, { file, title, comment });
        return { ok: true, tries };
      } catch (err) {
        const wait = err.retryAfterMs ?? RETRY_WAITS_MS[tries - 1]; // Slack's Retry-After when it gives one
        if (FINAL.has(err.code)) return { ok: false, tries, error: explain(err.code, s.channelName || s.channelId) };
        if (wait == null) return { ok: false, tries, error: `${err.message}; gave up after ${tries} tries` };
        this.emit('retry', { file, tries, waitMs: wait, error: err.message });
        await sleep(wait);
      }
    }
  }

  async upload(s, { file, title, comment }) {
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw Object.assign(new Error('The screenshot file is gone'), { code: 'file_missing' });
    }
    const filename = path.basename(file);
    const { upload_url: url, file_id: id } = await this.call('files.getUploadURLExternal', { filename, length: String(bytes.length) }, s.token);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw Object.assign(new Error(`Couldn't send the file to Slack (${err.message})`), { code: 'network' });
    }
    if (!res.ok) throw Object.assign(new Error(`Slack's upload answered HTTP ${res.status}`), { code: `http_${res.status}` });
    await this.call('files.completeUploadExternal', {
      files: JSON.stringify([{ id, title: title || filename }]),
      channel_id: s.channelId,
      initial_comment: comment || '',
    }, s.token);
  }
}

module.exports = { SlackPoster, channelIdFrom, TOKEN_FORMAT };
