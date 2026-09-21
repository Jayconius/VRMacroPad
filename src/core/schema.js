// Config shape, defaults and validation. Everything the UI sends goes through
// normalizeConfig(), so a buggy or hostile client cannot store a malformed config.
const crypto = require('crypto');
const Grid = require('../shared/grid');
const { defaultOverlay, normalizeOverlay } = require('./overlay-logic');
const Effects = require('../shared/effects');
const { NAME: IMAGE_NAME } = require('./images');

const CONFIG_VERSION = 1;
const LIMITS = { pages: 30, buttons: 200, steps: 30, triggers: 10, maxDelayMs: 600000 };
const TRIGGER_TYPES = ['hotkey', 'processStart', 'processStop', 'state', 'time'];
const CONFIRM_MODES = ['none', 'hold', 'double'];
const HEX = /^#[0-9a-fA-F]{6}$/;

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function str(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback;
  return v.slice(0, max);
}

function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf(v, list, fallback) {
  return list.includes(v) ? v : fallback;
}

function color(v, fallback) {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
}

function defaultSettings() {
  return {
    theme: 'dark',
    accent: '#4c8dff',
    animations: true, // button effects (pulse, flash...)
    gap: 10,
    lock: { unlockMethod: 'hold', holdMs: 1200, autoRelockSec: 180, unlockHotkey: 'Ctrl+Alt+Shift+E' },
    window: { alwaysOnTop: false, nonActivating: true, frameless: true, cleanView: false, cleanViewHotkey: 'Ctrl+Alt+Shift+V', showInTaskbar: true, closeToTray: false, startHidden: false, width: 960, height: 640, x: null, y: null },
    obs: { host: '127.0.0.1', port: 4455, password: '' },
    osc: { host: '127.0.0.1', sendPort: 9000, listenPort: 9001, listen: true },
    twitch: { clientId: '', adWarnMinutes: 5 },
    spotify: { clientId: '' },
    vr: { lowBatteryPercent: 15 },
    pear: { host: '127.0.0.1', port: 26538 },
    server: { port: 17420 },
    overlay: defaultOverlay(),
  };
}

function mergeSettings(input) {
  const d = defaultSettings();
  const s = input && typeof input === 'object' ? input : {};
  const lock = s.lock || {};
  const win = s.window || {};
  const obs = s.obs || {};
  const osc = s.osc || {};
  const twitch = s.twitch || {};
  const spotify = s.spotify || {};
  const vr = s.vr || {};
  const pear = s.pear || {};
  const server = s.server || {};
  const coord = (v) => (Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v)) : null);
  return {
    theme: oneOf(s.theme, ['dark', 'light'], d.theme),
    accent: color(s.accent, d.accent),
    animations: bool(s.animations, d.animations),
    gap: num(s.gap, 0, 40, d.gap),
    lock: {
      unlockMethod: oneOf(lock.unlockMethod, ['hold', 'hotkey'], d.lock.unlockMethod),
      holdMs: num(lock.holdMs, 300, 5000, d.lock.holdMs),
      autoRelockSec: num(lock.autoRelockSec, 0, 3600, d.lock.autoRelockSec),
      unlockHotkey: str(lock.unlockHotkey, 60, d.lock.unlockHotkey) || d.lock.unlockHotkey,
    },
    window: {
      alwaysOnTop: bool(win.alwaysOnTop, d.window.alwaysOnTop),
      nonActivating: bool(win.nonActivating, d.window.nonActivating),
      frameless: bool(win.frameless, d.window.frameless),
      cleanView: bool(win.cleanView, d.window.cleanView),
      cleanViewHotkey: str(win.cleanViewHotkey, 40, d.window.cleanViewHotkey).trim(),
      showInTaskbar: bool(win.showInTaskbar, d.window.showInTaskbar),
      closeToTray: bool(win.closeToTray, d.window.closeToTray),
      startHidden: bool(win.startHidden, d.window.startHidden),
      width: num(win.width, 320, 7680, d.window.width),
      height: num(win.height, 240, 4320, d.window.height),
      x: coord(win.x),
      y: coord(win.y),
    },
    obs: {
      host: str(obs.host, 200, d.obs.host) || d.obs.host,
      port: num(obs.port, 1, 65535, d.obs.port),
      password: str(obs.password, 200, ''),
    },
    osc: {
      host: str(osc.host, 200, d.osc.host) || d.osc.host,
      sendPort: num(osc.sendPort, 1, 65535, d.osc.sendPort),
      listenPort: num(osc.listenPort, 1, 65535, d.osc.listenPort),
      listen: bool(osc.listen, d.osc.listen),
    },
    twitch: {
      clientId: str(twitch.clientId, 80, '').trim(),
      adWarnMinutes: num(twitch.adWarnMinutes, 1, 60, d.twitch.adWarnMinutes),
    },
    spotify: { clientId: str(spotify.clientId, 80, '').trim() },
    vr: { lowBatteryPercent: num(vr.lowBatteryPercent, 1, 90, d.vr.lowBatteryPercent) },
    // Only a plain host name or address: this ends up inside a URL.
    pear: { host: /^[A-Za-z0-9.-]{1,100}$/.test(pear.host || '') ? pear.host : d.pear.host, port: num(pear.port, 1, 65535, d.pear.port) },
    server: { port: num(server.port, 1024, 65535, d.server.port) },
    overlay: normalizeOverlay(s.overlay),
  };
}

