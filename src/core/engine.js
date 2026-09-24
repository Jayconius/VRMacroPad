// Runs buttons, tracks their state, fires triggers and owns the edit lock.
const { EventEmitter } = require('events');
const { normalizeConfig } = require('./schema');
const { defs, autoStateKey, registry: pluginRegistry } = require('./actions');
const { WidgetRuntime, registry: widgetDefs } = require('./widgets');

const LOG_LIMIT = 200;

// Adds one needs-patch ({ vr: true, media: ['spotify'] ... }) into the running total. A Set/Array value
// means "these particular ones" (avatar parameter names, macro button numbers, media app ids); the set is
// created the first time something asks for it, so no needs-key has to be declared up front.
function mergeNeeds(total, add) {
  for (const [k, v] of Object.entries(add || {})) {
    if (v instanceof Set || Array.isArray(v)) {
      if (!(total[k] instanceof Set)) total[k] = new Set();
      for (const x of v) total[k].add(x);
    } else if (v) total[k] = true;
  }
}

class Engine extends EventEmitter {
  constructor({ store, helper, providers, hub, hooks, now, random, registry }) {
    super();
    this.store = store;
    this.helper = helper;
    this.providers = providers;
    this.hub = hub;
    this.hooks = hooks;
    this.registry = registry; // this app's full plugin registry (built-ins + any user plugins)
    this.widgets = new WidgetRuntime({
      store, now, random,
      extras: {
        // The generic escape hatch, same as ctx.plugin(id) for actions: a widget from a plugin can reach
        // its own runtime by id, so it needs no bespoke wiring here. Every other built-in widget (battery,
        // twitch.ads, twitch.stream, coin/dice's "post to chat") uses only this plus media/mediaControl
        // below — the same tools a third-party widget would use, nothing built-in-only.
        plugin: (id) => providers.get(id),
        // Windows media-session control by app name: not plugin-specific (any plugin's widget can control
        // any player), so it lives here like hub/toast rather than behind ctx.plugin(id).
        media: (app) => providers.mediaData(app),
        mediaControl: (app, cmd, pos) => providers.mediaControl(app, cmd, pos),
        toast: (text, level) => this.notify(level || 'info', text),
      },
    });
    this.widgets.on('change', () => this.emitWidgetData());
    this.widgets.on('timerFinished', (button) => this.onTimerFinished(button));
    this.lastWidgetData = '{}';
    this.config = null;
    this.activePageId = null;
    this.running = new Set();
    this.localToggle = new Map();
    this.watchers = [];
    this.timeTriggers = [];
    this.lastTimeFired = '';
    this.timeTimer = null;
    this.editing = false;
    this.relockAt = 0;
    this.relockTimer = null;
    this.lastStates = '{}';
    this.log = [];
    this.startWarnings = [];
    this.hub.on('change', () => this.onHubChange());
    // A plugin's own bug is shown as an error in the Activity log instead of crashing anything.
    this.reportedPluginErrors = new Set();
    if (providers.on) providers.on('pluginError', ({ text }) => this.reportPluginError(text));
    // A widget that shows a plugin's own state ("Starting…", an error) must redraw when that status changes, even
    // though no button state moved. Cheap: nothing is sent unless the widget's data actually differs.
    if (providers.on) providers.on('status', () => { try { this.emitWidgetData(); } catch { /* a widget's bug is reported where it is drawn */ } });
  }

  // Once per distinct message, so a plugin failing on every poll shows one line, not a wall of them.
  reportPluginError(text) {
    if (this.reportedPluginErrors.has(text)) return;
    this.reportedPluginErrors.add(text);
    this.notify('error', text);
  }

