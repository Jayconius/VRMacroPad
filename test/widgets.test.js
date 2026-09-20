// Widgets: dice / coin math, timer and stopwatch behavior, persistence, chat posting,
// and the data behind the battery and now-playing screens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createApp } = require('../src/core');
const { rollDice, flipCoin, fillTemplate, timerDurationMs, parseNames } = require('../src/core/widgets');
const { tempDir, FakeHelper, waitFor, sleep } = require('./helpers');

const cleanup = [];
test.after(async () => { for (const c of cleanup) { try { await c(); } catch { /* already stopped */ } } });

// rand that returns the given numbers in order
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

// ---- pure logic ----
test('dice: sums, modifier and notation', () => {
  const r = rollDice({ count: 2, sides: 6, modifier: 3 }, seq(3, 5));
  assert.deepEqual(r.rolls, [3, 5]);
  assert.equal(r.total, 11);
  assert.equal(r.notation, '2d6+3');
  assert.equal(r.detail, '3 + 5 + 3');
  const neg = rollDice({ count: 1, sides: 20, modifier: -2 }, seq(10));
  assert.equal(neg.total, 8);
  assert.equal(neg.notation, 'd20-2');
  assert.equal(neg.detail, '10 - 2');
});

test('dice: advantage keeps the higher of two d20s, disadvantage the lower, and only for a single d20', () => {
  const adv = rollDice({ count: 1, sides: 20, mode: 'advantage' }, seq(7, 15));
  assert.deepEqual([adv.rolls, adv.dropped, adv.total], [[15], [7], 15]);
  assert.match(adv.notation, /adv/);
  const dis = rollDice({ count: 1, sides: 20, mode: 'disadvantage' }, seq(7, 15));
  assert.deepEqual([dis.rolls, dis.dropped, dis.total], [[7], [15], 7]);
  const first = rollDice({ count: 1, sides: 20, mode: 'advantage' }, seq(18, 4));
  assert.equal(first.total, 18, 'keeps the first when it is higher');
  const notD20 = rollDice({ count: 1, sides: 6, mode: 'advantage' }, seq(2, 6));
  assert.deepEqual(notD20.dropped, []);
  const many = rollDice({ count: 2, sides: 20, mode: 'advantage' }, seq(2, 6));
  assert.deepEqual(many.dropped, []);
});

test('dice: natural 20 / natural 1 are reported, sizes are clamped', () => {
  assert.equal(rollDice({ sides: 20 }, seq(20)).natural, 20);
  assert.equal(rollDice({ sides: 20 }, seq(1)).natural, 1);
  assert.equal(rollDice({ sides: 6 }, seq(6)).natural, null);
  assert.equal(rollDice({ count: 999, sides: 6 }, seq(1)).count, 20);
  assert.equal(rollDice({ count: 0, sides: 1 }, seq(1)).sides, 2);
  assert.equal(rollDice({ sides: 99999 }, seq(1)).sides, 1000);
});

test('dice and coin: real randomness stays in range and uses every face', () => {
  const { registry } = require('../src/core/widgets');
  const crypto = require('crypto');
  const rand = (n) => crypto.randomInt(1, n + 1);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const r = rollDice({ sides: 6 }, rand);
    assert.ok(r.total >= 1 && r.total <= 6);
    seen.add(r.total);
  }
  assert.equal(seen.size, 6);
  const coins = new Set();
  for (let i = 0; i < 200; i++) coins.add(flipCoin(rand));
  assert.deepEqual([...coins].sort(), ['Heads', 'Tails']);
  assert.ok(registry.has('dice') && registry.has('coin'));
  assert.equal(flipCoin(seq(1)), 'Heads');
  assert.equal(flipCoin(seq(2)), 'Tails');
});

