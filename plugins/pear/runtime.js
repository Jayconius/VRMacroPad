// Pear Desktop (YouTube Music): publishes its live state to the hub while a button, widget or trigger needs
// it. The client (client.js) is the WebSocket connection and the one-time "click Allow in Pear" sign-in,
// unchanged from before the plugin split; ctx.client is that one PearClient instance.
class PearRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = ctx.client;
    if (this.client) this.client.on('change', () => { this.publish(); this.ctx.emitStatus(); });
  }

  configure() {
    if (this.client) this.client.configure(this.ctx.settings());
  }

  sync(needs) {
    if (!this.client) return;
    this.client.want(Boolean(needs.pear));
    if (!needs.pear) this.clear(false);
  }

  stop() {
    if (this.client) this.client.stop();
  }

  status() {
    return this.client ? this.client.info() : { status: 'off' };
  }

  publish() {
    const p = this.client;
    if (!p) return;
    const s = p.state;
    this.hub.set('pear.connected', p.isConnected());
    if (!p.isConnected() || !s) { this.clear(false); return; }
    this.hub.set('pear.playing', Boolean(s.isPlaying));
    this.hub.set('pear.shuffle', Boolean(s.shuffle));
    this.hub.set('pear.repeat', Boolean(s.repeat) && s.repeat !== 'NONE');
    this.hub.set('pear.muted', Boolean(s.muted));
    this.hub.set('pear.liked', p.like === 'LIKE');
    this.hub.set('pear.disliked', p.like === 'DISLIKE');
    this.hub.set('pear.info', p.view()); // changing every second keeps widgets moving
  }

  clear(includeConnected = true) {
    for (const k of ['pear.playing', 'pear.shuffle', 'pear.repeat', 'pear.muted', 'pear.liked', 'pear.disliked', 'pear.info']) this.hub.remove(k);
    if (includeConnected) this.hub.remove('pear.connected');
  }

  view() {
    return this.client ? this.client.view() : { available: false, error: 'Pear is not available' };
  }

  async thumbFor(url) {
    return this.client ? this.client.thumbFor(url) : '';
  }

  // Runs a Pear call, with a friendly message when it is not set up or not connected.
  async call(fn) {
    const c = this.client;
    if (!c) throw new Error('Pear is not available');
    if (!c.token) throw new Error('Pear is not connected. Connect it in Settings → Connections (Pear asks you to click Allow once).');
    return fn(c);
  }

  async control(cmd, arg) {
    if (!this.client) throw new Error('Pear is not available');
    await this.client.control(cmd, arg);
  }

  // ---- account link: the browser is allowed to call these by name (see plugin.js clientMethods) ----
  async connect() {
    if (!this.client) throw new Error('Pear is not available');
    this.client.authorize(); // waits for you to click Allow in Pear; progress arrives as status updates
    return true;
  }

  async disconnect() {
    if (this.client) this.client.disconnect();
    return true;
  }
}

module.exports = { PearRuntime };
