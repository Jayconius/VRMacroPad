// The two hardware plugins (Libre Hardware Monitor and HWiNFO): reading their data, the shared presets and widgets,
// the states buttons can follow, and the HWiNFO helper against a pretend HWiNFO memory block.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Helper } = require('../src/core/helper');
const { tempDir, waitFor } = require('./helpers');
const lhm = require('../plugins/librehardware/plugin');
const hwi = require('../plugins/hwinfo/plugin');
const { parseTree, parseValue } = require('../plugins/librehardware/client');
const hwClient = require('../plugins/hwinfo/client');
const { display, presetSensor, pickerNames, speedText } = require('../plugins/librehardware/sensors');

const onWindows = process.platform === 'win32';

// ---- Libre Hardware Monitor's data.json, cut down but shaped like the real one ----
const sensor = (id, type, text, value, min, max) => ({ id: 0, Text: text, Min: min || value, Value: value, Max: max || value, ImageURL: '', SensorId: id, Type: type, Children: [] });
const group = (text, kids) => ({ id: 0, Text: text, Min: '', Value: '', Max: '', ImageURL: '', Children: kids });
const hardware = (text, hwid, groups) => ({ id: 0, Text: text, Min: '', Value: '', Max: '', ImageURL: `images_icon/${hwid}.png`, Children: groups });
function tree(over = {}) {
  const t = over.temp || '70.3 °C';
  return group('Sensor', [group('PC', [
    hardware('AMD Ryzen 7', 'cpu', [
      group('Temperatures', [sensor('/amdcpu/0/temperature/2', 'Temperature', 'Core (Tctl/Tdie)', t, '60.0 °C', '80.0 °C'), sensor('/amdcpu/0/temperature/3', 'Temperature', 'CCD1 (Tdie)', '65.0 °C')]),
      group('Load', [sensor('/amdcpu/0/load/0', 'Load', 'CPU Total', over.cpu || '12,6 %'), sensor('/amdcpu/0/load/2', 'Load', 'CPU Core #1', '26.6 %')]),
      group('Clocks', [sensor('/amdcpu/0/clock/0', 'Clock', 'Bus Speed', '99.8 MHz'), sensor('/amdcpu/0/clock/1', 'Clock', 'Cores (Average)', '3712.0 MHz')]),
      group('Powers', [sensor('/amdcpu/0/power/0', 'Power', 'Package', '35.1 W')]),
    ]),
    hardware('NVIDIA GeForce RTX 3080', 'gpu', [
      group('Temperatures', [sensor('/gpu-nvidia/0/temperature/0', 'Temperature', 'GPU Core', over.gpuTemp || '48.0 °C'), sensor('/gpu-nvidia/0/temperature/2', 'Temperature', 'GPU Hot Spot', '57.3 °C')]),
      group('Load', [sensor('/gpu-nvidia/0/load/0', 'Load', 'GPU Core', '26.0 %'), sensor('/gpu-nvidia/0/load/3', 'Load', 'GPU Memory', '25.7 %'), sensor('/gpu-nvidia/0/load/3', 'Load', 'GPU Bus', '1.0 %')]),
      group('Fans', [sensor('/gpu-nvidia/0/fan/1', 'Fan', 'GPU Fan 1', '1117 RPM')]),
    ]),
    hardware('Total Memory', 'ram', [group('Load', [sensor('/ram/load/0', 'Load', 'Memory', over.ram || '52.2 %')]), group('Data', [sensor('/ram/data/0', 'Data', 'Memory Used', '16.7 GB')])]),
    hardware('Virtual Memory', 'ram', [group('Load', [sensor('/vram/load/1', 'Load', 'Memory', '79.6 %')])]),
    hardware('Force MP510', 'hdd', [group('Temperatures', [sensor('/nvme/0/temperature/0', 'Temperature', 'Composite Temperature', '54.0 °C'), sensor('/nvme/0/temperature/10', 'Temperature', 'Warning Temperature', '69.0 °C')]), group('Load', [sensor('/nvme/0/load/30', 'Load', 'Used Space', '32.4 %')])]),
    hardware('Bluetooth Network Connection', 'nic', [group('Throughput', [sensor('/nic/%7BAA%7D/throughput/7', 'Throughput', 'Upload Speed', '0.0 B/s'), sensor('/nic/%7BAA%7D/throughput/8', 'Throughput', 'Download Speed', '0.0 B/s')])]),
    hardware('Ethernet', 'nic', [group('Throughput', [sensor('/nic/%7BBB%7D/throughput/7', 'Throughput', 'Upload Speed', '75.0 KB/s'), sensor('/nic/%7BBB%7D/throughput/8', 'Throughput', 'Download Speed', '1.5 MB/s')])]),
  ])]);
}

