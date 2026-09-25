// A Voicemod Control API connection: a WebSocket on this PC (ws://localhost:59129/v1/) that Voicemod's desktop app
// serves. Every message is JSON. What is used here (Voicemod's own reference: https://control-api.voicemod.net/):
//   greeting:   { appVersion, msg: 'Pending authentication' }
//   we send:    { id, action: 'registerClient', payload: { clientKey } }     -> payload.status.code 200 (401 = wrong key)
//   we send:    { id, action, payload }      answers look like  { actionType, actionObject, actionID, id, appVersion }
//   events:     the same shape, arriving by themselves when something changes in Voicemod (toggleMuteMic, voiceChangedEvent...)
// One connection is kept while something needs Voicemod, and it reconnects by itself (like the OBS plugin).
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const TIMEOUT_MS = 5000;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;

class VoicemodClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.settings = null;
    this.ws = null;
    this.status = 'off'; // off | connecting | connected | auth-failed | error
    this.error = '';
    this.wanted = false;
    this.pending = new Map(); // request id -> { resolve, reject, action, timer }
    this.retryTimer = null;
    this.retryMs = 1000;
  }

  configure(settings) {
    const changed = !this.settings || ['host', 'port', 'clientKey'].some((k) => this.settings[k] !== settings[k]);
    this.settings = { ...settings };
    if (changed && this.wanted) this.reconnect();
  }

  // Called when a button or trigger needs Voicemod; idempotent.
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

  // host, port and key from Settings, checked so only a host name or address can get in.
  target() {
    const s = this.settings || {};
    const host = String(s.host || 'localhost').trim();
    const port = Math.round(Number(s.port) || 59129);
    const clientKey = String(s.clientKey || '').trim();
    if (!HOST.test(host)) throw new Error('The Voicemod address in Settings is not a valid host name or IP address.');
    if (!(port >= 1 && port <= 65535)) throw new Error('The Voicemod port in Settings must be between 1 and 65535.');
    return { host, port, clientKey, label: `${host}:${port}` };
  }

  connect() {
    if (!this.wanted || !this.settings || this.ws) return;
    clearTimeout(this.retryTimer);
    let t;
    try { t = this.target(); } catch (err) { this.setStatus('error', err.message); return; } // a wrong setting does not fix itself: no retry
    if (!t.clientKey) { this.setStatus('auth-failed', 'Voicemod needs a client key. Press Instructions to see how to get one, then paste it in this plugin\'s Settings.'); return; }
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(`ws://${t.host}:${t.port}/v1/`, { handshakeTimeout: this.timeoutMs }); } catch (err) { this.setStatus('error', err.message); this.scheduleRetry(); return; }
    this.ws = ws;
    ws.on('open', () => this.rawSend({ id: crypto.randomUUID(), action: 'registerClient', payload: { clientKey: t.clientKey } }));
    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('error', () => { /* the close event says what to do */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new Error('The Voicemod connection closed.'));
      if (this.status === 'auth-failed') return; // the same key would just fail again
      if (this.wanted) {
        this.setStatus('error', `Can't reach Voicemod at ${t.label}. Is Voicemod running?`);
        this.scheduleRetry();
      } else {
        this.setStatus('off');
      }
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  disconnect(status = 'off') {
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.terminate(); } catch { /* already gone */ } }
    this.failPending(new Error('The Voicemod connection closed.'));
    this.setStatus(status);
  }

  reconnect() {
    this.disconnect('off');
    this.retryMs = 1000;
    if (this.wanted) this.connect();
  }

  failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  rawSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // One action. Resolves with Voicemod's actionObject (or {}), rejects with a plain reason.
  request(action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (this.status !== 'connected' || !this.ws) { reject(new Error('Not connected to Voicemod.')); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Voicemod did not answer "${action}" in time.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, action, timer });
      this.rawSend({ id, action, payload });
    });
  }

  onMessage(ws, raw) {
    if (this.ws !== ws) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const type = m.actionType || m.action;
    if (!type) return; // the "Pending authentication" greeting
    if (type === 'registerClient') {
      const status = (m.payload && m.payload.status) || (m.actionObject && m.actionObject.status) || {};
      if (Number(status.code) === 200) { this.retryMs = 1000; this.setStatus('connected'); }
      else {
        this.status = 'auth-failed'; // before closing, so the close handler does not retry
        this.error = 'Voicemod did not accept the client key. Check it in this plugin\'s Settings.';
        this.emit('status', 'auth-failed');
        try { ws.close(); } catch { /* ignore */ }
      }
      return;
    }
    // An answer to one of ours (matched by id, else the oldest waiting request of the same kind) goes to whoever asked.
    // Anything else arrived by itself (you changed something in Voicemod): that is an event.
    const mid = m.id || m.actionID || m.actionId;
    let key = mid && this.pending.has(mid) ? mid : null;
    if (!key) for (const [k, p] of this.pending) if (p.action === type) { key = k; break; }
    if (key) {
      const p = this.pending.get(key);
      this.pending.delete(key);
      clearTimeout(p.timer);
      p.resolve(m.actionObject || {});
      return;
    }
    this.emit('event', type, m.actionObject || {});
  }
}

module.exports = { VoicemodClient };