test('templates, timer length and nickname parsing', () => {
  assert.equal(fillTemplate('🎲 {dice} -> {total}!', { dice: '2d6', total: 9 }), '🎲 2d6 -> 9!');
  assert.equal(fillTemplate('{typo} {total}', { total: 1 }), '{typo} 1', 'unknown placeholders stay visible');
  assert.equal(timerDurationMs({ minutes: 5, seconds: 30 }), 330000);
  assert.equal(timerDurationMs({ minutes: 0, seconds: 0 }), 1000, 'never zero');
  assert.equal(timerDurationMs({ minutes: 5000, seconds: 999 }), (999 * 60 + 59) * 1000, 'clamped');
  assert.deepEqual(parseNames('LHR-AAA=Left foot\n bad line \nlhr-bbb = Right foot'), { 'lhr-aaa': 'Left foot', 'lhr-bbb': 'Right foot' });
});

// ---- through the engine ----
class FakeTwitch extends EventEmitter {
  constructor(connected = true) {
    super();
    this.sent = [];
    this.connected = connected;
    this.status = connected ? 'connected' : 'needs-auth';
  }
  configure() {}
  isConnected() { return this.connected; }
  info() { return { status: this.status }; }
  stop() {}
  async sendChat(text) { this.sent.push(text); }
}

async function boot(buttons, { random, now, twitch, mediaHelper, vrHelper, audioHelper, dir } = {}) {
  const app = createApp({
    dataDir: dir || tempDir(), helper: audioHelper || new FakeHelper(), mediaHelper: mediaHelper || new FakeHelper(), vrHelper: vrHelper || new FakeHelper(),
    twitch: twitch || new FakeTwitch(false), port: 0, random, now,
  });
  cleanup.push(() => app.stop());
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = [{ id: 'p', name: 'P', cols: 8, rows: 4, buttons: buttons.map((b, i) => ({ x: (i * 2) % 8, y: Math.floor((i * 2) / 8) * 2, w: 2, h: 2, ...b })) }];
  app.engine.updateConfig(cfg);
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  return { app, engine: app.engine, toasts, data: (id) => app.engine.computeWidgetData()[id] };
}

const widget = (id, type, params = {}, extra = {}) => ({ id, label: id, widget: { type, params }, steps: [], ...extra });

test('coin: tapping flips, shows the result, and posts it to Twitch chat when asked', async () => {
  const twitch = new FakeTwitch(true);
  const { engine, data } = await boot([
    widget('plain', 'coin', { postToChat: false }),
    widget('chat', 'coin', { postToChat: true, template: '🪙 It is {result}!' }),
  ], { random: seq(1, 2, 1), twitch });
  assert.equal(data('plain').last, null);
  await engine.widgetCommand('plain', 'tap');
  assert.equal(data('plain').last.text, 'Heads');
  assert.equal(data('plain').seq, 1);
  assert.deepEqual(twitch.sent, [], 'not posted unless enabled');
  await engine.widgetCommand('chat', 'tap');
  assert.equal(data('chat').last.text, 'Tails');
  assert.deepEqual(twitch.sent, ['🪙 It is Tails!']);
});

test('dice: rolls with the configured size, count and modifier, and posts the template', async () => {
  const twitch = new FakeTwitch(true);
  const { engine, data } = await boot([
    widget('d', 'dice', { sides: '6', count: 2, modifier: 3, postToChat: true, template: '🎲 {dice}: {total} [{rolls}] {detail}' }),
    widget('c', 'dice', { sides: 'custom', customSides: 30, count: 1, modifier: 0, postToChat: false }),
    widget('adv', 'dice', { sides: '20', count: 1, modifier: 0, mode: 'advantage', postToChat: false }),
  ], { random: seq(3, 5, 27, 4, 16), twitch });
  await engine.widgetCommand('d', 'tap');
  assert.equal(data('d').last.text, '11');
  assert.equal(data('d').last.dice, '2d6+3');
  assert.deepEqual(twitch.sent, ['🎲 2d6+3: 11 [3, 5] 3 + 5 + 3']);
  await engine.widgetCommand('c', 'tap');
  assert.equal(data('c').last.text, '27');
  await engine.widgetCommand('adv', 'tap');
  assert.equal(data('adv').last.text, '16', 'advantage kept the higher of 4 and 16');
});

