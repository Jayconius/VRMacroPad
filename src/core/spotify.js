// Spotify Web API, used for ONE thing Windows cannot do: "Like" (save to Liked Songs) and showing whether the
// current song is liked. Everything else about Spotify (play, skip, shuffle, repeat, seek) goes through the
// Windows media session and needs no login.
//
// Sign-in is the standard "authorization code with PKCE" flow for desktop apps: you approve access on
// spotify.com and Spotify sends the browser back to a tiny web page this app serves on 127.0.0.1 for a
// minute. There is no client secret. You need a Client ID from a Spotify developer app (see the Settings
// panel for the exact steps). Endpoints follow Spotify's February 2026 API (PUT/DELETE /me/library).
// Base URLs are injectable so tests can run against a local fake.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SCOPES = ['user-read-currently-playing', 'user-library-read', 'user-library-modify'];
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const CALLBACK_PORT = 17422;
const CALLBACK_PATH = '/callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class SpotifyClient extends EventEmitter {
  constructor({
    secrets, apiBase = 'https://api.spotify.com/v1', authBase = 'https://accounts.spotify.com', fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(), callbackPort = CALLBACK_PORT, defaultClientId = require('./app-config').spotifyClientId,
  } = {}) {
    super();
    this.defaultClientId = String(defaultClientId || '').trim();
    this.usingBuiltIn = false;
    this.secrets = secrets;
    this.apiBase = apiBase;
    this.authBase = authBase;
    this.fetch = fetchImpl;
    this.now = now;
    this.callbackPort = callbackPort;
    this.clientId = '';
    this.tokens = null; // { access, refresh, expiresAt, scopes, clientId }
    this.user = null; // { id, name }
    this.status = 'off'; // off | needs-auth | authorizing | connected | error
    this.error = '';
    this.auth = null; // { state, verifier, server, timer, redirectUri }
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
      hasBuiltIn: Boolean(this.defaultClientId),
      usingBuiltIn: this.usingBuiltIn,
    };
  }

  isConnected() {
    return this.status === 'connected';
  }

  // What to register in the Spotify dashboard (Redirect URIs).
  redirectUri() {
    const port = this.auth && this.auth.port ? this.auth.port : this.callbackPort;
    return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  // A Client ID typed in Settings wins; otherwise the one shipped with the app (if any) is used.
  configure({ clientId }) {
    const own = (clientId || '').trim();
    const id = own || this.defaultClientId;
    this.usingBuiltIn = !own && Boolean(this.defaultClientId);
    if (id === this.clientId) return;
    this.clientId = id;
    this.cancelAuth();
    this.tokens = null;
    this.user = null;
    if (!id) { this.setStatus('off'); return; }
    this.loadSaved();
  }

  loadSaved() {
    let saved = null;
    try { saved = JSON.parse(this.secrets.get('spotify.tokens') || 'null'); } catch { saved = null; }
    if (saved && saved.clientId === this.clientId && saved.refresh) {
      this.tokens = saved;
      this.user = saved.user || null;
      this.setStatus('connected');
    } else {
      this.setStatus('needs-auth');
    }
  }

  saveTokens() {
    this.secrets.set('spotify.tokens', JSON.stringify({ ...this.tokens, user: this.user }));
  }

  stop() {
    this.cancelAuth();
  }

  // ---- sign-in (authorization code + PKCE, answered on a short-lived local page) ----
  async startAuth() {
    if (!this.clientId) throw new SpotifyError('Enter your Spotify Client ID first', 0);
    this.cancelAuth();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(16));
    const auth = { state, verifier, server: null, timer: null, port: 0 };
    auth.server = http.createServer((req, res) => this.onCallback(auth, req, res));
    await new Promise((resolve, reject) => {
      auth.server.once('error', (err) => reject(new SpotifyError(err.code === 'EADDRINUSE'
        ? `Port ${this.callbackPort} is busy. Close whatever is using it (another copy of this app signing in?) and try again`
        : `Could not listen for Spotify's answer: ${err.message}`, 0)));
      auth.server.listen(this.callbackPort, '127.0.0.1', resolve);
    });
    auth.port = auth.server.address().port;
    auth.timer = setTimeout(() => {
      if (this.auth === auth) { this.cancelAuth(); this.setStatus('needs-auth', 'The Spotify sign-in timed out. Press Connect again.'); }
    }, AUTH_TIMEOUT_MS);
    this.auth = auth;
    const url = new URL(`${this.authBase}/authorize`);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      state,
      scope: SCOPES.join(' '),
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
    // Only the browser coming back from Spotify to exactly this address is answered.
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${auth.port}`) { res.writeHead(404).end('Not found'); return; }
    if (this.auth !== auth || u.searchParams.get('state') !== auth.state) { this.page(res, 400, 'That did not work', 'This sign-in link is not the current one. Go back to VR Macro Pad and press Connect again.'); return; }
    const denied = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (denied || !code) {
      this.cancelAuth();
      this.setStatus('needs-auth', denied === 'access_denied' ? 'You declined access on Spotify.' : `Spotify sign-in failed: ${denied || 'no code returned'}`);
      this.page(res, 200, 'Not connected', 'You can close this tab.');
      return;
    }
    try {
      const body = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(), client_id: this.clientId, code_verifier: auth.verifier });
      this.tokens = this.tokensFrom(body);
      this.cancelAuth();
      await this.afterSignIn();
      this.page(res, 200, this.status === 'connected' ? 'Spotify connected' : 'Not connected', this.status === 'connected' ? 'You can close this tab and go back to VR Macro Pad.' : this.error);
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
    // Stop listening now; a browser that is still being answered gets a moment to finish.
    try { auth.server.close(); setTimeout(() => { try { auth.server.closeAllConnections(); } catch { /* gone */ } }, 1500).unref(); } catch { /* already closed */ }
    if (this.status === 'authorizing') this.setStatus(this.clientId ? 'needs-auth' : 'off');
  }

  tokensFrom(body, previous = null) {
    return {
      access: body.access_token,
      refresh: body.refresh_token || (previous && previous.refresh) || '', // a refresh answer may leave the old one valid
      expiresAt: this.now() + (body.expires_in || 3600) * 1000,
      scopes: String(body.scope || '').split(' ').filter(Boolean),
      clientId: this.clientId,
    };
  }

  async afterSignIn() {
    try {
      const me = (await this.api('GET', '/me')).body;
      this.user = { id: me.id, name: me.display_name || me.id };
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
    this.secrets.delete('spotify.tokens');
    this.setStatus(this.clientId ? 'needs-auth' : 'off');
  }

  // ---- tokens ----
  async tokenRequest(params) {
    const res = await this.fetch(`${this.authBase}/api/token`, { method: 'POST', headers: FORM, body: new URLSearchParams(params) });
    const body = await this.readJson(res);
    if (!res.ok || !body.access_token) {
      const why = body.error_description || (typeof body.error === 'string' ? body.error : '');
      throw new SpotifyError(`Spotify refused the sign-in${why ? `: ${why}` : ''} (${res.status})`, res.status);
    }
    return body;
  }

  async accessToken() {
    if (!this.tokens) throw new SpotifyError('Spotify is not connected. Connect it in Settings → Connections.', 401);
    if (this.tokens.expiresAt - this.now() < 60000) await this.refresh();
    return this.tokens.access;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const previous = this.tokens;
        const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refresh, client_id: this.clientId });
        this.tokens = this.tokensFrom(body, previous);
        this.saveTokens();
      } catch (err) {
        if (err.status === 400 || err.status === 401) {
          this.tokens = null;
          this.secrets.delete('spotify.tokens');
          this.setStatus('needs-auth', 'Spotify sign-in expired. Connect again in Settings.');
          throw new SpotifyError('Spotify sign-in expired. Connect again in Settings.', 401);
        }
        throw err; // offline or Spotify hiccup: keep the sign-in, try again next time
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
    const msg = body && ((body.error && body.error.message) || (typeof body.error === 'string' ? body.error : '') || body.message);
    if (status === 403) {
      return `Spotify refused (403${msg ? `: ${msg}` : ''}). A Spotify app in development mode only works when its owner has Premium and your account is listed under User Management in the developer dashboard.`;
    }
    if (status === 429) return 'Spotify is asking us to slow down. Try again in a moment.';
    return msg ? `Spotify: ${msg}` : `Spotify request failed (${status})`;
  }

  async api(method, path, { query, retried = false } = {}) {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await this.fetch(url, { method, headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.api(method, path, { query, retried: true });
    }
    const body = await this.readJson(res);
    if (!res.ok) throw new SpotifyError(this.describe(body, res.status), res.status);
    return { status: res.status, body };
  }

  // ---- what the buttons use ----
  // The song playing right now, or null when nothing is playing (or it is an ad / podcast, which cannot be liked).
  async currentTrack() {
    const r = await this.api('GET', '/me/player/currently-playing', { query: { additional_types: 'track' } });
    const item = r.status === 204 ? null : r.body && r.body.item;
    if (!item || item.type !== 'track' || !item.uri) return null;
    return { uri: item.uri, name: item.name || '', artist: (item.artists && item.artists[0] && item.artists[0].name) || '' };
  }

  // Spotify replaced the per-type endpoints with /me/library in 2026; apps that still have the old ones keep working.
  async library(method, uri) {
    const id = String(uri).split(':').pop();
    try {
      return await this.api(method, method === 'GET' ? '/me/library/contains' : '/me/library', { query: { uris: uri } });
    } catch (err) {
      if (err.status !== 404) throw err;
      return this.api(method, method === 'GET' ? '/me/tracks/contains' : '/me/tracks', { query: { ids: id } });
    }
  }

  async isSaved(uri) {
    const r = await this.library('GET', uri);
    return Array.isArray(r.body) && r.body[0] === true;
  }

  // mode: 'toggle' | 'like' | 'unlike'. Returns { liked, track }.
  async likeCurrent(mode = 'toggle') {
    const track = await this.currentTrack();
    if (!track) throw new SpotifyError('Nothing is playing in Spotify right now (or it is an ad or a podcast)', 0);
    const saved = await this.isSaved(track.uri);
    const want = mode === 'like' ? true : mode === 'unlike' ? false : !saved;
    if (want !== saved) await this.library(want ? 'PUT' : 'DELETE', track.uri);
    return { liked: want, track };
  }

  // For the button colour: is what is playing liked? { track, liked } or null when nothing is playing.
  async likedState() {
    const track = await this.currentTrack();
    return track ? { track, liked: await this.isSaved(track.uri) } : null;
  }
}

module.exports = { SpotifyClient, SpotifyError, SCOPES, CALLBACK_PORT };
