// The SteamVR overlay, desktop side. It
//   1. renders the app's own page off-screen (?view=overlay) and streams each picture to the SteamVR helper,
//   2. turns the helper's laser events back into mouse input on that page,
//   3. keeps the panel where the settings say (anchor, size, opacity...), and handles grab / drop / bring-to-me.
// Everything the overlay shows is the same page the desktop window shows, connected to the same core, so
// whatever changes on the desktop appears in VR by itself.
const fs = require('fs');
const path = require('path');
const L = require('../core/overlay-logic');
const { OverlayHelper } = require('../core/overlay-helper');

const ATTACH_MS = 3000; // how often to look for SteamVR while it is not there
const FPS = 30;
const COLLAPSED_WIDTH = 0.14; // meters
const DASH_SIZE = { width: 1280, height: 800 }; // the page shown in SteamVR's dashboard (the bar at the bottom of the VR menu)
const CLICK_CARRY_MS = 350; // a click shorter than this picks the panel up and it stays on the hand until the next click
const MAX_GRAB_MS = 120000;
const LOG_LIMIT = 512 * 1024;

class OverlayManager {
  // createHelper / now are test seams.
  constructor({ core, url, buildDir, dataDir, BrowserWindow, createHelper = (dir) => new OverlayHelper(dir), now = () => Date.now() }) {
    this.core = core;
    this.url = url;
    this.buildDir = buildDir;
    this.dataDir = dataDir;
    this.BrowserWindow = BrowserWindow;
    this.createHelper = createHelper;
    this.now = now;
    this.win = null;
    this.helper = null;
    this.timer = null;
    this.diagTimer = null;
    this.grabTimer = null;
    this.state = 'off'; // off | starting | waiting (no SteamVR yet) | connected | error
    this.error = '';
    this.attached = false;
    this.busy = false;
    this.applied = {};
    this.helperStatus = {};
    this.frame = null; // { w, h, buf } the newest picture
    this.dash = null; // the dashboard page's off-screen window
    this.dashFrame = null;
    this.dashPointer = { x: 0, y: 0 };
    this.grab = { on: false, since: 0, carry: false, device: -1 };
    this.noGrabUntil = 0;
    this.lastDevice = 0;
    this.pointer = null;
    this.events = [];
    this.devices = [];
    this.handTypes = { left: '', right: '' }; // what SteamVR says the controllers are (knuckles, oculus_touch...)
    this.snapRole = ''; // which wrist the carried panel is near right now
    this.deviceTick = 0;
    this.counters = { paints: 0, sent: 0, dropped: 0, fps: 0, windowStart: now() };
    this.lastInfoEmit = 0;
    this.lastHaptic = 0;
  }

  settings() {
    return this.core.engine.config.settings.overlay;
  }

  get running() {
    return Boolean(this.helper);
  }

  // ---- lifecycle ----
  sync() {
    const o = this.settings();
    const wanted = o.enabled || o.dim > 0; // the dimmer needs the helper even when the deck itself is off
    if (wanted && !this.running) this.start();
    else if (!wanted && this.running) this.stop();
    else if (this.running) this.applyAll();
  }

  start() {
    if (this.running) return;
    this.setState('starting');
    this.helper = this.createHelper(this.buildDir);
    this.helper.on('event', (ev) => this.onEvent(ev));
    this.helper.on('exit', (reason) => this.onHelperExit(reason));
    if (!this.helper.start()) {
      this.setState('error', this.helper.error || 'The overlay helper could not start');
      this.helper = null;
      return;
    }
    this.createWindow();
    this.createDashboard();
    this.timer = setInterval(() => this.tryAttach(), ATTACH_MS);
    this.diagTimer = setInterval(() => this.tickDiagnostics(), 1000);
    this.tryAttach();
    this.setState('waiting');
  }

  async stop() {
    clearInterval(this.timer);
    clearInterval(this.diagTimer);
    clearTimeout(this.grabTimer);
    this.timer = this.diagTimer = this.grabTimer = null;
    this.attached = false;
    this.grab.on = false;
    const helper = this.helper;
    this.helper = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    if (this.dash && !this.dash.isDestroyed()) this.dash.destroy();
    this.dash = null;
    if (helper) await helper.stop();
    this.frame = null;
    this.dashFrame = null;
    this.applied = {};
    this.setState('off');
  }

