// "Widget" buttons: mini screens that show live information (clock, timer, dice, battery,
// now-playing, Twitch ads...). Each definition says how to describe it in the UI, what data
// it shows, and what happens when it is tapped. State that must survive a restart (running
// timers) lives in WidgetRuntime.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CATEGORY = 'Mini screens & tools';

// ---- pure helpers (exported for tests) ----
// rand(n) returns an integer 1..n.
function rollDice({ count = 1, sides = 6, modifier = 0, mode = 'normal' }, rand) {
  const n = Math.max(1, Math.min(20, Math.round(count)));
  const s = Math.max(2, Math.min(1000, Math.round(sides)));
  const mod = Math.round(modifier) || 0;
  let rolls = Array.from({ length: n }, () => rand(s));
  let dropped = [];
  // Advantage / disadvantage: roll the die twice and keep the better / worse one.
  if (n === 1 && s === 20 && (mode === 'advantage' || mode === 'disadvantage')) {
    const second = rand(s);
    const keepFirst = mode === 'advantage' ? rolls[0] >= second : rolls[0] <= second;
    dropped = [keepFirst ? second : rolls[0]];
    rolls = [keepFirst ? rolls[0] : second];
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + mod;
  const notation = `${n > 1 ? n : ''}d${s}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}${dropped.length ? (mode === 'advantage' ? ' adv' : ' dis') : ''}`;
  const detail = `${rolls.join(' + ')}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''}`;
  return { rolls, dropped, modifier: mod, total, notation, detail, sides: s, count: n, natural: s === 20 && n === 1 ? rolls[0] : null };
}

function flipCoin(rand) {
  return rand(2) === 1 ? 'Heads' : 'Tails';
}

// "{result}" style placeholders; unknown ones are left as typed so typos are visible.
function fillTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function timerDurationMs(params) {
  const m = Math.max(0, Math.min(999, Math.round(Number(params.minutes) || 0)));
  const s = Math.max(0, Math.min(59, Math.round(Number(params.seconds) || 0)));
  return Math.max(1000, (m * 60 + s) * 1000);
}

// ---- definitions ----
// Each plugin registers its own widgets (Starter: clock/timer/stopwatch/coin/dice/media; SteamVR: battery; Twitch: twitch.ads/twitch.stream)
// by calling registerWidgets() below with an array in this same shape.

const registry = new Map(); // widget type -> def, populated by registerWidgets() as plugins load

// Adds (or replaces, for the same def object) widget definitions into the shared registry. `defsOrMap` is
// either an array of defs (a plugin's own `widgets` list) or a Map already keyed by id (the plugin loader's).
function registerWidgets(defsOrMap) {
  const entries = defsOrMap instanceof Map ? defsOrMap.entries() : defsOrMap.map((d) => [d.id, d]);
  for (const [id, d] of entries) registry.set(id, d);
}

function widgetCatalog() {
  return [...registry.values()].map((d) => ({
    id: d.id, category: d.category || CATEGORY, label: d.label, description: d.description, icon: d.icon, size: d.size,
    params: d.params, defaults: d.defaults, hasFinishSteps: Boolean(d.hasFinishSteps),
    // How a plugin's widget reacts to a tap: 'none' (default) | 'tap' | 'tap-hold' — its command(ctx, button, state, cmd) gets 'tap' / 'hold'.
    interaction: ['tap', 'tap-hold'].includes(d.interaction) ? d.interaction : 'none',
  }));
}

// ---- runtime ----
class WidgetRuntime extends EventEmitter {
  // engine supplies: config buttons, runSteps, notify, providers-derived data getters (ctxExtras)
  constructor({ store, now = () => Date.now(), random = (n) => crypto.randomInt(1, n + 1), extras }) {
    super();
    this.store = store;
    this.now = now;
    this.random = random;
    this.extras = extras; // functions supplying vr/media/twitch data and actions
    this.states = new Map();
    this.timers = new Map();
    this.buttons = new Map();
    const saved = store.readRuntime().widgets;
    this.saved = saved && typeof saved === 'object' ? saved : {};
  }

  context() {
    return { now: this.now, random: this.random, runtime: this, ...this.extras };
  }

  // Called with every button whenever the config changes.
  sync(buttons) {
    const live = new Set();
    this.buttons = new Map();
    for (const b of buttons) {
      if (!b.widget || !registry.has(b.widget.type)) continue;
      live.add(b.id);
      this.buttons.set(b.id, b);
      if (!this.states.has(b.id)) {
        const def = registry.get(b.widget.type);
        const restored = this.saved[b.id];
        const st = restored && restored.type === b.widget.type ? { ...def.initState(), ...restored.state } : def.initState();
        this.states.set(b.id, st);
        // A timer that ran out while the app was closed is finished, but its steps do not run late.
        if (b.widget.type === 'timer' && st.mode === 'running' && st.endsAt <= this.now()) Object.assign(st, { mode: 'done', endsAt: 0, remainingMs: 0 });
      }
    }
    for (const id of [...this.states.keys()]) {
      if (!live.has(id)) { this.states.delete(id); this.clearTimer(id); }
    }
    for (const b of this.buttons.values()) if (b.widget.type === 'timer') this.arm(b);
    this.persist();
  }

  persist() {
    const out = {};
    for (const [id, st] of this.states) out[id] = { type: this.buttons.get(id).widget.type, state: st };
    this.store.writeRuntime({ widgets: out });
  }

  clearTimer(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  // Schedules the "finished" moment of a running timer.
  arm(button) {
    this.clearTimer(button.id);
    const st = this.states.get(button.id);
    if (!st || st.mode !== 'running') return;
    const delay = Math.max(0, st.endsAt - this.now());
    this.timers.set(button.id, setTimeout(() => this.finish(button.id), Math.min(delay, 2 ** 31 - 1)));
  }

  setTimer(button, st, mode) {
    if (mode === 'running') { st.endsAt = this.now() + st.remainingMs; st.mode = 'running'; this.arm(button); }
    else if (mode === 'paused') { st.mode = 'paused'; st.endsAt = 0; this.clearTimer(button.id); }
    else { Object.assign(st, { mode: 'idle', endsAt: 0, remainingMs: 0 }); this.clearTimer(button.id); }
  }

  finish(id) {
    const st = this.states.get(id);
    const button = this.buttons.get(id);
    if (!st || !button || st.mode !== 'running') return;
    if (st.endsAt > this.now() + 5) { this.arm(button); return; } // fired early (clock adjustment)
    Object.assign(st, { mode: 'done', endsAt: 0, remainingMs: 0 });
    this.clearTimer(id);
    this.persist();
    this.emit('change');
    this.emit('timerFinished', button);
  }

  data(button) {
    const def = registry.get(button.widget.type);
    if (!def) return { unavailable: true, now: this.now() };
    try {
      const st = this.states.get(button.id) || (def.initState ? def.initState() : {});
      return { ...def.data(this.context(), button, st), now: this.now() };
    } catch (err) {
      // A widget from a plugin that throws shows as unavailable, with the reason, instead of breaking the page.
      return { unavailable: true, error: err.message, now: this.now() };
    }
  }

  async command(button, cmd, arg) {
    const def = registry.get(button.widget && button.widget.type);
    if (!def) throw new Error('That widget is not available in this version');
    if (!this.states.has(button.id)) this.states.set(button.id, def.initState());
    const st = this.states.get(button.id);
    await def.command(this.context(), button, st, cmd, arg);
    this.persist();
    this.emit('change');
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }
}

// Assigned before the self-load below runs, so a plugin's own widgets.js can safely require this module for
// rollDice/fillTemplate/etc. even while this file is still loading (a starter -> plugin-loader -> starter's
// own widgets.js -> back here circular require would otherwise see an empty module.exports).
module.exports = { WidgetRuntime, widgetCatalog, registry, registerWidgets, rollDice, flipCoin, fillTemplate, timerDurationMs, CATEGORY };

// Widgets bundled with the app register themselves here at module load, exactly like the old static array
// (so `require('./widgets')` alone, with no other module required first, is fully populated as before).
// A running app additionally merges in the user's own plugins via actions/index.js's loadUserPlugins().
{
  const { builtinRegistry } = require('./plugin-loader');
  for (const manifest of builtinRegistry().list()) if (manifest.widgets) registerWidgets(manifest.widgets);
}