function normalizeStep(s) {
  if (!s || typeof s !== 'object' || typeof s.action !== 'string') return null;
  const params = s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? s.params : {};
  return { action: s.action.slice(0, 80), params: JSON.parse(JSON.stringify(params)), delayMs: num(s.delayMs, 0, LIMITS.maxDelayMs, 0) };
}

function normalizeTrigger(t) {
  if (!t || typeof t !== 'object' || !TRIGGER_TYPES.includes(t.type)) return null;
  const base = { type: t.type };
  if (t.type === 'hotkey') return { ...base, accelerator: str(t.accelerator, 60) };
  if (t.type === 'processStart' || t.type === 'processStop') return { ...base, process: str(t.process, 120).toLowerCase() };
  if (t.type === 'state') return { ...base, key: str(t.key, 200), becomes: bool(t.becomes, true) };
  const days = Array.isArray(t.days) ? [...new Set(t.days.map((d) => num(d, 0, 6, -1)).filter((d) => d >= 0))] : [0, 1, 2, 3, 4, 5, 6];
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(t.at) ? t.at : '00:00';
  return { ...base, at, days };
}

// A widget button shows live information instead of just running steps. Unknown widget
// types are kept (so an older layout is not destroyed by a newer one) and render as unavailable.
function normalizeWidget(w) {
  if (!w || typeof w !== 'object' || typeof w.type !== 'string' || !w.type) return null;
  const params = w.params && typeof w.params === 'object' && !Array.isArray(w.params) ? w.params : {};
  return { type: w.type.slice(0, 40), params: JSON.parse(JSON.stringify(params)) };
}

function normalizeButton(b, used) {
  if (!b || typeof b !== 'object') return null;
  let id = str(b.id, 40);
  if (!id || used.has(id)) id = uid('b');
  used.add(id);
  const state = b.state && typeof b.state === 'object' ? b.state : {};
  return {
    id,
    x: num(b.x, 0, 1000, 0),
    y: num(b.y, 0, 1000, 0),
    w: num(b.w, 1, 24, 1),
    h: num(b.h, 1, 16, 1),
    label: str(b.label, 60),
    labelOn: str(b.labelOn, 60),
    icon: str(b.icon, 12),
    color: color(b.color, '#3b4a63'),
    colorOn: color(b.colorOn, ''),
    image: typeof b.image === 'string' && IMAGE_NAME.test(b.image) ? b.image : '',
    imageOn: typeof b.imageOn === 'string' && IMAGE_NAME.test(b.imageOn) ? b.imageOn : '',
    imageFit: oneOf(b.imageFit, ['cover', 'contain'], 'cover'),
    anim: Effects.isEffect(b.anim) ? b.anim : 'none',
    animOn: Effects.isEffect(b.animOn) ? b.animOn : 'none',
    animSpeed: Effects.isSpeed(b.animSpeed) ? b.animSpeed : 'normal',
    widget: normalizeWidget(b.widget),
    steps: (Array.isArray(b.steps) ? b.steps : []).slice(0, LIMITS.steps).map(normalizeStep).filter(Boolean),
    triggers: (Array.isArray(b.triggers) ? b.triggers : []).slice(0, LIMITS.triggers).map(normalizeTrigger).filter(Boolean),
    state: { source: oneOf(state.source, ['auto', 'none', 'toggle', 'key'], 'auto'), key: str(state.key, 200) },
    confirm: oneOf(b.confirm, CONFIRM_MODES, 'none'),
  };
}