  onHelperExit(reason) {
    if (!this.running) return;
    this.attached = false;
    this.setState('error', reason);
    // Try again shortly: the helper is cheap to restart.
    setTimeout(() => {
      if (!this.running || !(this.settings().enabled || this.settings().dim > 0)) return;
      const dead = this.helper;
      this.helper = null;
      clearInterval(this.timer);
      clearInterval(this.diagTimer);
      this.timer = this.diagTimer = null;
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
      this.win = null;
      if (this.dash && !this.dash.isDestroyed()) this.dash.destroy();
      this.dash = null;
      dead.removeAllListeners();
      this.start();
    }, 2000).unref();
  }

  // ---- the off-screen page ----
  overlayUrl() {
    const u = new URL(this.url);
    u.searchParams.set('view', 'overlay');
    return u.toString();
  }

  dashboardUrl() {
    const u = new URL(this.url);
    u.searchParams.set('view', 'dashboard');
    return u.toString();
  }

  // The SteamVR dashboard entry: a small control panel (show / hide the deck, where it goes, size, options) that
  // opens from the bar at the bottom of the VR menu, so the deck itself can be hidden or lost and still be found.
  createDashboard() {
    this.dash = new this.BrowserWindow({
      show: false, width: DASH_SIZE.width, height: DASH_SIZE.height, useContentSize: true, enableLargerThanScreen: true,
      frame: false, backgroundColor: '#14161c', focusable: false, skipTaskbar: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const wc = this.dash.webContents;
    wc.setFrameRate(20);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const origin = new URL(this.url).origin;
    wc.on('will-navigate', (e, target) => { if (new URL(target).origin !== origin) e.preventDefault(); });
    wc.on('paint', (event, dirty, image) => {
      const sz = image.getSize();
      if (!sz.width || !sz.height) return;
      this.dashFrame = { w: sz.width, h: sz.height, buf: image.toBitmap() };
      if (this.attached && this.helper) this.pushDash();
    });
    this.dash.loadURL(this.dashboardUrl());
    wc.once('did-finish-load', () => { try { wc.focus(); } catch { /* not focusable: fine */ } });
  }

  // Runs a small piece of script in the dashboard page (the shell around the editor). Never throws.
  dashJs(code) {
    if (!this.dash || this.dash.isDestroyed()) return;
    this.dash.webContents.executeJavaScript(code).catch(() => {});
  }

  // The thumbnail SteamVR shows for the dashboard entry.
  iconFile() {
    try {
      const file = path.join(this.dataDir, 'overlay-icon.png');
      if (!fs.existsSync(file)) fs.writeFileSync(file, require('./icon').makeIconPng(256));
      return file;
    } catch { return ''; }
  }

  pushDash() {
    const f = this.dashFrame;
    if (f && this.helper) this.helper.sendFrame(f.w, f.h, f.buf, 1);
  }

  createWindow() {
    const size = L.pictureSize(this.settings().resolution);
    this.pictureSize = size;
    this.win = new this.BrowserWindow({
      show: false, width: size.width, height: size.height, useContentSize: true, enableLargerThanScreen: true,
      transparent: true, frame: false, backgroundColor: '#00000000', focusable: false, skipTaskbar: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const wc = this.win.webContents;
    wc.setFrameRate(FPS);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const origin = new URL(this.url).origin;
    wc.on('will-navigate', (e, target) => { if (new URL(target).origin !== origin) e.preventDefault(); });
    wc.on('paint', (event, dirty, image) => this.onPaint(image));
    wc.on('render-process-gone', () => this.record('overlay page crashed; reloading') || setTimeout(() => { if (this.win && !this.win.isDestroyed()) this.win.loadURL(this.overlayUrl()); }, 1000));
    this.win.loadURL(this.overlayUrl());
  }

  onPaint(image) {
    const sz = image.getSize();
    if (!sz.width || !sz.height) return;
    this.frame = { w: sz.width, h: sz.height, buf: image.toBitmap() };
    this.counters.paints++;
    if (this.attached && this.helper) this.pushFrame();
  }

  pushFrame() {
    const f = this.frame;
    if (!f) return;
    if (this.helper.sendFrame(f.w, f.h, f.buf)) this.counters.sent++; else this.counters.dropped++;
  }

  // ---- talking to SteamVR ----
  async tryAttach() {
    if (this.busy || !this.helper) return;
    this.busy = true;
    try {
      const st = await this.helper.call('attach', { icon: this.iconFile() });
      this.helperStatus = st;
      if (st.connected) {
        if (!this.attached) {
          this.attached = true;
          this.applied = {};
          this.record('connected to SteamVR');
          this.applyAll(true);
          this.refreshDevices();
          if (this.frame) this.pushFrame();
          if (this.dashFrame) this.pushDash();
          if (this.win && !this.win.isDestroyed()) this.win.webContents.invalidate();
          if (this.dash && !this.dash.isDestroyed()) this.dash.webContents.invalidate();
        }
        this.setState('connected');
      } else {
        this.attached = false;
        this.setState(/not running|not installed/.test(st.error || '') ? 'waiting' : 'error', st.error);
      }
    } catch (err) {
      this.attached = false;
      this.setState('error', err.message);
    } finally {
      this.busy = false;
    }
  }

  // Sends what changed since last time.
  applyAll(force = false) {
    if (!this.attached || !this.helper) { this.maybeResize(); return; }
    const o = this.settings();
    const place = L.placement(o, { controllerType: this.handTypes[o.hand] });
    const props = { width: o.collapsed ? COLLAPSED_WIDTH : place.widthMeters, alpha: o.opacity, curvature: o.curvature, visible: o.enabled && !o.hidden, glance: o.glance };
    const spot = { mode: place.mode, role: place.role, serial: place.serial, matrix: place.matrix };
    const key = (v) => JSON.stringify(v);
    if (force || key(props) !== this.applied.props) { this.applied.props = key(props); this.helper.call('props', props).catch((e) => this.record(`props: ${e.message}`)); }
    if (force || o.dim !== this.applied.dim) {
      this.applied.dim = o.dim;
      this.helper.call('dim', { level: o.dim }).catch((e) => this.record(`dim: ${e.message}`));
    }
    if (force || o.upload !== this.applied.upload) {
      this.applied.upload = o.upload;
      this.helper.call('upload', { mode: o.upload === 'raw' ? 'raw' : 'gpu' }).catch((e) => this.record(`upload: ${e.message}`));
    }
    if (force || key(spot) !== this.applied.spot) { this.applied.spot = key(spot); this.helper.call('place', spot).catch((e) => this.record(`place: ${e.message}`)); }
    this.maybeResize();
  }

  maybeResize() {
    if (!this.win || this.win.isDestroyed()) return;
    const size = L.pictureSize(this.settings().resolution);
    if (this.pictureSize && (size.width !== this.pictureSize.width || size.height !== this.pictureSize.height)) {
      this.pictureSize = size;
      this.win.setContentSize(size.width, size.height);
      this.win.webContents.invalidate();
    }
  }

  // ---- laser input ----
  onEvent(ev) {
    if (ev.target === 'dash') { this.onDashEvent(ev); return; }
    if (ev.ev === 'dashboard') { this.record(`SteamVR dashboard ${ev.open ? 'opened' : 'closed'}${ev.open ? (ev.panel ? ' (our panel is showing)' : ' (our panel is not showing)') : ''}`); return; }
    if (ev.ev === 'mouse') this.onMouse(ev);
    else if (ev.ev === 'scroll') this.onScroll(ev);
    else if (ev.ev === 'quit') { this.attached = false; this.applied = {}; this.record('SteamVR quit'); this.setState('waiting', 'SteamVR closed'); }
    else if (ev.ev === 'snap') this.onSnapPreview(ev.role || '');
    else if (ev.ev === 'log') this.record(`helper: ${ev.text}`);
    else if (ev.ev === 'repaint') { this.record('sending the picture again'); if (this.frame) this.pushFrame(); if (this.dashFrame) this.pushDash(); }
    else if (ev.ev === 'visible') this.record(ev.shown ? 'overlay shown' : 'overlay hidden');
  }

  // Overlay coordinates: origin bottom-left, in the picture's own pixels. The page wants top-left, in CSS pixels.
  pagePoint(ev) {
    const f = this.frame || { w: this.pictureSize.width, h: this.pictureSize.height };
    const p = L.toPagePoint(ev.x, ev.y, { width: f.w, height: f.h });
    const scale = f.w / this.pictureSize.width || 1; // the page may be painted at more pixels than CSS pixels
    return { pixel: p, css: { x: Math.round(p.x / scale), y: Math.round(p.y / scale) } };
  }

  onMouse(ev) {
    if (!this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    this.lastDevice = ev.device;
    if (ev.type === 'leave') { wc.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 }); return; }
    const { pixel, css } = this.pagePoint(ev);
    this.pointer = { x: pixel.x, y: pixel.y, device: ev.device, type: ev.type };
    if (ev.type === 'move') { wc.sendInputEvent({ type: 'mouseMove', x: css.x, y: css.y }); return; }
    if (ev.button !== 1) return; // the trigger is the left button; other buttons do nothing
    if (ev.type === 'down') {
      this.record(`click at ${pixel.x},${pixel.y} from device ${ev.device}`);
      this.dropIfCarried();
      wc.sendInputEvent({ type: 'mouseDown', x: css.x, y: css.y, button: 'left', clickCount: 1 });
      this.haptic();
    } else {
      wc.sendInputEvent({ type: 'mouseUp', x: css.x, y: css.y, button: 'left', clickCount: 1 });
      this.onButtonUp();
    }
  }

  // Laser input on the dashboard page: plain clicks, nothing else.
  onDashEvent(ev) {
    if (ev.ev === 'visible') { this.record(ev.shown ? 'dashboard page shown' : 'dashboard page hidden'); return; }
    if (ev.ev === 'keyboard') { this.dashJs(`window.__vrKeyboard && window.__vrKeyboard(${JSON.stringify(ev.kind)}, ${JSON.stringify(String(ev.text || ''))})`); return; }
    if (ev.ev === 'scroll') { this.dashJs(`window.__vrScroll && window.__vrScroll(${this.dashPointer.x}, ${this.dashPointer.y}, ${Number(ev.dy) || 0})`); return; }
    if (ev.ev !== 'mouse' || !this.dash || this.dash.isDestroyed()) return;
    const wc = this.dash.webContents;
    if (ev.type === 'leave') { wc.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 }); return; }
    const f = this.dashFrame || { w: DASH_SIZE.width, h: DASH_SIZE.height };
    const p = L.toPagePoint(ev.x, ev.y, { width: f.w, height: f.h });
    const x = Math.round(p.x / (f.w / DASH_SIZE.width));
    const y = Math.round(p.y / (f.h / DASH_SIZE.height));
    this.dashPointer = { x, y };
    if (ev.type === 'move') { wc.sendInputEvent({ type: 'mouseMove', x, y }); return; }
    if (ev.button !== 1) return;
    if (ev.type === 'down') { this.record(`dashboard click at ${x},${y}`); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); this.haptic(); } else wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  // Thumbstick / trackpad scroll while holding the panel makes it bigger or smaller.
  onScroll(ev) {
    if (!this.grab.on || !ev.dy) return;
    const o = this.settings();
    const next = L.clampWidth(o.widths[o.anchor] * (1 + Math.max(-1, Math.min(1, ev.dy)) * 0.12));
    this.core.engine.patchSettings((s) => { s.overlay.widths[s.overlay.anchor] = next; });
  }

  haptic() {
    const t = this.now();
    if (!this.helper || !this.attached || t - this.lastHaptic < 60) return;
    this.lastHaptic = t;
    this.helper.call('haptic').catch(() => {});
  }

  // ---- grab / drop ----
  // The page asks for a grab when the laser trigger goes down on its handle. Holding moves the panel and letting go
  // drops it; a quick click picks it up and it stays on the hand until the next click.
  async grabStart() {
    const o = this.settings();
    if (o.locked) return false;
    if (this.now() < this.noGrabUntil) return false;
    if (!this.attached || !this.helper) throw new Error('The overlay is not connected to SteamVR');
    if (this.grab.on) return true;
    await this.helper.call('grab.start', { device: this.lastDevice, snapRadius: L.SNAP_RADIUS });
    this.grab = { on: true, since: this.now(), carry: false, device: this.lastDevice };
    this.record(`grab by device ${this.lastDevice}`);
    clearTimeout(this.grabTimer);
    this.grabTimer = setTimeout(() => this.drop(), MAX_GRAB_MS);
    this.grabTimer.unref();
    this.emitInfo(true);
    return true;
  }

  onButtonUp() {
    if (!this.grab.on || this.grab.carry) return;
    if (this.now() - this.grab.since < CLICK_CARRY_MS) { this.grab.carry = true; this.record('carrying: click again to drop'); this.emitInfo(true); } else this.drop();
  }

  dropIfCarried() {
    if (this.grab.on && this.grab.carry) { this.noGrabUntil = this.now() + 500; this.drop(); }
  }

  async drop() {
    if (!this.grab.on) return false;
    clearTimeout(this.grabTimer);
    this.grab = { on: false, since: 0, carry: false, device: -1 };
    try {
      const res = await this.helper.call('grab.stop');
      if (res && res.grabbed) this.decideDrop(res);
    } catch (err) {
      this.record(`drop: ${err.message}`);
    }
    this.snapRole = '';
    this.emitInfo(true);
    return true;
  }

  // Where the panel ends up when you let go of it:
  //   near a wrist -> on that wrist (letting go near the wrist it is already on keeps the new position and angle),
  //   anywhere else while it was on a wrist -> it comes off and stays in the room,
  //   otherwise it stays where it was (in front of you, or in the room) at its new spot.
  decideDrop(res) {
    const o = this.settings();
    const patch = (fn) => this.core.engine.patchSettings((s) => fn(s.overlay));
    const snap = res.snapRole || '';
    if (snap) {
      const type = res.snapType || this.handTypes[snap] || '';
      this.handTypes[snap] = type;
      if (o.anchor === 'wrist' && o.hand === snap && L.isMatrix(res.relative)) {
        const offset = L.toOffset(res.relative);
        const key = L.wristKey(type, snap);
        patch((ov) => this.storeWrist(ov, key, offset));
        this.record(`adjusted the ${snap} wrist (${key}): turn ${offset.roll}, tilt ${offset.pitch}`);
      } else {
        patch((ov) => { ov.anchor = 'wrist'; ov.hand = snap; ov.collapsed = false; });
        this.record(`snapped to the ${snap} wrist (${type || 'unknown controller'})`);
      }
      this.haptic();
      return;
    }
    if (o.anchor === 'wrist') {
      if (L.isMatrix(res.world)) {
        const offset = L.toOffset(res.world);
        patch((ov) => { ov.anchor = 'room'; ov.offsets.room = offset; });
        this.record(`taken off the wrist: now in the room at ${offset.x}, ${offset.y}, ${offset.z}`);
      }
      return;
    }
    const m = o.anchor === 'room' ? res.world : res.relative;
    if (L.isMatrix(m)) {
      const offset = L.toOffset(m);
      patch((ov) => { ov.offsets[ov.anchor] = offset; });
      this.record(`dropped: ${o.anchor} at ${offset.x}, ${offset.y}, ${offset.z}`);
    }
  }

  // Keeps at most a few adjusted positions (the oldest goes first).
  storeWrist(ov, key, offset) {
    delete ov.wristOffsets[key];
    const keys = Object.keys(ov.wristOffsets);
    for (const k of keys.slice(0, Math.max(0, keys.length - (L.MAX_WRIST_ADJUSTMENTS - 1)))) delete ov.wristOffsets[k];
    ov.wristOffsets[key] = offset;
  }

  onSnapPreview(role) {
    if (role === this.snapRole) return;
    this.snapRole = role;
    if (role) this.haptic(); // a buzz when the panel is close enough to snap
    this.emitInfo(true);
  }

  // Turn, tilt, flip or reset the panel on the wrist, or swap the wrist. The result is remembered for this controller type and hand.
  async adjustWrist(args = {}) {
    const o = this.settings();
    if (o.anchor !== 'wrist') throw new Error('These controls only work while it is on your wrist');
    const kind = String(args.kind || '');
    if (kind === 'hand') {
      this.core.engine.patchSettings((s) => { s.overlay.hand = s.overlay.hand === 'left' ? 'right' : 'left'; });
      return true;
    }
    if (this.attached && !this.handTypes[o.hand]) await this.refreshDevices();
    const type = this.handTypes[o.hand];
    const key = L.wristKey(type, o.hand);
    if (kind === 'reset') {
      this.core.engine.patchSettings((s) => { delete s.overlay.wristOffsets[key]; delete s.overlay.wristOffsets[L.wristKey('', o.hand)]; });
      this.record(`wrist position reset (${key})`);
      return true;
    }
    if (!['roll', 'pitch', 'yaw', 'flip'].includes(kind)) throw new Error('Unknown wrist adjustment');
    const amount = Math.max(-90, Math.min(90, Number(args.amount) || 0));
    const next = L.adjustOffset(L.wristOffsetFor(o, type), kind, amount);
    this.core.engine.patchSettings((s) => this.storeWrist(s.overlay, key, next));
    this.record(`wrist ${kind} ${amount || ''} (${key}): turn ${next.roll}, tilt ${next.pitch}`);
    return true;
  }

  // Learns which controllers are connected (their types decide the wrist position that gets used).
  async refreshDevices() {
    if (!this.attached || !this.helper) return;
    try {
      const { devices } = await this.helper.call('poses');
      this.devices = devices.map((d) => ({ index: d.index, class: d.class, role: d.role, controllerType: d.controllerType, model: d.model, valid: d.valid }));
      const before = JSON.stringify(this.handTypes);
      for (const hand of ['left', 'right']) {
        const c = devices.find((d) => d.role === hand && d.class === 'Controller');
        this.handTypes[hand] = c ? c.controllerType || c.model || '' : '';
      }
      if (JSON.stringify(this.handTypes) !== before) { this.record(`controllers: left ${this.handTypes.left || '-'}, right ${this.handTypes.right || '-'}`); this.applyAll(true); }
    } catch { /* not connected right now */ }
  }

  // "Bring it to me": the room anchor goes to 1 m in front of where you look, the others return to their default spot.
  async bring() {
    if (this.grab.on) await this.drop();
    const o = this.settings();
    if (o.anchor === 'room') {
      if (!this.attached || !this.helper) throw new Error('The overlay is not connected to SteamVR');
      const { devices } = await this.helper.call('poses');
      const hmd = devices.find((d) => d.index === 0 && L.isMatrix(d.matrix));
      if (!hmd) throw new Error('The headset has no position right now');
      const offset = L.inFrontOf(hmd.matrix, 1);
      this.core.engine.patchSettings((s) => { s.overlay.offsets.room = offset; });
    } else if (o.anchor === 'wrist') {
      await this.adjustWrist({ kind: 'reset' });
    } else {
      const def = { ...L.DEFAULT_OFFSETS[o.anchor] };
      this.core.engine.patchSettings((s) => { s.overlay.offsets[o.anchor] = def; });
    }
    this.record(`brought ${o.anchor} back`);
    return true;
  }

  async command(name, args) {
    if (name === 'grab') return this.grabStart();
    if (name === 'drop') return this.drop();
    if (name === 'bring') return this.bring();
    if (name === 'adjust') return this.adjustWrist(args);
    if (name === 'keyboard') { if (!this.attached || !this.helper) throw new Error('SteamVR is not connected'); return this.helper.call('keyboard', args); }
    if (name === 'keyboard.hide') { if (this.attached && this.helper) await this.helper.call('keyboard.hide').catch(() => {}); return true; }
    throw new Error(`Unknown overlay command "${name}"`);
  }

  // ---- what the UI can show ----
  record(text) {
    const line = `${new Date(this.now()).toISOString().slice(11, 19)} ${text}`;
    this.events.push(line);
    if (this.events.length > 40) this.events.shift();
    try {
      const file = path.join(this.dataDir, 'overlay.log');
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, `${line}\n`);
    } catch { /* the log is a convenience */ }
    return false; // lets callers use it in a || chain
  }

