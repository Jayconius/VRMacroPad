// Polls Voicemeeter for the parameters and macro buttons that buttons actually follow (asking for
// everything would be both slow and pointless). Moved unchanged from the old core Providers class; the
// Windows side is helper/VoiceMeeter.cs, reached here as ctx.winHelper('voicemeeter').
const POLL_MS = 700;

class VoicemeeterRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.timer = null;
    this.busy = false;
    this.data = { installed: true, connected: false, error: '' };
    this.wantedParams = new Set();
    this.wantedMacros = new Set();
    this.active = false;
  }

  get helper() { return this.ctx.winHelper('voicemeeter'); }

  sync(needs) {
    this.wantedParams = needs.vmParams instanceof Set ? needs.vmParams : new Set();
    this.wantedMacros = needs.vmMacros instanceof Set ? needs.vmMacros : new Set();
    this.active = Boolean(needs.vm);
    if (needs.vm) this.start(); else this.stop();
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.helper.release(); // logs out of Voicemeeter while nothing needs it
    this.data = { installed: true, connected: false, error: '' };
    for (const k of ['vm.connected', 'vm.param', 'vm.macro']) this.hub.remove(k);
  }

  status() {
    if (!this.active) return { state: 'off', error: '', info: '' };
    return { state: this.data.connected ? 'connected' : 'connecting', error: this.data.error, info: this.data.connected ? `${this.data.typeName} ${this.data.version}` : '' };
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await this.helper.call('poll', { names: [...this.wantedParams], macros: [...this.wantedMacros] }, 4000);
      const was = this.data.connected;
      this.data = { installed: res.installed !== false, connected: Boolean(res.connected), error: res.connected ? '' : (res.error || 'Voicemeeter is not running'), typeName: res.typeName || '', version: res.version || '', strips: res.strips || 0, buses: res.buses || 0 };
      this.hub.set('vm.connected', this.data.connected);
      if (this.data.connected) {
        this.hub.set('vm.param', res.values || {});
        this.hub.set('vm.macro', res.macros || {});
      } else {
        this.hub.remove('vm.param');
        this.hub.remove('vm.macro');
      }
      if (was !== this.data.connected) this.ctx.emitStatus();
    } catch (err) {
      this.data = { installed: true, connected: false, error: err.message };
      this.hub.set('vm.connected', false);
      this.hub.remove('vm.param');
      this.hub.remove('vm.macro');
    } finally {
      this.busy = false;
    }
  }

  // Sends one request to Voicemeeter (set, script, get...) and refreshes what buttons follow.
  async call(op, args = {}) {
    try {
      return await this.helper.call(op, args, 6000);
    } finally {
      if (this.timer) setTimeout(() => this.poll(), 60);
    }
  }

  async options() {
    const res = await this.helper.call('devices', {}, 6000);
    const seen = new Set();
    const out = [];
    for (const d of [...(res.outputs || []), ...(res.inputs || [])]) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ value: d.name, label: `${d.name}  (${d.driver.toUpperCase()})` });
    }
    return out;
  }
}

module.exports = { VoicemeeterRuntime };
