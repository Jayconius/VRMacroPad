// A TeamSpeak 3 ClientQuery connection. ClientQuery is a plugin that ships with, and is switched on in, the TS3
// client: a plain-text interface on 127.0.0.1:25639 that only programs on this PC can reach.
//   greeting:   "TS3 Client" / "Welcome to the TeamSpeak 3 ClientQuery interface..." (lines end with \n\r)
//   command:    auth apikey=XXXX-XXXX-...            ->   error id=0 msg=ok
//   command:    clientupdate client_input_muted=1    ->   error id=0 msg=ok
//   with data:  whoami                               ->   clid=5 cid=1 ...      (a line of data, then the error line)
//   events:     notifyclientupdated schandlerid=1 clid=5 client_input_muted=1    (any time, after clientnotifyregister)
// Values escape space as \s, | as \p, / as \/, \ as \\ and control characters as \n \t and so on. One command runs at a
// time and its answer is every line up to and including the "error id=... msg=..." line.
// One connection is kept while something needs TeamSpeak, and it reconnects by itself (like the OBS plugin).
const net = require('net');
const { EventEmitter } = require('events');

const TIMEOUT_MS = 5000;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;
const API_KEY = /^[A-Za-z0-9-]{1,80}$/;

const ESCAPES = [['\\', '\\\\'], ['/', '\\/'], [' ', '\\s'], ['|', '\\p'], ['\x07', '\\a'], ['\b', '\\b'], ['\f', '\\f'], ['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t'], ['\v', '\\v']];
const UNESCAPES = { '\\': '\\', '/': '/', s: ' ', p: '|', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

function escape(text) {
  let out = String(text);
  for (const [raw, esc] of ESCAPES) out = out.split(raw).join(esc);
  return out;
}

function unescape(text) {
  return String(text).replace(/\\(.)/g, (m, c) => (c in UNESCAPES ? UNESCAPES[c] : c));
}

// "clid=5 client_nickname=Nova\sB|clid=6 ..." -> [{ clid: '5', client_nickname: 'Nova B' }, { clid: '6', ... }]
function parseRecords(line) {
  return String(line).split('|').map((chunk) => {
    const rec = {};
    for (const part of chunk.trim().split(' ')) {
      if (!part) continue;
      const i = part.indexOf('=');
      if (i < 0) rec[part] = '';
      else rec[part.slice(0, i)] = unescape(part.slice(i + 1));
    }
    return rec;
  });
}

class Ts3Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.settings = null;
    this.socket = null;
    this.status = 'off'; // off | connecting | connected | auth-failed | error
    this.error = '';
    this.wanted = false;
    this.queue = [];
    this.current = null;
    this.buffer = '';
    this.retryTimer = null;
    this.retryMs = 1000;
  }

  configure(settings) {
    const changed = !this.settings || ['host', 'port', 'apiKey'].some((k) => this.settings[k] !== settings[k]);
    this.settings = { ...settings };
    if (changed && this.wanted) this.reconnect();
  }

  // Called when a button or trigger needs TeamSpeak; idempotent.
  want(on) {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.connect();
    else this.disconnect('off');
  }

  setStatus(status, error = '') {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.emit('status', status);
  }

  // host, port and key from Settings, checked so nothing but a host name and a plain key can get in (the key goes
  // into a command line, so a newline in it must never get through).
  target() {
    const s = this.settings || {};
    const host = String(s.host || '127.0.0.1').trim();
    const port = Math.round(Number(s.port) || 25639);
    const apiKey = String(s.apiKey || '').trim();
    if (!HOST.test(host)) throw new Error('The TeamSpeak address in Settings is not a valid host name or IP address.');
    if (!(port >= 1 && port <= 65535)) throw new Error('The TeamSpeak port in Settings must be between 1 and 65535.');
    if (apiKey && !API_KEY.test(apiKey)) throw new Error('The TeamSpeak API key in Settings has characters a key never has. Copy it again from TeamSpeak.');
    return { host: host.replace(/^\[|\]$/g, ''), port, apiKey, label: `${host}:${port}` };
  }

  connect() {
    if (!this.wanted || !this.settings || this.socket) return;
    clearTimeout(this.retryTimer);
    let t;
    try { t = this.target(); } catch (err) { this.setStatus('error', err.message); return; } // a wrong setting does not fix itself: no retry
    this.setStatus('connecting');
    this.buffer = '';
    const socket = net.connect({ host: t.host, port: t.port });
    socket.setEncoding('utf8');
    this.socket = socket;
    socket.on('connect', () => { this.handshake(socket, t); });
    socket.on('data', (chunk) => this.onData(socket, chunk));
    socket.on('error', (err) => { this.lastError = err.code === 'ECONNREFUSED' ? '' : err.message; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(new Error('The TeamSpeak connection closed.'));
      if (this.status === 'auth-failed') return; // the same key would just fail again
      if (this.wanted) {
        this.setStatus('error', `Can't reach TeamSpeak at ${t.label}. Is TeamSpeak 3 running, with the ClientQuery plugin switched on (Tools → Options → Addons)?`);
        this.scheduleRetry();
      } else {
        this.setStatus('off');
      }
    });
  }

  async handshake(socket, t) {
    try {
      if (t.apiKey) await this.request(`auth apikey=${t.apiKey}`);
      await this.request('clientnotifyregister schandlerid=0 event=any');
      if (this.socket !== socket) return;
      this.retryMs = 1000;
      this.setStatus('connected');
    } catch (err) {
      if (this.socket !== socket) return;
      const authProblem = /api ?key|auth|permission/i.test(err.message) || err.id === 2568;
      if (authProblem) {
        this.status = 'auth-failed'; // set before closing, so the close handler does not retry
        this.error = t.apiKey ? 'TeamSpeak did not accept the API key. Copy it again from Tools → Options → Addons → ClientQuery → Settings.' : 'TeamSpeak wants an API key. Copy it from Tools → Options → Addons → ClientQuery → Settings into this plugin\'s settings.';
        this.emit('status', 'auth-failed');
      } else {
        this.error = err.message;
      }
      try { socket.destroy(); } catch { /* already gone */ }
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  disconnect(status = 'off') {
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.destroy(); } catch { /* ignore */ } }
    this.failPending(new Error('The TeamSpeak connection closed.'));
    this.setStatus(status);
  }

  reconnect() {
    this.disconnect('off');
    this.retryMs = 1000;
    if (this.wanted) this.connect();
  }

  failPending(err) {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  // One command. Resolves with the records of its data lines (an array, often empty); rejects with the plain reason.
  request(command) {
    return new Promise((resolve, reject) => {
      if (/[\r\n]/.test(command)) { reject(new Error('A TeamSpeak command cannot contain a line break.')); return; }
      if (!this.socket) { reject(new Error('Not connected to TeamSpeak.')); return; }
      this.queue.push({ command, resolve, reject, lines: [] });
      this.pump();
    });
  }

  pump() {
    if (this.current || !this.queue.length || !this.socket) return;
    this.current = this.queue.shift();
    const cur = this.current;
    cur.timer = setTimeout(() => {
      if (this.current !== cur) return;
      this.current = null;
      cur.reject(new Error('TeamSpeak did not answer in time.'));
      this.reconnect(); // the connection is out of step now: start again
    }, this.timeoutMs);
    this.socket.write(`${cur.command}\n`);
  }

  onData(socket, chunk) {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.search(/\r?\n\r?|\r/)) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i).replace(/^(\r?\n\r?|\r)/, '');
      if (line.trim()) this.onLine(line.trim());
    }
  }

  onLine(line) {
    if (line.startsWith('notify')) {
      const space = line.indexOf(' ');
      const name = space < 0 ? line : line.slice(0, space);
      this.emit('notify', name, space < 0 ? {} : parseRecords(line.slice(space + 1))[0]);
      return;
    }
    if (/^TS3 Client$/.test(line) || /^Welcome to the TeamSpeak/.test(line) || /^selected /.test(line)) return; // the greeting
    const cur = this.current;
    if (!cur) return;
    if (line.startsWith('error ')) {
      const rec = parseRecords(line.slice(6))[0];
      clearTimeout(cur.timer);
      this.current = null;
      const id = Number(rec.id);
      if (id === 0) cur.resolve(cur.lines.flatMap((l) => parseRecords(l)));
      else { const err = new Error(`TeamSpeak said no (${rec.msg || `error ${rec.id}`}).`); err.id = id; cur.reject(err); }
      this.pump();
      return;
    }
    cur.lines.push(line);
  }
}

module.exports = { Ts3Client, escape, unescape, parseRecords, API_KEY };