  setState(state, error = '') {
    if (state === this.state && error === this.error) return;
    if (state !== this.state) this.record(`state: ${state}${error ? ` (${error})` : ''}`);
    this.state = state;
    this.error = error;
    this.emitInfo(true);
  }

  async tickDiagnostics() {
    const c = this.counters;
    const t = this.now();
    const secs = Math.max(0.5, (t - c.windowStart) / 1000);
    c.fps = Math.round(c.paints / secs);
    c.paints = 0;
    c.windowStart = t;
    const o = this.settings();
    if (this.attached && this.helper && (o.diagnostics || o.anchor === 'wrist') && ++this.deviceTick % (o.diagnostics ? 1 : 5) === 0) await this.refreshDevices();
    this.emitInfo(false);
  }

  info() {
    return {
      state: this.state, error: this.error, connected: this.attached, shown: Boolean(this.helperStatus.shown), grabbing: this.grab.on, snap: this.snapRole,
      frame: this.frame ? `${this.frame.w}x${this.frame.h}` : '', pipe: Boolean(this.helper && this.helper.pipeConnected),
      upload: { path: this.helperStatus.upload || '', ms: this.helperStatus.uploadMs || 0, maxMs: this.helperStatus.uploadMaxMs || 0, count: this.helperStatus.uploads || 0 },
      dashboard: Boolean(this.helperStatus.dashboard),
      diag: { hands: this.handTypes, fps: this.counters.fps, sent: this.counters.sent, dropped: this.counters.dropped, pointer: this.pointer, devices: this.devices, events: this.events.slice(-8) },
    };
  }

  // Status pushes are throttled unless something important changed.
  emitInfo(important) {
    const t = this.now();
    if (!important && t - this.lastInfoEmit < 900) return;
    this.lastInfoEmit = t;
    try { this.core.providers.emit('status'); } catch { /* shutting down */ }
  }
}

module.exports = { OverlayManager, COLLAPSED_WIDTH };
