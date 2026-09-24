// Talks to Discord through webhooks (a pasted URL per channel: no login, no bot) and, optionally, watches
// screenshot folders and shares new pictures on its own. Everything that reaches the network goes through
// call(), which keeps the error messages readable and retries once when Discord says "slow down".
const fs = require('fs');
const path = require('path');
const { expandShortcuts } = require('../../src/core/user-folders');
const { fillVrchat, publicOnly } = require('./vrchat');

const HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com', '127.0.0.1', 'localhost']);
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_FILE = 25 * 1024 * 1024;
const SLOTS = [2, 3, 4]; // extra channels; the main webhook is always "main"
const POLL_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mentionsFor(mode) {
  if (mode === 'people') return { parse: ['users', 'roles'] };
  if (mode === 'everyone') return { parse: ['users', 'roles', 'everyone'] };
  return { parse: [] }; // the default: typing @everyone in a message can never ping anyone
}

function explain(status, detail) {
  const extra = detail && detail.message ? ` (${detail.message})` : '';
  if (status === 400) return `Discord rejected that message${extra}.`;
  if (status === 401 || status === 403) return 'Discord did not accept that webhook. Check the URL in Settings.';
  if (status === 404) return 'Discord says that webhook or message no longer exists.';
  if (status === 413) return 'That file is too big for Discord.';
  if (status === 429) return 'Discord is rate-limiting this webhook. Try again in a moment.';
  return `Discord answered ${status}${extra}.`;
}

// A folder pattern where a "*" stands for any one folder name -> every matching folder that exists.
function expandFolders(pattern, overrides) {
  const parts = path.normalize(expandShortcuts(pattern, overrides)).split(path.sep);
  let paths = [parts[0] + path.sep];
  for (const part of parts.slice(1)) {
    const next = [];
    for (const base of paths) {
      if (part === '*') {
        let names = [];
        try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* not there */ }
        for (const n of names) next.push(path.join(base, n));
      } else if (part) next.push(path.join(base, part));
    }
    paths = next;
  }
  return paths.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

// Every image in a folder and its sub-folders (two levels: VRChat keeps a folder per month).
function imagesIn(dir, depth = 2) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && e.name.toLowerCase() !== 'thumbnails') out.push(...imagesIn(full, depth - 1)); }
    else if (IMAGE.test(e.name)) out.push(full);
  }
  return out;
}

