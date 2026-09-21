// Voicemeeter: the helper program (against its built-in pretend Voicemeeter, since the real one may not be installed),
// what each action sends, and how buttons follow Voicemeeter's state.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Helper } = require('../src/core/helper');
const { createApp } = require('../src/core');
const { defs, STATE_KEYS } = require('../src/core/actions');
const { tempDir, FakeHelper, waitFor } = require('./helpers');

const onWindows = process.platform === 'win32';
const helpers = [];
test.after(() => { for (const h of helpers) { try { h.stop(); } catch { /* gone */ } } });

async function boot(env = { VRMD_VMR_FAKE: '1' }) {
  Object.assign(process.env, env);
  const h = new Helper(path.join(tempDir('vrmd-vm-'), 'build'), 'voicemeeter');
  helpers.push(h);
  return h;
}

// ---- the helper program ----
test('voicemeeter helper: answers, reports the edition, and refuses what it does not know', { skip: !onWindows }, async () => {
  const h = await boot();
  assert.equal(await h.call('ping'), 'pong');
  const st = await h.call('status');
  assert.equal(st.connected, true);
  assert.equal(st.typeName, 'Voicemeeter Banana');
  assert.equal(st.strips, 5);
  assert.equal(st.buses, 5);
  assert.match(st.version, /^\d+\.\d+\.\d+\.\d+$/);
  await assert.rejects(h.call('nonsense'), /Unknown op/);
  await assert.rejects(h.call('set', { value: 1 }), /No parameter name/);
  await assert.rejects(h.call('script', { text: '   ' }), /Nothing to send/);
});

test('voicemeeter helper: set, get, poll (numbers, labels, macro buttons), scripts and commands', { skip: !onWindows }, async () => {
  const h = await boot();
  await h.call('set', { name: 'Strip[0].Mute', value: 1 });
  await h.call('set', { name: 'Bus[1].Gain', value: -6.5 });
  assert.equal(await h.call('get', { name: 'Strip[0].Mute' }), 1);
  assert.equal(await h.call('get', { name: 'Strip[0].Label' }), 'Mic', 'labels come back as text');
  const poll = await h.call('poll', { names: ['Strip[0].Mute', 'Strip[2].Mute', 'Bus[1].Gain', 'Strip[3].Label'], macros: [3, 4] });
  assert.equal(poll.connected, true);
  assert.deepEqual(poll.values, { 'Strip[0].Mute': 1, 'Strip[2].Mute': 0, 'Bus[1].Gain': -6.5, 'Strip[3].Label': 'Game' });
  assert.deepEqual(poll.macros, { 3: false, 4: false });
  await h.call('script', { text: 'Command.Button[3].State=1; Strip[0].Gain=-12;\nStrip[0].Gain +=3;\nBus[0].FadeTo=(-10,500);' });
  assert.equal(await h.call('macro', { button: 3 }), true);
  const seen = await h.call('fake');
  assert.equal(seen.floats['Strip[0].Gain'], -9);
  assert.equal(seen.floats['Bus[0].Gain'], -10);
  await h.call('set', { name: 'Command.Restart', value: 1 });
  await h.call('setString', { name: 'Command.Save', value: 'C:\\x\\a.xml' });
  await h.call('setString', { name: 'Strip[0].device.wdm', value: 'Headphones (Fake Audio)' });
  const after = await h.call('fake');
  assert.ok(after.strings['Command.Save'] === 'C:\\x\\a.xml');
  assert.equal(after.strings['Strip[0].device.wdm'], 'Headphones (Fake Audio)');
  await assert.rejects(h.call('script', { text: 'this is not a command' }), /does not know/);
});

test('voicemeeter helper: devices can be listed, Voicemeeter can be started, and a closed Voicemeeter is reported plainly', { skip: !onWindows }, async () => {
  const h = await boot();
  const d = await h.call('devices');
  assert.ok(d.outputs.length && d.inputs.length);
  assert.equal(d.outputs[0].driver, 'wdm');
  assert.equal(typeof d.outputs[0].name, 'string');
  await h.call('fake', { running: false });
  const st = await h.call('poll', { names: ['Strip[0].Mute'] });
  assert.equal(st.connected, false);
  assert.match(st.error, /not running/);
  await assert.rejects(h.call('set', { name: 'Strip[0].Mute', value: 1 }), /not running/);
  await h.call('run', { type: 5 });
  assert.equal((await h.call('poll', {})).connected, true, 'starting it brings it back');
  assert.ok((await h.call('fake')).commands.includes('run 5'));
});

