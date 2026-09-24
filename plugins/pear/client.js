// Pear Desktop / YouTube Music (the "API Server" plugin). Gives what Windows' media session
// cannot: album, like / dislike, shuffle, repeat and volume, with live position updates.
//
// How it works (from the plugin's own source): the plugin serves a REST API and a WebSocket on
// http://<host>:26538. You approve this app once (Pear shows an Allow / Deny prompt), which returns a
// token that is sent as "Authorization: Bearer" on requests and as ?token= on the WebSocket.
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const CLIENT_ID = 'vr-macro-pad';
const REPEAT_ORDER = ['NONE', 'ALL', 'ONE']; // the order YouTube Music's repeat button cycles through
// Album art is a plain https address; only ever fetch it from Google / YouTube image hosts.
const IMAGE_HOSTS = ['.ytimg.com', '.googleusercontent.com', '.ggpht.com', '.youtube.com'];

// Pear's volume has two scales. "Set volume" takes the slider position (what you see and expect),
// but the player reports its actual loudness on an exponential curve: asking for 90 reports 74,
// 75 reports 47, 50 reports 20, 25 reports 6 (measured on a real Pear). The curve
// actual = 100 * (16^(slider/100) - 1) / 15 fits those to within rounding, so converting back lets
// "raise by 10" mean 10 slider steps instead of 10 loudness points.
const CURVE_BASE = 16;
function actualFromSlider(slider) {
  const s = Math.max(0, Math.min(100, Number(slider) || 0));
  return (100 * (CURVE_BASE ** (s / 100) - 1)) / (CURVE_BASE - 1);
}
function sliderFromActual(actual) {
  const a = Math.max(0, Math.min(100, Number(actual) || 0));
  return (100 * Math.log(1 + ((CURVE_BASE - 1) * a) / 100)) / Math.log(CURVE_BASE);
}