test('dice and coin: a result is still shown when Twitch is not connected, with a warning', async () => {
  const { engine, data, toasts } = await boot([widget('d', 'dice', { sides: '20', count: 1, postToChat: true })], { random: seq(12) });
  const res = await engine.widgetCommand('d', 'tap');
  assert.equal(res.ok, true);
  assert.equal(data('d').last.text, '12');
  assert.match(toasts.at(-1).text, /Not posted to Twitch chat/);
  assert.equal(toasts.at(-1).level, 'warn');
});

test('a hotkey or trigger "pressing" a widget taps it', async () => {
  const { engine, data } = await boot([widget('d', 'dice', { sides: '20', count: 1 })], { random: seq(17) });
  await engine.press('d', { source: 'hotkey' });
  assert.equal(data('d').last.text, '17');
});

test('stopwatch: start, stop, resume and reset', async () => {
  let t = 1_000_000;
  const { engine, data } = await boot([widget('sw', 'stopwatch', {})], { now: () => t });
  assert.deepEqual([data('sw').running, data('sw').elapsedMs], [false, 0]);
  await engine.widgetCommand('sw', 'tap');
  assert.equal(data('sw').running, true);
  assert.equal(data('sw').startedAt, 1_000_000);
  t += 1500;
  await engine.widgetCommand('sw', 'tap');
  assert.deepEqual([data('sw').running, data('sw').elapsedMs], [false, 1500]);
  await engine.widgetCommand('sw', 'tap'); // resume keeps the total
  t += 500;
  await engine.widgetCommand('sw', 'tap');
  assert.equal(data('sw').elapsedMs, 2000);
  await engine.widgetCommand('sw', 'hold');
  assert.deepEqual([data('sw').running, data('sw').elapsedMs], [false, 0]);
});

test('timer: start, pause, resume, reset, finish (runs its steps once) and acknowledge', async () => {
  let t = 5_000_000;
  const { engine, data, toasts } = await boot([
    widget('tm', 'timer', { minutes: 0, seconds: 5, beep: true }, { steps: [{ action: 'system.toast', params: { message: 'Timer done!' }, delayMs: 0 }] }),
  ], { now: () => t });
  const tm = () => data('tm');
  assert.equal(tm().mode, 'idle');
  assert.equal(tm().durationMs, 5000);
  await engine.widgetCommand('tm', 'tap');
  assert.deepEqual([tm().mode, tm().endsAt], ['running', 5_005_000]);
  t += 2000;
  await engine.widgetCommand('tm', 'tap'); // pause
  assert.deepEqual([tm().mode, tm().remainingMs], ['paused', 3000]);
  t += 60_000; // time passes while paused: nothing is lost
  await engine.widgetCommand('tm', 'tap'); // resume
  assert.deepEqual([tm().mode, tm().endsAt], ['running', t + 3000]);
  await engine.widgetCommand('tm', 'hold'); // reset
  assert.equal(tm().mode, 'idle');
  await engine.widgetCommand('tm', 'tap');
  t += 5000;
  engine.widgets.finish('tm'); // the scheduled timeout firing
  assert.equal(tm().mode, 'done');
  await waitFor(() => toasts.some((x) => x.text === 'Timer done!'));
  assert.ok(toasts.some((x) => /tm finished/.test(x.text)), 'finish notice');
  engine.widgets.finish('tm'); // firing twice must not run the steps twice
  await sleep(30);
  assert.equal(toasts.filter((x) => x.text === 'Timer done!').length, 1);
  await engine.widgetCommand('tm', 'tap'); // acknowledge
  assert.equal(tm().mode, 'idle');
});

test('timer: a real timeout finishes it on schedule', async () => {
  const { engine, data } = await boot([widget('tm', 'timer', { minutes: 0, seconds: 1 })]);
  await engine.widgetCommand('tm', 'tap');
  assert.equal(data('tm').mode, 'running');
  await waitFor(() => data('tm').mode === 'done', 3000);
});