test('voicemeeter helper (real): without Voicemeeter installed it says so instead of failing', { skip: !onWindows }, async () => {
  delete process.env.VRMD_VMR_FAKE;
  const h = await boot({});
  const st = await h.call('status');
  assert.equal(typeof st.connected, 'boolean');
  if (!st.connected) assert.match(st.error, /Voicemeeter/);
  await assert.rejects(h.call('set', { name: 'Strip[0].Mute', value: 1 }), /Voicemeeter/);
  process.env.VRMD_VMR_FAKE = '1';
});

// ---- actions ----
function fakeVm(state = {}) {
  const vm = { calls: [], values: { ...state } };
  vm.ctx = {
    vm: async (op, args = {}) => {
      vm.calls.push({ op, ...args });
      if (op === 'get') return vm.values[args.name] ?? 0;
      if (op === 'macro') return Boolean(vm.values[`macro${args.button}`]);
      return true;
    },
  };
  return vm;
}
const run = (id, p, vm) => defs.get(id).run(p, vm.ctx);

test('voicemeeter: every action is in the catalog and the state keys exist', () => {
  for (const id of ['toggle', 'gain', 'macro', 'command', 'reset', 'start', 'device', 'appVolume', 'script']) assert.equal(defs.get(`vm.${id}`).category, 'Voicemeeter', id);
  for (const key of ['vm.connected', 'vm.param', 'vm.macro']) assert.ok(STATE_KEYS.some((k) => k.key === key), key);
  assert.equal(defs.get('vm.reset').defaults.confirm, 'hold', 'a full reset needs a held press');
});

test('voicemeeter: switches are named the way Voicemeeter names them, count from 1 in the UI, and follow the real state', async () => {
  const t = defs.get('vm.toggle');
  const strip = { target: 'strip', index: 1, stripOption: 'Mute', mode: 'toggle' };
  assert.equal(t.state(strip), 'vm.param=Strip[0].Mute');
  assert.deepEqual([...t.needs(strip).vmParams], ['Strip[0].Mute']);
  assert.equal(t.state({ target: 'bus', index: 3, busOption: 'Sel', mode: 'on' }), 'vm.param=Bus[2].Sel');
  assert.equal(t.state({ target: 'strip', index: 2, stripOption: 'B1' }), 'vm.param=Strip[1].B1');
  assert.equal(t.state({ target: 'recorder', recorderOption: 'record' }), 'vm.param=recorder.record');
  assert.equal(t.state({ target: 'strip', index: 99, stripOption: 'Mute' }), null, 'a bad number never becomes a parameter name');
  assert.equal(t.state({ target: 'strip', index: 1, stripOption: 'Evil; Command.Shutdown=1' }), null, 'nor does anything typed in');

  const vm = fakeVm({ 'Strip[0].Mute': 0 });
  await run('vm.toggle', strip, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'set', name: 'Strip[0].Mute', value: 1 }, 'toggle reads the state, then flips it');
  vm.values['Strip[0].Mute'] = 1;
  await run('vm.toggle', strip, vm);
  assert.equal(vm.calls.at(-1).value, 0);
  await run('vm.toggle', { ...strip, mode: 'on' }, vm);
  assert.equal(vm.calls.at(-1).value, 1);
  await run('vm.toggle', { ...strip, mode: 'off' }, vm);
  assert.equal(vm.calls.at(-1).value, 0);
  await run('vm.toggle', { target: 'recorder', recorderOption: 'play', mode: 'off' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'set', name: 'recorder.play', value: 1 }, 'play / stop are presses, not switches');
  await assert.rejects(() => run('vm.toggle', { target: 'strip', index: 0, stripOption: 'Mute' }, vm), /1 to 8/);
});

