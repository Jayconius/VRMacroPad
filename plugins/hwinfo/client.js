// Reads HWiNFO through its "Shared Memory Support" (HWiNFO -> Settings -> tick Shared Memory Support, and keep its Sensors
// window running). The Windows helper (src/helper/HwinfoHelper.cs) reads that read-only block and answers with sensors and
// readings; this file turns them into the plain list the widgets use (see sensors.js). Nothing is written to HWiNFO.
const { SPEED_UNITS } = require('./sensors');

const TYPE_BY_HWINFO = { 1: 'temperature', 2: 'voltage', 3: 'fan', 4: 'current', 5: 'power', 6: 'clock', 7: 'load' };

// HWiNFO splits one device into several sensor groups ("CPU [#0]: AMD Ryzen 7: Enhanced"); they are one CPU to us.
function deviceName(sensorName) {
  const m = /^((?:CPU|[di]?GPU) \[#\d+\]: [^:]+)/i.exec(sensorName);
  if (m) return m[1].trim();
  // "S.M.A.R.T.: Force MP510 (1911820700012771803C) [C:]" and "Drive: Force MP510 (1911820700012771803C) [C:]" are one drive, shown without the serial number
  const d = /^(?:S\.M\.A\.R\.T\.|Drive):\s*(.*)$/i.exec(sensorName);
  return d ? d[1].replace(/\s*\([0-9A-Za-z]{10,}\)/, '').trim() : sensorName;
}

function hardwareKind(sensorName, label) {
  const n = String(sensorName);
  if (/^CPU\b/i.test(n)) return 'cpu';
  if (/^[di]?GPU\b/i.test(n)) return 'gpu'; // "GPU [#0]", "dGPU [#0]" (a separate card) or "iGPU [#1]" (built into the CPU)
  if (/^(Drive|S\.M\.A\.R\.T\.)/i.test(n)) return 'storage';
  if (/^Network/i.test(n)) return 'network';
  if (/battery/i.test(n)) return 'battery';
  if (/^Physical Memory/i.test(label)) return 'ram';
  if (/^(Virtual Memory|Page File)/i.test(label)) return 'vram';
  if (/memory/i.test(n) || /^(System|Motherboard)/i.test(n)) return /^Memory/i.test(n) ? 'ram' : 'motherboard';
  return 'other';
}

function normalise(r, sensorName, keyCounter) {
  const label = String(r.label || '');
  let unit = String(r.unit || '');
  let type = TYPE_BY_HWINFO[r.type] || 'other';
  let k = 1;
  let f = (x) => x;
  if (unit === '°F') { unit = '°C'; f = (x) => ((x - 32) * 5) / 9; }
  else if (SPEED_UNITS[unit]) { type = 'throughput'; k = SPEED_UNITS[unit]; unit = 'B/s'; }
  else if ((unit === 'MB' || unit === 'GB') && type === 'other') type = 'data';
  else if (unit === '%' && type === 'other') type = 'load'; // "Physical Memory Load" is a percentage HWiNFO files under "other"
  const conv = (x) => (Number.isFinite(x) ? f(x) * k : NaN);
  const base = `${sensorName}|${label}`;
  const n = (keyCounter.get(base) || 0) + 1;
  keyCounter.set(base, n);
  return {
    key: n > 1 ? `${base}#${n}` : base, hw: deviceName(sensorName), hwKind: hardwareKind(sensorName, label), type, name: label,
    value: conv(Number(r.value)), unit, min: conv(Number(r.min)), max: conv(Number(r.max)),
  };
}

// The helper's answer -> the flat list. Readings that HWiNFO reports as text-like states (unit "Yes/No") are left out.
function parseReading(result) {
  const sensors = Array.isArray(result && result.sensors) ? result.sensors : [];
  const counter = new Map();
  const out = [];
  for (const r of Array.isArray(result && result.readings) ? result.readings : []) {
    const sensor = sensors[r.sensor];
    if (!sensor || /yes\/no/i.test(r.unit || '')) continue;
    out.push(normalise(r, String(sensor.name || ''), counter));
  }
  return out;
}

// One read, through the plugin's Windows helper.
function makeFetch(ctx) {
  return async () => {
    const result = await ctx.winHelper('hwinfo').call('read', {}, 6000);
    return parseReading(result);
  };
}

module.exports = { makeFetch, parseReading, deviceName, hardwareKind };