async function fakeLhm(getTree, { status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (status !== 200) return res.writeHead(status).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(getTree()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

function makeRuntime(plugin, fetchOrSettings, settings = {}) {
  const hub = new Map();
  const emitted = [];
  const ctx = {
    settings: () => ({ interval: 0.5, ...settings }),
    emitStatus: () => emitted.push(1),
    now: Date.now,
    hub: { set: (k, v) => hub.set(k, v), remove: (k) => hub.delete(k) },
    winHelper: () => ({ call: async () => fetchOrSettings }),
  };
  const rt = plugin.createRuntime(ctx);
  ctx.plugin = () => rt;
  return { rt, ctx, hub, emitted };
}

// ---- reading numbers ----
test('hardware: numbers with units, decimal commas and empty values are understood', () => {
  assert.deepEqual(parseValue('71.8 °C'), { n: 71.8, unit: '°C' });
  assert.deepEqual(parseValue('12,6 %'), { n: 12.6, unit: '%' });
  assert.deepEqual(parseValue('1,256 V'), { n: 1.256, unit: 'V' });
  assert.deepEqual(parseValue('1,234.5 MB'), { n: 1234.5, unit: 'MB' });
  assert.deepEqual(parseValue('1.234,5 MB'), { n: 1234.5, unit: 'MB' });
  assert.ok(Number.isNaN(parseValue('-').n));
  assert.ok(Number.isNaN(parseValue('').n));
  assert.equal(parseValue('1117 RPM').unit, 'RPM');
});

test('hardware: the Libre Hardware Monitor tree becomes a flat list with kinds, types and speeds in bytes per second', () => {
  const list = parseTree(tree());
  const cpu = list.find((s) => s.name === 'CPU Total');
  assert.equal(cpu.hwKind, 'cpu');
  assert.equal(cpu.type, 'load');
  assert.equal(cpu.value, 12.6);
  assert.equal(cpu.hw, 'AMD Ryzen 7');
  const eth = list.filter((s) => s.hw === 'Ethernet');
  assert.equal(eth.find((s) => s.name === 'Download Speed').value, 1.5e6);
  assert.equal(eth[0].unit, 'B/s');
  assert.equal(list.find((s) => s.name === 'Memory Used').hwKind, 'ram');
  assert.equal(list.find((s) => s.hw === 'Virtual Memory').hwKind, 'vram');
  assert.equal(list.find((s) => s.name === 'Composite Temperature').hwKind, 'storage');
});

test('hardware: a temperature that Libre Hardware Monitor reports in °F is kept in °C inside', () => {
  const list = parseTree(tree({ temp: '158.0 °F' }));
  assert.equal(list.find((s) => s.name === 'Core (Tctl/Tdie)').value, 70);
});

test('hardware: the picked readings are the right ones (CPU package temperature, the busiest network card, GPU memory)', () => {
  const list = parseTree(tree());
  assert.equal(presetSensor(list, 'cpuTemp').name, 'Core (Tctl/Tdie)');
  assert.equal(presetSensor(list, 'cpuLoad').value, 12.6);
  assert.equal(presetSensor(list, 'cpuClock').name, 'Cores (Average)');
  assert.equal(presetSensor(list, 'cpuPower').value, 35.1);
  assert.equal(presetSensor(list, 'gpuTemp').value, 48);
  assert.equal(presetSensor(list, 'gpuHotSpot').value, 57.3);
  assert.equal(presetSensor(list, 'gpuMemory').value, 25.7);
  assert.equal(presetSensor(list, 'gpuFan').value, 1117);
  assert.equal(presetSensor(list, 'ramLoad').value, 52.2);
  assert.equal(presetSensor(list, 'ramUsed').unit, 'GB');
  assert.equal(presetSensor(list, 'driveTemp').value, 54); // not the "Warning Temperature" limit
  assert.equal(presetSensor(list, 'download').hw, 'Ethernet'); // not the Bluetooth adapter that is idle
  assert.equal(presetSensor(list, 'upload').value, 75000);
});

test('hardware: text for a reading (°C or °F, GHz, watts, network speed)', () => {
  const list = parseTree(tree());
  assert.equal(display(presetSensor(list, 'cpuTemp'), false).text, '70°C');
  assert.equal(display(presetSensor(list, 'cpuTemp'), true).text, '159°F');
  assert.equal(display(presetSensor(list, 'cpuClock'), false).text, '3.71 GHz');
  assert.equal(display(presetSensor(list, 'cpuPower'), false).text, '35.1 W');
  assert.equal(display(presetSensor(list, 'cpuLoad'), false).text, '13%');
  assert.equal(display(presetSensor(list, 'ramUsed'), false).text, '16.7 GB');
  assert.equal(speedText(1500000).text, '1.5 MB/s');
  assert.equal(speedText(12).text, '12 B/s');
  assert.equal(display(null, false).text, '—');
});

test('hardware: the sensor list uses names, never ids, and tells apart two that share a name', () => {
  const names = pickerNames(parseTree(tree()));
  assert.ok(names.includes('AMD Ryzen 7: Core (Tctl/Tdie)'));
  assert.ok(names.every((n) => !/\/(amdcpu|gpu|nic)/.test(n)));
  assert.equal(new Set(names).size, names.length);
  const dupes = pickerNames([{ hw: 'X', name: 'Fan', type: 'fan' }, { hw: 'X', name: 'Fan', type: 'fan' }, { hw: 'X', name: 'Fan', type: 'temperature' }]);
  assert.deepEqual(dupes, ['X: Fan (fan)', 'X: Fan (fan) #2', 'X: Fan (temperature)']);
});

// ---- the plugin against a pretend Libre Hardware Monitor ----
test('librehardware: polls, publishes what buttons can follow, fills widgets, and stops cleanly', async () => {
  let current = tree();
  const srv = await fakeLhm(() => current);
  const { rt, hub, emitted } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port });
  rt.sync({ lhm: true });
  await waitFor(() => rt.status().state === 'connected');
  assert.equal(hub.get('lhm.connected'), true);
  assert.equal(hub.get('lhm.cpuHot'), false);
  assert.equal(hub.get('lhm.anyHot'), false);
  assert.ok(emitted.length >= 1);

  current = tree({ temp: '91.0 °C', ram: '97.0 %', cpu: '99 %' });
  await waitFor(() => hub.get('lhm.cpuHot') === true);
  assert.equal(hub.get('lhm.anyHot'), true);
  assert.equal(hub.get('lhm.ramHigh'), true);
  assert.equal(hub.get('lhm.cpuBusy'), true);
  assert.equal(hub.get('lhm.gpuHot'), false);

  const stat = lhm.widgets.find((w) => w.id === 'lhm.stat');
  const d = stat.data({ plugin: () => rt }, { widget: { params: { stat: 'cpuTemp', range: true } } });
  assert.equal(d.value, '91°C');
  assert.equal(d.status, 'error');
  assert.match(d.subtitle, /^CPU temperature · /);
  assert.ok(d.spark.length >= 2);
  assert.ok(d.progress > 0.9);
  const cool = stat.data({ plugin: () => rt }, { widget: { params: { stat: 'gpuTemp', warnAt: 40 } } });
  assert.equal(cool.status, 'warn'); // typed level beats the default
  assert.equal(stat.data({ plugin: () => rt }, { widget: { params: { stat: 'custom', sensor: '' } } }).subtitle, 'Pick a sensor');
  const custom = stat.data({ plugin: () => rt }, { widget: { params: { stat: 'custom', sensor: 'NVIDIA GeForce RTX 3080: GPU Fan 1' } } });
  assert.equal(custom.value, '1117 RPM');

  const over = lhm.widgets.find((w) => w.id === 'lhm.overview').data({ plugin: () => rt }, { widget: { params: { rows: ['cpuLoad', 'gpuTemp'] } } });
  assert.deepEqual(over.items, [{ label: 'CPU usage', value: '99%' }, { label: 'GPU temperature', value: '48°C' }]);
  assert.equal(over.status, 'warn');
  const temps = lhm.widgets.find((w) => w.id === 'lhm.temps').data({ plugin: () => rt }, { widget: { params: { count: 3 } } });
  assert.equal(temps.value, '91°C');
  assert.equal(temps.items.length, 2);
  assert.ok(!temps.items.some((i) => /Warning/.test(i.label)));
  const net = lhm.widgets.find((w) => w.id === 'lhm.network').data({ plugin: () => rt }, { widget: { params: {} } });
  assert.deepEqual([net.value, net.subtitle], ['↓ 1.5 MB/s', '↑ 75.0 KB/s']);
  const drives = lhm.widgets.find((w) => w.id === 'lhm.drives').data({ plugin: () => rt }, { widget: { params: {} } });
  assert.deepEqual(drives.items, [{ label: 'Force MP510', value: '54°C · 32% full' }]);

  rt.sync({});
  assert.equal(hub.has('lhm.cpuHot'), false);
  assert.equal(rt.status().state, 'off');
  srv.close();
});

test('librehardware: temperatures follow the °F choice, and hot levels stay in °C', async () => {
  const srv = await fakeLhm(() => tree({ temp: '91.0 °C' }));
  const { rt, hub } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port, fahrenheit: true });
  rt.sync({ lhm: true });
  await waitFor(() => rt.status().state === 'connected');
  assert.equal(hub.get('lhm.cpuHot'), true);
  const d = lhm.widgets.find((w) => w.id === 'lhm.stat').data({ plugin: () => rt }, { widget: { params: { stat: 'cpuTemp' } } });
  assert.equal(d.value, '196°F');
  assert.ok(d.spark.every((v) => v > 150)); // the graph is in °F too
  rt.stop();
  srv.close();
});