test('timer: a running timer survives an app restart; one that ran out meanwhile shows done without firing its steps', async () => {
  const dir = tempDir();
  let t = 9_000_000;
  const first = await boot([widget('tm', 'timer', { minutes: 1, seconds: 0 }, { steps: [{ action: 'system.toast', params: { message: 'late!' }, delayMs: 0 }] })], { now: () => t, dir });
  await first.engine.widgetCommand('tm', 'tap');
  const endsAt = first.data('tm').endsAt;
  await first.app.stop();

  t += 20_000; // restarted 20 seconds later: still running
  const second = createApp({ dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), twitch: new FakeTwitch(false), port: 0, now: () => t });
  cleanup.push(() => second.stop());
  await second.start();
  const id = second.engine.buttons().find((e) => e.button.widget).button.id;
  assert.equal(second.engine.computeWidgetData()[id].mode, 'running');
  assert.equal(second.engine.computeWidgetData()[id].endsAt, endsAt);
  await second.stop();

  t += 120_000; // restarted after it would have finished
  const third = createApp({ dataDir: dir, helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), twitch: new FakeTwitch(false), port: 0, now: () => t });
  cleanup.push(() => third.stop());
  await third.start();
  const toasts = [];
  third.engine.on('toast', (x) => toasts.push(x));
  assert.equal(third.engine.computeWidgetData()[id].mode, 'done');
  await sleep(50);
  assert.ok(!toasts.some((x) => x.text === 'late!'), 'steps do not run late');
});

test('widget state is dropped when its button is deleted, and unknown widget types fail politely', async () => {
  const { engine, toasts } = await boot([widget('tm', 'timer', {}), widget('x', 'hologram', {})]);
  assert.equal(engine.computeWidgetData().x.unavailable, true);
  const res = await engine.widgetCommand('x', 'tap');
  assert.equal(res.ok, false);
  assert.match(toasts.at(-1).text, /not available/);
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons = cfg.pages[0].buttons.filter((b) => b.id !== 'tm');
  engine.updateConfig(cfg);
  assert.ok(!engine.widgets.states.has('tm'));
  await assert.rejects(engine.widgetCommand('nope', 'tap'), /Unknown widget/);
});

test('widget data changes are pushed, and carry the server clock', async () => {
  const { engine } = await boot([widget('d', 'dice', { sides: '6', count: 1 })], { random: seq(4) });
  const pushes = [];
  engine.on('widgetData', (d) => pushes.push(d));
  await engine.widgetCommand('d', 'tap');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].d.last.text, '4');
  assert.equal(typeof pushes[0].d.now, 'number');
});

// ---- SteamVR battery ----
test('battery: devices are filtered, named, and reported; low battery becomes a state; SteamVR going away is shown', async () => {
  let snapshot = {
    connected: true, error: '',
    devices: [
      { index: 0, class: 'hmd', role: '', serial: 'HMD1', model: 'Quest', hasBattery: true, battery: 80, charging: false },
      { index: 1, class: 'controller', role: 'left', serial: 'CL', model: 'Touch', hasBattery: true, battery: 12, charging: false },
      { index: 2, class: 'controller', role: 'right', serial: 'CR', model: 'Touch', hasBattery: true, battery: 55, charging: true },
      { index: 3, class: 'tracker', role: '', serial: 'LHR-AAA', model: 'Tracker', hasBattery: true, battery: 33, charging: false },
      { index: 4, class: 'tracker', role: '', serial: 'LHR-BBB', model: 'Tracker', hasBattery: false, battery: -1, charging: false },
      { index: 5, class: 'basestation', role: '', serial: 'BS', model: 'Base', hasBattery: false, battery: -1, charging: false },
    ],
  };
  const vr = new FakeHelper({ snapshot: () => snapshot });
  const { app, engine, data } = await boot([widget('bat', 'battery', { show: ['hmd', 'controller', 'tracker'], lowPercent: 20, names: 'LHR-AAA=Left foot' })], { vrHelper: vr });
  await waitFor(() => data('bat').connected === true, 3000);
  const d = data('bat');
  assert.deepEqual(d.devices.map((x) => x.name), ['Headset', 'Left controller', 'Right controller', 'Left foot', 'Tracker 1'], 'base stations hidden, nicknames applied, other trackers numbered');
  assert.equal(d.devices[1].battery, 12);
  assert.equal(d.devices[2].charging, true);
  assert.equal(d.devices[4].hasBattery, false);
  assert.equal(d.lowPercent, 20);
  assert.equal(app.hub.eval('vr.lowBattery'), true, 'left controller is at 12% (limit 15)');
  assert.equal(app.hub.eval('vr.connected'), true);

  snapshot = { connected: false, error: 'SteamVR is not running', devices: [] };
  await app.providers.pollVr();
  assert.equal(data('bat').connected, false);
  assert.equal(data('bat').error, 'SteamVR is not running');
  assert.equal(app.hub.eval('vr.connected'), false);

  // only some kinds shown
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons[0].widget.params.show = ['hmd'];
  cfg.pages[0].buttons[0].widget.params.showDropped = false; // the headset seen earlier is not listed as "off"
  engine.updateConfig(cfg);
  snapshot = { connected: true, error: '', devices: [{ index: 0, class: 'hmd', role: '', serial: 'H', model: 'Q', hasBattery: true, battery: 90, charging: false }, { index: 1, class: 'tracker', role: '', serial: 'T', model: 'T', hasBattery: true, battery: 10, charging: false }] };
  await app.providers.pollVr();
  assert.deepEqual(data('bat').devices.map((x) => x.class), ['hmd']);
});

