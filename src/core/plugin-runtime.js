// Runs every plugin's live connection to the outside world (OBS, Twitch, SteamVR, Voicemeeter...), starting
// and stopping each one only while a button, widget or trigger actually needs it. This is the successor to
// the old monolithic "Providers" class: the same job, but each plugin now owns its own piece of it (see
// plugins/*/runtime.js and docs/PLUGIN-GUIDE.md for the contract a plugin's createRuntime(ctx) must meet).
const { EventEmitter } = require('events');
const { Helper } = require('./helper');
const { OscSender, OscListener } = require('./osc');
const appConfig = require('./app-config');

class PluginRuntime extends EventEmitter {
  // registry: a plugin-loader PluginRegistry. helper/media/vr/vm: pre-built Helper instances for the kinds
  // every built-in plugin uses (tests substitute fakes here, exactly as they did for the old Providers).
  // twitch/pear/spotify: pre-built client instances (option overrides for tests flow through these, not
  // through the generic plugin ctx, because they need constructor-time settings tests must control).
  constructor({ registry, helper, media, vr, vm, twitch, pear, spotify, hub, now = () => Date.now(), dataDir = '', store = null, buildDir = '', secrets = null }) {
    super();
    this.registry = registry;
    this.helper = helper; // the audio/keys Windows helper: status().helper reads it directly, as before
    this.helperMap = { audio: helper, media, vr, voicemeeter: vm };
    this.extraHelpers = new Map(); // kind -> lazily built Helper, for plugins that bring their own
    this.clients = { twitch, pear, spotify };
    this.hub = hub;
    this.now = now;
    this.dataDir = dataDir;
    this.store = store;
    this.buildDir = buildDir;
    this.secretsStore = secrets;
    this.settings = null;
    this.needs = {};
    this.osc = new OscSender();
    this.runtimes = new Map(); // plugin id -> whatever createRuntime(ctx) returned
    this.problems = new Map(); // plugin id -> Map(where -> text): what is currently throwing inside that plugin
    for (const manifest of registry.list()) this.instantiate(manifest);
  }

  instantiate(manifest) {
    if (manifest.broken || !manifest.createRuntime) return;
    try {
      const rt = manifest.createRuntime(this.ctxFor(manifest.id));
      if (rt) this.runtimes.set(manifest.id, rt);
    } catch (err) {
      this.problem(manifest.id, 'createRuntime', err);
    }
  }

  // Third-party code must never be able to take the app (or another plugin) down: every call into a plugin's
  // runtime goes through here. A throw is remembered, shown on that plugin's card and in the Activity log
  // (once per distinct problem), and the plugin is otherwise left alone until the next call succeeds.
  problem(id, where, err) {
    const text = `${where}() failed: ${err && err.message ? err.message : err}`;
    if (!this.problems.has(id)) this.problems.set(id, new Map());
    const mine = this.problems.get(id);
    if (mine.get(where) === text) return; // already known and already reported
    mine.set(where, text);
    const name = (this.registry.get(id) || {}).name || id;
    this.emit('pluginError', { id, text: `Plugin "${name}": ${text}` });
    this.emit('status');
  }

  guard(id, where, fn) {
    try {
      const out = fn();
      const mine = this.problems.get(id);
      if (mine && mine.delete(where)) {
        if (!mine.size) this.problems.delete(id);
        this.emit('status');
      }
      return out;
    } catch (err) {
      this.problem(id, where, err);
      return undefined;
    }
  }

  problemText(id) {
    const mine = this.problems.get(id);
    return mine && mine.size ? [...mine.values()][0] : '';
  }

  // A Windows helper process for a given kind, shared across whoever asks for it. The five kinds the app
  // ships with are pre-built (so tests can hand in fakes); anything else is built lazily and cached.
  helperFor(kind) {
    if (this.helperMap[kind]) return this.helperMap[kind];
    if (!this.extraHelpers.has(kind)) this.extraHelpers.set(kind, new Helper(this.buildDir, kind));
    return this.extraHelpers.get(kind);
  }

