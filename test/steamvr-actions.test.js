// SteamVR functions (supersampling, motion smoothing, brightness, play-area bounds, performance graph, recenter):
// what each button asks the helper to do, how values are clamped, and what buttons can follow.
const test = require('node:test');
const assert = require('node:assert/strict');
const { defs, STATE_KEYS } = require('../src/core/actions');
const { createApp } = require('../src/core');
const { tempDir, FakeHelper, waitFor } = require('./helpers');

// A stand-in for SteamVR: keeps the settings in memory and records every request.
function fakeSteam(values = {}) {
  const st = {
    connected: true,
    values: { 'steamvr.supersampleScale': 1, 'steamvr.motionSmoothing': true, 'steamvr.hmdDisplayColorGainR': 1, 'steamvr.showPerfGraph': false, ...values },
    boundsForced: false,
    calls: [],
    toasts: [],
  };
  const control = async (op, args = {}) => {
    st.calls.push({ op, ...args });
    if (op === 'settings.state') return { connected: st.connected, error: st.connected ? '' : 'SteamVR is not running', values: st.values, boundsForced: st.boundsForced };
    if (!st.connected) throw new Error('SteamVR is not running');
    if (op === 'settings.set') { st.values[`${args.section}.${args.key}`] = args.value; return args.value; }
    if (op === 'bounds.force') { st.boundsForced = args.on; return args.on; }
    return true;
  };
  st.ctx = {
    toast: (text) => st.toasts.push(text),
    plugin: (id) => (id === 'steamvr' ? { control } : null),
  };
  st.sets = () => st.calls.filter((c) => c.op === 'settings.set').map((c) => [`${c.section}.${c.key}`, c.value]);
  return st;
}
const run = (id, params, st) => defs.get(id).run(params, st.ctx);

test('steamvr: every function is in the catalog with a category, and follows-state keys exist for the ones that show a state', () => {
  for (const id of ['supersample', 'motionSmoothing', 'brightness', 'bounds', 'boundsStyle', 'perfGraph', 'recenter']) {
    const d = defs.get(`steamvr.${id}`);
    assert.ok(d, id);
    assert.equal(d.category, 'SteamVR');
    assert.equal(d.needs, 'vr');
  }
  for (const key of ['vr.motionSmoothing', 'vr.perfGraph', 'vr.boundsForced']) assert.ok(STATE_KEYS.some((k) => k.key === key), key);
  assert.equal(defs.get('steamvr.motionSmoothing').state({}), 'vr.motionSmoothing');
});

test('steamvr: supersampling sets, steps up and down, resets, and never leaves a sane range', async () => {
  const st = fakeSteam();
  await run('steamvr.supersample', { mode: 'set', value: 150 }, st);
  assert.deepEqual(st.sets(), [['steamvr.supersampleManualOverride', true], ['steamvr.supersampleScale', 1.5]], 'manual override first, or SteamVR picks its own value');
  st.calls.length = 0;
  await run('steamvr.supersample', { mode: 'up', step: 25 }, st);
  assert.equal(st.values['steamvr.supersampleScale'], 1.75, 'steps from the value SteamVR has now');
  await run('steamvr.supersample', { mode: 'down', step: 100 }, st);
  assert.equal(st.values['steamvr.supersampleScale'], 0.75);
  await run('steamvr.supersample', { mode: 'set', value: 9999 }, st);
  assert.equal(st.values['steamvr.supersampleScale'], 5);
  await run('steamvr.supersample', { mode: 'set', value: 1 }, st);
  assert.equal(st.values['steamvr.supersampleScale'], 0.2);
  await run('steamvr.supersample', { mode: 'reset' }, st);
  assert.equal(st.values['steamvr.supersampleScale'], 1);
  assert.match(st.toasts.at(-1), /100 %/);
});

test('steamvr: motion smoothing and the performance graph toggle from what SteamVR has now', async () => {
  const st = fakeSteam();
  await run('steamvr.motionSmoothing', { mode: 'toggle' }, st);
  assert.equal(st.values['steamvr.motionSmoothing'], false);
  await run('steamvr.motionSmoothing', { mode: 'toggle' }, st);
  assert.equal(st.values['steamvr.motionSmoothing'], true);
  await run('steamvr.motionSmoothing', { mode: 'off' }, st);
  await run('steamvr.motionSmoothing', { mode: 'off' }, st);
  assert.equal(st.values['steamvr.motionSmoothing'], false, 'off stays off');
  await run('steamvr.perfGraph', { mode: 'on' }, st);
  assert.equal(st.values['steamvr.showPerfGraph'], true);
  await run('steamvr.perfGraph', { mode: 'toggle' }, st);
  assert.equal(st.values['steamvr.showPerfGraph'], false);
});

test('steamvr: brightness moves all three colour gains together and stays between 5 and 100 percent', async () => {
  const st = fakeSteam();
  await run('steamvr.brightness', { mode: 'set', value: 60 }, st);
  for (const c of ['R', 'G', 'B']) assert.equal(st.values[`steamvr.hmdDisplayColorGain${c}`], 0.6);
  await run('steamvr.brightness', { mode: 'down', step: 20 }, st);
  assert.equal(st.values['steamvr.hmdDisplayColorGainG'], 0.4);
  await run('steamvr.brightness', { mode: 'down', step: 50 }, st);
  assert.equal(st.values['steamvr.hmdDisplayColorGainB'], 0.05, 'never fully black');
  await run('steamvr.brightness', { mode: 'up', step: 50 }, st);
  await run('steamvr.brightness', { mode: 'up', step: 50 }, st);
  assert.equal(st.values['steamvr.hmdDisplayColorGainR'], 1, 'never above full');
  await run('steamvr.brightness', { mode: 'reset' }, st);
  assert.equal(st.values['steamvr.hmdDisplayColorGainR'], 1);
});

