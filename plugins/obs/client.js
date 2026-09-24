// OBS WebSocket v5 client (built into OBS 28+). Keeps one connection alive while
// something needs it, reconnects with backoff, and surfaces events.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// General | Config | Scenes | Inputs | Transitions | Filters | Outputs
const EVENT_SUBSCRIPTIONS = 127;

function sha256b64(text) {
  return crypto.createHash('sha256').update(text).digest('base64');
}

// Auth string per the obs-websocket v5 spec.
function authString(password, salt, challenge) {
  const secret = sha256b64(password + salt);
  return sha256b64(secret + challenge);
}

class ObsClient extends EventEmitter {
  constructor() {
    super();
    this.settings = null;
    this.ws = null;
    this.status = 'off'; // off | connecting | connected | auth-failed | error
    this.error = '';
    this.wanted = false;
    this.pending = new Map();
    this.nextId = 1;
    this.retryTimer = null;
    this.retryMs = 1000;
  }

  configure(settings) {
    const changed = !this.settings || ['host', 'port', 'password'].some((k) => this.settings[k] !== settings[k]);
    this.settings = { ...settings };
    if (changed && this.wanted) this.reconnect();
  }

  // Called when some button or trigger needs OBS; idempotent.
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

  connect() {
    if (!this.wanted || !this.settings || this.ws) return;
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(`ws://${this.settings.host}:${this.settings.port}`, 'obswebsocket.json');
    } catch (err) {
      this.setStatus('error', err.message);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('error', (err) => {
      this.error = err.message;
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('OBS connection closed'));
      this.pending.clear();
      if (code === 4009) {
        this.setStatus('auth-failed', 'OBS rejected the password');
        return; // retrying with the same password would just fail again
      }
      if (this.wanted) {
        this.setStatus('error', this.error || 'Could not reach OBS');
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
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    for (const p of this.pending.values()) p.reject(new Error('OBS connection closed'));
    this.pending.clear();
    this.setStatus(status);
  }

  reconnect() {
    this.disconnect('off');
    this.retryMs = 1000;
    if (this.wanted) this.connect();
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { op, d } = msg;
    if (op === 0) {
      const identify = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
      if (d.authentication) {
        identify.authentication = authString(this.settings.password, d.authentication.salt, d.authentication.challenge);
      }
      this.send(1, identify);
    } else if (op === 2) {
      this.retryMs = 1000;
      this.setStatus('connected');
    } else if (op === 5) {
      this.emit('event', { type: d.eventType, data: d.eventData || {} });
    } else if (op === 7) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error((d.requestStatus && d.requestStatus.comment) || `OBS request failed (${d.requestType})`));
    }
  }

  request(type, data = {}, timeoutMs = 5000) {
    if (this.status !== 'connected') {
      return Promise.reject(new Error(this.status === 'auth-failed' ? 'OBS password is wrong' : 'OBS is not connected'));
    }
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS did not answer ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(6, { requestType: type, requestId, requestData: data });
    });
  }
}

module.exports = { ObsClient, authString };
