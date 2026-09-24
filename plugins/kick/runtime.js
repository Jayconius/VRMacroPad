// The live part of the Kick plugin: keeps the sign-in (client.js), and while something on the deck uses Kick, watches
// your channel (live? viewers? title? category?) and your ad-break allowance so buttons and mini screens can show them.
const { KickClient } = require('./client');

const POLL_MS = 10000;
const ADS_POLL_MS = 30000;
const KEYS = ['kick.connected', 'kick.live'];

class KickRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new KickClient({ secrets: ctx.secrets, now: ctx.now, ...options });
    this.client.on('status', () => { this.publishConnected(); this.ctx.emitStatus(); });
    this.timer = null;
    this.adsTimer = null;
    this.wantAds = false;
    this.busy = false;
    this.adsBusy = false;
    this.channel = null; // { id, slug, title, category, live, viewers, startedAt }
    this.ads = null;     // { remaining, blocked, optedIn, auto, limits }
    this.error = '';
  }

  configure() {
    const s = this.ctx.settings();
    this.client.configure({ clientId: s.clientId, clientSecret: s.clientSecret });
    this.publishConnected();
  }

  sync(needs) {
    this.wantAds = Boolean(needs.kickAds);
    if (needs.kick) this.start(); else this.stop();
    if (this.timer && this.wantAds && !this.adsTimer) {
      this.pollAds();
      this.adsTimer = setInterval(() => this.pollAds(), ADS_POLL_MS);
      if (this.adsTimer.unref) this.adsTimer.unref();
    }
    if (!this.wantAds && this.adsTimer) { clearInterval(this.adsTimer); this.adsTimer = null; this.ads = null; }
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // Polling only: an unfinished sign-in in Settings must survive "nothing uses Kick right now".
  stop() {
    clearInterval(this.timer); this.timer = null;
    clearInterval(this.adsTimer); this.adsTimer = null;
    this.channel = null; this.ads = null; this.error = '';
    for (const k of KEYS) this.hub.remove(k);
  }

  status() {
    return this.client.info();
  }

  publishConnected() {
    this.hub.set('kick.connected', this.client.isConnected());
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.publishConnected();
      if (!this.client.isConnected()) { this.channel = null; this.hub.set('kick.live', false); return; }
      this.channel = await this.client.channel();
      this.error = '';
      this.hub.set('kick.live', Boolean(this.channel && this.channel.live));
    } catch (err) {
      this.error = err.message; // the client reports its own sign-in problems; the widget shows this one
    } finally {
      this.busy = false;
      this.ctx.emitStatus();
    }
  }

  async pollAds() {
    if (this.adsBusy || !this.client.isConnected()) return;
    this.adsBusy = true;
    try { this.ads = await this.client.adStatus(); } catch (err) { this.ads = { error: err.message, remaining: 0, blocked: false, optedIn: true, auto: false, limits: null }; } finally {
      this.adsBusy = false;
      this.ctx.emitStatus();
    }
  }

  // A moment after a button changed something, look again instead of waiting for the next poll.
  refresh() {
    setTimeout(() => this.poll(), 800).unref();
  }

  // Runs a Kick call with a friendly message when it is not set up.
  async call(fn) {
    const c = this.client;
    if (!c.isConnected()) throw new Error('Kick is not connected yet: Settings → Plugins → Kick, enter your Client ID and Secret, then press Connect.');
    return fn(c);
  }

  snapshot() {
    return { connected: this.client.isConnected(), channel: this.channel, ads: this.ads, error: this.error, status: this.client.status };
  }

  // ---- account link: the browser is allowed to call these by name (see plugin.js clientMethods) ----
  async connect() {
    this.configure();
    return this.client.startAuth();
  }

  async disconnect() {
    await this.client.disconnect();
    this.channel = null; this.ads = null;
    return true;
  }
}

module.exports = { KickRuntime };
