// SteamVR: the fake-signal simulator file, remembered devices (off / dropped out), the new state keys
// for triggers, device pictures, and that every picture the widget can ask for really exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createApp } = require('../src/core');
const { pictureFor, nameDevices } = require('../plugins/steamvr/pictures');
const { tempDir, FakeHelper } = require('./helpers');

const cleanup = [];
test.after(async () => { for (const c of cleanup) { try { await c(); } catch { /* already stopped */ } } });

const ICONS = path.join(__dirname, '..', 'src', 'ui', 'assets', 'devices');
const dev = (o) => ({ index: 0, class: 'tracker', role: '', serial: 'S', model: 'M', manufacturer: '', type: '', hasBattery: true, battery: 50, charging: false, trackingOk: true, worn: null, ...o });
const widget = (params = {}) => ({ id: 'bat', label: '', widget: { type: 'battery', params }, steps: [] });

async function boot(params, { vrHelper, dir = tempDir() } = {}) {
  const app = createApp({
    dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: vrHelper || new FakeHelper(), port: 0,
    twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 },
  });
  cleanup.push(() => app.stop());
  const { port } = await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 4, buttons: [{ x: 0, y: 0, w: 3, h: 2, ...widget(params) }] }];
  app.engine.updateConfig(cfg);
  return { app, dir, port, data: () => app.engine.computeWidgetData().bat };
}

// The JSON format of the fake-signal test file.
function writeFake(dir, devices, { age = 0 } = {}) {
  const file = path.join(dir, 'fake_vr_signal.json');
  const full = { __steamvr_service__: { device_class: 'Service', model: 'SteamVR Service', battery_pct: null, charging: false, tracking_ok: null, hmd_active: null, role: '', manufacturer: 'Simulated' }, ...devices };
  fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now() / 1000, devices: full, audio: {} }));
  if (age) { const t = new Date(Date.now() - age); fs.utimesSync(file, t, t); }
  return file;
}
const sim = (o) => ({ device_class: 'GenericTracker', model: 'Demo Tracker', battery_pct: 80, charging: false, tracking_ok: true, hmd_active: null, role: '', manufacturer: 'Simulated', ...o });

// ---- pictures ----
test('pictures: every picture the widget can choose exists, including the low-battery and off versions', () => {
  const need = [];
  for (let i = 0; i < 6; i++) need.push(`HMD-${i}`, `HMD-${i}L`);
  for (let i = 0; i < 3; i++) need.push(`Tracker-${i}`, `Tracker-${i}L`);
  for (let i = 0; i < 4; i++) for (const s of ['L', 'R']) need.push(`Controller-${i}${s}`, `Controller-${i}${s}L`);
  for (const v of ['1.0', '2.0']) need.push(`Lighthouse-${v}`, `Lighthouse-${v}DC`);
  for (const n of need) assert.ok(fs.existsSync(path.join(ICONS, `${n}.png`)), `${n}.png is missing`);
  assert.equal(fs.readdirSync(ICONS).filter((n) => n.endsWith('.png')).length, need.length, 'no stray pictures in the icon folder');
});