test('steamvr: play-area bounds are forced on and off, and their look is set in the units SteamVR wants', async () => {
  const st = fakeSteam();
  await run('steamvr.bounds', { mode: 'toggle' }, st);
  assert.equal(st.boundsForced, true);
  await run('steamvr.bounds', { mode: 'toggle' }, st);
  assert.equal(st.boundsForced, false);
  await run('steamvr.boundsStyle', { opacity: 50, fade: 1.2 }, st);
  assert.equal(st.values['collisionBounds.CollisionBoundsColorGammaA'], 128, 'percent become 0-255');
  assert.equal(st.values['collisionBounds.CollisionBoundsFadeDistance'], 1.2);
  await run('steamvr.boundsStyle', { opacity: 500, fade: '' }, st);
  assert.equal(st.values['collisionBounds.CollisionBoundsColorGammaA'], 255);
  await assert.rejects(() => run('steamvr.boundsStyle', { opacity: '', fade: '' }, st), /opacity or a distance/);
});

test('steamvr: recentering asks the helper, and everything says so plainly when SteamVR is not running', async () => {
  const st = fakeSteam();
  await run('steamvr.recenter', {}, st);
  assert.ok(st.calls.some((c) => c.op === 'recenter'));
  st.connected = false;
  for (const [id, p] of [['steamvr.supersample', { mode: 'set', value: 100 }], ['steamvr.motionSmoothing', {}], ['steamvr.brightness', { mode: 'reset' }], ['steamvr.bounds', {}], ['steamvr.perfGraph', {}], ['steamvr.recenter', {}]]) {
    await assert.rejects(() => run(id, p, st), /SteamVR is not running/, id);
  }
});

test('steamvr: buttons can follow motion smoothing, the graph and forced bounds, and only what is allowed can be written', async () => {
  const vr = new FakeHelper({
    snapshot: () => ({ connected: true, error: '', devices: [] }),
    'settings.state': () => ({ connected: true, values: { 'steamvr.motionSmoothing': true, 'steamvr.showPerfGraph': false, 'steamvr.supersampleScale': 1.3 }, boundsForced: true }),
  });
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: vr, port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    const cfg = JSON.parse(JSON.stringify(app.engine.config));
    cfg.pages = [{ id: 'p', name: 'P', cols: 4, rows: 2, buttons: [{ id: 'b', x: 0, y: 0, w: 1, h: 1, label: 'S', steps: [{ action: 'steamvr.motionSmoothing', params: { mode: 'toggle' }, delayMs: 0 }] }] }];
    app.engine.updateConfig(cfg);
    await waitFor(() => app.hub.eval('vr.motionSmoothing') === true && app.hub.eval('vr.boundsForced') === true, 3000);
    assert.equal(app.hub.eval('vr.perfGraph'), false);
    assert.equal(app.hub.get('vr.supersample'), 1.3);
    assert.equal(app.engine.computeNeeds().vr, true, 'a SteamVR function makes the SteamVR poll run');
  } finally { await app.stop(); }
});

test('steamvr: dimming the view sets, steps, toggles and turns off, in whole percents from 0 to 90', async () => {
  const st = { overlay: { dim: 0 } };
  const toasts = [];
  const ctx = { patchSettings: (fn) => fn(st), toast: (t) => toasts.push(t) };
  const dim = (p) => defs.get('steamvr.dim').run(p, ctx);
  await dim({ mode: 'set', value: 40 });
  assert.equal(st.overlay.dim, 0.4);
  await dim({ mode: 'up', step: 25 });
  assert.equal(st.overlay.dim, 0.65);
  await dim({ mode: 'up', step: 50 });
  assert.equal(st.overlay.dim, 0.9, 'never fully black');
  await dim({ mode: 'down', step: 100 });
  assert.equal(st.overlay.dim, 0);
  await dim({ mode: 'toggle', value: 55 });
  assert.equal(st.overlay.dim, 0.55);
  await dim({ mode: 'toggle', value: 55 });
  assert.equal(st.overlay.dim, 0, 'toggle turns it off again');
  await dim({ mode: 'set', value: 500 });
  assert.equal(st.overlay.dim, 0.9);
  await dim({ mode: 'off' });
  assert.equal(st.overlay.dim, 0);
  assert.match(toasts.at(-1), /Full brightness/);
  assert.equal(defs.get('steamvr.dim').state({}), 'vr.dimmed');
  assert.ok(STATE_KEYS.some((k) => k.key === 'vr.dimmed'));
});

test('steamvr: the dimmed state is published for buttons, from the settings', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    assert.equal(app.hub.eval('vr.dimmed'), false);
    app.engine.patchSettings((s) => { s.overlay.dim = 0.4; });
    assert.equal(app.hub.eval('vr.dimmed'), true);
    app.engine.patchSettings((s) => { s.overlay.dim = 0; });
    assert.equal(app.hub.eval('vr.dimmed'), false);
  } finally { await app.stop(); }
});