test('librehardware: says what is wrong in plain words and recovers when Libre Hardware Monitor comes back', async () => {
  const srv = await fakeLhm(() => tree());
  const { rt } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port });
  const port = srv.port;
  srv.close();
  rt.sync({ lhm: true });
  await waitFor(() => rt.status().state === 'error');
  assert.match(rt.status().error, /Can't reach Libre Hardware Monitor.*Remote Web Server/);
  const wait = lhm.widgets[0].data({ plugin: () => rt }, { widget: { params: { stat: 'cpuTemp' } } });
  assert.equal(wait.status, 'error');
  assert.match(wait.subtitle, /Can't reach/);
  rt.stop();
  const auth = await fakeLhm(() => tree(), { status: 401 });
  const b = makeRuntime(lhm, null, { host: '127.0.0.1', port: auth.port });
  await assert.rejects(b.rt.options(), /user name and password/);
  auth.close();
  void port;
});

test('librehardware: sends the user name and password when set, and lists sensors for the picker', async () => {
  const srv = await fakeLhm(() => tree());
  const { rt } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port, username: 'me', password: 'pw' });
  const list = await rt.options();
  assert.equal(srv.seen[0].auth, `Basic ${Buffer.from('me:pw').toString('base64')}`);
  assert.equal(srv.seen[0].url, '/data.json');
  const gpu = list.find((o) => o.value === 'NVIDIA GeForce RTX 3080: GPU Core (temperature)');
  assert.ok(gpu, 'a name shared by a temperature and a load gets the type in brackets');
  assert.match(gpu.hint, /^temperature · 48°C$/);
  assert.deepEqual(await lhm.optionLists['lhm.test']({ plugins: { get: () => rt } }), list);
  srv.close();
});