function normalizePage(p, usedPageIds, warnings) {
  if (!p || typeof p !== 'object') return null;
  let id = str(p.id, 40);
  if (!id || usedPageIds.has(id)) id = uid('p');
  usedPageIds.add(id);
  const page = {
    id,
    name: str(p.name, 40, 'Page') || 'Page',
    cols: num(p.cols, 1, 24, 8),
    rows: num(p.rows, 1, 16, 5),
    autoShowProcess: str(p.autoShowProcess, 120).toLowerCase(),
    buttons: [],
  };
  const usedIds = new Set();
  const raw = (Array.isArray(p.buttons) ? p.buttons : []).slice(0, LIMITS.buttons);
  for (const rb of raw) {
    const b = normalizeButton(rb, usedIds);
    if (!b) continue;
    // Clamp to the page, then relocate if it collides with something already placed.
    b.w = Math.min(b.w, page.cols);
    b.h = Math.min(b.h, page.rows);
    b.x = Math.min(b.x, page.cols - b.w);
    b.y = Math.min(b.y, page.rows - b.h);
    if (!Grid.fits(page, b)) {
      const spot = Grid.findFreeSpot(page, b.w, b.h);
      if (!spot) {
        warnings.push(`Dropped "${b.label || b.id}" on page "${page.name}": no room left.`);
        continue;
      }
      b.x = spot.x;
      b.y = spot.y;
      warnings.push(`Moved "${b.label || b.id}" on page "${page.name}" because it overlapped another button.`);
    }
    page.buttons.push(b);
  }
  return page;
}

function normalizeConfig(input) {
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};
  const usedPageIds = new Set();
  let pages = (Array.isArray(src.pages) ? src.pages : []).slice(0, LIMITS.pages).map((p) => normalizePage(p, usedPageIds, warnings)).filter(Boolean);
  if (!pages.length) pages = [normalizePage({ name: 'Main', buttons: [] }, usedPageIds, warnings)];
  return { config: { version: CONFIG_VERSION, settings: mergeSettings(src.settings), pages }, warnings };
}

// A few harmless starter buttons so the first launch is not an empty grid.
function defaultConfig() {
  const btn = (x, y, w, h, label, icon, color, steps, extra = {}) => ({
    id: uid('b'), x, y, w, h, label, icon, color, steps: steps.map((s) => ({ delayMs: 0, params: {}, ...s })), ...extra,
  });
  return normalizeConfig({
    settings: defaultSettings(),
    pages: [
      {
        name: 'Main',
        cols: 8,
        rows: 4,
        buttons: [
          btn(0, 0, 2, 2, 'Mic', '🎙️', '#2f855a', [{ action: 'audio.micMute', params: { mode: 'toggle' } }], { colorOn: '#c53030', labelOn: 'Muted' }),
          btn(2, 0, 2, 2, 'Alt+Tab', '🔀', '#3b5b8f', [{ action: 'keys.press', params: { keys: 'alt+tab' } }]),
          btn(4, 0, 2, 2, 'Play / Pause', '⏯️', '#6b46c1', [{ action: 'media.key', params: { key: 'playpause' } }]),
          btn(6, 0, 1, 1, 'Vol −', '🔉', '#4a5568', [{ action: 'audio.volume', params: { target: 'output', mode: 'down', amount: 5 } }]),
          btn(7, 0, 1, 1, 'Vol +', '🔊', '#4a5568', [{ action: 'audio.volume', params: { target: 'output', mode: 'up', amount: 5 } }]),
          btn(6, 1, 2, 1, 'Say hi', '👋', '#b7791f', [{ action: 'system.toast', params: { message: 'Hello from VR Macro Pad!' } }]),
        ],
      },
      {
        name: 'Tools',
        cols: 8,
        rows: 4,
        buttons: [
          btn(0, 0, 3, 1, '', '', '#1f3a5f', [], { widget: { type: 'clock', params: { hour12: false, seconds: true, date: true, timezone: '' } } }),
          btn(3, 0, 2, 2, 'Timer', '', '#5a3a1f', [], { widget: { type: 'timer', params: { minutes: 5, seconds: 0, beep: true } } }),
          btn(5, 0, 2, 2, 'Stopwatch', '', '#1f5a3a', [], { widget: { type: 'stopwatch', params: { tenths: true } } }),
          btn(0, 1, 2, 2, 'Coin', '', '#6b5a1f', [], { widget: { type: 'coin', params: { postToChat: false, template: 'The coin landed on {result}!' } } }),
          btn(2, 2, 2, 2, 'Dice', '', '#5a1f4a', [], { widget: { type: 'dice', params: { sides: '20', customSides: 30, count: 1, modifier: 0, mode: 'normal', postToChat: false, template: '🎲 Rolled {dice}: {total}' } } }),
        ],
      },
    ],
  }).config;
}

module.exports = { CONFIG_VERSION, LIMITS, TRIGGER_TYPES, uid, defaultSettings, defaultConfig, normalizeConfig, mergeSettings };