test('voicemeeter: gain sets, steps with relative commands, fades, resets and stays in range', async () => {
  const vm = fakeVm();
  const base = { target: 'strip', index: 4 };
  await run('vm.gain', { ...base, mode: 'set', db: -12 }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'set', name: 'Strip[3].Gain', value: -12 });
  await run('vm.gain', { ...base, mode: 'set', db: 40 }, vm);
  assert.equal(vm.calls.at(-1).value, 12);
  await run('vm.gain', { ...base, mode: 'set', db: -200 }, vm);
  assert.equal(vm.calls.at(-1).value, -60);
  await run('vm.gain', { target: 'bus', index: 1, mode: 'up', db: 3 }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'script', text: 'Bus[0].Gain +=3;' });
  await run('vm.gain', { target: 'bus', index: 1, mode: 'down', db: 2.5 }, vm);
  assert.equal(vm.calls.at(-1).text, 'Bus[0].Gain -=2.5;');
  await run('vm.gain', { ...base, mode: 'fade', db: -20, ms: 1500 }, vm);
  assert.equal(vm.calls.at(-1).text, 'Strip[3].FadeTo=(-20,1500);');
  await run('vm.gain', { ...base, mode: 'reset' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'set', name: 'Strip[3].Gain', value: 0 });
});

test('voicemeeter: macro buttons, engine commands, presets, device choice, per-app volume and custom scripts', async () => {
  const vm = fakeVm({ macro5: true });
  await run('vm.macro', { button: 5, mode: 'toggle' }, vm);
  assert.equal(vm.calls.at(-1).text, 'Command.Button[5].State=0;', 'it was on, so toggling turns it off');
  await run('vm.macro', { button: 6, mode: 'toggle' }, vm);
  assert.equal(vm.calls.at(-1).text, 'Command.Button[6].State=1;');
  await run('vm.macro', { button: 6, mode: 'off' }, vm);
  assert.equal(vm.calls.at(-1).text, 'Command.Button[6].State=0;');
  await assert.rejects(() => run('vm.macro', { button: 80, mode: 'on' }, vm), /0 to 79/);
  assert.equal(defs.get('vm.macro').state({ button: 12 }), 'vm.macro=12');
  assert.deepEqual([...defs.get('vm.macro').needs({ button: 12 }).vmMacros], [12]);

  await run('vm.command', { command: 'Restart' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'set', name: 'Command.Restart', value: 1 });
  await run('vm.command', { command: 'Preset', preset: 3 }, vm);
  assert.equal(vm.calls.at(-1).name, 'Command.Preset[2].Recall');
  await run('vm.command', { command: 'Save', file: 'C:\\a\\b.xml' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'setString', name: 'Command.Save', value: 'C:\\a\\b.xml' });
  await assert.rejects(() => run('vm.command', { command: 'Load', file: 'C:\\a\\b.exe' }, vm), /\.xml/);
  await run('vm.reset', {}, vm);
  assert.equal(vm.calls.at(-1).name, 'Command.Reset');

  await run('vm.device', { target: 'bus', index: 1, driver: 'wdm', device: 'Headphones (Realtek)' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'setString', name: 'Bus[0].device.wdm', value: 'Headphones (Realtek)' });
  await run('vm.device', { target: 'bus', index: 2, driver: 'mme', device: '' }, vm);
  assert.equal(vm.calls.at(-1).value, '', 'empty unselects the device');
  await assert.rejects(() => run('vm.device', { target: 'bus', index: 1, driver: 'dos', device: 'x' }, vm), /driver/);

  await run('vm.appVolume', { index: 6, app: 'Spotify', what: 'gain', volume: 35 }, vm);
  assert.equal(vm.calls.at(-1).text, 'Strip[5].AppGain=("Spotify",0.35);');
  await run('vm.appVolume', { index: 6, app: 'Spotify', what: 'mute' }, vm);
  assert.equal(vm.calls.at(-1).text, 'Strip[5].AppMute=("Spotify",1);');
  await assert.rejects(() => run('vm.appVolume', { index: 6, app: 'a"); Command.Shutdown=1;("', what: 'mute' }, vm), /without quotes/, 'an app name cannot smuggle in another command');

  await run('vm.script', { text: 'Strip[0].Mute=1;' }, vm);
  assert.equal(vm.calls.at(-1).text, 'Strip[0].Mute=1;');
  await assert.rejects(() => run('vm.script', { text: '  ' }, vm), /Type the commands/);
  await run('vm.start', { edition: '2' }, vm);
  assert.deepEqual(vm.calls.at(-1), { op: 'run', type: 5 }, 'Banana 64-bit');
});

