// Listens for VRChat's own OSC messages (mic mute, avatar parameters, AFK/seated/VR-mode...) and remembers
// what an avatar-parameter button last set, since VRChat only reports the parameters it changes itself.
// Sending TO VRChat (chatbox, game controls, avatar parameters) needs no listener and is not gated here;
// it goes straight out over ctx.osc from the action's own run(), same as any OSC-capable app.
const VRC_BUILTIN = { AFK: 'vrc.AFK', Seated: 'vrc.Seated', Earmuffs: 'vrc.Earmuffs', InStation: 'vrc.InStation', VRMode: 'vrc.VRMode' };

class VrchatRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.listener = null;
    this.state = 'off'; // off | listening | error
    this.error = '';
    this.lastHeard = 0;
    this.params = {};
    this.needsExtra = new Set();
    this.lastOsc = null;
  }

  // A changed listen port (or listening switched off) needs a fresh socket; sync() re-opens it if still needed.
  configure() {
    const osc = this.ctx.coreSettings().osc;
    if (this.lastOsc && (this.lastOsc.listenPort !== osc.listenPort || this.lastOsc.listen !== osc.listen || this.lastOsc.host !== osc.host)) this.stop();
    this.lastOsc = { ...osc };
  }

  sync(needs) {
    this.needsExtra = needs.vrcParams instanceof Set ? needs.vrcParams : new Set();
    const s = this.ctx.coreSettings();
    if (needs.vrc && s && s.osc && s.osc.listen) this.start(); else this.stop();
  }

  start() {
    if (this.listener) return;
    const s = this.ctx.coreSettings();
    const { host, listenPort } = s.osc;
    const l = this.ctx.oscListen(listenPort, host === 'localhost' ? '127.0.0.1' : host);
    this.listener = l;
    l.on('listening', () => { this.state = 'listening'; this.error = ''; this.ctx.emitStatus(); });
    l.on('error', (err) => {
      this.state = 'error';
      this.error = err.code === 'EADDRINUSE' ? `Port ${listenPort} is already used by another app` : err.message;
      this.ctx.emitStatus();
    });
    l.on('message', (m) => this.onOsc(m));
    l.start();
  }

  stop() {
    if (this.listener) this.listener.stop();
    this.listener = null;
    this.state = 'off';
    this.error = '';
    for (const k of ['vrc.MuteSelf', 'vrc.avatar', ...Object.values(VRC_BUILTIN)]) this.hub.remove(k);
    this.ctx.emitStatus();
  }

  onOsc({ address, args }) {
    this.lastHeard = Date.now();
    if (address === '/avatar/change') { this.hub.set('vrc.avatar', String(args[0])); return; }
    const prefix = '/avatar/parameters/';
    if (!address.startsWith(prefix)) return;
    const name = address.slice(prefix.length);
    const value = args[0];
    if (name === 'MuteSelf') { this.hub.set('vrc.MuteSelf', Boolean(value)); return; }
    if (VRC_BUILTIN[name]) { this.hub.set(VRC_BUILTIN[name], Boolean(value)); return; }
    // Avatars stream dozens of parameters per second; only publish the ones something watches.
    const wanted = this.needsExtra || new Set();
    if (wanted.has(name) || name in this.params) this.remember(name, value);
  }

  status() {
    return { state: this.state, error: this.error, lastHeard: this.lastHeard };
  }

  remember(name, value) {
    this.params[name] = value;
    this.hub.set('vrc.param', { ...this.params });
  }
}

module.exports = { VrchatRuntime };
