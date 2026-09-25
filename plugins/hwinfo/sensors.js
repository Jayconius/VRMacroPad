// What both hardware plugins (Libre Hardware Monitor and HWiNFO) share, so a "CPU temperature" widget means the same
// thing whichever program supplies the numbers. Each plugin must be self-contained, so this file is kept as an identical
// copy in plugins/hwinfo/ (a test makes sure the two never drift apart). Do not put anything program-specific here.
//
// A reading (a "sensor") looks like:
//   { key, hw, hwKind, type, name, value, unit, min, max }
//   hwKind: cpu | gpu | ram | vram | storage | network | motherboard | battery | other
//   type:   temperature | load | clock | power | fan | voltage | current | data | throughput | other
//   unit:   '°C' '%' 'MHz' 'W' 'RPM' 'V' 'A' 'GB' 'MB' 'B/s' or ''   (data is GB or MB, network speed is always B/s)

const HISTORY_LENGTH = 60;

// ---- picking readings out of a list ----
const has = (s, re) => re.test(s.name);
const ofKind = (sensors, hwKind, type) => sensors.filter((s) => s.hwKind === hwKind && s.type === type && Number.isFinite(s.value));
const first = (list, ...res) => { for (const re of res) { const hit = list.find((s) => re.test(s.name)); if (hit) return hit; } return null; };
const highest = (list) => list.reduce((best, s) => (!best || s.value > best.value ? s : best), null);

// With two GPUs the busy one is the one you are looking at, so prefer the one with the most load.
function mainGpu(sensors) {
  const loads = ofKind(sensors, 'gpu', 'load').filter((s) => /core|gpu total|3d|graphics/i.test(s.name));
  const best = highest(loads);
  const byHw = best ? best.hw : (sensors.find((s) => s.hwKind === 'gpu') || {}).hw;
  return byHw ? sensors.filter((s) => s.hwKind === 'gpu' && s.hw === byHw) : [];
}
const mainCpu = (sensors) => sensors.filter((s) => s.hwKind === 'cpu' && s.hw === (sensors.find((x) => x.hwKind === 'cpu') || {}).hw);