test('pictures: chosen from the model, overridable by serial, and never turned into a path', () => {
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Vive Pro 2' }), ''), 'HMD-1', 'unknown headsets get the generic picture');
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Oculus Rift S' }), ''), 'HMD-1', 'the Rift S is not the CV1 picture');
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Oculus Rift CV1' }), ''), 'HMD-0');
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Oculus Quest2' }), ''), 'HMD-5');
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Quest 3' }), ''), 'HMD-3');
  assert.equal(pictureFor(dev({ class: 'hmd', model: 'Quest 3S' }), ''), 'HMD-4');
  assert.equal(pictureFor(dev({ class: 'controller', role: 'left', model: 'Knuckles Left' }), ''), 'Controller-1L');
  assert.equal(pictureFor(dev({ class: 'controller', role: 'right', model: 'Knuckles Right' }), ''), 'Controller-1R');
  assert.equal(pictureFor(dev({ class: 'controller', role: '', model: 'Touch' }), ''), 'Controller-0L');
  assert.equal(pictureFor(dev({ class: 'tracker', model: 'Tundra Tracker' }), ''), 'Tracker-1');
  assert.equal(pictureFor(dev({ class: 'basestation' }), ''), 'Lighthouse-2.0');
  assert.equal(pictureFor(dev({ class: 'other' }), ''), '', 'no picture for unknown things');
  assert.equal(pictureFor(dev({ class: 'tracker' }), 'Tracker-0'), 'Tracker-0');
  assert.equal(pictureFor(dev({ class: 'controller', role: 'right' }), 'controller-3'), 'Controller-3R', 'side comes from the device');
  assert.equal(pictureFor(dev({ class: 'basestation' }), 'Lighthouse-1.0'), 'Lighthouse-1.0');
  for (const bad of ['../../secret', 'Tracker-9', 'HMD-1', 'Lighthouse-3.0', 'Tracker-1.png', '']) {
    assert.equal(pictureFor(dev({ class: 'tracker' }), bad), 'Tracker-2', `"${bad}" is ignored`);
  }
});

test('names: trackers are numbered by serial, so the numbers stay put when the order changes', () => {
  const a = dev({ serial: 'B' }); const b = dev({ serial: 'A' }); const c = dev({ serial: 'C' });
  const first = nameDevices([a, b, c], { c: 'Hip' });
  assert.deepEqual([first.get(a), first.get(b), first.get(c)], ['Tracker 2', 'Tracker 1', 'Hip']);
  const again = nameDevices([c, a, b], { c: 'Hip' });
  assert.deepEqual([again.get(a), again.get(b)], ['Tracker 2', 'Tracker 1']);
});

// ---- the simulator file ----
test('simulator: a fresh file in the simulator format replaces the headset and never touches SteamVR', async () => {
  const vr = new FakeHelper({ snapshot: () => { throw new Error('real SteamVR must not be asked'); } });
  let released = 0;
  vr.release = () => { released++; };
  const { app, dir, data } = await boot({ layout: 'pictures', show: ['hmd', 'controller', 'tracker', 'basestation'] }, { vrHelper: vr });
  writeFake(dir, {
    'DEMO-HMD-01': sim({ device_class: 'HMD', model: 'Demo Headset', battery_pct: 64, tracking_ok: true, hmd_active: true }),
    'DEMO-CTRL-L': sim({ device_class: 'Controller', model: 'Demo Controller', role: 'Left', battery_pct: 12 }),
    'DEMO-CTRL-R': sim({ device_class: 'Controller', model: 'Demo Controller', role: 'Right', battery_pct: 90, charging: true }),
    'DEMO-TRACKER-01': sim({ battery_pct: 40, tracking_ok: false }),
    'DEMO-LIGHTHOUSE-01': sim({ device_class: 'TrackingReference', model: 'Demo Lighthouse 1', battery_pct: null, tracking_ok: null }),
  });
  await app.providers.get('steamvr').poll();
  const d = data();
  assert.equal(d.connected, true);
  assert.equal(d.simulated, true);
  assert.equal(d.layout, 'pictures');
  assert.deepEqual(d.devices.map((x) => [x.name, x.class, x.battery]), [
    ['Headset', 'hmd', 64], ['Left controller', 'controller', 12], ['Right controller', 'controller', 90], ['Tracker 1', 'tracker', 40], ['Base station', 'basestation', -1],
  ]);
  assert.equal(d.devices[2].charging, true);
  assert.equal(d.devices[3].trackingOk, false);
  assert.equal(d.devices[4].hasBattery, false);
  assert.ok(d.devices.every((x) => x.serial.startsWith('DEMO-') && x.picture), 'the service pseudo-device is not listed, everything else has a picture');
  assert.ok(released >= 1, 'our own SteamVR link is closed while a simulator is running');
  // the states triggers can use
  assert.equal(app.hub.eval('vr.connected'), true);
  assert.equal(app.hub.eval('vr.lowBattery'), true, 'left controller is at 12% (limit 15)');
  assert.equal(app.hub.eval('vr.charging'), true);
  assert.equal(app.hub.eval('vr.trackingLost'), true);
  assert.equal(app.hub.eval('vr.hmdWorn'), true);
  assert.equal(app.hub.eval('vr.device=DEMO-TRACKER-01'), true);
  assert.equal(app.hub.eval('vr.device=SOMETHING-ELSE'), false);
  assert.equal(app.providers.status().plugins.steamvr.simulated, true);
});