class PearError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class PearClient extends EventEmitter {
  constructor({ secrets, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), retryMs = 2000, likePollMs = 15000 } = {}) {
    super();
    this.secrets = secrets;
    this.fetch = fetchImpl;
    this.now = now;
    this.retryBaseMs = retryMs;
    this.likePollMs = likePollMs;
    this.host = '127.0.0.1';
    this.port = 26538;
    this.token = null;
    this.status = 'off'; // off | needs-auth | awaiting-approval | denied | not-running | connected | error
    this.error = '';
    this.wanted = false;
    this.ws = null;
    this.retryTimer = null;
    this.retryMs = retryMs;
    this.likeTimer = null;
    this.state = null; // { song, isPlaying, position, volume, muted, repeat, shuffle, at }
    this.like = null; // 'LIKE' | 'DISLIKE' | 'INDIFFERENT' | null
    this.thumbs = new Map();
    this.authRun = 0;
  }

  // ---- settings / state ----
  configure({ host, port }) {
    const h = String(host || '127.0.0.1');
    const p = Number(port) || 26538;
    const changed = h !== this.host || p !== this.port;
    this.host = h;
    this.port = p;
    if (changed) {
      this.token = null;
      if (this.wanted) this.restart();
    }
  }

  setStatus(status, error = '') {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.emit('status', status);
    this.emit('change');
  }

  info() {
    return { status: this.status, error: this.error, host: this.host, port: this.port, hasToken: Boolean(this.token) };
  }

  isConnected() {
    return this.status === 'connected';
  }

  statusMessage() {
    switch (this.status) {
      case 'not-running': return "Can't reach Pear. Is it running with the API Server plugin on?";
      case 'needs-auth': return 'Connect Pear in Settings → Connections';
      case 'awaiting-approval': return 'Click Allow in the Pear window…';
      case 'denied': return 'You clicked Deny in Pear. Connect again to allow it.';
      case 'error': return this.error || 'Pear problem';
      case 'off': return 'Pear is not set up';
      default: return '';
    }
  }

  // ---- token storage ----
  loadToken() {
    let saved = null;
    try { saved = JSON.parse(this.secrets.get('pear.token') || 'null'); } catch { saved = null; }
    this.token = saved && saved.host === this.host && saved.port === this.port ? saved.token : null;
  }

  saveToken() {
    this.secrets.set('pear.token', JSON.stringify({ token: this.token, host: this.host, port: this.port }));
  }

  clearToken() {
    this.token = null;
    this.secrets.delete('pear.token');
  }

  // ---- lifecycle ----
  // Called while a button, widget or trigger needs Pear.
  want(on) {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.start(); else this.stop();
  }

  start() {
    if (this.status === 'awaiting-approval') return;
    this.loadToken();
    if (!this.token) { this.setStatus('needs-auth'); return; }
    this.connect();
  }

  restart() {
    this.closeSocket();
    this.start();
  }

  stop() {
    this.wanted = false;
    this.authRun++;
    clearTimeout(this.retryTimer);
    clearInterval(this.likeTimer);
    this.likeTimer = null;
    this.closeSocket();
    this.state = null;
    this.like = null;
    if (this.status !== 'awaiting-approval') this.setStatus('off');
  }

  closeSocket() {
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  // ---- sign in (asks the user to click Allow inside Pear) ----
  async authorize() {
    this.authRun++;
    const run = this.authRun;
    this.closeSocket();
    this.setStatus('awaiting-approval');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      let res;
      try {
        res = await this.fetch(`http://${this.host}:${this.port}/auth/${CLIENT_ID}`, { method: 'POST', signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (run !== this.authRun) return;
      if (res.status === 403) { this.setStatus('denied'); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.accessToken) throw new PearError(`Pear answered ${res.status}`, res.status);
      this.token = body.accessToken;
      this.saveToken();
      this.setStatus('off');
      if (this.wanted) this.connect();
      else this.setStatus('needs-auth', '');
    } catch (err) {
      if (run !== this.authRun) return;
      const refused = err.name === 'AbortError' ? 'No answer from Pear in 2 minutes (was the Allow prompt hidden?)' : /ECONNREFUSED|fetch failed/i.test(`${err.message} ${err.cause ? err.cause.message : ''}`) ? '' : err.message;
      if (refused) this.setStatus('error', refused); else this.setStatus('not-running');
    }
  }

  disconnect() {
    this.authRun++;
    this.clearToken();
    this.closeSocket();
    this.state = null;
    this.like = null;
    clearInterval(this.likeTimer);
    this.likeTimer = null;
    this.setStatus(this.wanted ? 'needs-auth' : 'off');
  }

  // ---- live connection ----
  connect() {
    if (this.ws || !this.wanted || !this.token) return;
    const ws = new WebSocket(`ws://${this.host}:${this.port}/api/v1/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.on('open', () => {
      this.retryMs = this.retryBaseMs;
      this.setStatus('connected');
      clearInterval(this.likeTimer);
      this.likeTimer = setInterval(() => this.refreshLike(), this.likePollMs);
    });
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.likeTimer);
      this.likeTimer = null;
      this.state = null;
      if (code === 1008) {
        // Pear says the token is not (or no longer) authorized, so ask again rather than retrying forever.
        this.clearToken();
        this.setStatus('needs-auth', 'Pear no longer accepts this sign-in.');
        return;
      }
      if (this.status !== 'not-running') this.setStatus('not-running');
      this.scheduleRetry();
    });
    ws.on('error', () => { /* 'close' follows and handles it */ });
  }

  scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const s = this.state || (this.state = { song: null, isPlaying: false, position: 0, volume: 0, muted: false, repeat: 'NONE', shuffle: false, at: 0 });
    switch (m.type) {
      case 'PLAYER_INFO':
        Object.assign(s, { song: m.song || null, isPlaying: Boolean(m.isPlaying), position: Number(m.position) || 0, volume: Number(m.volume) || 0, muted: Boolean(m.muted), repeat: m.repeat || 'NONE', shuffle: Boolean(m.shuffle) });
        this.refreshLike();
        break;
      case 'VIDEO_CHANGED':
        s.song = m.song || null;
        s.position = Number(m.position) || 0;
        this.like = null;
        this.refreshLike();
        break;
      case 'PLAYER_STATE_CHANGED': s.isPlaying = Boolean(m.isPlaying); s.position = Number(m.position) || s.position; break;
      case 'POSITION_CHANGED': s.position = Number(m.position) || 0; break;
      case 'VOLUME_CHANGED': s.volume = Number(m.volume) || 0; s.muted = Boolean(m.muted); break;
      case 'REPEAT_CHANGED': s.repeat = m.repeat || 'NONE'; break;
      case 'SHUFFLE_CHANGED': s.shuffle = Boolean(m.shuffle); break;
      default: return;
    }
    s.at = this.now();
    this.emit('change');
  }

  // ---- what widgets show ----
  view() {
    const s = this.state;
    if (!this.isConnected() || !s || !s.song) {
      return { available: false, source: 'pear', error: this.isConnected() ? 'Nothing playing in Pear' : this.statusMessage(), pending: false, pearStatus: this.status };
    }
    const song = s.song;
    return {
      available: true, source: 'pear', appId: 'YouTube Music', title: song.title || '', artist: song.artist || '', album: song.album || '',
      playing: s.isPlaying, status: s.isPlaying ? 'Playing' : 'Paused', positionMs: Math.round(s.position * 1000), durationMs: Math.round((Number(song.songDuration) || 0) * 1000),
      canSeek: Number(song.songDuration) > 0, fetchedAt: s.at, thumbKey: song.imageSrc || '', error: '',
      // volume is the slider position (0-100); volumeActual is the loudness Pear reports.
      extras: { liked: this.like === 'LIKE', disliked: this.like === 'DISLIKE', shuffle: s.shuffle, repeat: s.repeat, volume: Math.round(sliderFromActual(s.volume)), volumeActual: s.volume, muted: s.muted },
    };
  }

  // Album art, fetched here (the page is not allowed to load pictures from other websites).
  async thumbFor(url) {
    if (!url) return '';
    if (this.thumbs.has(url)) return this.thumbs.get(url);
    let data = '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !IMAGE_HOSTS.some((h) => u.hostname.endsWith(h))) return '';
      const res = await this.fetch(url, { signal: AbortSignal.timeout(6000) });
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf.length < 2 * 1024 * 1024) data = `data:${type};base64,${buf.toString('base64')}`;
      }
    } catch { data = ''; }
    this.thumbs.set(url, data);
    for (const k of [...this.thumbs.keys()].slice(0, -6)) this.thumbs.delete(k);
    return data;
  }

  // ---- commands ----
  async request(method, path, body) {
    if (!this.token) throw new PearError('Pear is not connected. Connect it in Settings → Connections.', 401);
    let res;
    try {
      res = await this.fetch(`http://${this.host}:${this.port}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6000),
      });
    } catch (err) {
      this.setStatus('not-running');
      throw new PearError("Can't reach Pear. Is it running with the API Server plugin on?", 0);
    }
    if (res.status === 401 || res.status === 403) {
      this.clearToken();
      this.closeSocket();
      this.setStatus('needs-auth', 'Pear no longer accepts this sign-in.');
      throw new PearError('Pear no longer accepts this sign-in. Connect it again in Settings.', res.status);
    }
    if (!res.ok) throw new PearError(`Pear answered ${res.status} for ${method} ${path}`, res.status);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  async refreshLike() {
    try {
      const r = await this.request('GET', '/like-state');
      const state = r && r.state ? String(r.state).toUpperCase() : null;
      if (state !== this.like) { this.like = state; this.emit('change'); }
    } catch { /* not connected right now */ }
  }

  // cmd: toggle | play | pause | next | previous | seek (arg = milliseconds) | like | dislike | shuffle | repeat | mute
  async control(cmd, arg) {
    switch (cmd) {
      case 'toggle': await this.request('POST', '/toggle-play'); break;
      case 'play': await this.request('POST', '/play'); break;
      case 'pause': await this.request('POST', '/pause'); break;
      case 'next': await this.request('POST', '/next'); break;
      case 'previous': await this.request('POST', '/previous'); break;
      case 'seek': await this.request('POST', '/seek-to', { seconds: Math.max(0, Math.round(Number(arg) / 1000)) }); break;
      case 'like': await this.request('POST', '/like'); await this.refreshLike(); break;
      case 'dislike': await this.request('POST', '/dislike'); await this.refreshLike(); break;
      case 'shuffle': await this.request('POST', '/shuffle'); break;
      case 'repeat': await this.request('POST', '/switch-repeat', { iteration: 1 }); break;
      case 'mute': await this.request('POST', '/toggle-mute'); break;
      default: throw new PearError(`Pear can't do "${cmd}"`, 0);
    }
  }

  // Sets a specific repeat mode by pressing the repeat button the right number of times.
  async setRepeat(mode) {
    const want = REPEAT_ORDER.indexOf(mode);
    if (want < 0) throw new PearError('Unknown repeat mode', 0);
    const have = REPEAT_ORDER.indexOf((this.state && this.state.repeat) || 'NONE');
    const steps = (want - (have < 0 ? 0 : have) + REPEAT_ORDER.length) % REPEAT_ORDER.length;
    if (steps) await this.request('POST', '/switch-repeat', { iteration: steps });
  }

  // Current volume as the slider position, ready for raising or lowering by steps.
  sliderVolume() {
    return this.state ? sliderFromActual(this.state.volume) : 50;
  }

  // percent is the slider position (0-100).
  async setVolume(percent) {
    await this.request('POST', '/volume', { volume: Math.max(0, Math.min(100, Math.round(Number(percent)))) });
  }

  async seekBy(seconds) {
    const n = Math.round(Math.abs(Number(seconds)));
    if (!n) return;
    await this.request('POST', Number(seconds) < 0 ? '/go-back' : '/go-forward', { seconds: n });
  }
}

module.exports = { PearClient, PearError, REPEAT_ORDER, actualFromSlider, sliderFromActual };
