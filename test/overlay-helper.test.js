// The real overlay helper program, without SteamVR: its protocol, its matrix maths (checked against the JavaScript
// version), the picture conversion, and the picture pipe. Nothing here connects to SteamVR or creates an overlay.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { OverlayHelper } = require('../src/core/overlay-helper');
const L = require('../src/core/overlay-logic');
const { tempDir, waitFor } = require('./helpers');

const helpers = [];
test.after(async () => { for (const h of helpers) { try { await h.stop(); } catch { /* gone */ } } });

async function boot() {
  const h = new OverlayHelper(path.join(tempDir('vrmd-ovh-'), 'helper'));
  helpers.push(h);
  assert.equal(h.start(), true, h.error);
  return h;
}

const steamVrRunning = () => {
  try { return /vrserver\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq vrserver.exe', '/NH'], { encoding: 'utf8' })); } catch { return false; }
};

test('overlay helper: builds, answers, and rejects what it does not know', async () => {
  const h = await boot();
  assert.equal(await h.call('ping'), 'pong');
  await assert.rejects(() => h.call('nonsense'), /Unknown op/);
  await assert.rejects(() => h.call('place', { matrix: [1, 2, 3] }), /12-number matrix/);
  const st = await h.call('status');
  assert.equal(st.connected, false, 'nothing connects to SteamVR until asked to');
  assert.equal(st.overlay, false);
});

test('overlay helper: its matrix maths agrees with the JavaScript maths', async () => {
  const h = await boot();
  const rnd = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; }; };
  const r = rnd(42);
  for (let i = 0; i < 25; i++) {
    const a = L.fromOffset({ x: r() * 2, y: r() * 2, z: r() * 2, yaw: r() * 180, pitch: r() * 89, roll: r() * 180 });
    const b = L.fromOffset({ x: r() * 2, y: r() * 2, z: r() * 2, yaw: r() * 180, pitch: r() * 89, roll: r() * 180 });
    const res = await h.call('math', { a, b });
    L.multiply(a, b).forEach((v, k) => assert.ok(Math.abs(v - res.multiply[k]) < 1e-4, `multiply[${k}] ${v} vs ${res.multiply[k]}`));
    L.invert(a).forEach((v, k) => assert.ok(Math.abs(v - res.invert[k]) < 1e-4, `invert[${k}] ${v} vs ${res.invert[k]}`));
  }
});

test('overlay helper: the "only while I am looking at it" rule', async () => {
  const h = await boot();
  const head = L.fromOffset({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0, roll: 0 }); // at head height, looking down -Z
  const glance = (panel, was = false) => h.call('glance', { hmd: head, panel: L.fromOffset(panel), was });
  assert.equal(await glance({ x: 0, y: 1.4, z: -0.5, yaw: 0, pitch: -20, roll: 0 }), true, 'a panel ahead, facing me, is visible');
  assert.equal(await glance({ x: 0, y: 1.4, z: -0.5, yaw: 180, pitch: 0, roll: 0 }), false, 'facing away: hidden');
  assert.equal(await glance({ x: 0, y: 1.6, z: 0.5, yaw: 180, pitch: 0, roll: 0 }), false, 'behind me: hidden');
  assert.equal(await glance({ x: 1.2, y: 1.6, z: -0.5, yaw: 0, pitch: 0, roll: 0 }), false, 'well off to the side: hidden');
  assert.equal(await glance({ x: 0, y: 1.6, z: -2.5, yaw: 0, pitch: 0, roll: 0 }), false, 'too far away: hidden');
  // 42 degrees off the gaze: not visible yet, but stays visible if it already was (no flicker at the edge)
  const off = { x: -0.45, y: 1.6, z: -0.5, yaw: 42, pitch: 0, roll: 0 };
  assert.equal(await glance(off, false), false, 'not yet');
  assert.equal(await glance(off, true), true, 'but it does not vanish once it is there');
});