  secretsFor(id) {
    const prefix = `plugin:${id}:`;
    const store = this.secretsStore;
    return {
      get: (key) => (store ? store.get(prefix + key) : null),
      set: (key, value) => { if (store) store.set(prefix + key, value); },
      delete: (key) => { if (store) store.delete(prefix + key); },
      isEncrypted: () => Boolean(store && store.isEncrypted()),
    };
  }

  // Everything a plugin's createRuntime(ctx) gets. `settings()`/`coreSettings()` are live: they always read
  // this.settings at call time, so a plugin never needs a fresh ctx after a settings change.
  ctxFor(id) {
    return {
      id,
      hub: this.hub,
      now: this.now,
      dataDir: this.dataDir,
      buildDir: this.buildDir,
      client: this.clients[id],
      emitStatus: () => this.emit('status'),
      settings: () => (this.settings && this.settings.plugins && this.settings.plugins[id]) || {},
      coreSettings: () => this.settings,
      secrets: this.secretsFor(id),
      winHelper: (kind) => this.helperFor(kind),
      osc: this.osc,
      oscListen: (port, host) => new OscListener(port, host),
      store: {
        readRuntime: () => (this.store ? this.store.readRuntime() : {}),
        writeRuntime: (patch) => { if (this.store) this.store.writeRuntime(patch); },
      },
      app: { twitchClientId: appConfig.twitchClientId, spotifyClientId: appConfig.spotifyClientId },
      plugins: { get: (otherId) => this.runtimes.get(otherId) || null },
    };
  }

  get(id) {
    return this.runtimes.get(id) || null;
  }

  // Back-compat / test convenience: the old Providers class exposed its VRChat OSC listener directly.
  get listener() {
    const rt = this.get('vrchat');
    return rt ? rt.listener : null;
  }

  // Every plugin gets an enable/disable toggle for free (Settings → Plugins), on top of whatever its own
  // settingsFields declare — see the "enabled" field schema.js's normalizePluginSettings always adds.
  isEnabled(id) {
    const s = this.settings && this.settings.plugins && this.settings.plugins[id];
    return !s || s.enabled !== false;
  }

  // ---- lifecycle ----
  configure(settings) {
    this.settings = settings;
    // The overlay's "dim the view" is a core VR-overlay setting, not a plugin, but buttons follow it like one.
    this.hub.set('vr.dimmed', Boolean(settings.overlay && settings.overlay.dim > 0));
    for (const [id, rt] of this.runtimes) {
      if (!this.isEnabled(id)) { if (rt.stop) this.guard(id, 'stop', () => rt.stop()); continue; }
      if (rt.configure) this.guard(id, 'configure', () => rt.configure());
    }
    this.sync(this.needs);
  }

  // A plugin with autoConnect on is treated as always needed, so it reconnects a saved session at startup
  // (or as soon as the app it talks to becomes reachable, if its own runtime already retries — Pear's does)
  // instead of waiting for a button to need it first. It never starts a *fresh* sign-in on its own — connect()
  // is only ever called by a person pressing Connect — so there is nothing to auto-approve or pop up.
  // needsKeys lets a plugin override which needs[] key(s) its own sync(needs) actually checks, for the rare
  // case that differs from its id (SteamVR checks needs.vr, VRChat needs.vrc, Voicemeeter needs.vm — none of
  // which have a connect() flow today, so this only matters if a future or third-party plugin needs it).
  needsFor(id, needs) {
    const s = this.settings && this.settings.plugins && this.settings.plugins[id];
    if (!s || !s.autoConnect) return needs;
    const manifest = this.registry.get(id);
    const keys = (manifest && manifest.needsKeys) || [id];
    const patched = { ...needs };
    for (const k of keys) patched[k] = true;
    return patched;
  }