test('battery: a charging or unreported device never counts as low; the link is dropped when no widget needs it', async () => {
  const vr = new FakeHelper({ snapshot: () => ({ connected: true, error: '', devices: [{ index: 1, class: 'controller', role: 'left', serial: 'CL', model: 'T', hasBattery: true, battery: 5, charging: true }, { index: 2, class: 'tracker', role: '', serial: 'T', model: 'T', hasBattery: false, battery: -1, charging: false }] }) });
  let released = 0;
  vr.release = () => { released++; };
  const { app, engine } = await boot([widget('bat', 'battery', {})], { vrHelper: vr });
  await waitFor(() => app.hub.eval('vr.connected') === true, 3000);
  assert.equal(app.hub.eval('vr.lowBattery'), false);
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons = [];
  const before = released;
  engine.updateConfig(cfg);
  assert.ok(released > before, 'helper released (SteamVR link closed) once nothing uses it');
  assert.equal(app.hub.eval('vr.connected'), undefined);
});

// ---- now playing ----
test('media: track info, live progress, album art fetched once, controls and the playing state', async () => {
  const now = 1_780_000_000_000;
  let info = {
    available: true, appId: 'Spotify.exe', sessions: ['Spotify.exe'], title: 'Song', artist: 'Artist', album: 'Album', status: 'Playing',
    positionMs: 10_000, startMs: 0, endMs: 200_000, updatedAt: now - 2000, canSeek: true, thumbKey: 'k1', thumb: 'data:image/png;base64,AAAA',
  };
  const helper = new FakeHelper({ get: (a) => ({ ...info, thumb: a.knownThumbKey === info.thumbKey ? '' : info.thumb }), control: true });
  const { app, engine, data } = await boot([
    widget('np', 'media', { app: 'spotify', controls: true, progress: true }),
    { id: 'ppbtn', label: 'PP', steps: [{ action: 'media.control', params: { cmd: 'toggle', app: 'spotify' }, delayMs: 0 }] },
  ], { mediaHelper: helper, now: () => now });
  await waitFor(() => data('np').available === true, 3000);
  const d = data('np');
  assert.deepEqual([d.title, d.artist, d.album, d.playing, d.canSeek], ['Song', 'Artist', 'Album', true, true]);
  assert.equal(d.durationMs, 200_000);
  assert.equal(d.positionMs, 12_000, 'position projected forward by the time since the player last reported');
  assert.equal(d.thumbKey, 'k1');
  assert.ok(!('thumb' in d), 'picture data is never part of the widget state');
  assert.equal(app.providers.mediaThumb('k1'), 'data:image/png;base64,AAAA');
  assert.equal(helper.calls[0].app, 'spotify');
  await app.providers.pollMedia();
  assert.equal(helper.calls.at(-1).knownThumbKey, 'k1', 'asks not to resend a picture it already has');
  assert.equal(app.providers.mediaThumb('k1'), 'data:image/png;base64,AAAA', 'still cached');

  await engine.widgetCommand('np', 'next');
  assert.deepEqual(helper.calls.find((c) => c.op === 'control'), { op: 'control', app: 'spotify', cmd: 'next' });
  await engine.widgetCommand('np', 'seek', 90_000);
  assert.equal(helper.calls.filter((c) => c.op === 'control').at(-1).positionMs, 90_000);
  const bad = await engine.widgetCommand('np', 'explode');
  assert.equal(bad.ok, false);

  await waitFor(() => app.hub.eval('media.playing') === true, 3000);
  assert.equal(engine.computeButtonStates().ppbtn.active, true, 'the play/pause button lights up while music plays');
  await engine.press('ppbtn');
  assert.equal(helper.calls.filter((c) => c.op === 'control').at(-1).cmd, 'toggle');
});

