// Kick's OFFICIAL public API (docs.kick.com).
//
// Sign-in is Kick's OAuth 2.1 "authorization code with PKCE" flow: you approve access on kick.com and Kick sends the
// browser back to a tiny page this app serves on this PC for a few minutes. Kick also requires the app's Client Secret
// for the last step (swapping the code for a token). There are three ways to supply it:
//   1. broker: the app only knows the address of a small helper (broker/worker.mjs, a free Cloudflare Worker) that holds
//      the secret and does that step. Nothing secret is inside the app. This is what a shipped build should use.
//   2. bundled: the author's Client ID + Secret in kick-app.json next to this file (simple, but the secret ships).
//   3. own: the user makes their own Kick app and types its Client ID and Secret into the plugin's Settings.
// Typed values win over the built-in ones. Base URLs are injectable so tests can run against a local fake.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Only what the buttons use: your profile and channel, changing the title/category, chat, ad breaks and timeouts.
const SCOPES = ['user:read', 'channel:read', 'channel:write', 'chat:write', 'moderation:ban', 'ads:read', 'ads:write'];
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'Content-Type': 'application/json', Accept: 'application/json' };
const CALLBACK_PORT = 17423;
const CALLBACK_PATH = '/callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

class KickError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The Kick app this plugin signs people in with, if its author put a kick-app.json next to this file:
//   { "brokerUrl": "https://your-worker.workers.dev" }                      (recommended: no secret in the app)
//   { "clientId": "...", "clientSecret": "..." }                              (the secret ships inside the app)
// With either, users just press Connect; without one, each user makes their own Kick app and types its Client ID and Secret
// into the plugin's Settings. A secret inside something you hand out can be dug out by a determined person, which is why
// the broker is better: it cannot open anyone's Kick account either way (each person approves access themselves), but
// with a broker there is nothing to dig out.
function bundledApp() {
  try {
    const j = require('./kick-app.json');
    const broker = String(j.brokerUrl || '').trim().replace(/\/+$/, '');
    return {
      brokerUrl: /^https:\/\/[^\s/]+/.test(broker) ? broker : '',
      clientId: String(j.clientId || '').trim(),
      clientSecret: String(j.clientSecret || '').trim(),
    };
  } catch { return { brokerUrl: '', clientId: '', clientSecret: '' }; }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unwrap = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

class KickClient extends EventEmitter {
  constructor({
    secrets, apiBase = 'https://api.kick.com', authBase = 'https://id.kick.com', fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(), callbackPort = CALLBACK_PORT,
    defaultClientId = bundledApp().clientId, defaultClientSecret = bundledApp().clientSecret, defaultBrokerUrl = bundledApp().brokerUrl,
  } = {}) {
    super();
    this.defaultBrokerUrl = String(defaultBrokerUrl || '').trim().replace(/\/+$/, '');
    this.brokerUrl = ''; // set while in broker mode
    this.mode = 'none'; // none | own | broker | bundled
    this.defaultClientId = String(defaultClientId || '').trim();
    this.defaultClientSecret = String(defaultClientSecret || '').trim();
    this.usingBuiltIn = false;
    this.secrets = secrets;
    this.apiBase = apiBase;
    this.authBase = authBase;
    this.fetch = fetchImpl;
    this.now = now;
    this.callbackPort = callbackPort;
    this.clientId = '';
    this.clientSecret = '';
    this.redirectHost = 'localhost'; // Kick's docs say to register localhost (127.0.0.1 needs a special workaround)
    this.tokens = null; // { access, refresh, expiresAt, scopes, clientId }
    this.user = null; // { id, name }
    this.status = 'off'; // off | needs-auth | authorizing | connected | error
    this.error = '';
    this.auth = null; // { state, verifier, server, timer, port }
    this.refreshing = null;
  }

  // ---- state ----
  setStatus(status, error = '') {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.emit('status', status);
  }

  info() {
    return {
      status: this.status,
      error: this.error,
      user: this.user,
      redirectUri: this.redirectUri(),
      encrypted: this.secrets ? this.secrets.isEncrypted() : false,
      hasBuiltIn: Boolean(this.defaultBrokerUrl || (this.defaultClientId && this.defaultClientSecret)),
      usingBuiltIn: this.usingBuiltIn,
    };
  }

  isConnected() {
    return this.status === 'connected';
  }

  // What to register as the Redirect URL in your Kick app.
  redirectUri() {
    const port = this.auth && this.auth.port ? this.auth.port : this.callbackPort;
    return `http://${this.redirectHost}:${port}${CALLBACK_PATH}`;
  }

  // Your own Client ID and Secret (typed in Settings) win. With none typed, the app's built-in sign-in is used: the broker
  // if there is one, otherwise the bundled Client ID and Secret.
  configure({ clientId, clientSecret }) {
    const ownId = String(clientId || '').trim();
    const ownSecret = String(clientSecret || '').trim();
    let mode = 'none', id = '', secret = '', broker = '';
    if (ownId || ownSecret) { mode = 'own'; id = ownId; secret = ownSecret; }
    else if (this.defaultBrokerUrl) { mode = 'broker'; broker = this.defaultBrokerUrl; }
    else if (this.defaultClientId && this.defaultClientSecret) { mode = 'bundled'; id = this.defaultClientId; secret = this.defaultClientSecret; }
    this.usingBuiltIn = mode === 'broker' || mode === 'bundled';
    if (mode === this.mode && id === this.clientId && secret === this.clientSecret && broker === this.brokerUrl) return;
    const before = this.identity();
    this.mode = mode; this.clientId = id; this.clientSecret = secret; this.brokerUrl = broker;
    this.cancelAuth();
    if (this.identity() !== before) { this.tokens = null; this.user = null; }
    if (!this.ready()) { this.setStatus('off'); return; }
    if (!this.tokens) this.loadSaved();
  }

  // Who the saved tokens belong to (a different app or broker means they must not be reused).
  identity() {
    return `${this.mode}|${this.mode === 'broker' ? this.brokerUrl : this.clientId}`;
  }

  // Is there a way to sign in at all (a broker, or a full Client ID + Secret)?
  ready() {
    return this.mode === 'broker' || Boolean(this.clientId && this.clientSecret);
  }

  loadSaved() {
    let saved = null;
    try { saved = JSON.parse(this.secrets.get('tokens') || 'null'); } catch { saved = null; }
    if (saved && saved.clientId === this.identity() && saved.refresh) {
      this.tokens = saved;
      this.user = saved.user || null;
      this.setStatus('connected');
    } else {
      this.setStatus('needs-auth');
    }
  }

  saveTokens() {
    this.secrets.set('tokens', JSON.stringify({ ...this.tokens, user: this.user }));
  }

  stop() {
    this.cancelAuth();
  }

  // ---- sign-in (authorization code + PKCE, answered on a short-lived local page) ----
  async startAuth() {
    if (!this.ready()) {
      throw new KickError(this.mode === 'own' ? 'Enter your Kick Client ID and Client Secret first' : 'Kick sign-in is not set up in this build. Enter your own Kick Client ID and Client Secret in Settings → Plugins → Kick.', 0);
    }
    const clientId = this.mode === 'broker' ? (await this.brokerConfig()).clientId : this.clientId;
    this.cancelAuth();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(16));
    const auth = { state, verifier, server: null, server6: null, timer: null, port: 0 };
    auth.server = http.createServer((req, res) => this.onCallback(auth, req, res));
    await new Promise((resolve, reject) => {
      auth.server.once('error', (err) => reject(new KickError(err.code === 'EADDRINUSE'
        ? `Port ${this.callbackPort} is busy. Close whatever is using it (another copy of this app signing in?) and try again`
        : `Could not listen for Kick's answer: ${err.message}`, 0)));
      auth.server.listen(this.callbackPort, '127.0.0.1', resolve);
    });
    auth.port = auth.server.address().port;
    auth.server6 = http.createServer((req, res) => this.onCallback(auth, req, res));
    auth.server6.on('error', () => { auth.server6 = null; }); // no IPv6 here: the IPv4 listener is enough
    auth.server6.listen(auth.port, '::1');
    auth.timer = setTimeout(() => {
      if (this.auth === auth) { this.cancelAuth(); this.setStatus('needs-auth', 'The Kick sign-in timed out. Press Connect again.'); }
    }, AUTH_TIMEOUT_MS);
    if (auth.timer.unref) auth.timer.unref();
    this.auth = auth;
    const url = new URL(`${this.authBase}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      state,
      scope: SCOPES.join(' '),
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    this.setStatus('authorizing');
    this.emit('status', 'authorizing');
    return { url: url.toString(), redirectUri: this.redirectUri() };
  }

  page(res, code, title, text) {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>VR Macro Pad</title><body style="font-family:system-ui;background:#12151d;color:#eef;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`);
  }

  async onCallback(auth, req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    // Only the browser coming back from Kick to exactly this address is answered.
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH || req.headers.host !== `${this.redirectHost}:${auth.port}`) { res.writeHead(404).end('Not found'); return; }
    if (this.auth !== auth || u.searchParams.get('state') !== auth.state) { this.page(res, 400, 'That did not work', 'This sign-in link is not the current one. Go back to VR Macro Pad and press Connect again.'); return; }
    const denied = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (denied || !code) {
      this.cancelAuth();
      this.setStatus('needs-auth', denied === 'access_denied' ? 'You declined access on Kick.' : `Kick sign-in failed: ${denied || 'no code returned'}`);
      this.page(res, 200, 'Not connected', 'You can close this tab.');
      return;
    }
    try {
      const body = await this.exchange('code', { code, redirect_uri: this.redirectUri(), code_verifier: auth.verifier });
      this.tokens = this.tokensFrom(body);
      this.cancelAuth();
      await this.afterSignIn();
      this.page(res, 200, this.status === 'connected' ? 'Kick connected' : 'Not connected', this.status === 'connected' ? 'You can close this tab and go back to VR Macro Pad.' : this.error);
    } catch (err) {
      this.cancelAuth();
      this.setStatus('needs-auth', err.message);
      this.page(res, 200, 'Not connected', 'You can close this tab.');
    }
  }

  cancelAuth() {
    const auth = this.auth;
    if (!auth) return;
    this.auth = null;
    clearTimeout(auth.timer);
    for (const server of [auth.server, auth.server6]) {
      if (!server) continue;
      try { server.close(); setTimeout(() => { try { server.closeAllConnections(); } catch { /* gone */ } }, 1500).unref(); } catch { /* already closed */ }
    }
    if (this.status === 'authorizing') this.setStatus(this.ready() ? 'needs-auth' : 'off');
  }

  tokensFrom(body, previous = null) {
    return {
      access: body.access_token,
      refresh: body.refresh_token || (previous && previous.refresh) || '',
      expiresAt: this.now() + (body.expires_in || 3600) * 1000,
      scopes: String(body.scope || '').split(/[ ,]+/).filter(Boolean),
      clientId: this.identity(),
    };
  }

  async afterSignIn() {
    try {
      const me = await this.me();
      this.user = { id: me.id, name: me.name };
      this.saveTokens();
      this.setStatus('connected');
    } catch (err) {
      this.tokens = null;
      this.user = null;
      this.setStatus('error', err.message);
    }
  }

  async disconnect() {
    this.cancelAuth();
    this.tokens = null;
    this.user = null;
    try { this.secrets.delete('tokens'); } catch { /* nothing stored */ }
    this.setStatus(this.ready() ? 'needs-auth' : 'off');
  }

  // ---- tokens ----
  // Which Client ID the broker signs people in with (it is public: the browser sees it in the sign-in address).
  async brokerConfig() {
    let res;
    try { res = await this.fetch(`${this.brokerUrl}/config`, { headers: { Accept: 'application/json' } }); } catch (err) {
      throw new KickError(`Could not reach the Kick sign-in service (${err.message}). Try again in a moment.`, 0);
    }
    const body = await this.readJson(res);
    if (!res.ok || !body.clientId) throw new KickError(`The Kick sign-in service did not answer properly (${res.status}).`, res.status);
    return body;
  }

  // kind: 'code' (swap the sign-in code for tokens) or 'refresh'. Through the broker when there is one; otherwise straight
  // to Kick with the Client Secret.
  async exchange(kind, params) {
    const broker = this.mode === 'broker';
    let res;
    try {
      if (broker) {
        res = await this.fetch(`${this.brokerUrl}/${kind === 'refresh' ? 'refresh' : 'token'}`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(params) });
      } else {
        const form = { grant_type: kind === 'refresh' ? 'refresh_token' : 'authorization_code', client_id: this.clientId, client_secret: this.clientSecret, ...params };
        res = await this.fetch(`${this.authBase}/oauth/token`, { method: 'POST', headers: FORM, body: new URLSearchParams(form) });
      }
    } catch (err) {
      throw new KickError(broker ? `Could not reach the Kick sign-in service (${err.message}). Try again in a moment.` : `Could not reach Kick (${err.message}).`, 0);
    }
    const body = await this.readJson(res);
    if (!res.ok || !body.access_token) {
      const why = body.error_description || (typeof body.error === 'string' ? body.error : '') || body.message || '';
      throw new KickError(`Kick refused the sign-in${why ? `: ${why}` : ''} (${res.status}).${broker ? '' : ' Check the Client ID, Client Secret and Redirect URL of your Kick app.'}`, res.status);
    }
    return body;
  }

  async accessToken() {
    if (!this.tokens) throw new KickError('Kick is not connected. Connect it in Settings → Plugins → Kick.', 401);
    if (this.tokens.expiresAt - this.now() < 60000) await this.refresh();
    return this.tokens.access;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const previous = this.tokens;
        const body = await this.exchange('refresh', { refresh_token: previous.refresh });
        this.tokens = this.tokensFrom(body, previous);
        this.saveTokens();
      } catch (err) {
        if (err.status === 400 || err.status === 401) {
          this.tokens = null;
          try { this.secrets.delete('tokens'); } catch { /* nothing stored */ }
          this.setStatus('needs-auth', 'Kick sign-in expired. Connect again in Settings.');
          throw new KickError('Kick sign-in expired. Connect again in Settings.', 401);
        }
        throw err; // offline or a Kick hiccup: keep the sign-in, try again next time
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ---- HTTP ----
  async readJson(res) {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { message: text.slice(0, 200) }; }
  }

  describe(body, status) {
    const msg = body && (typeof body.message === 'string' ? body.message : (typeof body.error === 'string' ? body.error : ''));
    if (status === 403) return `Kick refused (403${msg ? `: ${msg}` : ''}). Your Kick app may be missing a permission: tick the scopes listed in Settings → Plugins → Kick, then Disconnect and Connect again.`;
    if (status === 404) return `Kick could not find that (404${msg ? `: ${msg}` : ''}).`;
    if (status === 429) return 'Kick is asking us to slow down. Try again in a moment.';
    if (status === 400 || status === 422) return `Kick rejected that${msg ? `: ${msg}` : ` (${status})`}.`;
    return msg ? `Kick: ${msg}` : `Kick request failed (${status})`;
  }

  async api(method, path, { query, body, retried = false } = {}) {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, Accept: 'application/json' };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await this.fetch(url, init);
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.api(method, path, { query, body, retried: true });
    }
    const json = await this.readJson(res);
    if (!res.ok) throw new KickError(this.describe(json, res.status), res.status);
    return { status: res.status, body: json, data: unwrap(json) };
  }

  // ---- what the buttons use ----
  async me() {
    const list = (await this.api('GET', '/public/v1/users')).data;
    const u = Array.isArray(list) ? list[0] : list;
    if (!u || u.user_id === undefined) throw new KickError('Kick did not say who you are', 0);
    return { id: Number(u.user_id), name: u.name || String(u.user_id) };
  }

  normalizeChannel(c) {
    if (!c) return null;
    const s = c.stream || {};
    return {
      id: Number(c.broadcaster_user_id),
      slug: c.slug || '',
      title: c.stream_title || '',
      category: c.category ? { id: Number(c.category.id), name: c.category.name || '' } : null,
      live: Boolean(s.is_live),
      viewers: Number(s.viewer_count) || 0,
      startedAt: s.start_time ? Date.parse(s.start_time) || 0 : 0,
    };
  }

  async channel() {
    if (!this.user) throw new KickError('Kick is not connected. Connect it in Settings → Plugins → Kick.', 401);
    const list = (await this.api('GET', '/public/v1/channels', { query: { broadcaster_user_id: this.user.id } })).data;
    return this.normalizeChannel(Array.isArray(list) ? list[0] : list);
  }

  async channelBySlug(slug) {
    const name = String(slug || '').trim().replace(/^@/, '').toLowerCase();
    if (!name) throw new KickError('Type a Kick channel name first', 0);
    const list = (await this.api('GET', '/public/v1/channels', { query: { slug: name } })).data;
    const c = this.normalizeChannel(Array.isArray(list) ? list[0] : list);
    if (!c || !c.id) throw new KickError(`Kick has no channel called "${name}"`, 404);
    return c;
  }

  // as: 'user' (sent as you) or 'bot' (sent by your Kick app)
  async sendChat(text, { as = 'user' } = {}) {
    const content = String(text || '').trim();
    if (!content) throw new KickError('Type a message first', 0);
    if ([...content].length > 500) throw new KickError('Kick chat messages can be at most 500 characters', 0);
    const body = as === 'bot' ? { content, type: 'bot' } : { content, type: 'user', broadcaster_user_id: this.user.id };
    const r = await this.api('POST', '/public/v1/chat', { body });
    if (r.data && r.data.is_sent === false) throw new KickError('Kick did not send that message', 0);
    return r.data;
  }

  async findCategory(name) {
    const q = String(name || '').trim();
    if (!q) throw new KickError('Type a category name first', 0);
    const r = await this.api('GET', '/public/v1/categories', { query: { q } });
    const list = Array.isArray(r.data) ? r.data : [];
    const exact = list.find((c) => String(c.name).toLowerCase() === q.toLowerCase());
    const hit = exact || list[0];
    if (!hit) throw new KickError(`Kick has no category called "${q}"`, 404);
    return { id: Number(hit.id), name: hit.name };
  }

  // { title, categoryId, tags }: only what is given is changed.
  async updateChannel({ title, categoryId, tags } = {}) {
    const body = {};
    if (title) body.stream_title = String(title).trim();
    if (categoryId) body.category_id = Number(categoryId);
    if (Array.isArray(tags) && tags.length) body.custom_tags = tags.slice(0, 10).map(String);
    if (!Object.keys(body).length) throw new KickError('Give a title, a category or tags to change', 0);
    await this.api('PATCH', '/public/v1/channels', { body });
  }

  async adBreak(seconds) {
    const n = Math.round(Number(seconds));
    if (!(n >= 7 && n <= 300)) throw new KickError('An ad break is 7 to 300 seconds', 0);
    const r = await this.api('POST', '/public/v1/ads/ad-break', { body: { break_duration_seconds: n, id: crypto.randomUUID() } });
    return r.data || {};
  }

  async adStatus() {
    const r = await this.api('GET', '/public/v1/ads/ad-break-status');
    const d = r.data || {};
    return { remaining: Number(d.remaining_ad_breaks) || 0, blocked: Boolean(d.ads_blocked), optedIn: d.opted_in !== false, auto: Boolean(d.auto_ads_active), limits: d.limits || null };
  }

  // A timeout of 1-10080 minutes (omit minutes and Kick would make it a permanent ban, which no button does)
  async ban(slug, { minutes, reason } = {}) {
    const target = await this.channelBySlug(slug);
    const body = { broadcaster_user_id: this.user.id, user_id: target.id };
    if (reason) body.reason = String(reason).slice(0, 100);
    if (minutes !== undefined) {
      const m = Math.round(Number(minutes));
      if (!(m >= 1 && m <= 10080)) throw new KickError('A timeout is 1 to 10080 minutes', 0);
      body.duration = m;
    }
    await this.api('POST', '/public/v1/moderation/bans', { body });
    return target;
  }
}

module.exports = { KickClient, KickError, SCOPES, CALLBACK_PORT, CALLBACK_PATH };