test('librehardware: refuses an address that is not a host name, and a page that is not Libre Hardware Monitor', async () => {
  const { rt } = makeRuntime(lhm, null, { host: 'evil.com/x?y', port: 8085 });
  await assert.rejects(rt.options(), /not a valid host name/);
  const srv = await fakeLhm(() => 'hello');
  const b = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port });
  await assert.rejects(b.rt.options(), /does not look like Libre Hardware Monitor/);
  srv.close();
});

test('librehardware: the show-a-stat action pops the value up, and clear graphs empties them', async () => {
  const srv = await fakeLhm(() => tree());
  const { rt } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port });
  const toasts = [];
  const ctx = { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) };
  await lhm.actions.find((a) => a.id === 'lhm.show').run({ stat: 'gpuTemp' }, ctx);
  assert.deepEqual(toasts, [['GPU temperature: 48°C', 'info']]);
  await assert.rejects(lhm.actions.find((a) => a.id === 'lhm.show').run({ stat: 'custom', sensor: 'nope' }, ctx), /Pick a sensor/);
  rt.history.push([{ key: 'k', value: 1 }]);
  await lhm.actions.find((a) => a.id === 'lhm.resetGraphs').run({}, ctx);
  assert.equal(rt.history.get('k').length, 0);
  srv.close();
});

