// Buttons that follow the REAL state of the thing they control, instead of remembering their last press:
// per-app mute, media keys, "launch a program", VRChat avatar. (Microphone buttons are tested in engine.test.js,
// Twitch ad buttons in twitch.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir, waitFor } = require('./helpers');

const apps = [];
test.after(async () => { for (const a of apps) { try { await a.stop(); } catch { /* already stopped */ } } });

const btn = (id, action, params) => ({ id, x: 0, y: 0, w: 1, h: 1, label: id, steps: [{ action, params, delayMs: 0 }], state: { source: 'auto', key: '' }, triggers: [] });

async function boot(buttons, helperAnswers) {
  const helper = new FakeHelper(helperAnswers);
  const app = createApp({ dataDir: tempDir(), helper, port: 0 });
  apps.push(app);
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 2, buttons: buttons.map((b, i) => ({ ...b, x: i % 8, y: Math.floor(i / 8) })) }];
  app.engine.updateConfig(cfg);
  return { app, helper, engine: app.engine, hub: app.hub, states: () => app.engine.computeButtonStates() };
}
const action = (id) => require('../src/core/actions').defs.get(id);

test('follow: per-app mute shows whether that app is really muted, and catches up when Windows changes it', async () => {
  const sessions = [{ name: 'Discord', volume: 80, muted: false }, { name: 'chrome', volume: 100, muted: true }];
  const { app, engine, states, helper } = await boot([
    btn('discord', 'audio.appVolume', { process: 'Discord.exe', mode: 'toggleMute' }),
    btn('chrome', 'audio.appVolume', { process: 'chrome', mode: 'mute' }),
    btn('louder', 'audio.appVolume', { process: 'Discord', mode: 'up', amount: 5 }),
  ], { 'audio.snapshot': () => ({ capture: null, render: null }), 'audio.devices': () => [], 'audio.sessions': () => sessions });
  await waitFor(() => states().discord && !states().discord.unknown);
  assert.deepEqual([states().discord.active, states().chrome.active], [false, true], 'each app shows its own real mute state (".exe" and case do not matter)');
  assert.equal(states().louder, undefined, 'a volume-change button has no on/off state');
  sessions[0].muted = true; // muted from somewhere else, e.g. the Windows volume mixer
  await app.providers.get('starter').pollAudio();
  assert.equal(states().discord.active, true);
  sessions[1].muted = false;
  await app.providers.get('starter').pollAudio();
  assert.equal(states().chrome.active, false);
  assert.ok(helper.calls.some((c) => c.op === 'audio.sessions'));
});

test('follow: the per-app mute check only runs while a button actually follows it', async () => {
  const { app, helper, engine } = await boot([btn('louder', 'audio.appVolume', { process: 'Discord', mode: 'up', amount: 5 }), btn('mic', 'audio.micMute', { mode: 'toggle' })],
    { 'audio.snapshot': () => ({ capture: { id: 'm', muted: false }, render: null }), 'audio.devices': () => [], 'audio.sessions': () => [] });
  await waitFor(() => helper.calls.some((c) => c.op === 'audio.snapshot'));
  await app.providers.get('starter').pollAudio();
  assert.ok(!helper.calls.some((c) => c.op === 'audio.sessions'), 'no per-app polling for a volume button or a mic button');
  assert.equal(app.hub.get('audio.app.muted'), undefined);
});

test('follow: the Mute media key follows the real output mute, Play / Pause follows what is playing', async () => {
  const snap = { capture: null, render: { id: 'spk', muted: false, volume: 40 } };
  const { app, states } = await boot([btn('mute', 'media.key', { key: 'volumemute' }), btn('next', 'media.key', { key: 'next' })],
    { 'audio.snapshot': () => snap, 'audio.devices': () => [] });
  await waitFor(() => states().mute && !states().mute.unknown);
  assert.equal(states().mute.active, false);
  assert.equal(states().next, undefined, 'one-shot keys (next, previous, volume up) have no state');
  snap.render.muted = true;
  await app.providers.get('starter').pollAudio();
  assert.equal(states().mute.active, true);
  const key = action('media.key').state;
  assert.equal(key({ key: 'playpause' }), 'media.playing');
  assert.equal(key({ key: 'stop' }), null);
});