const newestFile = (paths) => paths.map((p) => { try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.m - a.m)[0];

class DiscordRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.last = { state: 'off', error: '' }; // off | connected | error
    this.share = { on: false, timer: null, since: 0, seen: new Map(), busy: false };
    this.hub.set('discord.lastOk', false);
    this.hub.set('discord.autoShare', false);
  }

  setting(key) {
    return this.ctx.settings()[key];
  }

  status() {
    return { state: this.last.state, error: this.last.error };
  }

  record(ok, error = '') {
    this.last = { state: ok ? 'connected' : 'error', error };
    this.hub.set('discord.lastOk', ok);
    this.ctx.emitStatus();
  }

  // ---- channels: the main webhook plus up to three named extras ----
  channels() {
    const s = this.ctx.settings();
    const list = [];
    if (String(s.webhookUrl || '').trim()) list.push({ value: 'main', label: String(s.mainName || '').trim() || 'Main channel' });
    for (const n of SLOTS) {
      if (String(s[`url${n}`] || '').trim()) list.push({ value: String(n), label: String(s[`name${n}`] || '').trim() || `Channel ${n}` });
    }
    return list;
  }

  baseUrl(channel) {
    const s = this.ctx.settings();
    const id = channel && channel !== '' ? String(channel) : 'main';
    const raw = String(id === 'main' ? s.webhookUrl : s[`url${id}`] || '').trim();
    if (!raw) throw new Error(id === 'main' ? 'Paste your Webhook URL first (Settings → Plugins → Discord).' : `That channel has no Webhook URL (Settings → Plugins → Discord).`);
    let u;
    try { u = new URL(raw); } catch { throw new Error('That Webhook URL is not a valid link.'); }
    if (!HOSTS.has(u.hostname)) throw new Error('That is not a Discord webhook URL.');
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !local) throw new Error('The Webhook URL must start with https://');
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }

  async call(channel, method, { path: sub = '', query = {}, json, form } = {}) {
    const url = new URL(this.baseUrl(channel) + sub);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(url, { method, headers: json ? { 'Content-Type': 'application/json' } : undefined, body: form || (json ? JSON.stringify(json) : undefined) });
      } catch (err) {
        this.record(false, err.message);
        throw new Error(`Could not reach Discord: ${err.message}`);
      }
      if (res.status === 429 && attempt === 0) {
        const body = await res.json().catch(() => ({}));
        await sleep(Math.min(5000, (Number(body.retry_after) || 1) * 1000));
        continue;
      }
      if (!res.ok) {
        const msg = explain(res.status, await res.json().catch(() => null));
        this.record(false, msg);
        throw new Error(msg);
      }
      this.record(true);
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    return null;
  }

  // ---- posting ----
  // opts: { channel, content, username, avatarUrl, embeds, mentions, file: <path> }
  async send(opts) {
    const s = this.ctx.settings();
    const body = {
      content: String(opts.content || '').slice(0, 2000),
      username: opts.username || s.username || 'VR Macro Pad',
      allowed_mentions: mentionsFor(opts.mentions),
    };
    const avatar = opts.avatarUrl || s.avatarUrl;
    if (avatar) body.avatar_url = avatar;
    if (opts.embeds && opts.embeds.length) body.embeds = opts.embeds;
    if (!body.content && !body.embeds && !opts.file) throw new Error('There is nothing to send: type a message first.');
    const query = { wait: 'true' };
    if (opts.file) {
      let data;
      try {
        const st = fs.statSync(opts.file);
        if (st.size > MAX_FILE) throw new Error('That file is over Discord\'s 25 MB limit.');
        data = fs.readFileSync(opts.file);
      } catch (err) { throw new Error(err.message.startsWith('That file') ? err.message : `Could not read that file (${err.code || err.message}).`); }
      const form = new FormData();
      form.append('payload_json', JSON.stringify(body));
      form.append('files[0]', new Blob([data]), path.basename(opts.file));
      return this.call(opts.channel, 'POST', { query, form });
    }
    return this.call(opts.channel, 'POST', { query, json: body });
  }

  // "Save and test connection": asks Discord about the webhook without posting anything.
  async check() {
    const info = await this.call('main', 'GET');
    return [{ value: (info && info.channel_id) || 'ok', label: (info && info.name) || 'webhook' }];
  }

  // ---- newest picture, on demand ----
  // The folders the user typed in Settings for when auto-detect cannot find Steam or VRChat's pictures.
  overrides() {
    const s = this.ctx.settings();
    return { steam: s.steamFolder, vrchat: s.vrchatFolder };
  }

  newestPicture(source, target) {
    let files = [];
    if (source === 'file') { files = [expandShortcuts(target, this.overrides())]; }
    else for (const dir of expandFolders(target, this.overrides())) files.push(...imagesIn(dir));
    const best = newestFile(files.filter((f) => IMAGE.test(f) || source === 'file'));
    if (!best) throw new Error(source === 'file' ? 'That file was not found.' : 'No pictures found in that folder.');
    return best.p;
  }

  // ---- automatic screenshot sharing ----
  folders() {
    const list = String(this.ctx.settings().screenshotFolders || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return list.flatMap((l) => expandFolders(l, this.overrides()));
  }

  // opts (all optional, they come from the button): { steam: share Steam screenshots (default yes), vrchat: share VRChat photos (default no),
  // channel, vrchatChannel, caption }.
  // Anything not given falls back to the plugin's Settings.
  vrchatFolders() {
    return expandFolders('{vrchat}', this.overrides());
  }

  setAutoShare(on, opts = {}) {
    if (on === this.share.on && !on) return;
    this.share.on = on;
    clearInterval(this.share.timer); this.share.timer = null;
    this.share.seen = new Map();
    this.share.opts = opts || {};
    if (on) {
      this.share.since = this.ctx.now();
      this.share.timer = setInterval(() => this.scan().catch(() => {}), POLL_MS);
      if (this.share.timer.unref) this.share.timer.unref();
    }
    this.hub.set('discord.autoShare', on);
    this.ctx.emitStatus();
  }

  // The folders being watched, each with where its pictures go: Steam / game screenshots, and (only if asked for) VRChat photos.
  shareSources() {
    const s = this.ctx.settings();
    const o = this.share.opts || {};
    const channel = o.channel || s.autoChannel || 'main';
    const caption = o.caption !== undefined && o.caption !== '' ? o.caption : (s.autoCaption || '');
    const sources = [];
    if (o.steam !== false) sources.push({ kind: 'screenshot', folders: this.folders(), channel, caption });
    if (o.vrchat) sources.push({ kind: 'vrchat', folders: this.vrchatFolders(), channel: o.vrchatChannel || channel, caption });
    return sources;
  }

  // One look at the folders: share pictures that appeared since sharing was switched on, once they have
  // stopped growing (a game may still be writing the file).
  async scan() {
    if (!this.share.on || this.share.busy) return;
    this.share.busy = true;
    try {
      for (const src of this.shareSources()) {
        for (const file of src.folders.flatMap((d) => imagesIn(d))) {
          let st;
          try { st = fs.statSync(file); } catch { continue; }
          if (st.mtimeMs < this.share.since) continue;
          const key = `${file}|${st.mtimeMs}`;
          const seen = this.share.seen.get(key);
          if (seen === 'done') continue;
          if (seen !== st.size) { this.share.seen.set(key, st.size); continue; } // wait one more look for the size to settle
          this.share.seen.set(key, 'done');
          const o = this.share.opts || {};
          const procs = () => (this.ctx.winHelper ? this.ctx.winHelper('audio').call('proc.list') : Promise.resolve([]));
          try {
            if (src.kind === 'vrchat' && o.onlyPublic) {
              const g = await publicOnly({ procs });
              if (!g.ok) { this.record(false, `Skipped a VRChat photo: ${g.reason}`); continue; }
            }
            await this.send({ channel: src.channel, content: await fillVrchat(src.caption, this.ctx, { procs, file }), file, mentions: 'none' });
          } catch { /* record() already put the reason on the status */ }
        }
      }
    } finally { this.share.busy = false; }
  }

  configure() {
    this.ctx.emitStatus();
  }

  stop() {
    this.setAutoShare(false);
  }
}

module.exports = { DiscordRuntime, expandFolders, imagesIn, mentionsFor };
