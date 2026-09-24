// YouTube's OFFICIAL Data API v3 (developers.google.com/youtube/v3).
//
// Sign-in is Google's standard "installed app" flow: OAuth 2.0 authorization code with PKCE. You approve access on
// accounts.google.com and Google sends the browser back to a tiny page this app serves on this PC for a few minutes.
// Google also wants the app's Client Secret for the last step (swapping the code for a token). There are two ways to
// supply it:
//   1. own (the default): the user makes their own Google Cloud OAuth client (type "Desktop app") and types its Client ID
//      and Client Secret into the plugin's Settings. The Settings card has an "Instructions" button that walks through it.
//   2. broker (private): the author runs a small helper (broker/worker.mjs, a free Cloudflare Worker) that holds the
//      author's Client Secret and only answers people who type a valid ACCESS KEY into Settings -> Advanced. The app only
//      knows the helper's address; the secret and the list of keys never leave the helper, so nothing in the app (or in
//      its code) can be dug out to use the built-in sign-in without a key.
// Typed Client ID / Secret win over the broker. Base URLs are injectable so tests can run against a local fake.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// One permission covers everything the buttons do: live chat, going live / ending, ad breaks, title and privacy.
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'Content-Type': 'application/json', Accept: 'application/json' };
const CALLBACK_PORT = 17424;
const CALLBACK_PATH = '/callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const KEY_REFUSED = 'That access key was not accepted (it may be mistyped, or turned off). Check it in Settings → Plugins → YouTube → Advanced, or use your own Client ID and Secret instead.';

// YouTube's fixed video categories (the API has no free-text "game" field, only these).
const CATEGORIES = [
  ['20', 'Gaming'], ['22', 'People & Blogs'], ['24', 'Entertainment'], ['10', 'Music'], ['23', 'Comedy'], ['27', 'Education'],
  ['28', 'Science & Technology'], ['26', 'Howto & Style'], ['1', 'Film & Animation'], ['17', 'Sports'], ['25', 'News & Politics'],
  ['19', 'Travel & Events'], ['15', 'Pets & Animals'], ['2', 'Autos & Vehicles'], ['29', 'Nonprofits & Activism'],
];

