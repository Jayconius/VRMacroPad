// Talks to Mix It Up's Developer API (Mix It Up → Services → Developer API → Connect), a small REST server that
// only listens on this PC: http://localhost:8911/api/v2. No password. Mix It Up's own wiki documents it at
// https://mixitup.bot/docs/reference/developer-api. What is used here:
//   GET   /commands?skip=&pageSize=          -> { TotalCount, Commands: [{ ID, Name, Type, IsEnabled, Unlocked, GroupName }] }
//   POST  /commands/{id}                     body { Platform?, Arguments?, SpecialIdentifiers?, IgnoreRequirements }   -> 200
//   PATCH /commands/{id}/state/{0|1|2}       0 = disable, 1 = enable, 2 = toggle
//   POST  /chat/message                      body { Message, Platform?, SendAsStreamer }
//   POST  /chat/clear
// Errors come back as { status, title, detail }. Nothing is polled and no connection is kept: one short request is
// made when a button is pressed or when you open the command list.
const http = require('http');

const TIMEOUT_MS = 5000;
const PAGE = 500;
const MAX_COMMANDS = 5000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;
const STATES = { disable: 0, enable: 1, toggle: 2 };

class MixItUpRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.state = 'off'; // off | connected | error
    this.error = '';
  }

  status() {
    return { state: this.state, error: this.error };
  }

  // host and port from Settings, checked so nothing but a host name or address can get in.
  base() {
    const s = this.ctx.settings();
    const host = String(s.host || '127.0.0.1').trim();
    const port = Math.round(Number(s.port) || 8911);
    if (!HOST.test(host)) throw new Error('The Mix It Up address in Settings is not a valid host name or IP address.');
    if (!(port >= 1 && port <= 65535)) throw new Error('The Mix It Up port in Settings must be between 1 and 65535.');
    return { host, port, label: `${host}:${port}` };
  }

  fail(message) {
    this.state = 'error';
    this.error = message;
    this.ctx.emitStatus();
    return new Error(message);
  }

  // One request. Resolves with the parsed JSON (or null when the answer has no body), rejects with a plain sentence.
  request(method, path, body) {
    const { host, port, label } = this.base();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      const problem = (msg) => done(reject, this.fail(msg));
      const headers = { Accept: 'application/json' };
      if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      const req = http.request({ host: host.replace(/^\[|\]$/g, ''), port, path: `/api/v2${path}`, method, headers }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) req.destroy(new Error('too big')); else chunks.push(c); });
        res.on('error', () => problem(`Mix It Up at ${label} dropped the connection.`));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text.trim()) { try { json = JSON.parse(text); } catch { json = null; } }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            this.state = 'connected';
            this.error = '';
            this.ctx.emitStatus();
            return done(resolve, json);
          }
          const detail = String((json && (json.detail || json.title)) || '').slice(0, 200);
          if (res.statusCode === 404) return problem(`Mix It Up could not find that${detail ? ` (${detail})` : ''}. Was the command renamed or deleted?`);
          problem(`Mix It Up said no (${res.statusCode}${detail ? `: ${detail}` : ''}).`);
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (settled) return;
        if (err && err.message === 'timeout') return problem(`Mix It Up at ${label} did not answer in time.`);
        problem(`Can't reach Mix It Up at ${label}. Is it running, with the Developer API connected (Services → Developer API → Connect)?`);
      });
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  // Every command, all pages. Mix It Up answers { TotalCount, Commands: [...] }.
  async allCommands() {
    const out = [];
    for (let skip = 0; skip < MAX_COMMANDS; skip += PAGE) {
      const json = await this.request('GET', `/commands?skip=${skip}&pageSize=${PAGE}`);
      const list = json && Array.isArray(json.Commands) ? json.Commands : (Array.isArray(json) ? json : []);
      for (const c of list) if (c && c.ID && c.Name) out.push({ id: String(c.ID), name: String(c.Name), type: String(c.Type || ''), group: String(c.GroupName || ''), enabled: c.IsEnabled !== false });
      const total = json && Number.isFinite(json.TotalCount) ? json.TotalCount : out.length;
      if (list.length < PAGE || out.length >= total) break;
    }
    return out;
  }

  // For the button's dropdown and "Save and test connection": [{ value, label, hint }]. The name is what the list shows
  // (and what a button stores); the id is only used when two commands share a name, so the list never shows raw ids.
  async commands() {
    const list = await this.allCommands();
    const count = new Map();
    for (const c of list) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) || 0) + 1);
    return list
      .map((c) => ({ value: count.get(c.name.toLowerCase()) === 1 ? c.name : c.id, label: c.name, hint: [c.type, c.group, c.enabled ? '' : 'disabled'].filter(Boolean).join(' · ') }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  async check() {
    return this.commands();
  }

  // A command's id, from an id or from its exact name (not case sensitive). Two commands with one name: ask for the id.
  async resolve(value) {
    const v = String(value || '').trim();
    if (!v) throw new Error('Pick a Mix It Up command first.');
    if (GUID.test(v)) return v;
    const list = await this.allCommands();
    const hits = list.filter((c) => c.name.toLowerCase() === v.toLowerCase());
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) throw new Error(`More than one Mix It Up command is called "${v}". Pick the right one from the list instead of typing the name.`);
    throw new Error(`Mix It Up has no command called "${v}". Pick one from the list (it fills in when Mix It Up is running).`);
  }

  // options: { platform, arguments, specialIdentifiers: {name: value}, ignoreRequirements }
  async run(command, options = {}) {
    const id = await this.resolve(command);
    const body = { IgnoreRequirements: options.ignoreRequirements !== false };
    if (options.platform) body.Platform = String(options.platform);
    if (options.arguments) body.Arguments = String(options.arguments);
    if (options.specialIdentifiers && Object.keys(options.specialIdentifiers).length) body.SpecialIdentifiers = options.specialIdentifiers;
    await this.request('POST', `/commands/${id}`, body);
  }

  // state: 'enable' | 'disable' | 'toggle'
  async setState(command, state) {
    if (!(state in STATES)) throw new Error('Unknown command state.');
    const id = await this.resolve(command);
    await this.request('PATCH', `/commands/${id}/state/${STATES[state]}`);
  }

  async chat(message, options = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('Type the chat message first.');
    const body = { Message: text.slice(0, 500), SendAsStreamer: Boolean(options.sendAsStreamer) };
    if (options.platform) body.Platform = String(options.platform);
    await this.request('POST', '/chat/message', body);
  }

  async clearChat() {
    await this.request('POST', '/chat/clear');
  }
}

module.exports = { MixItUpRuntime, GUID, STATES };
