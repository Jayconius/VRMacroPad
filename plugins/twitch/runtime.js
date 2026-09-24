// Polls Twitch for the things buttons and widgets follow (chat modes, shield mode, the ad schedule, whether
// you're live), only for the parts a button, widget or trigger actually asks for. The client itself (login,
// Helix calls) is client.js, unchanged; ctx.client is the one TwitchClient instance, built once in
// src/core/index.js so tests can inject their own client options exactly as before.
const POLL_MS = 10000;

// Twitch sends times as RFC3339 text, or (in older payloads) epoch seconds. Returns epoch ms, 0 if none.
function parseTime(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (/^\d+$/.test(String(v))) return parseTime(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

class TwitchRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = ctx.client; // the TwitchClient instance (or undefined in a test that never wired one)
    this.timer = null;
    this.busy = false;
    this.tick = 0;
    this.ads = { error: '' };
    this.stream = { error: '' };
    this.needsExtra = { ads: false, stream: false, modes: false };
    if (this.client) {
      this.client.on('status', () => {
        if (this.timer) this.poll(true);
        this.ctx.emitStatus();
      });
    }
  }

  configure() {
    if (this.client) this.client.configure({ clientId: this.ctx.settings().clientId });
  }

  sync(needs) {
    this.needsExtra = { ads: Boolean(needs.twitchAds), stream: Boolean(needs.twitchStream), modes: Boolean(needs.twitchModes) };
    if (needs.twitch) this.start(); else this.stop();
  }

  start() {
    if (this.timer || !this.client) return;
    this.tick = 0;
    this.poll(true);
    this.timer = setInterval(() => this.poll(false), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const k of ['twitch.connected', 'twitch.live', 'twitch.adSoon', 'twitch.emoteOnly', 'twitch.followersOnly', 'twitch.subsOnly', 'twitch.slowMode', 'twitch.uniqueChat', 'twitch.shield', 'twitch.ads', 'twitch.adRunning', 'twitch.stream']) this.hub.remove(k);
  }

  refresh() {
    if (this.timer) this.poll(true);
  }

  status() {
    return this.client ? this.client.info() : { status: 'off' };
  }

  // Runs a Twitch call, with a friendly message when it is not set up.
  async call(fn) {
    const t = this.client;
    if (!t || t.status === 'off') throw new Error('Twitch is not set up. Add your Client ID in Settings → Connections.');
    if (!t.isConnected()) throw new Error('Twitch is not connected. Connect it in Settings → Connections.');
    return fn(t);
  }

  // ---- account link: the browser is allowed to call these by name (see plugin.js clientMethods) ----
  async connect() {
    if (!this.client) throw new Error('Twitch is not available');
    return this.client.startDeviceFlow();
  }

  async disconnect() {
    if (this.client) await this.client.disconnect();
    return true;
  }

  async check() {
    if (!this.client) throw new Error('Twitch is not available');
    return this.client.validate();
  }

  async poll(force) {
    const t = this.client;
    if (!t || this.busy) return;
    this.busy = true;
    try {
      this.hub.set('twitch.connected', t.isConnected());
      if (!t.isConnected()) {
        for (const k of ['twitch.live', 'twitch.adSoon', 'twitch.emoteOnly', 'twitch.followersOnly', 'twitch.subsOnly', 'twitch.slowMode', 'twitch.uniqueChat', 'twitch.shield', 'twitch.ads', 'twitch.adRunning', 'twitch.stream']) this.hub.remove(k);
        return;
      }
      const tick = this.tick++;
      if (this.needsExtra.modes && (force || tick % 2 === 0)) {
        try {
          const s = await t.getChatSettings();
          if (s) {
            this.hub.set('twitch.emoteOnly', Boolean(s.emote_mode));
            this.hub.set('twitch.followersOnly', Boolean(s.follower_mode));
            this.hub.set('twitch.subsOnly', Boolean(s.subscriber_mode));
            this.hub.set('twitch.slowMode', Boolean(s.slow_mode));
            this.hub.set('twitch.uniqueChat', Boolean(s.unique_chat_mode));
          }
        } catch { /* stays "unknown"; the action reports the error if used */ }
        try { this.hub.set('twitch.shield', await t.getShield()); } catch { /* same */ }
      }
      if (this.needsExtra.ads && (force || tick % 3 === 0)) {
        try {
          const a = await t.getAds();
          this.ads = a ? {
            error: '', nextAdAt: parseTime(a.next_ad_at), lastAdAt: parseTime(a.last_ad_at), durationSec: Number(a.duration) || 0,
            snoozeCount: Number(a.snooze_count) || 0, snoozeRefreshAt: parseTime(a.snooze_refresh_at),
          } : { error: '' };
        } catch (err) { this.ads = { error: err.message }; }
      }
      if (this.needsExtra.stream && (force || tick % 6 === 0)) {
        try {
          const s = await t.getStream();
          this.stream = s ? { error: '', live: true, viewers: Number(s.viewer_count) || 0, startedAt: parseTime(s.started_at), title: s.title || '', game: s.game_name || '' } : { error: '', live: false };
        } catch (err) { this.stream = { error: err.message, live: false }; }
      }
      if (this.needsExtra.ads) {
        const warn = ((this.ctx.settings().adWarnMinutes) || 5) * 60000;
        const until = this.ads.nextAdAt ? this.ads.nextAdAt - this.ctx.now() : -1;
        this.hub.set('twitch.adSoon', until > 0 && until <= warn);
        this.hub.set('twitch.ads', { ...this.ads });
        // A commercial is running from the moment the last one started until its length has passed.
        this.hub.set('twitch.adRunning', Boolean(this.ads.lastAdAt && this.ads.durationSec > 0 && this.ctx.now() < this.ads.lastAdAt + this.ads.durationSec * 1000));
      }
      if (this.needsExtra.stream) {
        this.hub.set('twitch.live', Boolean(this.stream.live));
        this.hub.set('twitch.stream', { ...this.stream });
      }
    } catch { /* the client reports its own status */ } finally {
      this.busy = false;
    }
  }

  adsData() {
    const t = this.client;
    return { connected: Boolean(t && t.isConnected()), status: t ? t.status : 'off', ...this.ads };
  }

  streamData() {
    const t = this.client;
    return { connected: Boolean(t && t.isConnected()), status: t ? t.status : 'off', ...this.stream };
  }
}

module.exports = { TwitchRuntime, parseTime };
