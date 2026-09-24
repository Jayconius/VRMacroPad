// Reads SteamVR battery/tracking state and a short list of picture settings (supersampling, motion
// smoothing, brightness, bounds, performance graph), and sends control commands (recenter, change a
// setting). Moved unchanged from the old core Providers class; the Windows side is helper/VrHelper.cs,
// reached here as ctx.winHelper('vr') (a "vr" Helper process is one of the five kinds the app ships).
const fs = require('fs');
const path = require('path');

const POLL_MS = 3000;
// A test hook: while a tool keeps a fresh "fake signal" file in the data folder it stands in for the real
// headset (used by the automated tests; nothing in the product writes it).
const FAKE_VR_FILE = 'fake_vr_signal.json';
const FAKE_VR_MAX_AGE_MS = 3000;
const FAKE_VR_SERVICE = '__steamvr_service__';
const FAKE_VR_CLASS = { HMD: 'hmd', Controller: 'controller', GenericTracker: 'tracker', TrackingReference: 'basestation' };
const KNOWN_MAX = 40;
const KEYS = ['vr.connected', 'vr.lowBattery', 'vr.charging', 'vr.trackingLost', 'vr.hmdWorn', 'vr.dropped', 'vr.device', 'vr.snapshot', 'vr.motionSmoothing', 'vr.perfGraph', 'vr.boundsForced', 'vr.supersample'];
const TRACKED = new Set(['hmd', 'controller', 'tracker']);

class SteamvrRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.now = ctx.now;
    this.fakePath = ctx.dataDir ? path.join(ctx.dataDir, FAKE_VR_FILE) : '';
    this.known = new Map(); // serial -> last seen device (survives restarts: runtime.json)
    this.knownSim = new Map(); // same, for simulator devices (never saved)
    this.knownLoaded = false;
    this.present = new Set();
    this.simActive = false;
    this.timer = null;
    this.busy = false;
    this.data = { connected: false, error: 'Checking SteamVR…', devices: [] };
  }

  get helper() { return this.ctx.winHelper('vr'); }

  sync(needs) {
    if (needs.vr) this.start(); else this.stop();
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.helper.release(); // drop our connection to SteamVR while nothing needs it
    this.data = { connected: false, error: 'Checking SteamVR…', devices: [] };
    this.simActive = false;
    this.present = new Set();
    this.knownSim.clear();
    for (const k of KEYS) this.hub.remove(k);
  }

  status() {
    return { state: this.data.connected ? 'connected' : 'off', error: this.data.error, simulated: Boolean(this.data.simulated) };
  }

  // The simulator's file, as a snapshot in the same shape the real helper returns. null = no fresh file.
  readFake() {
    if (!this.fakePath) return null;
    let stat;
    try { stat = fs.statSync(this.fakePath); } catch { return null; }
    if (Date.now() - stat.mtimeMs > FAKE_VR_MAX_AGE_MS) return null;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.fakePath, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    const src = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
    const devices = [];
    let service = false;
    for (const [serial, d] of Object.entries(src)) {
      if (!d || typeof d !== 'object') continue;
      if (serial === FAKE_VR_SERVICE) { service = true; continue; }
      const pct = d.battery_pct === null || d.battery_pct === undefined ? NaN : Number(d.battery_pct);
      const role = String(d.role || '').toLowerCase();
      devices.push({
        index: devices.length,
        class: FAKE_VR_CLASS[d.device_class] || 'other',
        role: role === 'left' || role === 'right' ? role : '',
        model: String(d.model || ''),
        serial,
        type: '',
        manufacturer: String(d.manufacturer || ''),
        trackingOk: typeof d.tracking_ok === 'boolean' ? d.tracking_ok : null,
        worn: typeof d.hmd_active === 'boolean' ? d.hmd_active : null,
        hasBattery: Number.isFinite(pct),
        battery: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : -1,
        charging: Boolean(d.charging),
      });
    }
    return service
      ? { connected: true, error: '', devices, simulated: true }
      : { connected: false, error: 'SteamVR is not running (simulated)', devices: [], simulated: true };
  }

  loadKnown() {
    if (this.knownLoaded) return;
    this.knownLoaded = true;
    try {
      const saved = this.ctx.store.readRuntime().vrKnown;
      for (const d of Array.isArray(saved) ? saved : []) if (d && d.serial) this.known.set(String(d.serial), { ...d });
    } catch { /* start with none */ }
  }

  saveKnown() {
    try { this.ctx.store.writeRuntime({ vrKnown: [...this.known.values()] }); } catch { /* not critical */ }
  }

  // Remembers every device ever seen so one that is switched off or has dropped out can still be listed
  // (with its last battery level), and publishes the values buttons and triggers can react to.
  apply(snap) {
    this.loadKnown();
    const known = snap.simulated ? this.knownSim : this.known;
    const list = snap.devices || [];
    const present = new Set();
    let dirty = false;
    if (snap.connected) {
      for (const d of list) {
        if (!d.serial) continue;
        present.add(d.serial);
        if (!known.has(d.serial)) dirty = true;
        known.set(d.serial, {
          serial: d.serial, class: d.class, role: d.role, model: d.model, manufacturer: d.manufacturer || '',
          hasBattery: d.hasBattery, battery: d.battery, charging: d.charging, lastSeen: this.now(),
        });
      }
      if (known.size > KNOWN_MAX) {
        const oldest = [...known.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, known.size - KNOWN_MAX);
        for (const d of oldest) known.delete(d.serial);
        dirty = true;
      }
      if (!snap.simulated && [...this.present].some((s) => !present.has(s))) dirty = true;
      if (!snap.simulated) this.present = present;
    }
    snap.dropped = snap.connected
      ? [...known.values()].filter((d) => !present.has(d.serial) && d.class !== 'other').map((d) => ({ ...d }))
      : [];
    if (dirty && !snap.simulated) this.saveKnown();

    const low = (this.ctx.settings().lowBatteryPercent) || 15;
    const devices = snap.connected ? list : [];
    const byId = {};
    for (const d of devices) if (d.serial) byId[d.serial] = true;
    this.hub.set('vr.connected', Boolean(snap.connected));
    this.hub.set('vr.lowBattery', devices.some((d) => d.hasBattery && d.battery >= 0 && d.battery <= low && !d.charging));
    this.hub.set('vr.charging', devices.some((d) => d.hasBattery && d.charging));
    this.hub.set('vr.trackingLost', devices.some((d) => TRACKED.has(d.class) && d.trackingOk === false));
    this.hub.set('vr.hmdWorn', devices.some((d) => d.class === 'hmd' && d.worn === true));
    this.hub.set('vr.dropped', snap.dropped.length > 0);
    this.hub.set('vr.device', byId);
    this.hub.set('vr.snapshot', snap);
    this.data = snap;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const wasConnected = this.data.connected;
      const fake = this.readFake();
      if (fake) {
        if (!this.simActive) { this.simActive = true; this.helper.release(); }
        this.apply(fake);
      } else {
        this.simActive = false;
        const snap = await this.helper.call('snapshot', {}, 6000);
        this.apply(snap);
        this.pollSettings(snap.connected).catch(() => {}); // not awaited: the picture of the devices must not wait for it
      }
      if (this.data.connected !== wasConnected) this.ctx.emitStatus();
    } catch (err) {
      this.data = { connected: false, error: err.message, devices: [], dropped: [] };
      for (const k of KEYS) if (k !== 'vr.snapshot') this.hub.set(k, k === 'vr.device' ? {} : false);
      this.hub.set('vr.snapshot', this.data);
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    return this.data;
  }

  // The few SteamVR settings buttons can follow (motion smoothing, performance graph, forced bounds, supersampling).
  async pollSettings(connected) {
    let values = null;
    let forced = false;
    if (connected) {
      try {
        const st = await this.helper.call('settings.state', {}, 6000);
        if (st.connected) { values = st.values || {}; forced = Boolean(st.boundsForced); }
      } catch { /* an older helper or SteamVR going away: no settings this round */ }
    }
    this.hub.set('vr.motionSmoothing', Boolean(values && values['steamvr.motionSmoothing'] === true));
    this.hub.set('vr.perfGraph', Boolean(values && values['steamvr.showPerfGraph'] === true));
    this.hub.set('vr.boundsForced', forced);
    this.hub.set('vr.supersample', values && Number.isFinite(values['steamvr.supersampleScale']) ? values['steamvr.supersampleScale'] : 0);
  }

  // Runs a SteamVR control command (change a setting, recenter...) and refreshes what buttons follow.
  async control(op, args = {}) {
    if (this.simActive) throw new Error('The SteamVR simulator is running instead of the real SteamVR');
    try {
      return await this.helper.call(op, args, 8000);
    } finally {
      if (this.timer) this.poll();
    }
  }

  // ---- for the editor's dropdowns ----
  async options() {
    this.loadKnown();
    const map = new Map();
    for (const d of [...this.known.values(), ...(this.data.devices || [])]) if (d.serial && d.class !== 'other') map.set(d.serial, d);
    return [...map.values()].map((d) => ({ value: d.serial, label: `${d.model || d.class} (${d.serial})` }));
  }
}

module.exports = { SteamvrRuntime };