test('librehardware: every state key it lists is one matchState picks up, and every one is published', async () => {
  const srv = await fakeLhm(() => tree());
  const { rt, hub } = makeRuntime(lhm, null, { host: '127.0.0.1', port: srv.port });
  rt.sync({ lhm: true });
  await waitFor(() => rt.status().state === 'connected');
  for (const k of lhm.stateKeys) {
    assert.deepEqual(lhm.matchState(k.key), { lhm: true });
    assert.equal(typeof hub.get(k.key), 'boolean', k.key);
  }
  assert.equal(lhm.matchState('hwinfo.cpuHot'), null);
  rt.stop();
  srv.close();
});

// ---- HWiNFO ----
const HW_SENSORS = [{ name: 'CPU [#0]: AMD Ryzen 7 5800X3D' }, { name: 'CPU [#0]: AMD Ryzen 7 5800X3D: Enhanced' }, { name: 'dGPU [#0]: NVIDIA GeForce RTX 3080' }, { name: 'System: ASRock B550' }, { name: 'Drive: Force MP510 (1234)' }, { name: 'Network: Intel Ethernet' }];
const HW_READINGS = [
  { type: 7, sensor: 0, label: 'Total CPU Usage', unit: '%', value: 12.5, min: 1, max: 40, avg: 10 },
  { type: 6, sensor: 0, label: 'Core Clocks (avg)', unit: 'MHz', value: 4100, min: 3000, max: 4500, avg: 3900 },
  { type: 1, sensor: 1, label: 'CPU Package', unit: '°C', value: 71, min: 40, max: 80, avg: 60 },
  { type: 5, sensor: 1, label: 'CPU Package Power', unit: 'W', value: 45.25, min: 10, max: 90, avg: 40 },
  { type: 1, sensor: 2, label: 'GPU Temperature', unit: '°C', value: 49, min: 30, max: 60, avg: 45 },
  { type: 7, sensor: 2, label: 'GPU Core Load', unit: '%', value: 30, min: 0, max: 99, avg: 20 },
  { type: 7, sensor: 2, label: 'GPU Memory Usage', unit: '%', value: 25.5, min: 0, max: 80, avg: 20 },
  { type: 8, sensor: 3, label: 'Physical Memory Used', unit: 'MB', value: 16384, min: 8000, max: 20000, avg: 15000 },
  { type: 8, sensor: 3, label: 'Physical Memory Load', unit: '%', value: 51, min: 20, max: 80, avg: 50 },
  { type: 1, sensor: 4, label: 'Drive Temperature', unit: '°C', value: 54, min: 30, max: 60, avg: 40 },
  { type: 8, sensor: 5, label: 'Current DL rate', unit: 'KB/s', value: 1500, min: 0, max: 9000, avg: 100 },
  { type: 8, sensor: 5, label: 'Current UP rate', unit: 'KB/s', value: 75, min: 0, max: 900, avg: 10 },
  { type: 8, sensor: 3, label: 'Some flag', unit: 'Yes/No', value: 1, min: 0, max: 1, avg: 0 },
];

test('hwinfo: readings become the same kind of list, with the CPU sensor groups joined and units understood', () => {
  const list = hwClient.parseReading({ sensors: HW_SENSORS, readings: HW_READINGS });
  assert.equal(list.length, HW_READINGS.length - 1); // the Yes/No flag is left out
  assert.equal(presetSensor(list, 'cpuTemp').value, 71);
  assert.equal(presetSensor(list, 'cpuTemp').hw, 'CPU [#0]: AMD Ryzen 7 5800X3D');
  assert.equal(presetSensor(list, 'cpuLoad').value, 12.5);
  assert.equal(presetSensor(list, 'cpuClock').value, 4100);
  assert.equal(presetSensor(list, 'cpuPower').value, 45.25);
  assert.equal(presetSensor(list, 'gpuTemp').value, 49);
  assert.equal(presetSensor(list, 'gpuLoad').value, 30);
  assert.equal(presetSensor(list, 'gpuMemory').value, 25.5);
  assert.equal(presetSensor(list, 'ramLoad').value, 51);
  assert.equal(presetSensor(list, 'ramUsed').value, 16);
  assert.equal(presetSensor(list, 'ramUsed').unit, 'GB');
  assert.equal(presetSensor(list, 'driveTemp').value, 54);
  assert.equal(presetSensor(list, 'download').value, 1.5e6);
  assert.equal(presetSensor(list, 'upload').value, 75000);
});

