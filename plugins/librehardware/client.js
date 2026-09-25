// Reads Libre Hardware Monitor's built-in web server (Options -> Remote Web Server -> Run), which only shows numbers:
//   GET http://127.0.0.1:8085/data.json  ->  a tree: computer -> hardware -> group (Temperatures, Load...) -> sensors
// Each sensor is { Text, Value: "71.8 °C", Min, Max, SensorId: "/amdcpu/0/temperature/2", Type: "Temperature" }.
// Nothing is written and nothing is controlled. The result is turned into the plain list the widgets use (see sensors.js).
const http = require('http');
const { SPEED_UNITS } = require('./sensors');

const TIMEOUT_MS = 4000;
const MAX_BYTES = 8 * 1024 * 1024;
const HOST = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;

// "1.256 V" -> { n: 1.256, unit: 'V' }; "3,5 GHz" too; "-" or "" -> NaN. Both "1,234.5" and "1.234,5" are understood.
function parseValue(text) {
  const m = /^\s*(-?\d[\d.,]*)\s*(.*?)\s*$/.exec(String(text === undefined || text === null ? '' : text));
  if (!m) return { n: NaN, unit: '' };
  let num = m[1];
  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) num = lastComma > lastDot ? num.replace(/\./g, '').replace(',', '.') : num.replace(/,/g, '');
  else if (lastComma >= 0) num = /,.*,/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.'); // "1,256 V" is a decimal comma
  const n = Number(num);
  return { n: Number.isFinite(n) ? n : NaN, unit: m[2] };
}

function hardwareKind(id) {
  const h = String(id || '').toLowerCase();
  if (/^\/(intelcpu|amdcpu)/.test(h)) return 'cpu';
  if (h.startsWith('/gpu')) return 'gpu';
  if (h === '/ram') return 'ram';
  if (h === '/vram') return 'vram';
  if (/^\/(nvme|hdd|ssd|storage)/.test(h)) return 'storage';
  if (h.startsWith('/nic')) return 'network';
  if (h.startsWith('/battery')) return 'battery';
  if (/^\/(motherboard|lpc|embeddedcontroller|superio)/.test(h)) return 'motherboard';
  return 'other';
}

const TYPES = { temperature: 'temperature', load: 'load', clock: 'clock', power: 'power', fan: 'fan', voltage: 'voltage', current: 'current', data: 'data', smalldata: 'data', throughput: 'throughput' };

// One sensor, all numbers in the units the widgets expect (°C, B/s, GB or MB).
function normalise(node, hwName) {
  const id = String(node.SensorId);
  const type = TYPES[String(node.Type || '').toLowerCase()] || 'other';
  const v = parseValue(node.Value);
  const lo = parseValue(node.Min);
  const hi = parseValue(node.Max);
  let unit = v.unit;
  let k = 1;
  let f = (x) => x;
  if (unit === '°F') { unit = '°C'; f = (x) => ((x - 32) * 5) / 9; }
  else if (type === 'throughput' && SPEED_UNITS[unit]) { k = SPEED_UNITS[unit]; unit = 'B/s'; }
  const conv = (x) => (Number.isFinite(x) ? f(x) * k : NaN);
  return {
    key: `${id}#${node.Text}`, hw: hwName, hwKind: hardwareKind(id.replace(/\/[a-z]+\/[^/]+$/i, '')), type,
    name: String(node.Text || ''), value: conv(v.n), unit, min: conv(lo.n), max: conv(hi.n),
  };
}

// The whole tree -> a flat list. The hardware a sensor belongs to is two levels up (hardware -> group -> sensor).
function parseTree(root) {
  const out = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (node.SensorId) {
      const hw = trail.length >= 2 ? trail[trail.length - 2] : (trail[trail.length - 1] || '');
      out.push(normalise(node, hw));
      return;
    }
    const kids = Array.isArray(node.Children) ? node.Children : [];
    for (const c of kids) walk(c, [...trail, String(node.Text || '')]);
  };
  walk(root, []);
  return out;
}

function base(settings) {
  const host = String(settings.host || '127.0.0.1').trim();
  const port = Math.round(Number(settings.port) || 8085);
  if (!HOST.test(host)) throw new Error('The address in Settings is not a valid host name or IP address.');
  if (!(port >= 1 && port <= 65535)) throw new Error('The port in Settings must be between 1 and 65535.');
  return { host, port, label: `${host}:${port}` };
}

// One request, resolving to the list of sensors or rejecting with a plain sentence.
function fetchSensors(settings, timeoutMs = TIMEOUT_MS) {
  const { host, port, label } = base(settings);
  const headers = { Accept: 'application/json' };
  if (settings.username) headers.Authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password || ''}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = http.request({ host: host.replace(/^\[|\]$/g, ''), port, path: '/data.json', method: 'GET', headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) req.destroy(new Error('too big')); else chunks.push(c); });
      res.on('error', () => done(reject, new Error(`Libre Hardware Monitor at ${label} dropped the connection.`)));
      res.on('end', () => {
        if (res.statusCode === 401) return done(reject, new Error('Libre Hardware Monitor wants a user name and password (Settings has the boxes for them).'));
        if (res.statusCode !== 200) return done(reject, new Error(`Libre Hardware Monitor said no (${res.statusCode}).`));
        try { const list = parseTree(JSON.parse(Buffer.concat(chunks).toString('utf8'))); if (!list.length) throw new Error('empty'); done(resolve, list); } catch { done(reject, new Error(`${label} answered, but it does not look like Libre Hardware Monitor.`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      if (settled) return;
      if (err && err.message === 'timeout') return done(reject, new Error(`Libre Hardware Monitor at ${label} did not answer in time.`));
      done(reject, new Error(`Can't reach Libre Hardware Monitor at ${label}. Is it running, with Options → Remote Web Server → Run ticked?`));
    });
    req.end();
  });
}

module.exports = { fetchSensors, parseTree, parseValue, hardwareKind };