test('simulator: unticking the SteamVR Service row looks like SteamVR closing; a stale file is ignored', async () => {
  let realCalls = 0;
  const vr = new FakeHelper({ snapshot: () => { realCalls++; return { connected: true, error: '', devices: [dev({ class: 'hmd', serial: 'REAL', battery: 77 })] }; } });
  const { app, dir, data } = await boot({}, { vrHelper: vr });
  const file = writeFake(dir, { 'DEMO-TRACKER-01': sim({}) });
  const noService = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete noService.devices.__steamvr_service__;
  fs.writeFileSync(file, JSON.stringify(noService));
  realCalls = 0; // (the poll at startup ran before the file existed)
  await app.providers.get('steamvr').poll();
  assert.equal(data().connected, false);
  assert.match(data().error, /not running/i);
  assert.equal(app.hub.eval('vr.connected'), false);
  assert.equal(realCalls, 0);

  // the simulator was closed / crashed: the heartbeat stops, the file gets old, real SteamVR takes over again
  writeFake(dir, { 'DEMO-TRACKER-01': sim({}) }, { age: 10000 });
  await app.providers.get('steamvr').poll();
  assert.equal(realCalls, 1);
  assert.equal(data().simulated, false);
  assert.equal(data().devices[0].serial, 'REAL');
  assert.equal(app.providers.status().plugins.steamvr.simulated, false);
});

test('simulator: a broken or odd file is ignored or tolerated instead of breaking the widget', async () => {
  const vr = new FakeHelper({ snapshot: () => ({ connected: true, error: '', devices: [dev({ class: 'hmd', serial: 'REAL' })] }) });
  const { app, dir, data } = await boot({ show: ['hmd', 'controller'] }, { vrHelper: vr });
  const file = path.join(dir, 'fake_vr_signal.json');
  fs.writeFileSync(file, '{ not json');
  await app.providers.get('steamvr').poll();
  assert.equal(data().devices[0].serial, 'REAL');
  fs.writeFileSync(file, `﻿${JSON.stringify({ timestamp: 1, devices: { X: 5, Y: null, __steamvr_service__: {}, Z: { device_class: 'Controller', battery_pct: '55', role: 'RIGHT' } } })}`);
  await app.providers.get('steamvr').poll();
  assert.equal(data().simulated, true, 'a byte-order mark and junk entries are tolerated');
  assert.deepEqual(data().devices.map((x) => [x.serial, x.role, x.battery]), [['Z', 'right', 55]]);
});

