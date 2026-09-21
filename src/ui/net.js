// WebSocket link to the local core: request/response plus pushed events.
const listeners = new Map(); // message type -> [fn]
const pending = new Map(); // rid -> { resolve, reject }
let socket = null;
let nextRid = 1;
let retryMs = 500;

export const conn = { connected: false, error: '' };

function token() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem('vrmd-token', fromUrl); } catch { /* storage may be blocked */ }
    // Keep the secret out of the address bar / history once we have it.
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  try { return sessionStorage.getItem('vrmd-token') || ''; } catch { return ''; }
}

// The secret the pictures need in their address (kept out of the address bar by token() above).
export function authToken() {
  return token();
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

function emit(type, msg) {
  for (const fn of listeners.get(type) || []) fn(msg);
}

export function connect() {
  const tok = token();
  if (!tok) {
    conn.error = 'missing-token';
    emit('conn', conn);
    return;
  }
  const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(tok)}`);
  socket = ws;
  ws.addEventListener('open', () => {
    retryMs = 500;
    conn.connected = true;
    conn.error = '';
    emit('conn', conn);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'res') {
      const p = pending.get(msg.rid);
      if (!p) return;
      pending.delete(msg.rid);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'Request failed'));
      return;
    }
    emit(msg.t, msg);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    conn.connected = false;
    for (const p of pending.values()) p.reject(new Error('Connection lost'));
    pending.clear();
    emit('conn', conn);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  });
}

export function request(t, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      reject(new Error('Not connected to the app'));
      return;
    }
    const rid = nextRid++;
    pending.set(rid, { resolve, reject });
    socket.send(JSON.stringify({ t, rid, ...payload }));
  });
}