// ---- following state ----
test('voicemeeter: buttons follow Voicemeeter, only the parameters buttons use are polled, and it lets go when nothing needs it', async () => {
  const vmHelper = new FakeHelper({
    poll: (args) => ({ installed: true, connected: true, typeName: 'Voicemeeter Banana', version: '2.1.1.8', strips: 5, buses: 5, values: Object.fromEntries((args.names || []).map((n) => [n, n === 'Strip[0].Mute' ? 1 : 0])), macros: Object.fromEntries((args.macros || []).map((b) => [b, b === 7])) }),
    devices: { outputs: [{ driver: 'wdm', name: 'Headphones (Fake)', id: 'a' }], inputs: [{ driver: 'wdm', name: 'Mic (Fake)', id: 'b' }, { driver: 'mme', name: 'Headphones (Fake)', id: 'c' }] },
  });
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), vmHelper, port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    const btn = (id, action, params, x) => ({ id, x, y: 0, w: 1, h: 1, label: id, steps: [{ action, params, delayMs: 0 }] });
    const cfg = JSON.parse(JSON.stringify(app.engine.config));
    cfg.pages = [{ id: 'p', name: 'P', cols: 6, rows: 2, buttons: [
      btn('mic', 'vm.toggle', { target: 'strip', index: 1, stripOption: 'Mute', mode: 'toggle' }, 0),
      btn('game', 'vm.toggle', { target: 'strip', index: 4, stripOption: 'Solo', mode: 'toggle' }, 1),
      btn('mac', 'vm.macro', { button: 7, mode: 'toggle' }, 2),
    ] }];
    app.engine.updateConfig(cfg);
    await waitFor(() => app.hub.eval('vm.param=Strip[0].Mute') === true, 3000);
    assert.equal(app.hub.eval('vm.param=Strip[3].Solo'), false);
    assert.equal(app.hub.eval('vm.macro=7'), true);
    assert.equal(app.hub.eval('vm.connected'), true);
    const polls = vmHelper.calls.filter((c) => c.op === 'poll');
    assert.deepEqual(polls.at(-1).names.sort(), ['Strip[0].Mute', 'Strip[3].Solo']);
    assert.deepEqual(polls.at(-1).macros, [7]);
    assert.equal(app.providers.status().voicemeeter, 'connected');
    assert.match(app.providers.status().voicemeeterInfo, /Banana/);

    const list = await app.providers.options('vm.devices');
    assert.deepEqual(list.map((o) => o.value), ['Headphones (Fake)', 'Mic (Fake)'], 'one entry per device name');
    assert.match(list[0].label, /WDM/);

    // remove the buttons: Voicemeeter is no longer needed
    cfg.pages[0].buttons = [];
    app.engine.updateConfig(cfg);
    await waitFor(() => app.hub.get('vm.connected') === undefined, 3000);
    assert.equal(app.providers.status().voicemeeter, 'off');
  } finally { await app.stop(); }
});

test('voicemeeter: when Voicemeeter is not running buttons show neutral and the status says why', async () => {
  const vmHelper = new FakeHelper({ poll: () => ({ installed: true, connected: false, error: 'Voicemeeter is not running' }) });
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), vmHelper, port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    const cfg = JSON.parse(JSON.stringify(app.engine.config));
    cfg.pages = [{ id: 'p', name: 'P', cols: 4, rows: 2, buttons: [{ id: 'm', x: 0, y: 0, w: 1, h: 1, label: 'M', steps: [{ action: 'vm.toggle', params: { target: 'strip', index: 1, stripOption: 'Mute', mode: 'toggle' }, delayMs: 0 }] }] }];
    app.engine.updateConfig(cfg);
    await waitFor(() => app.hub.get('vm.connected') === false, 3000);
    assert.equal(app.hub.eval('vm.param=Strip[0].Mute'), undefined);
    assert.equal(app.providers.status().voicemeeter, 'connecting');
    assert.match(app.providers.status().voicemeeterError, /not running/);
  } finally { await app.stop(); }
});