test('follow: a Launch button lights up while that program is running', async () => {
  const running = ['obs64.exe', 'explorer.exe'];
  const { app, states } = await boot([
    btn('obs', 'system.launch', { path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\OBS64.exe' }),
    btn('quoted', 'system.launch', { path: '"C:\\Games\\Not Running\\game.exe"', args: '--fast' }),
    btn('doc', 'system.launch', { path: 'C:\\Notes\\readme.txt' }),
  ], { 'proc.list': () => running });
  await waitFor(() => states().obs && !states().obs.unknown);
  assert.deepEqual([states().obs.active, states().quoted.active], [true, false]);
  assert.equal(states().doc, undefined, 'a document has no process to watch');
  running.push('game.exe');
  await app.providers.get('starter').pollProc();
  assert.equal(states().quoted.active, true, 'quotes around the path and program arguments are handled');
  running.length = 0;
  await app.providers.get('starter').pollProc();
  assert.equal(states().obs.active, false);
  const st = action('system.launch').state;
  assert.equal(st({ path: 'steam://rungameid/438100' }), null);
  assert.equal(st({ path: '' }), null);
});

test('follow: the Change avatar button lights up while you are wearing that avatar', async () => {
  const mine = 'avtr_11111111-2222-3333-4444-555555555555';
  const other = 'avtr_99999999-8888-7777-6666-555555555555';
  const { app, hub, states } = await boot([btn('a', 'vrc.avatar', { avatarId: mine }), btn('b', 'vrc.avatar', { avatarId: other })]);
  hub.set('vrc.avatar', mine); // what VRChat's OSC "avatar changed" message publishes
  assert.deepEqual([states().a.active, states().b.active], [true, false]);
  hub.set('vrc.avatar', other);
  assert.deepEqual([states().a.active, states().b.active], [false, true]);
  assert.equal(app.registry.get('vrchat').matchState(`vrc.avatar=${mine}`).vrc, true, 'following it switches the VRChat listener on');
});

test('cycle microphones: each press makes the next chosen microphone the Windows default, wraps around, and names it', async () => {
  let current = 'vr';
  const devices = [{ id: 'vr', name: 'VR mic' }, { id: 'xlr', name: 'Desktop XLR' }, { id: 'other', name: 'Some other mic' }];
  const { engine, helper } = await boot([
    btn('cycle', 'audio.cycleInput', { devices: ['vr', 'xlr'] }),
    btn('bad', 'audio.cycleInput', { devices: ['vr'] }),
  ], {
    'audio.snapshot': () => ({ capture: { id: current, muted: false, volume: 100 }, render: null }),
    'audio.devices': (a) => (a.flow === 'capture' ? devices : []),
    'audio.setDefault': (a) => { current = a.device; return true; },
  });
  const toasts = [];
  engine.on('toast', (t) => toasts.push(`${t.level}: ${t.text}`));
  await engine.press('cycle');
  assert.equal(current, 'xlr', 'VR mic -> desktop mic');
  assert.ok(toasts.includes('info: Microphone: Desktop XLR'), 'the toast names the microphone that is live now');
  await engine.press('cycle');
  assert.equal(current, 'vr', 'wraps around to the first');
  current = 'other'; // the default is some microphone that is not in the list
  await engine.press('cycle');
  assert.equal(current, 'vr', 'starts at the first chosen microphone');
  assert.ok(helper.calls.filter((c) => c.op === 'audio.setDefault').every((c) => c.flow === 'capture'), 'only the microphone default is ever changed, never the output');
  await engine.press('bad');
  assert.ok(toasts.some((t) => /error: .*at least two microphones/.test(t)), 'one microphone is not a cycle');
  assert.equal(current, 'vr', 'and nothing was changed');
});