  // ---- startup / config ----
  init() {
    const loaded = this.store.load();
    this.config = loaded.config;
    this.startWarnings = loaded.warnings;
    if (loaded.fresh) this.store.save(this.config);
    const runtime = this.store.readRuntime();
    this.activePageId = this.config.pages.some((p) => p.id === runtime.activePage) ? runtime.activePage : this.config.pages[0].id;
    this.applyConfig();
    this.timeTimer = setInterval(() => this.checkTimeTriggers(), 15000);
    for (const w of loaded.warnings) this.notify('warn', w);
    // Plugins that already failed (createRuntime threw, or a file would not load) before anyone was listening.
    for (const e of this.registry.errors) this.reportPluginError(`Plugin "${e.name}" could not be loaded: ${e.error}`);
    if (this.providers.problems) for (const [id, mine] of this.providers.problems) for (const text of mine.values()) this.reportPluginError(`Plugin "${(this.registry.get(id) || {}).name || id}": ${text}`);
  }

  stop() {
    clearInterval(this.timeTimer);
    clearTimeout(this.relockTimer);
    this.widgets.stop();
  }

  // Validate, persist and apply a full config from the UI.
  updateConfig(input) {
    const { config, warnings } = normalizeConfig(input, this.registry);
    // Window position/size belong to the desktop shell, not the UI: the UI's copy can be stale.
    const { width, height, x, y } = this.config.settings.window;
    Object.assign(config.settings.window, { width, height, x, y });
    this.config = config;
    if (!config.pages.some((p) => p.id === this.activePageId)) this.setActivePage(config.pages[0].id);
    this.store.save(config);
    this.applyConfig();
    this.emit('config', config);
    return warnings;
  }

  // For settings the app itself changes (window position, tray toggles) without the edit lock.
  // broadcast=false is for high-frequency, UI-irrelevant changes such as the window position.
  patchSettings(mutate, { broadcast = true } = {}) {
    const copy = JSON.parse(JSON.stringify(this.config));
    mutate(copy.settings);
    const { config } = normalizeConfig(copy, this.registry);
    this.config = config;
    this.store.save(config);
    this.providers.configure(config.settings);
    if (broadcast) this.emit('config', config);
  }

  applyConfig() {
    this.providers.configure(this.config.settings);
    this.widgets.sync(this.buttons().map((e) => e.button));
    this.rebuildTriggers();
    this.providers.sync(this.computeNeeds());
    this.onHubChange(true);
  }

  buttons() {
    const out = [];
    for (const page of this.config.pages) for (const button of page.buttons) out.push({ page, button });
    return out;
  }

  findButton(id) {
    return this.buttons().find((e) => e.button.id === id) || null;
  }

  stateKeyOf(button) {
    if (button.widget) return null; // widgets draw their own state
    const s = button.state;
    if (s.source === 'none') return null;
    if (s.source === 'toggle') return `local:${button.id}`;
    if (s.source === 'key') return s.key || null;
    return autoStateKey(button);
  }

  // Which plugins must be running for the current config. Each plugin classifies its own state/trigger
  // keys (see matchState() in its plugin.js); action and widget defs classify their own params directly.
  computeNeeds() {
    const needs = {};
    const note = (key) => {
      if (!key) return;
      const patch = pluginRegistry.needsForKey(key);
      if (patch) mergeNeeds(needs, patch);
    };
    for (const { button } of this.buttons()) {
      if (button.widget) {
        const wdef = widgetDefs.get(button.widget.type);
        if (wdef && wdef.needs) { try { mergeNeeds(needs, wdef.needs(button.widget.params || {})); } catch { /* a buggy needs() just asks for nothing */ } }
        if (button.widget.params && button.widget.params.postToChat) needs.twitch = true;
      }
      for (const step of button.steps) {
        const def = defs.get(step.action);
        if (!def || !def.needs) continue;
        try { mergeNeeds(needs, typeof def.needs === 'function' ? def.needs(step.params || {}) : { [def.needs]: true }); } catch { /* same */ }
      }
      note(this.stateKeyOf(button));
      for (const t of button.triggers) {
        if (t.type === 'state') note(t.key);
        if (t.type === 'processStart' || t.type === 'processStop') needs.process = true;
      }
    }
    for (const page of this.config.pages) if (page.autoShowProcess) needs.process = true;
    return needs;
  }