test('overlay helper: "close enough to snap onto a wrist"', async () => {
  const h = await boot();
  const wrist = L.fromOffset({ x: 0.2, y: 1.1, z: -0.3, yaw: 0, pitch: 0, roll: 0 });
  const near = (x, y, z, radius = L.SNAP_RADIUS) => h.call('snap', { panel: L.fromOffset({ x, y, z, yaw: 0, pitch: 0, roll: 0 }), controller: wrist, radius });
  assert.equal(await near(0.2, 1.1, -0.3), true, 'right on it');
  assert.equal(await near(0.2, 1.3, -0.3), true, '20 cm away');
  assert.equal(await near(0.2, 1.1, 0.2), false, '50 cm away');
  assert.equal(await near(0.2, 1.2, -0.3, 0.05), false, '10 cm away is outside a 5 cm zone');
  assert.equal(await near(0.2, 1.2, -0.3, 0.15), true, 'and inside a 15 cm one');
  assert.equal(await near(0.2 + 0.2, 1.1 + 0.2, -0.3 + 0.2), true, 'distance counts in all three directions (35 cm < 35 cm is false, 34.6 cm is true)');
});

test('overlay helper: pictures are converted from Chromium\'s BGRA to SteamVR\'s RGBA', async () => {
  const h = await boot();
  const bgra = Buffer.from([10, 20, 30, 255, 40, 50, 60, 128, 0, 0, 255, 0, 1, 2, 3, 4]); // 4 pixels
  const out = Buffer.from(await h.call('swap', { bgra: bgra.toString('base64') }), 'base64');
  assert.deepEqual([...out], [30, 20, 10, 255, 60, 50, 40, 128, 255, 0, 0, 0, 3, 2, 1, 4], 'red and blue swap, green and alpha stay');
});

test('overlay helper: pictures travel over the pipe, and a slow reader does not stall the sender', async () => {
  const h = await boot();
  await waitFor(() => h.pipeConnected, 5000, 25);
  assert.equal(h.sendFrame(8, 4, Buffer.alloc(8 * 4 * 4, 7)), true);
  await waitFor(async () => (await h.call('status')).frame === '8x4', 3000, 25);
  assert.equal(h.sendFrame(16, 10, Buffer.alloc(16 * 10 * 4, 9)), true);
  await waitFor(async () => (await h.call('status')).frame === '16x10', 3000, 25);
  // many big frames at once: none of it throws, and it keeps working afterwards
  const big = Buffer.alloc(1024 * 640 * 4, 1);
  for (let i = 0; i < 30; i++) h.sendFrame(1024, 640, big);
  await waitFor(async () => (await h.call('status')).frame === '1024x640', 8000, 50);
  assert.ok(h.framesSent >= 3);
  assert.throws(() => h.sendFrame(2, 2, Buffer.alloc(3)), /expected 16/, 'a wrong-sized picture is refused before it can corrupt the stream');
});

test('overlay helper: asking it to connect while SteamVR is not running says so, and never starts SteamVR', async (t) => {
  if (steamVrRunning()) { t.skip('SteamVR is running on this PC; this check would create a real overlay in it'); return; }
  const h = await boot();
  const st = await h.call('attach');
  assert.equal(st.connected, false);
  assert.match(st.error, /not running|not installed/);
  assert.equal(steamVrRunning(), false, 'still not running afterwards');
});

test('overlay helper: the dashboard picture is kept apart from the deck picture', async () => {
  const h = await boot();
  await waitFor(() => h.pipeConnected, 5000, 25);
  assert.equal(h.sendFrame(8, 4, Buffer.alloc(8 * 4 * 4, 7)), true);
  await waitFor(async () => (await h.call('status')).frame === '8x4', 3000, 25);
  assert.equal(h.sendFrame(12, 6, Buffer.alloc(12 * 6 * 4, 3), 1), true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await h.call('status')).frame, '8x4', 'a dashboard picture does not change the size the deck is known by');
});