test('hwinfo: the plugin fills the same widgets and states from a helper answer', async () => {
  const { rt, hub } = makeRuntime(hwi, { sensors: HW_SENSORS, readings: HW_READINGS });
  rt.sync({ hwinfo: true });
  await waitFor(() => rt.status().state === 'connected');
  assert.equal(hub.get('hwinfo.connected'), true);
  assert.equal(hub.get('hwinfo.cpuHot'), false);
  const d = hwi.widgets.find((w) => w.id === 'hwinfo.stat').data({ plugin: () => rt }, { widget: { params: { stat: 'gpuTemp' } } });
  assert.equal(d.value, '49°C');
  const over = hwi.widgets.find((w) => w.id === 'hwinfo.overview').data({ plugin: () => rt }, { widget: { params: {} } });
  assert.equal(over.items.length, 5);
  for (const k of hwi.stateKeys) assert.equal(typeof hub.get(k.key), 'boolean', k.key);
  assert.equal(hwi.matchState('hwinfo.gpuHot').hwinfo, true);
  assert.equal((await rt.options()).length, HW_READINGS.length - 1);
  rt.stop();
});

test('hwinfo: a helper error (HWiNFO not sharing) is shown as it is', async () => {
  const hub = new Map();
  const ctx = { settings: () => ({ interval: 0.5 }), emitStatus() {}, now: Date.now, hub: { set: (k, v) => hub.set(k, v), remove: (k) => hub.delete(k) }, winHelper: () => ({ call: async () => { throw new Error('HWiNFO is not sharing its sensors.'); } }) };
  const rt = hwi.createRuntime(ctx);
  rt.sync({ hwinfo: true });
  await waitFor(() => rt.status().state === 'error');
  assert.equal(rt.status().error, 'HWiNFO is not sharing its sensors.');
  assert.equal(hub.get('hwinfo.connected'), false);
  rt.stop();
});

test('hwinfo helper: reads a block laid out the way HWiNFO lays it out (text, numbers, UTF-8 units), and says what is wrong when it is missing or switched off', { skip: !onWindows }, async () => {
  process.env.VRMD_HWINFO_TEST = '1';
  const h = new Helper(path.join(tempDir('vrmd-hw-'), 'build'), 'hwinfo');
  try {
    assert.equal(await h.call('ping'), 'pong');
    const map = `Local\\VRMD_HWINFO_TEST_${process.pid}`;
    await assert.rejects(h.call('read', { map }), /not sharing its sensors/);
    await h.call('publish', { map, sensors: HW_SENSORS, readings: HW_READINGS });
    const got = await h.call('read', { map });
    assert.equal(got.sensors.length, HW_SENSORS.length);
    assert.equal(got.sensors[2].name, 'dGPU [#0]: NVIDIA GeForce RTX 3080');
    assert.equal(got.readings.length, HW_READINGS.length);
    assert.deepEqual(got.readings[2], { type: 1, sensor: 1, label: 'CPU Package', unit: '°C', value: 71, min: 40, max: 80, avg: 60 });
    assert.deepEqual(hwClient.parseReading(got).map((s) => s.name), HW_READINGS.filter((r) => r.unit !== 'Yes/No').map((r) => r.label));
    await h.call('publish', { map, sensors: HW_SENSORS, readings: HW_READINGS, dead: true });
    await assert.rejects(h.call('read', { map }), /Shared Memory Support is switched off/);
    await assert.rejects(h.call('nonsense'), /unknown op/);
  } finally {
    h.stop();
    delete process.env.VRMD_HWINFO_TEST;
  }
});

// ---- the two plugins share their code: keep the copies identical ----
test('hardware plugins: the shared files are identical copies, and each plugin loads on its own', () => {
  for (const f of ['sensors.js', 'monitor.js', 'kit.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'hwinfo', f), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'plugins', 'librehardware', f), 'utf8'), `${f} differs between the two plugins`);
  }
  for (const p of [lhm, hwi]) {
    assert.ok(p.widgets.length >= 5 && p.actions.length >= 2);
    const ids = [...p.widgets, ...p.actions].map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const w of p.widgets) assert.deepEqual(w.needs(), { [p === lhm ? 'lhm' : 'hwinfo']: true });
  }
  assert.deepEqual(lhm.widgets.map((w) => w.id.split('.')[1]), hwi.widgets.map((w) => w.id.split('.')[1]));
});
