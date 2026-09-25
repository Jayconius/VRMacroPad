// The runtime both hardware plugins share (an identical copy lives in plugins/hwinfo/; a test keeps them the same).
// It polls a source (the plugin's own client), remembers the last reading and a short history, and publishes a few
// yes/no states ("the CPU is hot") to the hub so buttons can light up. It only runs while a button or trigger needs it.
const { History, presetSensor, pickerNames, findByName, display, statusFor, PRESETS } = require('./sensors');

const DEFAULT_INTERVAL_S = 2;

class MonitorRuntime {
  // options: { prefix: 'lhm', needsKey: 'lhm', fetch: async (settings) => sensors[], name: 'Libre Hardware Monitor' }
  constructor(ctx, options) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.prefix = options.prefix;
    this.needsKey = options.needsKey || options.prefix;
    this.source = options.fetch;
    this.name = options.name;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.history = new History();
    this.data = { connected: false, error: '', sensors: [], at: 0 };
    this.keys = ['connected', 'cpuHot', 'gpuHot', 'driveHot', 'anyHot', 'cpuBusy', 'gpuBusy', 'ramHigh'].map((k) => `${this.prefix}.${k}`);
  }

  sync(needs) {
    if (needs[this.needsKey]) this.start(); else this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.history.clear();
    this.data = { connected: false, error: '', sensors: [], at: 0 };
    for (const k of this.keys) this.hub.remove(k);
  }

  status() {
    return { state: this.data.connected ? 'connected' : (this.data.error ? 'error' : 'off'), error: this.data.error };
  }

  settings() { return this.ctx.settings() || {}; }

  fahrenheit() { return this.settings().fahrenheit === true; }

  intervalMs() {
    const s = Number(this.settings().interval);
    return Math.round((s >= 0.5 && s <= 60 ? s : DEFAULT_INTERVAL_S) * 1000);
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll(), this.intervalMs());
    if (this.timer.unref) this.timer.unref();
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    const was = this.data.connected;
    const wasError = this.data.error;
    try {
      const sensors = await this.source(this.settings());
      if (!this.running) return;
      this.history.push(sensors);
      this.data = { connected: true, error: '', sensors, at: this.ctx.now ? this.ctx.now() : Date.now() };
      this.publish();
    } catch (err) {
      if (!this.running) return;
      this.data = { connected: false, error: err.message, sensors: this.data.sensors, at: this.data.at };
      for (const k of this.keys) this.hub.set(k, false);
    } finally {
      this.busy = false;
      if (this.data.connected !== was || this.data.error !== wasError) this.ctx.emitStatus();
      this.schedule();
    }
  }

  limits() {
    const s = this.settings();
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
    return {
      temp: num(s.tempWarn, 85),
      drive: num(s.driveWarn, 60),
      load: num(s.loadWarn, 95),
      ram: num(s.ramWarn, 90),
    };
  }

  publish() {
    const all = this.data.sensors;
    const lim = this.limits();
    const at = (id) => { const s = presetSensor(all, id); return s ? s.value : NaN; };
    const over = (v, limit) => Number.isFinite(v) && v >= limit;
    const cpuHot = over(at('cpuTemp'), lim.temp);
    const gpuHot = over(at('gpuTemp'), lim.temp) || over(at('gpuHotSpot'), lim.temp + 10);
    const driveHot = over(at('driveTemp'), lim.drive);
    const set = (k, v) => this.hub.set(`${this.prefix}.${k}`, v);
    set('connected', true);
    set('cpuHot', cpuHot);
    set('gpuHot', gpuHot);
    set('driveHot', driveHot);
    set('anyHot', cpuHot || gpuHot || driveHot);
    set('cpuBusy', over(at('cpuLoad'), lim.load));
    set('gpuBusy', over(at('gpuLoad'), lim.load));
    set('ramHigh', over(at('ramLoad'), lim.ram));
  }

  // One fresh reading when nothing is polling (a button press while no widget is showing).
  async ensure() {
    if (this.data.connected && this.ctx.now && this.ctx.now() - this.data.at < 3000) return;
    const sensors = await this.source(this.settings());
    this.data = { connected: true, error: '', sensors, at: this.ctx.now ? this.ctx.now() : Date.now() };
  }

  snapshot() { return this.data; }

  preset(id) { return presetSensor(this.data.sensors, id); }

  // A sensor picked by name (from the list) for a "custom" widget.
  custom(name) { return findByName(this.data.sensors, name); }

  historyOf(sensor) { return sensor ? this.history.get(sensor.key) : []; }

  clearHistory() { this.history.clear(); }

  // For the sensor picker: [{ value: name, label: name, hint: 'now: 72°C' }]. Fetches fresh so the list works even when
  // nothing is running yet ("Save and test connection" and the editor use this).
  async options() {
    let sensors = this.data.sensors;
    if (!this.data.connected || !sensors.length) sensors = await this.source(this.settings());
    const names = pickerNames(sensors);
    const f = this.fahrenheit();
    return sensors
      .map((s, i) => ({ value: names[i], label: names[i], hint: `${s.type} · ${display(s, f).text}` }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
  }

  // One line for a preset: { label, text, number, status } (for the overview widget, the toast action and states).
  line(id) {
    const p = PRESETS.find((x) => x.id === id);
    const s = this.preset(id);
    if (!p) return null;
    if (!s) return { label: p.label, short: p.short, text: '—', number: NaN, status: '' };
    const d = display(s, this.fahrenheit());
    const lim = this.limits();
    const isTemp = p.type === 'temperature';
    const status = statusFor(s.value, isTemp ? (id === 'driveTemp' ? lim.drive : lim.temp) : (p.type === 'load' ? (id === 'ramLoad' ? lim.ram : lim.load) : NaN), NaN);
    return { label: p.label, short: p.short, text: d.text, number: d.number, status };
  }
}

module.exports = { MonitorRuntime, DEFAULT_INTERVAL_S };
