// Talks to Streamer.bot's WebSocket server (Servers/Clients -> WebSocket Server, default ws://127.0.0.1:8080/):
//   { request: 'GetActions' }                              -> { status: 'ok', actions: [{ id, name }] }   (fills the button's action list)
//   { request: 'DoAction', action: { id | name }, args }   -> { status: 'ok' }                            (runs one)
// If you set a password on that server, it sends a salt and challenge first and we answer with
//   secret = base64(sha256(password + salt)), authentication = base64(sha256(secret + challenge)).
// Nothing is polled and no connection is kept: one short connection is opened when a button is pressed or you test.
const crypto = require('crypto');
const WebSocket = require('ws');

const TIMEOUT_MS = 5000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;
const sha256b64 = (text) => crypto.createHash('sha256').update(text).digest('base64');

class StreamerbotRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.state = 'off'; // off | connected | error
    this.error = '';
  }

  status() {
    return { state: this.state, error: this.error };
  }

  // ws://host:port/ from Settings, with the host checked so nothing but a host name or address can get in.
  base() {
    const s = this.ctx.settings();
    const host = String(s.host || '127.0.0.1').trim();
    const port = Math.round(Number(s.port) || 8080);
    if (!HOST.test(host)) throw new Error('The Streamer.bot address in Settings is not a valid host name or IP address.');
    if (!(port >= 1 && port <= 65535)) throw new Error('The Streamer.bot port in Settings must be between 1 and 65535.');
    const secrets = typeof this.ctx.secrets === 'function' ? this.ctx.secrets() : this.ctx.secrets;
    const password = String((secrets && secrets.password) || s.password || '');
    return { url: `ws://${host}:${port}/`, label: `${host}:${port}`, password };
  }

  fail(message) {
    this.state = 'error';
    this.error = message;
    this.ctx.emitStatus();
    return new Error(message);
  }

  // Opens one connection, signs in if asked to, sends one request, returns Streamer.bot's answer, closes.
  request(body) {
    const { url, label, password } = this.base();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws && ws.terminate(); } catch { /* already gone */ }
        fn(value);
      };
      const problem = (msg) => done(reject, this.fail(msg));
      const timer = setTimeout(() => problem(`Streamer.bot at ${label} did not answer in time.`), this.timeoutMs);
      const send = (obj) => ws.send(JSON.stringify(obj));
      const sendRequest = () => send({ ...body, id: 'vrmp' });
      try { ws = new WebSocket(url, { handshakeTimeout: this.timeoutMs }); } catch { return problem(`Can't reach Streamer.bot at ${label}.`); }
      ws.on('error', () => problem(`Can't reach Streamer.bot at ${label}. Is it running, with its WebSocket Server started (Servers/Clients → WebSocket Server)?`));
      ws.on('close', () => problem(`Streamer.bot at ${label} closed the connection.`));
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.request === 'Hello' || (m.authentication !== undefined && m.info)) {
          const a = m.authentication;
          if (a && a.salt) {
            // No password saved: just try. Streamer.bot only refuses if it enforces its password (handled below).
            if (!password) return sendRequest();
            const secret = sha256b64(password + a.salt);
            return send({ request: 'Authenticate', authentication: sha256b64(secret + a.challenge), id: 'auth' });
          }
          return sendRequest();
        }
        if (m.id === 'auth') {
          if (m.status === 'ok') return sendRequest();
          return problem('Streamer.bot did not accept the password. Check it in this plugin\'s Settings.');
        }
        if (m.id === 'vrmp') {
          if (m.status === 'ok' || m.status === undefined) {
            this.state = 'connected';
            this.error = '';
            this.ctx.emitStatus();
            return done(resolve, m);
          }
          if (!password && /auth/i.test(String(m.error || ''))) return problem('Streamer.bot wants its WebSocket Server password. Type it in this plugin\'s Settings.');
          const detail = String(m.error || '').slice(0, 160);
          return problem(`Streamer.bot said no${detail ? ` (${detail})` : ''}. ${body.request === 'DoAction' ? 'Is the action name exactly right, and is the action enabled?' : ''}`.trim());
        }
      });
    });
  }

  // For the button's dropdown and "Save and test connection": [{ value, label }], value = the action's id.
  async actions() {
    const json = await this.request({ request: 'GetActions' });
    const list = json && Array.isArray(json.actions) ? json.actions : [];
    const named = list.filter((a) => a && (a.id || a.name));
    const count = new Map();
    for (const a of named) count.set(a.name, (count.get(a.name) || 0) + 1);
    // The name is what the list shows (and what a button stores); the id is only used when two actions share a name.
    return named
      .map((a) => {
        const group = String(a.group || '').trim();
        // hint: what the drop-down shows on the right of the name (the action's group in Streamer.bot)
        const base = a.name && count.get(a.name) === 1 ? { value: String(a.name), label: String(a.name) } : { value: String(a.id || a.name), label: String(a.name || a.id) };
        return { ...base, hint: group };
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  async check() {
    return this.actions();
  }

  // action: an action's GUID or its exact name. args: an object of name -> value.
  async run(action, args = {}) {
    const value = String(action || '').trim();
    if (!value) throw new Error('Pick a Streamer.bot action first.');
    const body = { request: 'DoAction', action: GUID.test(value) ? { id: value } : { name: value } };
    if (args && Object.keys(args).length) body.args = args;
    await this.request(body);
  }
}

module.exports = { StreamerbotRuntime, GUID, sha256b64 };
