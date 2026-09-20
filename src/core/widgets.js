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

// "serial=Name" per line -> { serial: Name }
function parseNames(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const CLASS_ORDER = { hmd: 0, controller: 1, tracker: 2, basestation: 3, other: 4 };

// Names for a whole list of devices. Trackers are numbered by serial so the numbers stay put when one
// drops out or the order SteamVR reports them in changes.
function nameDevices(devices, names) {
  const trackers = devices.filter((d) => d.class === 'tracker' && !names[(d.serial || '').toLowerCase()]).map((d) => d.serial).sort();
  const out = new Map();
  for (const d of devices) {
    const custom = names[(d.serial || '').toLowerCase()];
    let name = custom;
    if (!name) {
      if (d.class === 'hmd') name = 'Headset';
      else if (d.class === 'controller') name = d.role === 'left' ? 'Left controller' : d.role === 'right' ? 'Right controller' : 'Controller';
      else if (d.class === 'tracker') name = `Tracker ${trackers.indexOf(d.serial) + 1}`;
      else if (d.class === 'basestation') name = 'Base station';
      else name = d.model || 'Device';
    }
    out.set(d, name);
  }
  return out;
}

// ---- device pictures ----
// The illustrated pack in src/ui/assets/devices: HMD-0..5, Controller-0..3 (+L/R), Tracker-0..2,
// Lighthouse-1.0/2.0. The UI adds "L" for the low-battery version and "DC" to a base station that is off.
const PICTURE_PREFIX = { hmd: 'HMD', controller: 'Controller', tracker: 'Tracker', basestation: 'Lighthouse' };
const PICTURE_STYLES = { hmd: ['0', '1', '2', '3', '4', '5'], controller: ['0', '1', '2', '3'], tracker: ['0', '1', '2'], basestation: ['1.0', '2.0'] };

function pictureFor(d, override) {
  const prefix = PICTURE_PREFIX[d.class];
  if (!prefix) return '';
  const styles = PICTURE_STYLES[d.class];
  let style = '';
  const m = /^([a-z]+)-(\d(?:\.0)?)$/i.exec(String(override || '').trim());
  if (m && m[1].toLowerCase() === prefix.toLowerCase() && styles.includes(m[2])) style = m[2];
  const text = `${d.model || ''} ${d.manufacturer || ''} ${d.type || ''}`;
  if (!style) {
    if (d.class === 'hmd') style = /cv1|rift(?! ?s(?![a-z]))/i.test(text) ? '0' : /quest ?2/i.test(text) ? '5' : /quest ?3s/i.test(text) ? '4' : /quest ?3/i.test(text) ? '3' : '1';
    else if (d.class === 'controller') style = /knuckles|index/i.test(text) ? '1' : /cosmos/i.test(text) ? '3' : /touch.?pro|quest pro/i.test(text) ? '2' : '0';
    else if (d.class === 'tracker') style = /tundra/i.test(text) ? '1' : '2';
    else style = '2.0';
  }
  return `${prefix}-${style}${d.class === 'controller' ? (d.role === 'right' ? 'R' : 'L') : ''}`;
}

// ---- definitions ----
const defs = [
  {
    id: 'clock',
    label: 'Clock',
    description: 'Shows the time and date, in your time zone or any other.',
    icon: '🕒',
    size: { w: 2, h: 1 },
    params: [
      { key: 'hour12', label: '12-hour clock', type: 'boolean', default: false },
      { key: 'seconds', label: 'Show seconds', type: 'boolean', default: true },
      { key: 'date', label: 'Show the date', type: 'boolean', default: true },
      { key: 'timezone', label: 'Time zone (optional)', type: 'text', placeholder: 'e.g. America/New_York', suggestions: ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney'], help: 'Leave empty for your own time zone.' },
    ],
    defaults: { color: '#1f3a5f' },
    initState: () => ({}),
    data: () => ({}),
    command: async () => {},
  },
  {
    id: 'timer',
    label: 'Countdown timer',
    description: 'Tap to start / pause, hold to reset. Can run buttons when it finishes.',
    icon: '⏲️',
    size: { w: 2, h: 2 },
    params: [
      { key: 'minutes', label: 'Minutes', type: 'number', min: 0, max: 999, default: 5 },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 0, max: 59, default: 0 },
      { key: 'beep', label: 'Beep when it finishes', type: 'boolean', default: true },
    ],
    defaults: { color: '#5a3a1f' },
    hasFinishSteps: true,
    initState: () => ({ mode: 'idle', endsAt: 0, remainingMs: 0 }),
    data(ctx, button, st) {
      return { mode: st.mode, durationMs: timerDurationMs(button.widget.params), endsAt: st.endsAt, remainingMs: st.remainingMs };
    },
    async command(ctx, button, st, cmd) {
      const duration = timerDurationMs(button.widget.params);
      if (cmd === 'hold') { ctx.runtime.setTimer(button, st, 'idle'); return; }
      if (st.mode === 'idle' || st.mode === 'done') {
        if (st.mode === 'done') { ctx.runtime.setTimer(button, st, 'idle'); return; }
        st.remainingMs = duration;
        ctx.runtime.setTimer(button, st, 'running');
      } else if (st.mode === 'running') {
        st.remainingMs = Math.max(0, st.endsAt - ctx.now());
        ctx.runtime.setTimer(button, st, 'paused');
      } else if (st.mode === 'paused') {
        ctx.runtime.setTimer(button, st, 'running');
      }
    },
  },
  {
    id: 'stopwatch',
    label: 'Stopwatch',
    description: 'Tap to start / stop, hold to reset.',
    icon: '⏱️',
    size: { w: 2, h: 2 },
    params: [{ key: 'tenths', label: 'Show tenths of a second', type: 'boolean', default: true }],
    defaults: { color: '#1f5a3a' },
    initState: () => ({ running: false, startedAt: 0, elapsedMs: 0 }),
    data: (ctx, button, st) => ({ running: st.running, startedAt: st.startedAt, elapsedMs: st.elapsedMs }),
    async command(ctx, button, st, cmd) {
      if (cmd === 'hold') { Object.assign(st, { running: false, startedAt: 0, elapsedMs: 0 }); return; }
      if (st.running) { st.elapsedMs += ctx.now() - st.startedAt; st.running = false; st.startedAt = 0; } else { st.running = true; st.startedAt = ctx.now(); }
    },
  },
  {
    id: 'coin',
    label: 'Coin flip',
    description: 'Tap to flip. Optionally posts the result to your Twitch chat.',
    icon: '🌕',
    size: { w: 2, h: 2 },
    params: [
      { key: 'postToChat', label: 'Post the result to Twitch chat', type: 'boolean', default: false },
      { key: 'template', label: 'Chat message', type: 'text', default: 'The coin landed on {result}!', help: 'Use {result}.', showIf: { key: 'postToChat', in: [true] } },
    ],
    defaults: { color: '#6b5a1f' },
    initState: () => ({ last: null, seq: 0 }),
    data: (ctx, button, st) => ({ last: st.last, seq: st.seq }),
    async command(ctx, button, st) {
      const result = flipCoin(ctx.random);
      st.seq += 1;
      st.last = { text: result, detail: '', at: ctx.now() };
      if (button.widget.params.postToChat) await ctx.postChat(fillTemplate(button.widget.params.template || 'Coin flip: {result}', { result }));
    },
  },
  {
    id: 'dice',
    label: 'Dice roller',
    description: 'Roll d4 to d100 (or any size), several at once, with a modifier. Optionally posts to Twitch chat.',
    icon: '🎲',
    size: { w: 2, h: 2 },
    params: [
      { key: 'sides', label: 'Dice type', type: 'select', default: '20', options: [['4', 'd4'], ['6', 'd6'], ['8', 'd8'], ['10', 'd10'], ['12', 'd12'], ['20', 'd20'], ['100', 'd100'], ['custom', 'Custom…']] },
      { key: 'customSides', label: 'Sides', type: 'number', min: 2, max: 1000, default: 30, showIf: { key: 'sides', in: ['custom'] } },
      { key: 'count', label: 'How many dice', type: 'number', min: 1, max: 20, default: 1 },
      { key: 'modifier', label: 'Modifier (+/−)', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'mode', label: 'd20 mode (single die only)', type: 'select', default: 'normal', options: [['normal', 'Normal'], ['advantage', 'Advantage (roll twice, keep higher)'], ['disadvantage', 'Disadvantage (roll twice, keep lower)']], showIf: { key: 'sides', in: ['20'] } },
      { key: 'postToChat', label: 'Post the result to Twitch chat', type: 'boolean', default: false },
      { key: 'template', label: 'Chat message', type: 'text', default: '🎲 Rolled {dice}: {total}', help: 'Use {dice}, {total}, {rolls}, {detail}.', showIf: { key: 'postToChat', in: [true] } },
    ],
    defaults: { color: '#5a1f4a' },
    initState: () => ({ last: null, seq: 0 }),
    data: (ctx, button, st) => ({ last: st.last, seq: st.seq }),
    async command(ctx, button, st) {
      const p = button.widget.params;
      const sides = p.sides === 'custom' ? Number(p.customSides) || 6 : Number(p.sides) || 20;
      const r = rollDice({ count: Number(p.count) || 1, sides, modifier: Number(p.modifier) || 0, mode: p.mode }, ctx.random);
      st.seq += 1;
      st.last = { text: String(r.total), detail: r.detail, dice: r.notation, natural: r.natural, at: ctx.now() };
      if (p.postToChat) {
        await ctx.postChat(fillTemplate(p.template || '🎲 {dice}: {total}', { dice: r.notation, total: r.total, rolls: r.rolls.join(', '), detail: r.detail }));
      }
    },
  },
  {
    id: 'battery',
    category: 'SteamVR',
    label: 'SteamVR battery',
    description: 'Battery level of your headset, controllers and trackers (whatever SteamVR reports), as a list or with pictures.',
    icon: '🔋',
    size: { w: 3, h: 2 },
    params: [
      { key: 'layout', label: 'Layout', type: 'select', default: 'list', options: [['list', 'List with battery bars'], ['pictures', 'Pictures (illustrated devices)']] },
      { key: 'show', label: 'Show', type: 'multiselect', default: ['hmd', 'controller', 'tracker'], options: [['hmd', 'Headset'], ['controller', 'Controllers'], ['tracker', 'Trackers'], ['basestation', 'Base stations']] },
      { key: 'showDropped', label: 'Also show devices that are off or dropped out (with their last level)', type: 'boolean', default: true },
      { key: 'lowPercent', label: 'Warn below (%)', type: 'number', min: 1, max: 90, default: 20 },
      { key: 'names', label: 'Nicknames (one per line: serial=Name)', type: 'textarea', placeholder: 'LHR-1A2B3C4D=Left foot', help: 'Trackers only have serial numbers. Turn one on and check the list to find it.' },
      { key: 'pictures', label: 'Pictures (one per line: serial=Style)', type: 'textarea', placeholder: 'LHR-1A2B3C4D=Tracker-1', help: 'Only for the Pictures layout. Styles: HMD-0 to HMD-5, Controller-0 to Controller-3, Tracker-0 to Tracker-2, Lighthouse-1.0, Lighthouse-2.0. Left blank, a picture is chosen from the device model.', showIf: { key: 'layout', in: ['pictures'] } },
    ],
    defaults: { color: '#1f4a4a' },
    needs: () => ({ vr: true }),
    initState: () => ({}),
    data(ctx, button) {
      const snap = ctx.vr();
      const p = button.widget.params;
      const show = new Set(Array.isArray(p.show) ? p.show : ['hmd', 'controller', 'tracker']);
      const names = parseNames(p.names);
      const pictures = parseNames(p.pictures);
      const live = (snap.devices || []).map((d) => ({ ...d, connected: true }));
      const gone = p.showDropped === false || !snap.connected ? [] : (snap.dropped || []).map((d) => ({ ...d, connected: false, trackingOk: null, worn: null }));
      const all = [...live, ...gone];
      const shown = all.filter((d) => show.has(d.class));
      const label = nameDevices(all, names);
      const order = (d) => [CLASS_ORDER[d.class] === undefined ? 9 : CLASS_ORDER[d.class], d.role === 'left' ? 0 : d.role === 'right' ? 1 : 2, d.serial || ''];
      shown.sort((a, b) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); });
      const devices = shown.map((d) => ({
        name: label.get(d), class: d.class, role: d.role, serial: d.serial, connected: d.connected,
        hasBattery: d.hasBattery, battery: d.battery, charging: d.charging, trackingOk: d.trackingOk, worn: d.worn,
        picture: pictureFor(d, pictures[(d.serial || '').toLowerCase()]),
      }));
      return { connected: snap.connected, error: snap.error || '', simulated: Boolean(snap.simulated), layout: p.layout === 'pictures' ? 'pictures' : 'list', devices, lowPercent: Number(p.lowPercent) || 20 };
    },
    command: async () => {},
  },
  {
    id: 'media',
    label: 'Now playing (Spotify & more)',
    description: 'Album cover, title, progress bar and play / pause / skip. Works with Spotify and most players.',
    icon: '🎵',
    size: { w: 4, h: 2 },
    params: [
      { key: 'app', label: 'Player', type: 'select', optionsFrom: 'media.players', unknownSuffix: 'not running right now', default: 'auto', help: 'Pick the app to show. The list is what Windows sees right now (start the music first if it is missing). Automatic prefers a playing music app over a browser tab. Pear API adds the album plus like, shuffle and repeat buttons (connect it in Settings first).' },
      { key: 'controls', label: 'Show play / pause / skip buttons', type: 'boolean', default: true },
      { key: 'progress', label: 'Show the progress bar', type: 'boolean', default: true },
    ],
    defaults: { color: '#14261c' },
    needs: (p) => (String(p.app) === 'pear' ? { pear: true } : { media: [String(p.app || 'auto')] }),
    initState: () => ({}),
    data: (ctx, button) => ctx.media(String(button.widget.params.app || 'auto')),
    async command(ctx, button, st, cmd, arg) {
      const map = { toggle: 'toggle', next: 'next', previous: 'previous', play: 'play', pause: 'pause', seek: 'seek', like: 'like', dislike: 'dislike', shuffle: 'shuffle', repeat: 'repeat' };
      if (!map[cmd]) throw new Error(`Unknown media command "${cmd}"`);
      await ctx.mediaControl(String(button.widget.params.app || 'auto'), map[cmd], arg);
    },
  },
  {
    id: 'twitch.ads',
    category: 'Twitch',
    label: 'Twitch ad timer',
    description: 'Counts down to your next ad break. Tap to snooze it.',
    icon: '📺',
    size: { w: 2, h: 2 },
    params: [{ key: 'tapAction', label: 'Tap does', type: 'select', default: 'snooze', options: [['snooze', 'Snooze the next ad'], ['none', 'Nothing (display only)']] }],
    defaults: { color: '#3a1f6b' },
    needs: () => ({ twitch: true, twitchAds: true }),
    initState: () => ({}),
    data: (ctx) => ctx.twitchAds(),
    async command(ctx, button, st, cmd) {
      if (cmd !== 'tap' || button.widget.params.tapAction === 'none') return;
      await ctx.twitchApi((t) => t.snoozeAd());
      ctx.refreshTwitch();
    },
  },
  {
    id: 'twitch.stream',
    category: 'Twitch',
    label: 'Twitch stream status',
    description: 'Shows whether you are live, your viewer count and how long you have been streaming.',
    icon: '🔴',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { color: '#3a1f6b' },
    needs: () => ({ twitch: true, twitchStream: true }),
    initState: () => ({}),
    data: (ctx) => ctx.twitchStream(),
    command: async () => {},
  },
];

const registry = new Map(defs.map((d) => [d.id, d]));

function widgetCatalog() {
  return defs.map((d) => ({
    id: d.id, category: d.category || CATEGORY, label: d.label, description: d.description, icon: d.icon, size: d.size,
    params: d.params, defaults: d.defaults, hasFinishSteps: Boolean(d.hasFinishSteps),
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
    const st = this.states.get(button.id) || def.initState();
    return { ...def.data(this.context(), button, st), now: this.now() };
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

module.exports = { WidgetRuntime, widgetCatalog, registry, rollDice, flipCoin, fillTemplate, timerDurationMs, parseNames, nameDevices, pictureFor, CATEGORY };