  // ---- triggers ----
  rebuildTriggers() {
    this.watchers = [];
    this.timeTriggers = [];
    const hotkeys = [];
    for (const { button } of this.buttons()) {
      for (const t of button.triggers) {
        const fire = () => this.press(button.id, { source: 'trigger' });
        if (t.type === 'hotkey' && t.accelerator) hotkeys.push({ accelerator: t.accelerator, buttonId: button.id });
        else if (t.type === 'processStart' && t.process) this.watchers.push({ key: `proc=${t.process}`, becomes: true, fire, prev: undefined });
        else if (t.type === 'processStop' && t.process) this.watchers.push({ key: `proc=${t.process}`, becomes: false, fire, prev: undefined });
        else if (t.type === 'state' && t.key) this.watchers.push({ key: t.key, becomes: t.becomes, fire, prev: undefined });
        else if (t.type === 'time') this.timeTriggers.push({ at: t.at, days: t.days, fire });
      }
    }
    for (const page of this.config.pages) {
      if (page.autoShowProcess) {
        this.watchers.push({ key: `proc=${page.autoShowProcess}`, becomes: true, fire: () => this.setActivePage(page.id), prev: undefined });
      }
    }
    for (const w of this.watchers) w.prev = this.hub.eval(w.key);
    const failed = this.hooks.registerHotkeys(hotkeys) || [];
    for (const accel of failed) this.notify('warn', `Hotkey ${accel} could not be registered (another app may be using it).`);
  }

