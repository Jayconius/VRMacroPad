// The live part of the YouTube plugin: keeps the sign-in (client.js), and while something on the deck uses YouTube, watches
// your broadcast (live? viewers? title? stream health?) and, if a mini screen wants it, your channel numbers.
//
// YouTube gives every app a daily allowance (10,000 "units"; a list request costs 1). Checking your broadcast once a minute
// while you are live (3 requests) and every two minutes while you are not, plus channel numbers every five minutes, stays
// far below it. Nothing is polled unless a button or screen on your deck uses YouTube.
const { YouTubeClient } = require('./client');

const LIVE_POLL_MS = 60000;
const IDLE_POLL_MS = 120000;
const STATS_POLL_MS = 300000;
const KEYS = ['youtube.connected', 'youtube.live'];

class YouTubeRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new YouTubeClient({ secrets: ctx.secrets, now: ctx.now, ...options });
    this.client.on('status', () => { this.publishConnected(); this.ctx.emitStatus(); });
    this.timer = null;
    this.statsTimer = null;
    this.wantStats = false;
    this.busy = false;
    this.statsBusy = false;
    this.broadcast = null; // { id, title, chatId, life, live, privacy, startedAt, ... }
    this.viewers = 0;
    this.likes = 0;
    this.health = null; // { status, health }
    this.stats = null; // { subscribers, views, videos }
    this.error = '';
    this.pollMs = IDLE_POLL_MS;
  }

  configure() {
    const s = this.ctx.settings();
    this.client.configure({ clientId: s.clientId, clientSecret: s.clientSecret, accessKey: s.accessKey });
    this.publishConnected();
  }

  sync(needs) {
    this.wantStats = Boolean(needs.youtubeStats);
    if (needs.youtube) this.start(); else this.stop();
    if (this.timer && this.wantStats && !this.statsTimer) {
      this.pollStats();
      this.statsTimer = setInterval(() => this.pollStats(), STATS_POLL_MS);
      if (this.statsTimer.unref) this.statsTimer.unref();
    }
    if (!this.wantStats && this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; this.stats = null; }
  }

  start() {
    if (this.timer) return;
    this.schedule(0);
  }

  // One poll now, the next one after `ms` (shorter while you are live).
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => { await this.poll(); if (this.timer) this.schedule(this.pollMs); }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  // Polling only: an unfinished sign-in in Settings must survive "nothing uses YouTube right now".
  stop() {
    clearTimeout(this.timer); this.timer = null;
    clearInterval(this.statsTimer); this.statsTimer = null;
    this.broadcast = null; this.stats = null; this.health = null; this.viewers = 0; this.likes = 0; this.error = '';
    for (const k of KEYS) this.hub.remove(k);
  }

  status() {
    return this.client.info();
  }

  publishConnected() {
    this.hub.set('youtube.connected', this.client.isConnected());
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.publishConnected();
      if (!this.client.isConnected()) { this.broadcast = null; this.hub.set('youtube.live', false); return; }
      const b = await this.client.currentBroadcast();
      this.broadcast = b;
      if (b && b.live) {
        const [info, health] = await Promise.all([this.client.videoInfo(b.id), this.client.streamHealth(b.streamId).catch(() => null)]);
        this.viewers = info.viewers; this.likes = info.likes; this.health = health;
        this.pollMs = LIVE_POLL_MS;
      } else {
        this.viewers = 0; this.likes = 0; this.health = null;
        this.pollMs = IDLE_POLL_MS;
      }
      this.error = '';
      this.hub.set('youtube.live', Boolean(b && b.live));
    } catch (err) {
      this.error = err.message; // the client reports its own sign-in problems; the widget shows this one
    } finally {
      this.busy = false;
      this.ctx.emitStatus();
    }
  }

  async pollStats() {
    if (this.statsBusy || !this.client.isConnected()) return;
    this.statsBusy = true;
    try { this.stats = await this.client.channelStats(); } catch (err) { this.stats = { error: err.message }; } finally {
      this.statsBusy = false;
      this.ctx.emitStatus();
    }
  }

  // A moment after a button changed something, look again instead of waiting for the next poll.
  refresh() {
    setTimeout(() => this.poll(), 1500).unref();
  }

  // Runs a YouTube call with a friendly message when it is not set up.
  async call(fn) {
    const c = this.client;
    if (!c.isConnected()) throw new Error('YouTube is not connected yet: Settings → Plugins → YouTube, then press Connect.');
    return fn(c);
  }

  snapshot() {
    return {
      connected: this.client.isConnected(), broadcast: this.broadcast, viewers: this.viewers, likes: this.likes,
      health: this.health, stats: this.stats, error: this.error, status: this.client.status,
    };
  }

  // ---- account link: the browser is allowed to call these by name (see plugin.js clientMethods) ----
  async connect() {
    this.configure();
    return this.client.startAuth();
  }

  async disconnect() {
    await this.client.disconnect();
    this.broadcast = null; this.stats = null; this.health = null;
    return true;
  }
}

module.exports = { YouTubeRuntime };