  sync(needs) {
    this.needs = needs;
    for (const [id, rt] of this.runtimes) {
      if (!this.isEnabled(id)) { if (rt.stop) this.guard(id, 'stop', () => rt.stop()); continue; }
      if (rt.sync) this.guard(id, 'sync', () => rt.sync(this.needsFor(id, needs)));
    }
  }

  stop() {
    for (const [id, rt] of this.runtimes) if (rt.stop) this.guard(id, 'stop', () => rt.stop());
    this.osc.close();
  }

  status() {
    const plugins = {};
    for (const id of new Set([...this.runtimes.keys(), ...this.problems.keys()])) {
      const rt = this.runtimes.get(id);
      if (!this.isEnabled(id)) { plugins[id] = { state: 'disabled', error: '' }; continue; }
      let st = rt && rt.status ? this.guard(id, 'status', () => rt.status()) : undefined;
      const p = this.problemText(id);
      if (p) st = { ...(st || {}), state: 'error', status: undefined, error: p };
      if (st) plugins[id] = st;
    }
    return { helper: this.helper ? this.helper.status : 'off', helperError: this.helper ? this.helper.error : '', plugins };
  }

  // ---- for the editor's dropdowns: each plugin registers the kinds of lists it can answer ----
  // args: the current values of the fields this list depends on (a param's optionsFilter), e.g. { board: 'Anime' }.
  async options(kind, args = {}) {
    for (const manifest of this.registry.list()) {
      if (manifest.optionLists && manifest.optionLists[kind]) return manifest.optionLists[kind](this.ctxFor(manifest.id), args);
    }
    throw new Error(`Unknown option list "${kind}"`);
  }

  // ---- media: a plugin can register as the definitive source for one app id (mediaBridge, Pear's own
  // local API instead of the Windows media session) or as a decorator that adds its own extra state onto
  // the generic reading for apps matching a pattern (likeProvider, Spotify's Like — Windows has no like
  // button). Neither hook is keyed to "pear" or "spotify" here; any plugin can declare either. Anything
  // that matches neither goes to the starter pack's generic Windows-media-session control.
  mediaBridgeFor(app) {
    for (const m of this.registry.list()) if (m.mediaBridge && m.mediaBridge.app === app) return this.get(m.id);
    return null;
  }
  likeProviderFor(app) {
    for (const m of this.registry.list()) if (m.likeProvider && m.likeProvider.matches(app)) return this.get(m.id);
    return null;
  }

  async mediaControl(app, cmd, arg) {
    const bridge = this.mediaBridgeFor(app);
    if (bridge) { await bridge.control(cmd, arg); return; }
    if (cmd === 'like' || cmd === 'dislike') {
      const provider = this.likeProviderFor(app);
      if (!provider) throw new Error('Like is not available for this player');
      if (cmd === 'dislike' && !provider.dislike) throw new Error(`${app} has no dislike`);
      await provider.like(cmd === 'dislike' ? 'dislike' : 'toggle');
      return;
    }
    const starter = this.get('starter');
    if (!starter) throw new Error('Media control is not available');
    await starter.control(app, cmd, arg);
  }

  mediaData(app) {
    const bridge = this.mediaBridgeFor(app);
    if (bridge) return bridge.view();
    const starter = this.get('starter');
    const info = starter ? starter.mediaData(app) : { available: false, error: '', pending: true };
    const provider = info.available ? this.likeProviderFor(app) : null;
    return provider && provider.decorate ? provider.decorate(info) : info;
  }

  nowPlaying() {
    const starter = this.get('starter');
    return starter ? starter.nowPlaying() : null;
  }

  async thumb(key) {
    if (/^https:\/\//.test(key)) {
      for (const m of this.registry.list()) {
        const rt = m.mediaBridge ? this.get(m.id) : null;
        if (rt && rt.thumbFor) { const t = await rt.thumbFor(key); if (t) return t; }
      }
    }
    const starter = this.get('starter');
    return starter ? starter.thumb(key) : '';
  }
}

module.exports = { PluginRuntime };