  checkTimeTriggers() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const stamp = `${now.toDateString()} ${hhmm}`;
    if (stamp === this.lastTimeFired) return;
    let matched = false;
    for (const t of this.timeTriggers) {
      if (t.at === hhmm && t.days.includes(now.getDay())) { matched = true; t.fire(); }
    }
    if (matched) this.lastTimeFired = stamp;
  }

  onHubChange(force = false) {
    for (const w of this.watchers) {
      const v = this.hub.eval(w.key);
      if (w.prev !== undefined && v !== undefined && v !== w.prev && v === w.becomes) w.fire();
      w.prev = v;
    }
    const states = JSON.stringify(this.computeButtonStates());
    if (force || states !== this.lastStates) {
      this.lastStates = states;
      this.emit('buttonStates', JSON.parse(states));
    }
    this.emitWidgetData(force);
  }

  // ---- widgets ----
  // { buttonId: data } for every widget button. Each entry carries the server's clock ("now")
  // so the UI can keep timers right even if its own clock is off.
  computeWidgetData() {
    const out = {};
    for (const { button } of this.buttons()) if (button.widget) out[button.id] = this.widgets.data(button);
    return out;
  }

  emitWidgetData(force = false) {
    const data = this.computeWidgetData();
    const sig = JSON.stringify(data, (k, v) => (k === 'now' ? undefined : v));
    if (!force && sig === this.lastWidgetData) return;
    this.lastWidgetData = sig;
    this.emit('widgetData', data);
  }

  async widgetCommand(id, cmd, arg) {
    const found = this.findButton(id);
    if (!found || !found.button.widget) throw new Error('Unknown widget');
    try {
      await this.widgets.command(found.button, cmd, arg);
      return { ok: true };
    } catch (err) {
      this.notify('error', `${found.button.label || found.button.widget.type}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  onTimerFinished(button) {
    this.notify('info', `⏲️ ${button.label || 'Timer'} finished`);
    if (button.steps.length) {
      this.runSteps(button.steps).catch((err) => this.notify('error', `${button.label || 'Timer'}: ${err.message}`));
    }
    this.emitWidgetData();
  }

  // { buttonId: { active: bool, unknown: bool } } for every button that has a state source.
  computeButtonStates() {
    const out = {};
    for (const { button } of this.buttons()) {
      const key = this.stateKeyOf(button);
      if (!key) continue;
      const v = key.startsWith('local:') ? Boolean(this.localToggle.get(button.id)) : this.hub.eval(key);
      out[button.id] = { active: v === true, unknown: v === undefined };
    }
    return out;
  }

  // ---- running buttons ----
  async press(id, { source = 'ui' } = {}) {
    const found = this.findButton(id);
    if (!found) throw new Error('Unknown button');
    const { button } = found;
    // Hotkeys and triggers "press" a widget by tapping it (roll the dice, start the timer...).
    if (button.widget) return this.widgetCommand(id, 'tap');
    if (this.running.has(id)) return { skipped: true };
    if (!button.steps.length) {
      this.notify('info', `"${button.label || 'This button'}" has no actions yet. Unlock editing and add one.`);
      return { ok: false };
    }
    this.running.add(id);
    this.emit('running', { id, on: true });
    try {
      await this.runSteps(button.steps);
      if (button.state.source === 'toggle') {
        this.localToggle.set(id, !this.localToggle.get(id));
        this.onHubChange(true);
      }
      this.emit('pressResult', { id, ok: true, source });
      return { ok: true };
    } catch (err) {
      this.notify('error', `${button.label || 'Button'}: ${err.message}`);
      this.emit('pressResult', { id, ok: false, source });
      return { ok: false, error: err.message };
    } finally {
      this.running.delete(id);
      this.emit('running', { id, on: false });
    }
  }

  // A plugin that is not loaded (removed, or never bundled) or switched off (Settings → Plugins) still
  // gets a friendly error instead of a crash or a confusing "not connected".
  need(id, what) {
    const rt = this.providers.get(id);
    if (!rt) throw new Error(`${what} is not available (the ${id} plugin is not loaded)`);
    if (!this.providers.isEnabled(id)) throw new Error(`${what} is disabled (Settings → Plugins)`);
    return rt;
  }

  // Every action's ctx, built-in or third-party, is exactly this — no plugin gets anything more. A built-in
  // action reaches its own plugin's runtime the same way a third-party one would: ctx.plugin(id), then
  // whatever method that runtime itself exposes (ctx.plugin('obs').client.request(...), ctx.plugin('twitch')
  // .call(fn), ...). See need() above for why this throws a friendly error instead of "not connected" when
  // the plugin is missing or switched off, and docs/PLUGIN-GUIDE.md for the full contract.
  context() {
    return {
      helper: this.helper,
      hub: this.hub,
      plugin: (id) => this.need(id, (this.registry.get(id) || {}).name || id),
      toast: (text, level) => this.notify(level || 'info', text),
      // Two cross-cutting facilities, not tied to one plugin (any plugin's action can send raw OSC or
      // control a Windows media session by app name), so they live here like hub/toast.
      osc: { send: (address, args) => { const s = this.providers.settings.osc; return this.providers.osc.send(s.host, s.sendPort, address, args); } },
      oscTo: (host, port, address, args) => this.providers.osc.send(host, port, address, args),
      nowPlaying: () => this.providers.nowPlaying(),
      mediaControl: (app, cmd, pos) => this.providers.mediaControl(app, cmd, pos),
      patchSettings: (fn) => this.patchSettings(fn),
    };
  }

  async runSteps(steps) {
    const ctx = this.context();
    for (const step of steps) {
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const def = defs.get(step.action);
      if (!def) throw new Error(`Unknown action "${step.action}"`);
      await def.run(step.params || {}, ctx);
    }
  }

  // ---- pages ----
  setActivePage(id) {
    if (!this.config.pages.some((p) => p.id === id) || id === this.activePageId) return;
    this.activePageId = id;
    this.store.writeRuntime({ activePage: id });
    this.emit('page', id);
  }

  // ---- edit lock ----
  // Locked is the default and the only state after a restart.
  setEditing(on) {
    clearTimeout(this.relockTimer);
    this.editing = on;
    this.relockAt = 0;
    if (on) this.touchEdit(false);
    this.emit('edit', this.editState());
  }

  touchEdit(emit = true) {
    if (!this.editing) return;
    clearTimeout(this.relockTimer);
    const sec = this.config.settings.lock.autoRelockSec;
    this.relockAt = sec ? Date.now() + sec * 1000 : 0;
    if (sec) this.relockTimer = setTimeout(() => this.setEditing(false), sec * 1000);
    if (emit) this.emit('edit', this.editState());
  }

  editState() {
    return { on: this.editing, relockAt: this.relockAt, unlockMethod: this.config.settings.lock.unlockMethod };
  }

  // ---- notifications / log ----
  notify(level, text) {
    const entry = { t: Date.now(), level, text };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.emit('toast', entry);
  }
}

module.exports = { Engine };