class YouTubeError extends Error {
  constructor(message, status, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Where the author's private sign-in helper lives, if the author put a youtube-app.json next to this file:
//   { "brokerUrl": "https://your-site.example/youtube" }
// That is only an address. A Client ID or Secret in this file is ignored on purpose, so a secret can never be shipped
// inside the app by accident.
function bundledBroker() {
  try {
    const j = require('./youtube-app.json');
    const broker = String(j.brokerUrl || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[^\s/]+/.test(broker) ? broker : '';
  } catch { return ''; }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const iso = (s) => (s ? Date.parse(s) || 0 : 0);

class YouTubeClient extends EventEmitter {
  constructor({
    secrets, apiBase = 'https://www.googleapis.com/youtube/v3', authUrl = 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl = 'https://oauth2.googleapis.com/token', fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(), callbackPort = CALLBACK_PORT, defaultBrokerUrl = bundledBroker(),
  } = {}) {
    super();
    this.defaultBrokerUrl = String(defaultBrokerUrl || '').trim().replace(/\/+$/, '');
    this.brokerUrl = ''; // set while in broker mode
    this.accessKey = ''; // the key typed in Settings; only ever sent to the broker
    this.mode = 'none'; // none | own | broker
    this.usingBuiltIn = false;
    this.secrets = secrets;
    this.apiBase = apiBase;
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.callbackPort = callbackPort;
    this.clientId = '';
    this.clientSecret = '';
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
      encrypted: this.secrets ? this.secrets.isEncrypted() : false,
      usingBuiltIn: this.usingBuiltIn, // true only while an access key is in use with the private helper
      note: this.usingBuiltIn ? 'Built-in login is ON: your access key is in use, so you can leave the Client ID and Secret empty. Press Connect and pick your Google account.' : '',
    };
  }

  isConnected() {
    return this.status === 'connected';
  }

  // Google accepts any port on the loopback address for a desktop-app client, so nothing needs registering.
  redirectUri() {
    const port = this.auth && this.auth.port ? this.auth.port : this.callbackPort;
    return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  // Your own Client ID and Secret (typed in Settings) win. With none typed, an access key (also typed in Settings) switches on
  // the author's private sign-in helper, if this build knows where it is. With neither there is no way to sign in.
  configure({ clientId, clientSecret, accessKey }) {
    const ownId = String(clientId || '').trim();
    const ownSecret = String(clientSecret || '').trim();
    const key = String(accessKey || '').trim();
    let mode = 'none', id = '', secret = '', broker = '';
    if (ownId || ownSecret) { mode = 'own'; id = ownId; secret = ownSecret; }
    else if (key && this.defaultBrokerUrl) { mode = 'broker'; broker = this.defaultBrokerUrl; }
    this.usingBuiltIn = mode === 'broker';
    const keyChanged = key !== this.accessKey;
    this.accessKey = key;
    if (mode === this.mode && id === this.clientId && secret === this.clientSecret && broker === this.brokerUrl) { if (keyChanged && mode === 'broker') this.cancelAuth(); return; }
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
      throw new YouTubeError(this.mode === 'own'
        ? 'Enter both your Google Client ID and Client Secret first (the Instructions button in Settings → Plugins → YouTube shows how to get them).'
        : 'Enter your own Google Client ID and Client Secret in Settings → Plugins → YouTube (the Instructions button shows how to get them), or an access key if you were given one.', 0);
    }
    const clientId = this.mode === 'broker' ? (await this.brokerConfig()).clientId : this.clientId;
    this.cancelAuth();
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(16));
    const auth = { state, verifier, server: null, timer: null, port: 0 };
    auth.server = http.createServer((req, res) => this.onCallback(auth, req, res));
    // The usual port if it is free, otherwise any free one (Google does not care which loopback port is used).
    for (const port of [this.callbackPort, 0]) {
      try {
        await new Promise((resolve, reject) => { auth.server.once('error', reject); auth.server.listen(port, '127.0.0.1', () => { auth.server.removeListener('error', reject); resolve(); }); });
        break;
      } catch (err) {
        if (port === 0 || err.code !== 'EADDRINUSE') throw new YouTubeError(`Could not listen for Google's answer: ${err.message}`, 0);
      }
    }
    auth.port = auth.server.address().port;
    auth.timer = setTimeout(() => {
      if (this.auth === auth) { this.cancelAuth(); this.setStatus('needs-auth', 'The YouTube sign-in timed out. Press Connect again.'); }
    }, AUTH_TIMEOUT_MS);
    if (auth.timer.unref) auth.timer.unref();
    this.auth = auth;
    const url = new URL(this.authUrl);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      state,
      scope: SCOPES.join(' '),
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline', // so Google hands back a refresh token: you sign in once, not every hour
      prompt: 'consent',
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
    // Only the browser coming back from Google to exactly this address is answered.
    if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${auth.port}`) { res.writeHead(404).end('Not found'); return; }
    if (this.auth !== auth || u.searchParams.get('state') !== auth.state) { this.page(res, 400, 'That did not work', 'This sign-in link is not the current one. Go back to VR Macro Pad and press Connect again.'); return; }
    const denied = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (denied || !code) {
      this.cancelAuth();
      this.setStatus('needs-auth', denied === 'access_denied' ? 'You declined access on Google.' : `YouTube sign-in failed: ${denied || 'no code returned'}`);
      this.page(res, 200, 'Not connected', 'You can close this tab.');
      return;
    }
    try {
      const body = await this.exchange('code', { code, redirect_uri: this.redirectUri(), code_verifier: auth.verifier });
      this.tokens = this.tokensFrom(body);
      this.cancelAuth();
      await this.afterSignIn();
      this.page(res, 200, this.status === 'connected' ? 'YouTube connected' : 'Not connected', this.status === 'connected' ? 'You can close this tab and go back to VR Macro Pad.' : this.error);
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
    try { auth.server.close(); setTimeout(() => { try { auth.server.closeAllConnections(); } catch { /* gone */ } }, 1500).unref(); } catch { /* already closed */ }
    if (this.status === 'authorizing') this.setStatus(this.ready() ? 'needs-auth' : 'off');
  }

  tokensFrom(body, previous = null) {
    return {
      access: body.access_token,
      refresh: body.refresh_token || (previous && previous.refresh) || '', // Google only sends it the first time
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
  brokerHeaders(extra = {}) {
    return { ...extra, 'X-Access-Key': this.accessKey };
  }

  async brokerConfig() {
    let res;
    try { res = await this.fetch(`${this.brokerUrl}/config`, { headers: this.brokerHeaders({ Accept: 'application/json' }) }); } catch (err) {
      throw new YouTubeError(`Could not reach the YouTube sign-in service (${err.message}). Try again in a moment.`, 0);
    }
    const body = await this.readJson(res);
    if (res.status === 403) throw new YouTubeError(KEY_REFUSED, 403, 'access_denied');
    if (!res.ok || !body.clientId) throw new YouTubeError(`The YouTube sign-in service did not answer properly (${res.status}).`, res.status);
    return body;
  }

  // kind: 'code' (swap the sign-in code for tokens) or 'refresh'. Through the broker when there is one; otherwise straight
  // to Google with the Client Secret.
  async exchange(kind, params) {
    const broker = this.mode === 'broker';
    let res;
    try {
      if (broker) {
        res = await this.fetch(`${this.brokerUrl}/${kind === 'refresh' ? 'refresh' : 'token'}`, { method: 'POST', headers: this.brokerHeaders(JSON_BODY), body: JSON.stringify(params) });
      } else {
        const form = { grant_type: kind === 'refresh' ? 'refresh_token' : 'authorization_code', client_id: this.clientId, client_secret: this.clientSecret, ...params };
        res = await this.fetch(this.tokenUrl, { method: 'POST', headers: FORM, body: new URLSearchParams(form) });
      }
    } catch (err) {
      throw new YouTubeError(broker ? `Could not reach the YouTube sign-in service (${err.message}). Try again in a moment.` : `Could not reach Google (${err.message}).`, 0);
    }
    const body = await this.readJson(res);
    if (broker && res.status === 403) throw new YouTubeError(KEY_REFUSED, 403, 'access_denied');
    if (!res.ok || !body.access_token) {
      const reason = typeof body.error === 'string' ? body.error : '';
      const why = body.error_description || reason || body.message || '';
      throw new YouTubeError(`Google refused the sign-in${why ? `: ${why}` : ''} (${res.status}).${broker ? '' : ' Check the Client ID and Client Secret (the OAuth client type must be "Desktop app").'}`, res.status, reason);
    }
    return body;
  }

  async accessToken() {
    if (!this.tokens) throw new YouTubeError('YouTube is not connected. Connect it in Settings → Plugins → YouTube.', 401);
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
        if (err.reason === 'access_denied') { // the access key was turned off
          this.tokens = null;
          try { this.secrets.delete('tokens'); } catch { /* nothing stored */ }
          this.setStatus('needs-auth', KEY_REFUSED);
          throw new YouTubeError(KEY_REFUSED, 403, 'access_denied');
        }
        if (err.reason === 'invalid_grant') { // revoked in your Google account, or the app is still in "Testing" and a week passed
          this.tokens = null;
          try { this.secrets.delete('tokens'); } catch { /* nothing stored */ }
          this.setStatus('needs-auth', 'YouTube sign-in expired. Connect again in Settings.');
          throw new YouTubeError('YouTube sign-in expired. Connect again in Settings.', 401);
        }
        throw err; // offline or a Google hiccup: keep the sign-in, try again next time
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

  // Google's error body is { error: { code, message, errors: [{ reason }] } }.
  describe(body, status) {
    const e = body && typeof body.error === 'object' && body.error ? body.error : {};
    const msg = e.message || (body && typeof body.message === 'string' ? body.message : '');
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) return 'YouTube says this app used up its daily allowance. It resets at midnight Pacific time. Try again later.';
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(reason) || status === 429) return 'YouTube is asking us to slow down. Try again in a moment.';
    if (/liveStreamingNotEnabled/i.test(reason)) return 'Your YouTube channel is not enabled for live streaming yet. Turn it on at youtube.com/features (it can take up to 24 hours).';
    if (/liveChat(NotFound|Disabled|Ended)/i.test(reason)) return 'This stream has no live chat open right now.';
    if (/insufficientPermissions|forbidden|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason) || status === 403) return `YouTube refused (403${msg ? `: ${msg}` : ''}). Disconnect and Connect again, and approve every permission on the Google page.`;
    if (status === 404) return `YouTube could not find that (404${msg ? `: ${msg}` : ''}).`;
    if (status === 400) return `YouTube rejected that${msg ? `: ${msg}` : ' (400)'}.`;
    return msg ? `YouTube: ${msg}` : `YouTube request failed (${status})`;
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
    if (!res.ok) throw new YouTubeError(this.describe(json, res.status), res.status, (json.error && json.error.errors && json.error.errors[0] && json.error.errors[0].reason) || '');
    return json;
  }

  // ---- what the buttons use ----
  async me() {
    const r = await this.api('GET', '/channels', { query: { part: 'snippet', mine: 'true' } });
    const c = r.items && r.items[0];
    if (!c) throw new YouTubeError('This Google account has no YouTube channel. Create one at youtube.com first.', 0);
    return { id: c.id, name: (c.snippet && c.snippet.title) || c.id };
  }

  async channelStats() {
    const r = await this.api('GET', '/channels', { query: { part: 'statistics', mine: 'true' } });
    const s = (r.items && r.items[0] && r.items[0].statistics) || {};
    return {
      subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount) || 0,
      views: Number(s.viewCount) || 0,
      videos: Number(s.videoCount) || 0,
    };
  }

  normalizeBroadcast(b) {
    if (!b) return null;
    const sn = b.snippet || {};
    const st = b.status || {};
    const life = st.lifeCycleStatus || '';
    return {
      id: b.id,
      title: sn.title || '',
      description: sn.description || '',
      chatId: sn.liveChatId || '',
      life,
      live: life === 'live' || life === 'liveStarting',
      privacy: st.privacyStatus || '',
      startedAt: iso(sn.actualStartTime),
      scheduledAt: iso(sn.scheduledStartTime),
      streamId: (b.contentDetails && b.contentDetails.boundStreamId) || '',
    };
  }

  // The broadcast you are streaming now, or otherwise the next one you have set up. null when there is none.
  async currentBroadcast() {
    const part = 'id,snippet,status,contentDetails';
    let r = await this.api('GET', '/liveBroadcasts', { query: { part, broadcastStatus: 'active', maxResults: 5 } });
    let items = r.items || [];
    if (!items.length) {
      r = await this.api('GET', '/liveBroadcasts', { query: { part, broadcastStatus: 'upcoming', maxResults: 10 } });
      items = (r.items || []).slice().sort((a, b) => iso(a.snippet && a.snippet.scheduledStartTime) - iso(b.snippet && b.snippet.scheduledStartTime));
    }
    return this.normalizeBroadcast(items[0]);
  }

  // Viewers and likes of a video (a broadcast is a video).
  async videoInfo(id) {
    const r = await this.api('GET', '/videos', { query: { part: 'statistics,liveStreamingDetails', id } });
    const v = r.items && r.items[0];
    if (!v) return { viewers: 0, likes: 0 };
    return { viewers: Number(v.liveStreamingDetails && v.liveStreamingDetails.concurrentViewers) || 0, likes: Number(v.statistics && v.statistics.likeCount) || 0 };
  }

  // Is YouTube receiving good video from your streaming software? { status: active|inactive|..., health: good|ok|bad|noData }
  async streamHealth(streamId) {
    if (!streamId) return null;
    const r = await this.api('GET', '/liveStreams', { query: { part: 'status', id: streamId } });
    const s = r.items && r.items[0] && r.items[0].status;
    return s ? { status: s.streamStatus || '', health: (s.healthStatus && s.healthStatus.status) || '' } : null;
  }

  async liveBroadcastOrFail(what = 'a broadcast') {
    const b = await this.currentBroadcast();
    if (!b) throw new YouTubeError(`You have no live or upcoming broadcast on YouTube to use for ${what}. Create one in YouTube Studio (Go live) first.`, 0);
    return b;
  }

  // Says something in the live chat of your stream (YouTube allows 200 characters).
  async sendChat(text) {
    const messageText = String(text || '').trim();
    if (!messageText) throw new YouTubeError('Type a message first', 0);
    if ([...messageText].length > 200) throw new YouTubeError('YouTube live chat messages can be at most 200 characters', 0);
    const b = await this.currentBroadcast();
    if (!b || !b.chatId) throw new YouTubeError('You have no live broadcast with an open chat right now.', 0);
    await this.api('POST', '/liveChat/messages', {
      query: { part: 'snippet' },
      body: { snippet: { liveChatId: b.chatId, type: 'textMessageEvent', textMessageDetails: { messageText } } },
    });
  }

  // 'live' starts the broadcast (your streaming software must already be sending video), 'complete' ends it.
  async transition(to) {
    const b = await this.liveBroadcastOrFail(to === 'live' ? 'going live' : 'ending the stream');
    if (to === 'live' && b.live) throw new YouTubeError('You are already live.', 0);
    if (to === 'complete' && !b.live) throw new YouTubeError('You are not live, so there is nothing to end.', 0);
    await this.api('POST', '/liveBroadcasts/transition', { query: { part: 'id,status', id: b.id, broadcastStatus: to } });
    return b;
  }

  async adBreak(seconds) {
    const n = Math.round(Number(seconds));
    if (!(n >= 10 && n <= 180)) throw new YouTubeError('An ad break is 10 to 180 seconds', 0);
    const b = await this.currentBroadcast();
    if (!b || !b.live) throw new YouTubeError('You can only run an ad break while you are live.', 0);
    await this.api('POST', '/liveBroadcasts/cuepoint', { query: { id: b.id }, body: { cueType: 'cueTypeAd', durationSecs: n } });
  }

  // { title, description, categoryId }: only what is given is changed. Works on the live (or next upcoming) broadcast.
  async updateDetails({ title, description, categoryId } = {}) {
    const t = title === undefined ? '' : String(title).trim();
    const d = description === undefined ? '' : String(description);
    const cat = String(categoryId || '').trim();
    if (!t && !d.trim() && !cat) throw new YouTubeError('Give a title, a description or a category to change', 0);
    if (t.length > 100) throw new YouTubeError('A YouTube title can be at most 100 characters', 0);
    if (/[<>]/.test(t)) throw new YouTubeError('A YouTube title cannot contain < or >', 0);
    if (Buffer.byteLength(d, 'utf8') > 5000) throw new YouTubeError('A YouTube description can be at most 5000 bytes', 0);
    const b = await this.liveBroadcastOrFail('changing the title');
    // A video update replaces the whole snippet, so read it first and send it all back with just your changes.
    const r = await this.api('GET', '/videos', { query: { part: 'snippet', id: b.id } });
    const sn = r.items && r.items[0] && r.items[0].snippet;
    if (!sn) throw new YouTubeError('YouTube did not return your stream\'s details.', 0);
    const snippet = { title: t || sn.title, description: d.trim() ? d : sn.description || '', categoryId: cat || sn.categoryId };
    if (sn.tags) snippet.tags = sn.tags;
    if (sn.defaultLanguage) snippet.defaultLanguage = sn.defaultLanguage;
    await this.api('PUT', '/videos', { query: { part: 'snippet' }, body: { id: b.id, snippet } });
    return b;
  }

  async setPrivacy(privacy) {
    if (!['public', 'unlisted', 'private'].includes(privacy)) throw new YouTubeError('Choose public, unlisted or private', 0);
    const b = await this.liveBroadcastOrFail('changing who can watch');
    const r = await this.api('GET', '/videos', { query: { part: 'status', id: b.id } });
    const cur = r.items && r.items[0] && r.items[0].status;
    if (!cur) throw new YouTubeError('YouTube did not return your stream\'s settings.', 0);
    const status = { privacyStatus: privacy };
    for (const k of ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids']) if (cur[k] !== undefined) status[k] = cur[k];
    await this.api('PUT', '/videos', { query: { part: 'status' }, body: { id: b.id, status } });
    return b;
  }
}

module.exports = { YouTubeClient, YouTubeError, SCOPES, CATEGORIES, CALLBACK_PORT, CALLBACK_PATH };