// ---- devices that are off or dropped out ----
test('remembered devices: one that goes away is listed as off with its last level, and can be hidden', async () => {
  const left = dev({ class: 'controller', role: 'left', serial: 'CL', battery: 41 });
  let devices = [left, dev({ serial: 'T1', battery: 23 }), dev({ serial: 'T2', battery: 88 })];
  const vr = new FakeHelper({ snapshot: () => ({ connected: true, error: '', devices }) });
  const { app, data } = await boot({}, { vrHelper: vr });
  await app.providers.get('steamvr').poll();
  assert.equal(data().devices.length, 3);
  assert.equal(app.hub.eval('vr.dropped'), false);

  devices = [left, devices[2]]; // T1 dropped out
  await app.providers.get('steamvr').poll();
  const off = data().devices.find((x) => x.serial === 'T1');
  assert.equal(off.connected, false);
  assert.equal(off.battery, 23, 'keeps its last known level');
  assert.equal(off.name, 'Tracker 1', 'and its name');
  assert.equal(data().devices.find((x) => x.serial === 'T2').connected, true);
  assert.equal(app.hub.eval('vr.dropped'), true);
  assert.equal(app.hub.eval('vr.device=T1'), false);
  assert.equal(app.hub.eval('vr.lowBattery'), false, 'an off device is not a low-battery warning');

  devices = [left, dev({ serial: 'T1', battery: 22 }), dev({ serial: 'T2', battery: 88 })]; // it came back
  await app.providers.get('steamvr').poll();
  assert.equal(data().devices.find((x) => x.serial === 'T1').connected, true);
  assert.equal(app.hub.eval('vr.dropped'), false);

  devices = [left];
  await app.providers.get('steamvr').poll();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages[0].buttons[0].widget.params.showDropped = false;
  app.engine.updateConfig(cfg);
  assert.deepEqual(data().devices.map((x) => x.serial), ['CL']);
});

test('remembered devices: nothing is shown as off while SteamVR itself is not running, and they survive a restart', async () => {
  const dir = tempDir();
  let snap = { connected: true, error: '', devices: [dev({ serial: 'T1', battery: 30 })] };
  const first = await boot({}, { vrHelper: new FakeHelper({ snapshot: () => snap }), dir });
  await first.app.providers.get('steamvr').poll();
  snap = { connected: false, error: 'SteamVR is not running', devices: [] };
  await first.app.providers.get('steamvr').poll();
  assert.equal(first.data().connected, false);
  assert.deepEqual(first.data().devices, [], 'no ghost list while SteamVR is closed');
  assert.equal(first.app.hub.eval('vr.dropped'), false);
  await first.app.stop();

  // next launch: the tracker is not switched on yet
  snap = { connected: true, error: '', devices: [dev({ class: 'hmd', serial: 'H', battery: 90 })] };
  const second = await boot({}, { vrHelper: new FakeHelper({ snapshot: () => snap }), dir });
  await second.app.providers.get('steamvr').poll();
  const t1 = second.data().devices.find((x) => x.serial === 'T1');
  assert.ok(t1, 'a tracker seen last time is still listed');
  assert.equal(t1.connected, false);
  assert.equal(t1.battery, 30);
  assert.equal(second.app.hub.eval('vr.dropped'), true);
});

test('remembered devices: simulated devices are never saved as if they were the real rig', async () => {
  const { app, dir } = await boot({});
  writeFake(dir, { 'DEMO-TRACKER-01': sim({}) });
  await app.providers.get('steamvr').poll();
  const runtime = path.join(dir, 'runtime.json');
  const saved = fs.existsSync(runtime) ? fs.readFileSync(runtime, 'utf8') : '';
  assert.equal(saved.includes('DEMO-'), false);
});

// ---- the editor's list, and serving the pictures ----
test('editor list: the "device is connected" trigger offers known devices', async () => {
  const vr = new FakeHelper({ snapshot: () => ({ connected: true, error: '', devices: [dev({ class: 'hmd', serial: 'H', model: 'Quest' }), dev({ class: 'other', serial: 'O' })] }) });
  const { app } = await boot({}, { vrHelper: vr });
  await app.providers.get('steamvr').poll();
  assert.deepEqual(await app.providers.options('vr.devices'), [{ value: 'H', label: 'Quest (H)' }]);
});

test('the server hands out the device pictures (and only those)', async () => {
  const { port } = await boot({});
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], size: Buffer.concat(chunks).length }));
    }).on('error', reject);
  });
  const ok = await get('/assets/devices/HMD-3.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.size > 1000);
  assert.match(ok.cache, /max-age/);
  assert.notEqual((await get('/assets/devices/..%2f..%2f..%2fpackage.json')).status, 200);
  assert.equal((await get('/assets/devices/nothing.png')).status, 404);
});
