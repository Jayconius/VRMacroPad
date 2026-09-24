// Keeps one OBS WebSocket connection alive while something needs it, loads scene/input state and follows
// its events. Moved unchanged from the old core Providers class; the connection itself is client.js
// (obs-websocket v5), unchanged from before the plugin split.
const { ObsClient } = require('./client');

class ObsRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new ObsClient(); // actions reach it via ctx.plugin('obs').client
    this.cache = { scenes: [], inputs: [] };
    this.adHoc = 0; // "keep it connected a little longer" deadline, for the editor's dropdowns
    this.adHocTimer = null;
    this.lastNeeds = {};
    this.client.on('status', (s) => this.onStatus(s));
    this.client.on('event', (e) => this.onEvent(e));
  }

  configure() {
    this.client.configure(this.ctx.settings());
  }

  sync(needs) {
    this.lastNeeds = needs;
    this.client.want(Boolean(needs.obs) || Date.now() < this.adHoc);
  }

  stop() {
    this.client.want(false);
    clearTimeout(this.adHocTimer);
  }

  status() {
    return { state: this.client.status, error: this.client.error };
  }

  // Lets the editor list OBS scenes before any button uses OBS.
  keepAliveFor(ms) {
    this.adHoc = Date.now() + ms;
    clearTimeout(this.adHocTimer);
    this.adHocTimer = setTimeout(() => this.sync(this.lastNeeds), ms + 50);
    this.client.want(true);
  }

  onStatus(status) {
    if (status === 'connected') this.loadState();
    else for (const k of ['obs.recording', 'obs.streaming', 'obs.replay', 'obs.scene', 'obs.inputMuted']) this.hub.remove(k);
    this.ctx.emitStatus();
  }

  async loadState() {
    const ask = (type, data) => this.client.request(type, data).catch(() => null);
    const [rec, stream, replay, scenes, inputs] = await Promise.all([
      ask('GetRecordStatus'), ask('GetStreamStatus'), ask('GetReplayBufferStatus'), ask('GetSceneList'), ask('GetInputList'),
    ]);
    this.hub.set('obs.recording', Boolean(rec && rec.outputActive));
    this.hub.set('obs.streaming', Boolean(stream && stream.outputActive));
    this.hub.set('obs.replay', Boolean(replay && replay.outputActive));
    if (scenes) {
      this.cache.scenes = scenes.scenes.map((s) => s.sceneName).reverse();
      this.hub.set('obs.scene', scenes.currentProgramSceneName);
    }
    if (inputs) {
      const names = inputs.inputs.map((i) => i.inputName);
      this.cache.inputs = names;
      const muted = {};
      await Promise.all(names.slice(0, 60).map(async (name) => {
        const r = await ask('GetInputMute', { inputName: name });
        if (r) muted[name] = r.inputMuted;
      }));
      this.hub.set('obs.inputMuted', muted);
    }
  }

  onEvent({ type, data }) {
    if (type === 'RecordStateChanged') this.hub.set('obs.recording', Boolean(data.outputActive));
    else if (type === 'StreamStateChanged') this.hub.set('obs.streaming', Boolean(data.outputActive));
    else if (type === 'ReplayBufferStateChanged') this.hub.set('obs.replay', Boolean(data.outputActive));
    else if (type === 'CurrentProgramSceneChanged') this.hub.set('obs.scene', data.sceneName);
    else if (type === 'InputMuteStateChanged') this.hub.set('obs.inputMuted', { ...(this.hub.get('obs.inputMuted') || {}), [data.inputName]: data.inputMuted });
    else if (type === 'SceneListChanged' || type === 'InputCreated' || type === 'InputRemoved') this.loadState();
  }

  async options(kind) {
    this.keepAliveFor(60000);
    if (this.client.status !== 'connected') {
      await new Promise((resolve) => {
        const done = () => { this.client.off('status', done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 2500);
        this.client.on('status', done);
      });
    }
    if (this.client.status !== 'connected') {
      throw new Error(this.client.status === 'auth-failed' ? 'OBS password is wrong (Settings → Connections)' : 'OBS is not reachable. Is it running with WebSocket enabled? (Tools → WebSocket Server Settings)');
    }
    await this.loadState();
    const list = kind === 'obs.scenes' ? this.cache.scenes : this.cache.inputs;
    return list.map((n) => ({ value: n, label: n }));
  }
}

module.exports = { ObsRuntime };