test('overlay helper: when the pipe is busy the newest picture waits and is sent as soon as it is free', () => {
  const h = new OverlayHelper('');
  const written = [];
  const sock = { destroyed: false, writableNeedDrain: true, write: (b) => { written.push(b); return true; } };
  h.pipeSocket = sock;
  assert.equal(h.sendFrame(2, 2, Buffer.alloc(16, 1)), false);
  assert.equal(h.sendFrame(2, 2, Buffer.alloc(16, 2)), false, 'a second picture replaces the first one that was waiting');
  assert.equal(h.sendFrame(2, 2, Buffer.alloc(16, 5), 1), false);
  assert.equal(written.length, 0);
  sock.writableNeedDrain = false;
  h.flushLatest();
  assert.equal(written.length, 2, 'one waiting picture per page');
  const last = written.find((b) => b.readUInt32LE(12) === 0);
  assert.equal(last[16], 2, 'the deck got its newest picture, not the first');
  assert.equal(h.latest.size, 0);
});

test('overlay helper: this PC can turn pixels into a GPU texture (the smooth way to show pictures)', async (t) => {
  const h = await boot();
  let res;
  try { res = await h.call('d3d'); } catch (err) { t.skip(`no Direct3D on this machine: ${err.message}`); return; }
  assert.equal(res.ok, true);
});

// Talks to the real SteamVR when it is running: an overlay with its own key that is never given a place, so nobody sees it.
async function liveGpuCheck(env) {
  Object.assign(process.env, env);
  const h = await boot();
  const logs = [];
  let repaint = false;
  h.on('event', (ev) => { if (ev.ev === 'log') logs.push(ev.text); if (ev.ev === 'repaint') repaint = true; });
  const st = await h.call('attach');
  assert.equal(st.connected, true, st.error);
  await waitFor(() => h.pipeConnected, 5000, 25);
  const px = Buffer.alloc(1024 * 640 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 200; px[i + 1] = 80; px[i + 2] = 40; px[i + 3] = 255; }
  h.sendFrame(1024, 640, px);
  await waitFor(() => logs.some((l) => /GPU picture|empty/.test(l)), 6000, 50);
  await h.call('shutdown').catch(() => {});
  return { logs, repaint };
}

test('overlay helper (real SteamVR): a GPU picture really arrives, and the check says so', async (t) => {
  if (!steamVrRunning()) { t.skip('SteamVR is not running'); return; }
  const r = await liveGpuCheck({ VRMD_OVERLAY_KEY: 'com.jayconius.vrmacropad.test1', VRMD_DASHBOARD_KEY: 'com.jayconius.vrmacropad.testdash1' });
  delete process.env.VRMD_TEST_NOFLUSH;
  assert.ok(r.logs.some((l) => /GPU picture arrived \(checked\)/.test(l)), r.logs.join(' | '));
  assert.equal(r.repaint, false);
});

test('overlay helper (real SteamVR): if a GPU picture arrives empty it falls back to raw pixels and asks for a repaint', async (t) => {
  if (!steamVrRunning()) { t.skip('SteamVR is not running'); return; }
  const r = await liveGpuCheck({ VRMD_OVERLAY_KEY: 'com.jayconius.vrmacropad.test2', VRMD_DASHBOARD_KEY: 'com.jayconius.vrmacropad.testdash2', VRMD_TEST_NOFLUSH: '1' });
  delete process.env.VRMD_TEST_NOFLUSH;
  assert.ok(r.logs.some((l) => /arrived empty/.test(l)), r.logs.join(' | '));
  assert.equal(r.repaint, true);
});

test('overlay helper: the dim level is clamped and reported', async () => {
  const h = await boot();
  assert.equal((await h.call('dim', { level: 0.4 })).dim, 0.4);
  assert.equal((await h.call('dim', { level: 5 })).dim, 0.9);
  assert.equal((await h.call('dim', { level: -2 })).dim, 0);
});