test('media: nothing playing, a paused player, and a failing helper are all shown sensibly', async () => {
  let mode = 'none';
  const helper = new FakeHelper({
    get: () => {
      if (mode === 'error') throw new Error('The media API did not answer in time');
      if (mode === 'none') return { available: false, sessions: ['brave.exe'] };
      return { available: true, appId: 'x', sessions: [], title: 'T', artist: '', album: '', status: 'Paused', positionMs: 5000, startMs: 0, endMs: 0, updatedAt: 0, canSeek: false, thumbKey: 'k', thumb: '' };
    },
  });
  const { app, data } = await boot([widget('np', 'media', { app: 'any' })], { mediaHelper: helper });
  await waitFor(() => data('np').pending === undefined && data('np').available === false, 3000);
  assert.deepEqual(data('np').sessions, ['brave.exe']);
  mode = 'paused';
  await app.providers.pollMedia();
  assert.deepEqual([data('np').available, data('np').playing, data('np').durationMs, data('np').canSeek], [true, false, 0, false]);
  assert.equal(data('np').positionMs, 5000, 'a paused track does not advance');
  mode = 'error';
  await app.providers.pollMedia();
  assert.equal(data('np').available, false);
  assert.match(data('np').error, /did not answer/);
});

test('media: the Player picker lists what Windows sees right now, and a widget with no choice follows "auto"', async () => {
  const helper = new FakeHelper({
    get: { available: false, sessions: [] },
    list: [
      { id: 'brave.exe', status: 'Playing', title: 'A stream', artist: '' },
      { id: 'Spotify.exe', status: 'Paused', title: 'Danza Kuduro', artist: 'The Saints' },
      { id: 'YouTube Music.exe', status: 'Playing', title: 'Sandstorm', artist: 'Darude' },
    ],
  });
  const { app } = await boot([widget('np', 'media', {})], { mediaHelper: helper });
  await waitFor(() => helper.calls.some((c) => c.op === 'get'), 3000);
  assert.equal(helper.calls.find((c) => c.op === 'get').app, 'auto', 'no player chosen means automatic');
  const list = await app.providers.options('media.players');
  assert.deepEqual(list.map((o) => o.value), ['auto', 'any', 'brave', 'spotify', 'youtube music', 'pear']);
  assert.match(list[3].label, /^Spotify\s+\(paused: Danza Kuduro - The Saints\)$/);
  assert.match(list[4].label, /playing: Sandstorm - Darude/);
  const empty = await new FakeHelper({ list: new Error('helper down') });
  app.providers.mediaHelper = empty;
  assert.deepEqual((await app.providers.options('media.players')).map((o) => o.value), ['auto', 'any', 'pear'], 'still offers the fixed choices when the helper fails');
});

