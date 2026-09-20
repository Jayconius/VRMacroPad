// Twitch Helix client with "device code" sign-in: you only need a Client ID from a Twitch
// developer app (Client Type "Public"). No client secret and no redirect server.
//
// Endpoints, methods and scopes follow the Twitch API reference (checked against Twitch's
// own CLI mock server). Base URLs are injectable so tests can run against a local fake.
const { EventEmitter } = require('events');

// Everything the buttons and widgets can do. Requested once at sign-in.
const SCOPES = [
  'user:write:chat', // send chat messages
  'moderator:manage:chat_settings', // emote-only, followers-only, slow mode...
  'moderator:manage:shield_mode', // shield mode (protection mode)
  'moderator:read:shield_mode',
  'moderator:read:chat_settings',
  'moderator:manage:announcements',
  'moderator:manage:chat_messages', // clear chat
  'moderator:manage:shoutouts',
  'channel:read:ads', // ad schedule
  'channel:manage:ads', // snooze next ad
  'channel:edit:commercial', // run an ad break
  'channel:manage:broadcast', // stream markers, title, category
  'channel:manage:raids',
  'clips:edit',
];

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

class TwitchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class TwitchClient extends EventEmitter {
  constructor({
    secrets, apiBase = 'https://api.twitch.tv/helix', authBase = 'https://id.twitch.tv/oauth2', fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(), minPollMs = 1000, defaultClientId = require('./app-config').twitchClientId,
  } = {}) {
    super();
    this.minPollMs = minPollMs;
    this.defaultClientId = String(defaultClientId || '').trim(); // shipped with the app, so users need no developer account
    this.usingBuiltIn = false;
    this.secrets = secrets;
    this.apiBase = apiBase;
    this.authBase = authBase;
    this.fetch = fetchImpl;
    this.now = now;
    this.clientId = '';
    this.tokens = null; // { access, refresh, expiresAt, scopes, clientId }
    this.user = null; // { id, login, name }
    this.status = 'off'; // off | needs-auth | authorizing | connected | error
    this.error = '';
    this.pending = null; // { userCode, verificationUri, expiresAt }
    this.pollTimer = null;
    this.refreshing = null;
    this.deviceRun = 0;
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
      pending: this.pending ? { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri } : null,
      encrypted: this.secrets ? this.secrets.isEncrypted() : false,
      hasBuiltIn: Boolean(this.defaultClientId),
      usingBuiltIn: this.usingBuiltIn,
    };
  }

  isConnected() {
    return this.status === 'connected';
  }

  // A Client ID typed in Settings wins; otherwise the one shipped with the app is used.
  configure({ clientId }) {
    const own = (clientId || '').trim();
    const id = own || this.defaultClientId;
    this.usingBuiltIn = !own && Boolean(this.defaultClientId);
    if (id === this.clientId) return;
    this.clientId = id;
    this.cancelDeviceFlow();
    this.tokens = null;
    this.user = null;
    if (!id) { this.setStatus('off'); return; }
    this.loadSaved();
  }

  loadSaved() {
    let saved = null;
    try { saved = JSON.parse(this.secrets.get('twitch.tokens') || 'null'); } catch { saved = null; }
    if (saved && saved.clientId === this.clientId && saved.refresh) {
      this.tokens = saved;
      this.user = saved.user || null;
      this.setStatus('connected');
    } else {
      this.setStatus('needs-auth');
    }
  }

  saveTokens() {
    this.secrets.set('twitch.tokens', JSON.stringify({ ...this.tokens, user: this.user }));
  }

  // ---- sign-in (device code flow) ----
  async startDeviceFlow() {
    if (!this.clientId) throw new TwitchError('Enter your Twitch Client ID first', 0);
    this.cancelDeviceFlow();
    const res = await this.fetch(`${this.authBase}/device`, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ client_id: this.clientId, scopes: SCOPES.join(' ') }),
    });
    const body = await this.readJson(res);
    if (!res.ok) throw new TwitchError(this.describe(body, res.status, 'Twitch refused the Client ID'), res.status);
    const run = ++this.deviceRun;
    this.pending = { userCode: body.user_code, verificationUri: body.verification_uri, expiresAt: this.now() + body.expires_in * 1000 };
    this.setStatus('authorizing');
    this.emit('status', 'authorizing'); // listeners also need to hear about the new code when the status name did not change
    this.schedulePoll(run, body.device_code, Math.max(this.minPollMs, (body.interval || 5) * 1000));
    return { userCode: body.user_code, verificationUri: body.verification_uri, expiresIn: body.expires_in };
  }

  schedulePoll(run, deviceCode, intervalMs) {
    this.pollTimer = setTimeout(() => this.pollOnce(run, deviceCode, intervalMs), intervalMs);
  }

  async pollOnce(run, deviceCode, intervalMs) {
    if (run !== this.deviceRun || !this.pending) return;
    if (this.now() > this.pending.expiresAt) {
      this.pending = null;
      this.setStatus('needs-auth', 'The sign-in code expired. Press Connect again.');
      return;
    }
    try {
      const res = await this.fetch(`${this.authBase}/token`, {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({ client_id: this.clientId, scopes: SCOPES.join(' '), device_code: deviceCode, grant_type: DEVICE_GRANT }),
      });
      const body = await this.readJson(res);
      if (run !== this.deviceRun) return;
      if (res.ok && body.access_token) {
        this.pending = null;
        this.tokens = this.tokensFrom(body);
        await this.afterSignIn();
        return;
      }
      const message = String(body.message || body.error || '');
      if (message.includes('authorization_pending')) { this.schedulePoll(run, deviceCode, intervalMs); return; }
      if (message.includes('slow_down')) { this.schedulePoll(run, deviceCode, intervalMs + 5000); return; }
      this.pending = null;
      this.setStatus('needs-auth', `Sign-in failed: ${message || res.status}`);
    } catch (err) {
      if (run !== this.deviceRun) return;
      this.schedulePoll(run, deviceCode, intervalMs); // network blip: keep trying until the code expires
    }
  }

  tokensFrom(body) {
    return {
      access: body.access_token,
      refresh: body.refresh_token,
      expiresAt: this.now() + (body.expires_in || 14400) * 1000,
      scopes: Array.isArray(body.scope) ? body.scope : [],
      clientId: this.clientId,
    };
  }

  async afterSignIn() {
    try {
      const me = await this.api('GET', '/users');
      const u = me.data && me.data[0];
      if (!u) throw new TwitchError('Twitch did not say who you are', 0);
      this.user = { id: u.id, login: u.login, name: u.display_name };
      this.saveTokens();
      this.setStatus('connected');
    } catch (err) {
      this.tokens = null;
      this.setStatus('error', err.message);
    }
  }

  cancelDeviceFlow() {
    this.deviceRun++;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
    if (this.status === 'authorizing') this.setStatus(this.clientId ? 'needs-auth' : 'off');
  }

  async disconnect() {
    const token = this.tokens && this.tokens.access;
    this.cancelDeviceFlow();
    this.tokens = null;
    this.user = null;
    this.secrets.delete('twitch.tokens');
    if (token && this.clientId) {
      // Best effort: tell Twitch the token is no longer wanted.
      try { await this.fetch(`${this.authBase}/revoke`, { method: 'POST', headers: FORM, body: new URLSearchParams({ client_id: this.clientId, token }) }); } catch { /* offline: fine */ }
    }
    this.setStatus(this.clientId ? 'needs-auth' : 'off');
  }

  // Asks Twitch which permissions the saved sign-in actually has.
  async validate() {
    const res = await this.fetch(`${this.authBase}/validate`, { headers: { Authorization: `OAuth ${await this.accessToken()}` } });
    const body = await this.readJson(res);
    if (!res.ok) throw new TwitchError(this.describe(body, res.status, 'Token check failed'), res.status);
    return { login: body.login, userId: body.user_id, scopes: body.scopes || [], missing: SCOPES.filter((s) => !(body.scopes || []).includes(s)) };
  }

  // ---- tokens ----
  async accessToken() {
    if (!this.tokens) throw new TwitchError('Twitch is not connected', 401);
    if (this.tokens.expiresAt - this.now() < 60000) await this.refresh();
    return this.tokens.access;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const res = await this.fetch(`${this.authBase}/token`, {
          method: 'POST',
          headers: FORM,
          body: new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.tokens.refresh }),
        });
        const body = await this.readJson(res);
        if (!res.ok || !body.access_token) {
          // Refresh tokens are single-use and expire after 30 idle days: sign in again.
          this.tokens = null;
          this.secrets.delete('twitch.tokens');
          this.setStatus('needs-auth', 'Twitch sign-in expired. Connect again in Settings.');
          throw new TwitchError('Twitch sign-in expired. Connect again in Settings.', 401);
        }
        this.tokens = this.tokensFrom(body);
        this.saveTokens();
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

  describe(body, status, fallback) {
    const msg = body && (body.message || body.error);
    if (status === 401 && /scope/i.test(msg || '')) return `${msg} (disconnect and connect Twitch again to grant it)`;
    return msg ? `Twitch: ${msg}` : `${fallback} (${status})`;
  }

  async api(method, path, { query, json } = {}, retried = false) {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, 'Client-Id': this.clientId };
    const init = { method, headers };
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    const res = await this.fetch(url, init);
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.api(method, path, { query, json }, true);
    }
    const body = await this.readJson(res);
    if (!res.ok) throw new TwitchError(this.describe(body, res.status, 'Twitch request failed'), res.status);
    return body;
  }

  // ---- channel actions ----
  requireUser() {
    if (!this.user) throw new TwitchError('Twitch is not connected. Connect it in Settings → Connections.', 401);
    return this.user.id;
  }

  async sendChat(message) {
    const id = this.requireUser();
    const body = await this.api('POST', '/chat/messages', { json: { broadcaster_id: id, sender_id: id, message: String(message).slice(0, 500) } });
    const r = body.data && body.data[0];
    if (r && r.is_sent === false) throw new TwitchError(`Twitch did not send it: ${(r.drop_reason && r.drop_reason.message) || 'message dropped'}`, 0);
  }

  async getChatSettings() {
    const id = this.requireUser();
    const body = await this.api('GET', '/chat/settings', { query: { broadcaster_id: id, moderator_id: id } });
    return body.data && body.data[0];
  }

  async setChatSettings(patch) {
    const id = this.requireUser();
    await this.api('PATCH', '/chat/settings', { query: { broadcaster_id: id, moderator_id: id }, json: patch });
  }

  async getShield() {
    const id = this.requireUser();
    const body = await this.api('GET', '/moderation/shield_mode', { query: { broadcaster_id: id, moderator_id: id } });
    return Boolean(body.data && body.data[0] && body.data[0].is_active);
  }

  async setShield(active) {
    const id = this.requireUser();
    await this.api('PUT', '/moderation/shield_mode', { query: { broadcaster_id: id, moderator_id: id }, json: { is_active: Boolean(active) } });
  }

  async getAds() {
    const id = this.requireUser();
    const body = await this.api('GET', '/channels/ads', { query: { broadcaster_id: id } });
    return body.data && body.data[0];
  }

  async snoozeAd() {
    const id = this.requireUser();
    const body = await this.api('POST', '/channels/ads/schedule/snooze', { query: { broadcaster_id: id } });
    return body.data && body.data[0];
  }

  async startCommercial(length) {
    const id = this.requireUser();
    const body = await this.api('POST', '/channels/commercial', { json: { broadcaster_id: id, length: Number(length) } });
    return body.data && body.data[0];
  }

  async announce(message, color) {
    const id = this.requireUser();
    const json = { message: String(message).slice(0, 500) };
    if (color && color !== 'primary') json.color = color;
    await this.api('POST', '/chat/announcements', { query: { broadcaster_id: id, moderator_id: id }, json });
  }

  async clearChat() {
    const id = this.requireUser();
    await this.api('DELETE', '/moderation/chat', { query: { broadcaster_id: id, moderator_id: id } });
  }

  async createMarker(description) {
    const id = this.requireUser();
    await this.api('POST', '/streams/markers', { json: { user_id: id, description: String(description || '').slice(0, 140) } });
  }

  async createClip() {
    const id = this.requireUser();
    const body = await this.api('POST', '/clips', { query: { broadcaster_id: id } });
    return body.data && body.data[0];
  }

  async userByLogin(login) {
    const clean = String(login || '').trim().replace(/^@/, '').toLowerCase();
    if (!clean) throw new TwitchError('Enter a channel name', 0);
    const body = await this.api('GET', '/users', { query: { login: clean } });
    const u = body.data && body.data[0];
    if (!u) throw new TwitchError(`Twitch has no channel called "${clean}"`, 404);
    return u;
  }

  async raid(login) {
    const id = this.requireUser();
    const target = await this.userByLogin(login);
    await this.api('POST', '/raids', { query: { from_broadcaster_id: id, to_broadcaster_id: target.id } });
    return target;
  }

  async shoutout(login) {
    const id = this.requireUser();
    const target = await this.userByLogin(login);
    await this.api('POST', '/chat/shoutouts', { query: { from_broadcaster_id: id, to_broadcaster_id: target.id, moderator_id: id } });
    return target;
  }

  async getStream() {
    const id = this.requireUser();
    const body = await this.api('GET', '/streams', { query: { user_id: id } });
    return (body.data && body.data[0]) || null;
  }

  async setChannel({ title, game }) {
    const id = this.requireUser();
    const json = {};
    if (title) json.title = String(title).slice(0, 140);
    if (game) {
      const found = await this.api('GET', '/games', { query: { name: game } });
      const g = found.data && found.data[0];
      if (!g) throw new TwitchError(`Twitch has no category called "${game}"`, 404);
      json.game_id = g.id;
    }
    if (!Object.keys(json).length) throw new TwitchError('Enter a title or a category', 0);
    await this.api('PATCH', '/channels', { query: { broadcaster_id: id }, json });
  }

  stop() {
    this.cancelDeviceFlow();
  }
}

module.exports = { TwitchClient, TwitchError, SCOPES };