const PRESETS = [
  {
    id: 'cpuTemp', label: 'CPU temperature', short: 'CPU', type: 'temperature', group: 'CPU', warn: 80, alert: 90, max: 100,
    pick: (all) => { const l = ofKind(mainCpu(all), 'cpu', 'temperature'); return first(l, /package|tctl|tdie|cpu \(tctl/i, /^cpu$/i, /core max|average/i) || highest(l.filter((s) => !/distance|margin|limit/i.test(s.name))); },
  },
  { id: 'cpuLoad', label: 'CPU usage', short: 'CPU', type: 'load', group: 'CPU', warn: 90, alert: 98, max: 100, pick: (all) => first(ofKind(mainCpu(all), 'cpu', 'load'), /total/i) },
  { id: 'cpuClock', label: 'CPU speed', short: 'CPU', type: 'clock', group: 'CPU', pick: (all) => { const l = ofKind(mainCpu(all), 'cpu', 'clock').filter((s) => !/bus|effective|limit|cache|fabric|controller|uclk|fclk/i.test(s.name)); return first(l, /average|avg/i) || highest(l.filter((s) => /^core ?#?\d+/i.test(s.name))) || highest(l); } },
  { id: 'cpuPower', label: 'CPU power', short: 'CPU', type: 'power', group: 'CPU', pick: (all) => { const l = ofKind(mainCpu(all), 'cpu', 'power'); return first(l, /package|cpu package|total/i) || highest(l); } },
  { id: 'gpuTemp', label: 'GPU temperature', short: 'GPU', type: 'temperature', group: 'GPU', warn: 80, alert: 90, max: 100, pick: (all) => { const l = ofKind(mainGpu(all), 'gpu', 'temperature'); return first(l, /^gpu( core| temperature)?$/i, /core|gpu/i) || highest(l); } },
  { id: 'gpuHotSpot', label: 'GPU hot spot', short: 'GPU hot spot', type: 'temperature', group: 'GPU', warn: 90, alert: 100, max: 110, pick: (all) => first(ofKind(mainGpu(all), 'gpu', 'temperature'), /hot ?spot/i, /^(?!.*mem).*junction/i) },
  { id: 'gpuLoad', label: 'GPU usage', short: 'GPU', type: 'load', group: 'GPU', warn: 95, alert: 99, max: 100, pick: (all) => { const l = ofKind(mainGpu(all), 'gpu', 'load'); return first(l, /^gpu( core| total| utilization)?$/i, /^gpu core/i, /core|total|3d/i); } },
  {
    id: 'gpuMemory', label: 'GPU memory used', short: 'VRAM', type: 'load', group: 'GPU', warn: 90, alert: 97, max: 100,
    pick: (all) => {
      const g = mainGpu(all);
      const pct = first(ofKind(g, 'gpu', 'load'), /^gpu memory( used| usage)?$/i, /memory (used|usage)/i);
      if (pct) return pct;
      const used = first(ofKind(g, 'gpu', 'data'), /memory used|dedicated/i);
      const total = first(ofKind(g, 'gpu', 'data'), /memory total/i);
      return used && total && total.value > 0 ? { ...used, name: 'GPU memory used', type: 'load', unit: '%', value: (used.value / total.value) * 100, min: NaN, max: NaN } : null;
    },
  },
  { id: 'gpuPower', label: 'GPU power', short: 'GPU', type: 'power', group: 'GPU', pick: (all) => { const l = ofKind(mainGpu(all), 'gpu', 'power'); return first(l, /package|total|board|gpu power/i) || highest(l); } },
  { id: 'gpuClock', label: 'GPU speed', short: 'GPU', type: 'clock', group: 'GPU', pick: (all) => { const l = ofKind(mainGpu(all), 'gpu', 'clock'); return first(l, /^gpu( core)?$/i, /core|gpu clock/i) || highest(l); } },
  { id: 'gpuFan', label: 'GPU fan', short: 'GPU fan', type: 'fan', group: 'GPU', pick: (all) => { const l = ofKind(mainGpu(all), 'gpu', 'fan'); return l[0] || null; } },
  { id: 'ramLoad', label: 'Memory used (%)', short: 'RAM', type: 'load', group: 'Memory', warn: 85, alert: 95, max: 100, pick: (all) => first(ofKind(all, 'ram', 'load'), /memory|physical|used/i) },
  {
    id: 'ramUsed', label: 'Memory used (GB)', short: 'RAM', type: 'data', group: 'Memory',
    pick: (all) => { const s = first(ofKind(all, 'ram', 'data'), /memory used|physical memory used/i); return s ? toGB(s) : null; },
  },
  { id: 'driveTemp', label: 'Hottest drive', short: 'Drive', type: 'temperature', group: 'Storage', warn: 60, alert: 70, max: 90, pick: (all) => highest(ofKind(all, 'storage', 'temperature').filter((s) => !/warning|critical|limit|threshold|max|min/i.test(s.name))) },
  { id: 'download', label: 'Download speed', short: 'Down', type: 'throughput', group: 'Network', pick: (all) => busiestNetwork(all, /down|\bdl\b|receive|rx|\bin\b/i) },
  { id: 'upload', label: 'Upload speed', short: 'Up', type: 'throughput', group: 'Network', pick: (all) => busiestNetwork(all, /\bup|\bul\b|send|tx|\bout\b/i) },
];

// Data in MB is shown in GB so a memory figure reads the same from either program.
function toGB(s) {
  if (s.unit === 'MB') return { ...s, unit: 'GB', value: s.value / 1024, min: s.min / 1024, max: s.max / 1024 };
  return s;
}

// The network card that is actually moving data (VPN, Bluetooth and virtual adapters sit at zero).
function busiestNetwork(all, re) {
  const speeds = ofKind(all, 'network', 'throughput');
  const total = new Map();
  for (const s of speeds) total.set(s.hw, (total.get(s.hw) || 0) + s.value);
  let bestHw = null;
  for (const [hw, v] of total) if (bestHw === null || v > total.get(bestHw)) bestHw = hw;
  if (bestHw === null) return null;
  return speeds.find((s) => s.hw === bestHw && re.test(s.name)) || null;
}

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

function presetSensor(sensors, id) {
  const p = PRESET_BY_ID.get(id);
  if (!p) return null;
  try { return p.pick(sensors) || null; } catch { return null; }
}

// ---- naming: what the sensor picker shows (words, never raw ids) ----
// "Hardware: Sensor" and, when two share that, "(type)" and then "#2". The stored value is this name.
function pickerNames(sensors) {
  const base = sensors.map((s) => `${s.hw}: ${s.name}`);
  const count = new Map();
  for (const b of base) count.set(b, (count.get(b) || 0) + 1);
  const withType = sensors.map((s, i) => (count.get(base[i]) > 1 ? `${base[i]} (${s.type})` : base[i]));
  const seen = new Map();
  const names = withType.map((n) => { const c = (seen.get(n) || 0) + 1; seen.set(n, c); return c > 1 ? `${n} #${c}` : n; });
  return names;
}

function findByName(sensors, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const names = pickerNames(sensors);
  const i = names.findIndex((n) => n.toLowerCase() === want);
  return i >= 0 ? sensors[i] : (sensors.find((s) => s.name.toLowerCase() === want) || null);
}

// ---- turning a reading into text ----
const toF = (c) => (c * 9) / 5 + 32;

// Returns { text, number, unit } with the temperature already in the unit you chose.
function display(s, fahrenheit) {
  if (!s || !Number.isFinite(s.value)) return { text: '—', number: NaN, unit: '' };
  let v = s.value;
  let unit = s.unit || '';
  if (unit === '°C' && fahrenheit) { v = toF(v); unit = '°F'; }
  if (unit === 'MHz' && Math.abs(v) >= 1000) return { text: `${(v / 1000).toFixed(2)} GHz`, number: v / 1000, unit: 'GHz' };
  if (unit === 'B/s') return speedText(v);
  if (unit === 'W') return { text: `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)} W`, number: v, unit };
  if (unit === 'V' || unit === 'A') return { text: `${v.toFixed(3)} ${unit}`, number: v, unit };
  if (unit === 'GB' || unit === 'MB') return { text: `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)} ${unit}`, number: v, unit };
  const tight = unit === '%' || unit === '°C' || unit === '°F';
  return { text: `${Math.round(v)}${tight ? '' : ' '}${unit}`.trim(), number: v, unit };
}

function speedText(bytesPerSecond) {
  const v = Math.max(0, bytesPerSecond);
  const bits = [['GB/s', 1e9], ['MB/s', 1e6], ['KB/s', 1e3]];
  for (const [u, n] of bits) if (v >= n) return { text: `${(v / n).toFixed(v / n >= 100 ? 0 : 1)} ${u}`, number: v, unit: 'B/s' };
  return { text: `${Math.round(v)} B/s`, number: v, unit: 'B/s' };
}

// "12.5 KB/s" -> bytes per second (decimal, as Libre Hardware Monitor shows it). Used by the client of each program.
const SPEED_UNITS = { 'B/s': 1, 'KB/s': 1e3, 'MB/s': 1e6, 'GB/s': 1e9, 'KiB/s': 1024, 'MiB/s': 1048576, 'GiB/s': 1073741824 };

// ---- history: a short ring of recent values per sensor, for the little graphs ----
class History {
  constructor(length = HISTORY_LENGTH) {
    this.length = length;
    this.map = new Map();
  }

  push(sensors) {
    const seen = new Set();
    for (const s of sensors) {
      if (!Number.isFinite(s.value)) continue;
      seen.add(s.key);
      let a = this.map.get(s.key);
      if (!a) { a = []; this.map.set(s.key, a); }
      a.push(s.value);
      if (a.length > this.length) a.shift();
    }
    for (const k of [...this.map.keys()]) if (!seen.has(k)) this.map.delete(k);
  }

  get(key) { return (this.map.get(key) || []).slice(); }

  clear() { this.map.clear(); }
}

// ---- how worried to be: 'ok' | 'warn' | 'error' (only for a reading that has limits) ----
function statusFor(value, warn, alert) {
  if (!Number.isFinite(value)) return '';
  if (Number.isFinite(alert) && value >= alert) return 'error';
  if (Number.isFinite(warn) && value >= warn) return 'warn';
  return 'ok';
}

// Limits typed on a widget are in the unit you display in (°F if you chose that); they are compared in °C.
const limitInCelsius = (n, fahrenheit) => (fahrenheit ? ((n - 32) * 5) / 9 : n);

module.exports = { PRESETS, PRESET_BY_ID, presetSensor, pickerNames, findByName, display, speedText, SPEED_UNITS, History, statusFor, limitInCelsius, toF, mainGpu, toGB, HISTORY_LENGTH, ofKind, highest, has };