// ---- the Spotify action pack (through the Windows media session) ----
test('spotify pack: shuffle / repeat / seek / volume actions reach the right helper calls, and the buttons follow Spotify', async () => {
  let info = { available: true, appId: 'Spotify.exe', sessions: ['Spotify.exe'], title: 'Song', artist: 'A', album: 'B', status: 'Paused', positionMs: 5000, startMs: 0, endMs: 100000, updatedAt: 0, canSeek: true, thumbKey: 'k', thumb: '', shuffle: false, repeat: 'None', canShuffle: true, canRepeat: true };
  const media = new FakeHelper({ get: () => info, control: true });
  const audio = new FakeHelper({});
  const step = (action, params = {}) => [{ action, params, delayMs: 0 }];
  let n = 0; // small buttons, so nine of them fit on the test page
  const btn = (id, action, params) => { const i = n++; return { id, label: id, x: i % 8, y: Math.floor(i / 8), w: 1, h: 1, steps: step(action, params) }; };
  const { app, engine } = await boot([
    btn('play', 'spotify.playback', { cmd: 'toggle' }),
    btn('shuf', 'spotify.shuffle', {}),
    btn('shufOn', 'spotify.shuffle', { mode: 'on' }),
    btn('rep', 'spotify.repeat', {}),
    btn('repOne', 'spotify.repeat', { mode: 'track' }),
    btn('fwd', 'spotify.seek', { direction: 'forward', seconds: 15 }),
    btn('back', 'spotify.seek', { direction: 'back', seconds: 5 }),
    btn('volUp', 'spotify.volume', { mode: 'up', amount: 7 }),
    btn('mute', 'spotify.volume', { mode: 'toggleMute' }),
  ], { mediaHelper: media, audioHelper: audio });
  await waitFor(() => app.hub.eval('spotify.shuffle') === false, 3000);
  assert.equal(app.hub.eval('spotify.repeat'), false);
  assert.equal(app.hub.eval('spotify.playing'), false);

  const last = () => media.calls.filter((c) => c.op === 'control').at(-1);
  await engine.press('play'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'toggle' });
  await engine.press('shuf'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'shuffle', mode: '' });
  await engine.press('shufOn'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'shuffle', mode: 'on' });
  await engine.press('rep'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'repeat', mode: '' });
  await engine.press('repOne'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'repeat', mode: 'track' });
  await engine.press('fwd'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'seekby', deltaMs: 15000 });
  await engine.press('back'); assert.deepEqual(last(), { op: 'control', app: 'spotify', cmd: 'seekby', deltaMs: -5000 });
  await engine.press('volUp');
  assert.deepEqual(audio.calls.find((c) => c.op === 'audio.setSession'), { op: 'audio.setSession', process: 'spotify', delta: 7 });
  await engine.press('mute');
  assert.equal(audio.calls.filter((c) => c.op === 'audio.setSession').at(-1).toggleMute, true);

  // Spotify turns shuffle and repeat on: the buttons light up
  info = { ...info, status: 'Playing', shuffle: true, repeat: 'Track' };
  await app.providers.pollMedia();
  assert.equal(app.hub.eval('spotify.shuffle'), true);
  assert.equal(app.hub.eval('spotify.repeat'), true);
  assert.equal(app.hub.eval('spotify.playing'), true);
  const states = engine.computeButtonStates();
  assert.deepEqual([states.play.active, states.shuf.active, states.rep.active], [true, true, true]);
});

test('spotify pack: the now-playing widget offers shuffle and repeat only when the player reports them', async () => {
  let info = { available: true, appId: 'Spotify.exe', sessions: [], title: 'T', artist: 'A', album: '', status: 'Playing', positionMs: 0, startMs: 0, endMs: 1000, updatedAt: 0, canSeek: true, thumbKey: 'k', thumb: '', shuffle: true, repeat: 'List' };
  const media = new FakeHelper({ get: () => info, control: true });
  const { app, data } = await boot([widget('np', 'media', { app: 'spotify' })], { mediaHelper: media });
  await waitFor(() => data('np').available === true, 3000);
  assert.deepEqual(data('np').extras, { shuffle: true, repeat: 'ALL' });
  info = { ...info, shuffle: null, repeat: '' };
  await app.providers.pollMedia();
  assert.equal(data('np').extras, undefined, 'a player that says nothing about shuffle gets no extra buttons');
});
