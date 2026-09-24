// Only for "Like": everything else about Spotify (play, skip, shuffle, repeat, seek) goes through the
// starter plugin's generic Windows media-session control and needs no Spotify plugin at all. The client
// (client.js) is the PKCE sign-in and the Web API calls, unchanged from before the plugin split.
const POLL_MS = 8000;

class SpotifyRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = ctx.client;
    this.timer = null;
    this.busy = false;
    this.liked = null; // { uri, liked } for the song playing now
    if (this.client) this.client.on('status', () => this.ctx.emitStatus());
  }

  configure() {
    if (this.client) this.client.configure({ clientId: this.ctx.settings().clientId });
  }

  sync(needs) {
    if (needs.spotify) this.start(); else this.stop();
  }

  start() {
    if (this.timer || !this.client) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.liked = null;
    this.hub.remove('spotify.liked');
    this.hub.remove('spotify.connected');
  }

  status() {
    return this.client ? this.client.info() : { status: 'off' };
  }

  async poll() {
    if (this.busy || !this.client) return;
    this.busy = true;
    try {
      this.hub.set('spotify.connected', this.client.isConnected());
      if (!this.client.isConnected()) { this.liked = null; this.hub.set('spotify.liked', false); return; }
      const s = await this.client.likedState();
      this.liked = s ? { uri: s.track.uri, liked: s.liked } : null;
      this.hub.set('spotify.liked', Boolean(s && s.liked));
    } catch { /* the client reports its own status */ } finally {
      this.busy = false;
    }
  }

  // Runs a Spotify Web API call, with a friendly message when it is not set up.
  async call(fn) {
    const c = this.client;
    if (!c || !c.isConnected()) throw new Error('Spotify likes need a one-time connection: Settings → Connections → Spotify → Connect.');
    return fn(c);
  }

  async like(mode) {
    const r = await this.call((c) => c.likeCurrent(mode));
    this.liked = { uri: r.track.uri, liked: r.liked };
    this.hub.set('spotify.liked', r.liked);
    const starter = this.ctx.plugins.get('starter');
    if (starter) setTimeout(() => starter.pollMedia(), 250);
    return r;
  }

  // Joins Spotify's own like state onto the generic Windows media-session info the starter plugin reads.
  decorate(info) {
    if (!this.client || !this.client.isConnected() || !this.liked) return info;
    return { ...info, extras: { shuffle: false, repeat: 'NONE', ...(info.extras || {}), liked: this.liked.liked } };
  }

  // ---- account link: the browser is allowed to call these by name (see plugin.js clientMethods) ----
  async connect() {
    if (!this.client) throw new Error('Spotify is not available');
    return this.client.startAuth();
  }

  async disconnect() {
    if (this.client) await this.client.disconnect();
    return true;
  }
}

module.exports = { SpotifyRuntime };
