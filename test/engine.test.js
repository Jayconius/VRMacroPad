const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../src/core');
const { OscListener } = require('../src/core/osc');
const { tempDir, FakeHelper, sleep, waitFor } = require('./helpers');

const btn = (id, steps, extra = {}) => ({ id, x: 0, y: 0, w: 1, h: 1, label: id, steps: steps.map((s) => ({ delayMs: 0, params: {}, ...s })), ...extra });

// Every booted app is stopped after the file's tests, even when one fails,
// so a failing test can never leave servers open and hang the run.
const booted = [];
test.after(async () => {
  for (const app of booted) {
    try { await app.stop(); } catch { /* already stopped */ }
  }
});

// Boots a full app (no HTTP client needed) with a fake helper and a given first page.
async function boot(buttons, { helperAnswers, settings, pages, hooks } = {}) {
  const dir = tempDir();
  const helper = new FakeHelper(helperAnswers);
  const app = createApp({ dataDir: dir, helper, port: 0, hooks });
  booted.push(app);
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages = pages || [{ id: 'main', name: 'Main', cols: 8, rows: 4, buttons: buttons.map((b, i) => ({ ...b, x: i % 8, y: Math.floor(i / 8) })) }];
  if (settings) Object.assign(cfg.settings, settings);
  app.engine.updateConfig(cfg);
  const toasts = [];
  app.engine.on('toast', (t) => toasts.push(t));
  return { app, helper, toasts, engine: app.engine, hub: app.hub };
}

test('engine: steps run in order and honor the delay before a step', async () => {
  const { app, toasts, engine } = await boot([
    btn('b', [
      { action: 'system.toast', params: { message: 'first' } },
      { action: 'system.toast', params: { message: 'second' }, delayMs: 60 },
    ]),
  ]);
  const t0 = Date.now();
  await engine.press('b');
  assert.deepEqual(toasts.map((t) => t.text), ['first', 'second']);
  assert.ok(Date.now() - t0 >= 55, 'waited ~60ms before the second step');
  await app.stop();
});

test('engine: an unknown action becomes an error toast, not a crash, and the button can be pressed again', async () => {
  const { app, toasts, engine } = await boot([btn('b', [{ action: 'nope.nothing' }])]);
  const res = await engine.press('b');
  assert.equal(res.ok, false);
  assert.match(toasts.at(-1).text, /Unknown action "nope.nothing"/);
  assert.equal(toasts.at(-1).level, 'error');
  assert.equal(engine.running.size, 0);
  await engine.press('b');
  await app.stop();
});

test('engine: pressing a button that is still running is ignored', async () => {
  const { app, engine } = await boot([btn('b', [{ action: 'system.wait', params: { ms: 150 } }])]);
  const first = engine.press('b');
  const second = await engine.press('b');
  assert.deepEqual(second, { skipped: true });
  assert.equal((await first).ok, true);
  await app.stop();
});

test('engine: an empty button explains itself', async () => {
  const { app, toasts, engine } = await boot([btn('b', [])]);
  await engine.press('b');
  assert.match(toasts.at(-1).text, /no actions yet/);
  await app.stop();
});

test('actions: mic mute and keys reach the helper with the right arguments', async () => {
  const { app, helper, engine } = await boot([
    btn('t', [{ action: 'audio.micMute', params: { mode: 'toggle' } }]),
    btn('m', [{ action: 'audio.micMute', params: { mode: 'mute', device: 'dev-1' } }]),
    btn('k', [{ action: 'keys.press', params: { keys: 'ctrl+shift+F13', holdMs: 50, scan: true } }]),
    btn('c', [{ action: 'system.shortcut', params: { shortcut: 'alttab' } }]),
    btn('v', [{ action: 'audio.volume', params: { target: 'output', mode: 'down', amount: 5 } }]),
    btn('a', [{ action: 'audio.appVolume', params: { process: 'discord', mode: 'toggleMute' } }]),
    btn('o', [{ action: 'audio.setDefaultOutput', params: { device: 'out-2' } }]),
  ]);
  const call = async (id) => { helper.calls.length = 0; await engine.press(id); return helper.calls.find((c) => c.op !== 'audio.snapshot'); };
  assert.deepEqual(await call('t'), { op: 'audio.setMute', flow: 'capture', device: null, muted: null });
  assert.deepEqual(await call('m'), { op: 'audio.setMute', flow: 'capture', device: 'dev-1', muted: true });
  assert.deepEqual(await call('k'), { op: 'keys.combo', vks: [0x11, 0x10, 0x7c], holdMs: 50, scan: true });
  assert.deepEqual(await call('c'), { op: 'keys.combo', vks: [0x12, 0x09], holdMs: 30, scan: false });
  assert.deepEqual(await call('v'), { op: 'audio.setVolume', flow: 'render', device: null, delta: -5 });
  assert.deepEqual(await call('a'), { op: 'audio.setSession', process: 'discord', toggleMute: true });
  assert.deepEqual(await call('o'), { op: 'audio.setDefault', flow: 'render', device: 'out-2' });
  await app.stop();
});

test('actions: bad parameters give readable errors', async () => {
  const { app, toasts, engine } = await boot([
    btn('k', [{ action: 'keys.press', params: { keys: 'ctrl+banana' } }]),
    btn('o', [{ action: 'audio.setDefaultOutput', params: {} }]),
    btn('u', [{ action: 'system.openUrl', params: { url: 'not a url' } }]),
    btn('h', [{ action: 'http.request', params: { url: 'ftp://x' } }]),
  ]);
  for (const id of ['k', 'o', 'u', 'h']) await engine.press(id);
  assert.match(toasts[0].text, /Unknown key "banana"/);
  assert.match(toasts[1].text, /Pick an output device/);
  assert.match(toasts[2].text, /not a URL/);
  assert.match(toasts[3].text, /http/);
  await app.stop();
});

test('state: buttons take their color state from the provider that backs them', async () => {
  const snap = { capture: { id: 'mic', muted: true, volume: 100 }, render: { id: 'spk', muted: false, volume: 40 } };
  const { app, engine, helper } = await boot([
    btn('mic', [{ action: 'audio.micMute', params: { mode: 'toggle' } }]),
    btn('out', [{ action: 'audio.outputMute', params: { mode: 'toggle' } }]),
    btn('dev', [{ action: 'audio.setDefaultOutput', params: { device: 'spk' } }]),
    btn('none', [{ action: 'system.toast', params: { message: 'x' } }]),
  ], { helperAnswers: { 'audio.snapshot': () => snap } });
  await waitFor(() => engine.computeButtonStates().mic && !engine.computeButtonStates().mic.unknown);
  const s = engine.computeButtonStates();
  assert.deepEqual(s.mic, { active: true, unknown: false });
  assert.deepEqual(s.out, { active: false, unknown: false });
  assert.deepEqual(s.dev, { active: true, unknown: false });
  assert.equal(s.none, undefined, 'buttons without a state source have no entry');
  // flipping the underlying state re-emits
  const changes = [];
  engine.on('buttonStates', (x) => changes.push(x));
  snap.capture.muted = false;
  await engine.press('mic'); // triggers an immediate refresh
  await waitFor(() => changes.some((c) => c.mic && c.mic.active === false));
  assert.ok(helper.calls.some((c) => c.op === 'audio.setMute'));
  await app.stop();
});

test('state: unknown until a provider reports, e.g. OBS not running', async () => {
  const { app, engine } = await boot([btn('rec', [{ action: 'obs.record', params: { mode: 'toggle' } }])], {
    settings: { obs: { host: '127.0.0.1', port: 1, password: '' } },
  });
  assert.deepEqual(engine.computeButtonStates().rec, { active: false, unknown: true });
  await app.stop();
});

test('state: "own toggle" buttons flip on each successful press', async () => {
  const { app, engine } = await boot([btn('t', [{ action: 'system.toast', params: { message: 'hi' } }], { state: { source: 'toggle', key: '' } })]);
  assert.equal(engine.computeButtonStates().t.active, false);
  await engine.press('t');
  assert.equal(engine.computeButtonStates().t.active, true);
  await engine.press('t');
  assert.equal(engine.computeButtonStates().t.active, false);
  await app.stop();
});

test('state: an explicit key overrides the automatic one', async () => {
  const { app, engine, hub } = await boot([btn('k', [{ action: 'system.toast', params: { message: 'x' } }], { state: { source: 'key', key: 'obs.scene=Chatting' } })]);
  hub.set('obs.scene', 'Chatting');
  assert.equal(engine.computeButtonStates().k.active, true);
  hub.set('obs.scene', 'Gaming');
  assert.equal(engine.computeButtonStates().k.active, false);
  await app.stop();
});

test('triggers: state triggers fire on the transition only, never on the initial value', async () => {
  // A neutral key: obs.* keys are owned by the OBS provider, which (correctly) clears them when OBS is unreachable.
  const { app, engine, hub, toasts } = await boot([
    btn('r', [{ action: 'system.toast', params: { message: 'recording started' } }], { triggers: [{ type: 'state', key: 'test.flag', becomes: true }] }),
    btn('s', [{ action: 'system.toast', params: { message: 'recording stopped' } }], { triggers: [{ type: 'state', key: 'test.flag', becomes: false }] }),
  ]);
  hub.set('test.flag', true); // first value seen: primes, must not fire
  await sleep(30);
  assert.equal(toasts.length, 0);
  hub.set('test.flag', false);
  await waitFor(() => toasts.length === 1);
  assert.equal(toasts[0].text, 'recording stopped');
  hub.set('test.flag', true);
  await waitFor(() => toasts.length === 2);
  assert.equal(toasts[1].text, 'recording started');
  hub.remove('test.flag'); // provider went away: not a transition
  await sleep(30);
  assert.equal(toasts.length, 2);
  await app.stop();
});

test('triggers: app start/stop triggers and page auto-switch follow the process list', async () => {
  let procs = ['steam.exe'];
  const pages = [
    { id: 'main', name: 'Main', cols: 4, rows: 2, buttons: [btn('up', [{ action: 'system.toast', params: { message: 'vrchat up' } }], { triggers: [{ type: 'processStart', process: 'vrchat.exe' }, { type: 'processStop', process: 'vrchat.exe' }] })] },
    { id: 'vrc', name: 'VRChat', cols: 4, rows: 2, autoShowProcess: 'vrchat.exe', buttons: [] },
  ];
  const { app, engine, hub, toasts } = await boot([], { pages, helperAnswers: { 'proc.list': () => procs } });
  await waitFor(() => hub.get('proc'));
  assert.equal(engine.activePageId, 'main');
  procs = ['steam.exe', 'vrchat.exe'];
  await app.providers.get('starter').pollProc();
  await waitFor(() => toasts.length === 1);
  assert.equal(engine.activePageId, 'vrc');
  procs = ['steam.exe'];
  await app.providers.get('starter').pollProc();
  await waitFor(() => toasts.length === 2, 1000);
  await app.stop();
});

test('triggers: hotkeys are registered through the host, failures are reported', async () => {
  const seen = [];
  const { app, engine } = await boot([
    btn('a', [{ action: 'system.toast', params: { message: 'x' } }], { triggers: [{ type: 'hotkey', accelerator: 'F13' }, { type: 'hotkey', accelerator: 'Ctrl+F14' }] }),
  ], { hooks: { registerHotkeys: (list) => { seen.push(list); return list.some((h) => h.accelerator === 'Ctrl+F14') ? ['Ctrl+F14'] : []; } } });
  assert.deepEqual(seen.at(-1), [{ accelerator: 'F13', buttonId: 'a' }, { accelerator: 'Ctrl+F14', buttonId: 'a' }]);
  assert.ok(engine.log.some((t) => t.level === 'warn' && /Ctrl\+F14 could not be registered/.test(t.text)));
  await app.stop();
});

test('triggers: time-of-day triggers fire once per matching minute', async () => {
  const now = new Date();
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const { app, engine, toasts } = await boot([
    btn('t', [{ action: 'system.toast', params: { message: 'time!' } }], { triggers: [{ type: 'time', at, days: [0, 1, 2, 3, 4, 5, 6] }] }),
    btn('w', [{ action: 'system.toast', params: { message: 'wrong day' } }], { triggers: [{ type: 'time', at, days: [(now.getDay() + 1) % 7] }] }),
  ]);
  engine.checkTimeTriggers();
  engine.checkTimeTriggers();
  await waitFor(() => toasts.length >= 1);
  await sleep(50);
  assert.deepEqual(toasts.map((t) => t.text), ['time!']);
  await app.stop();
});

test('needs: providers only run for what the config uses', async () => {
  const { app, engine } = await boot([btn('a', [{ action: 'system.toast', params: { message: 'x' } }])]);
  let n = engine.computeNeeds();
  assert.deepEqual([Boolean(n.audio), Boolean(n.obs), Boolean(n.vrc), Boolean(n.process)], [false, false, false, false]);
  const cfg = JSON.parse(JSON.stringify(engine.config));
  cfg.pages[0].buttons.push({ id: 'x1', x: 5, y: 0, w: 1, h: 1, steps: [{ action: 'obs.scene', params: { scene: 'A' } }] });
  cfg.pages[0].buttons.push({ id: 'x2', x: 6, y: 0, w: 1, h: 1, steps: [{ action: 'vrc.param', params: { name: 'Hat', type: 'bool', mode: 'toggle' } }] });
  cfg.pages[0].buttons.push({ id: 'x3', x: 7, y: 0, w: 1, h: 1, steps: [], triggers: [{ type: 'processStart', process: 'x.exe' }] });
  engine.updateConfig(cfg);
  n = engine.computeNeeds();
  assert.equal(n.obs, true);
  assert.equal(n.vrc, true);
  assert.equal(n.process, true);
  assert.ok(n.vrcParams.has('Hat'));
  await app.stop();
});

test('edit lock: starts locked, auto-relocks after the timeout, refreshes on activity', async () => {
  const { app, engine } = await boot([btn('a', [])]);
  assert.equal(engine.editing, false);
  engine.patchSettings((s) => { s.lock.autoRelockSec = 1; });
  const events = [];
  engine.on('edit', (e) => events.push(e.on));
  engine.setEditing(true);
  assert.equal(engine.editing, true);
  await sleep(600);
  engine.touchEdit();
  await sleep(600);
  assert.equal(engine.editing, true, 'activity postponed the relock');
  await waitFor(() => engine.editing === false, 2000);
  assert.deepEqual(events, [true, true, false]);
  await app.stop();
});

test('config: updates are persisted, invalid active page falls back', async () => {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, helper: new FakeHelper(), port: 0 });
  booted.push(app);
  await app.start();
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  const before = cfg.pages.length;
  cfg.pages.push({ id: 'second', name: 'Second', cols: 4, rows: 2, buttons: [] });
  app.engine.updateConfig(cfg);
  app.engine.setActivePage('second');
  await app.stop();
  const again = createApp({ dataDir: dir, helper: new FakeHelper(), port: 0 });
  booted.push(again);
  await again.start();
  assert.equal(again.engine.config.pages.length, before + 1);
  assert.equal(again.engine.activePageId, 'second', 'remembers the open page');
  const trimmed = JSON.parse(JSON.stringify(again.engine.config));
  trimmed.pages = trimmed.pages.slice(0, 1);
  again.engine.updateConfig(trimmed);
  assert.equal(again.engine.activePageId, trimmed.pages[0].id);
  await again.stop();
});

test('vrchat: mic toggle pulses /input/Voice 0,1,0 over OSC and honors the reported mute state', async () => {
  const listener = new OscListener(0, '127.0.0.1');
  const got = [];
  listener.on('message', (m) => got.push(m));
  listener.start();
  const port = await waitFor(() => { try { return listener.socket.address().port; } catch { return 0; } });
  const { app, engine, hub, toasts } = await boot([
    btn('t', [{ action: 'vrc.mic', params: { mode: 'toggle' } }]),
    btn('m', [{ action: 'vrc.mic', params: { mode: 'mute' } }]),
  ], { settings: { osc: { host: '127.0.0.1', sendPort: port, listenPort: 0, listen: false } } });
  await engine.press('t');
  await waitFor(() => got.length >= 3);
  assert.deepEqual(got.map((m) => [m.address, m.args[0]]), [['/input/Voice', 0], ['/input/Voice', 1], ['/input/Voice', 0]]);
  got.length = 0;
  await engine.press('m'); // state unknown -> refuses instead of guessing
  assert.match(toasts.at(-1).text, /has not reported your mic state/);
  hub.set('vrc.MuteSelf', true);
  await engine.press('m'); // already muted -> nothing sent
  await sleep(100);
  assert.equal(got.length, 0);
  hub.set('vrc.MuteSelf', false);
  await engine.press('m');
  await waitFor(() => got.length >= 3);
  listener.stop();
  await app.stop();
});

test('vrchat: chatbox, avatar parameter toggle and avatar change send the documented messages', async () => {
  const listener = new OscListener(0, '127.0.0.1');
  const got = [];
  listener.on('message', (m) => got.push(m));
  listener.start();
  const port = await waitFor(() => { try { return listener.socket.address().port; } catch { return 0; } });
  const { app, engine, toasts } = await boot([
    btn('c', [{ action: 'vrc.chatbox', params: { text: 'x'.repeat(200), immediate: true, sound: false } }]),
    btn('p', [{ action: 'vrc.param', params: { name: 'Hat', type: 'bool', mode: 'toggle' } }]),
    btn('f', [{ action: 'vrc.param', params: { name: 'Size', type: 'float', mode: 'set', value: 0.5 } }]),
    btn('a', [{ action: 'vrc.avatar', params: { avatarId: 'avtr_123e4567-e89b-12d3-a456-426614174000' } }]),
    btn('bad', [{ action: 'vrc.avatar', params: { avatarId: 'nope' } }]),
  ], { settings: { osc: { host: '127.0.0.1', sendPort: port, listenPort: 0, listen: false } } });
  await engine.press('c');
  await engine.press('p');
  await engine.press('p');
  await engine.press('f');
  await engine.press('a');
  await engine.press('bad');
  await waitFor(() => got.length >= 5);
  assert.equal(got[0].address, '/chatbox/input');
  assert.equal(got[0].args[0].length, 144, 'chatbox text clamped to VRChat limit');
  assert.deepEqual(got[0].args.slice(1), [true, false]);
  assert.deepEqual([got[1].address, got[1].args], ['/avatar/parameters/Hat', [true]]);
  assert.deepEqual([got[2].address, got[2].args], ['/avatar/parameters/Hat', [false]], 'second press toggles back');
  assert.equal(got[3].address, '/avatar/parameters/Size');
  assert.equal(got[3].args[0], 0.5);
  assert.equal(got[4].address, '/avatar/change');
  assert.match(toasts.at(-1).text, /does not look like an avatar ID/);
  listener.stop();
  await app.stop();
});

test('vrchat: incoming OSC updates mic state; only watched parameters are published', async () => {
  const { OscSender } = require('../src/core/osc');
  const { app, engine, hub } = await boot([
    btn('m', [{ action: 'vrc.mic', params: { mode: 'toggle' } }]),
    btn('p', [{ action: 'vrc.param', params: { name: 'Hat', type: 'bool', mode: 'toggle' } }]),
  ], { settings: { osc: { host: '127.0.0.1', sendPort: 9000, listenPort: 0, listen: true } } });
  await waitFor(() => app.providers.listener && app.providers.listener.socket && (() => { try { return app.providers.listener.socket.address().port; } catch { return 0; } })());
  const port = app.providers.listener.socket.address().port;
  const tx = new OscSender();
  await tx.send('127.0.0.1', port, '/avatar/parameters/MuteSelf', [true]);
  await tx.send('127.0.0.1', port, '/avatar/parameters/Viseme', [3]);
  await tx.send('127.0.0.1', port, '/avatar/parameters/Hat', [true]);
  await waitFor(() => engine.computeButtonStates().m && engine.computeButtonStates().m.active === true);
  await waitFor(() => engine.computeButtonStates().p && engine.computeButtonStates().p.active === true);
  assert.equal(hub.get('vrc.param').Viseme, undefined, 'unwatched params are not published');
  tx.close();
  await app.stop();
});

function localServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

test('http.request: sends method, headers and body; non-2xx is an error', async () => {
  const srv = await localServer((req, res) => { res.statusCode = req.url === '/bad' ? 500 : 200; res.end('ok'); });
  const { app, engine, toasts } = await boot([
    btn('a', [{ action: 'http.request', params: { method: 'POST', url: `http://127.0.0.1:${srv.port}/hook`, headers: 'X-Key: abc\nContent-Type: text/plain', body: 'hello' } }]),
    btn('b', [{ action: 'http.request', params: { method: 'GET', url: `http://127.0.0.1:${srv.port}/bad` } }]),
  ]);
  await engine.press('a');
  assert.equal(srv.seen[0].method, 'POST');
  assert.equal(srv.seen[0].headers['x-key'], 'abc');
  assert.equal(srv.seen[0].body, 'hello');
  await engine.press('b');
  assert.match(toasts.at(-1).text, /answered 500/);
  srv.server.close();
  await app.stop();
});

test('ha.service: posts to /api/services/<domain>/<service> with the bearer token and entity', async () => {
  const srv = await localServer((req, res) => { res.statusCode = req.headers.authorization === 'Bearer good' ? 200 : 401; res.end('[]'); });
  const { app, engine, toasts } = await boot([
    btn('g', [{ action: 'ha.service', params: { baseUrl: `http://127.0.0.1:${srv.port}/`, token: 'good', domain: 'light', service: 'toggle', entityId: 'light.desk', data: '{"brightness_pct":40}' } }]),
    btn('b', [{ action: 'ha.service', params: { baseUrl: `http://127.0.0.1:${srv.port}`, token: 'bad', domain: 'light', service: 'toggle' } }]),
    btn('j', [{ action: 'ha.service', params: { baseUrl: `http://127.0.0.1:${srv.port}`, token: 'good', domain: 'light', service: 'toggle', data: '{oops' } }]),
  ]);
  await engine.press('g');
  assert.equal(srv.seen[0].url, '/api/services/light/toggle');
  assert.deepEqual(JSON.parse(srv.seen[0].body), { brightness_pct: 40, entity_id: 'light.desk' });
  await engine.press('b');
  assert.match(toasts.at(-1).text, /rejected the token/);
  await engine.press('j');
  assert.match(toasts.at(-1).text, /not valid JSON/);
  srv.server.close();
  await app.stop();
});

test('state: a button tied to ONE microphone follows that microphone\'s real mute state, even when Windows changes it', async () => {
  const devices = {
    capture: [{ id: 'micA', name: 'Mic A', isDefault: true, muted: false }, { id: 'micB', name: 'Mic B', isDefault: false, muted: true }],
    render: [{ id: 'spkA', name: 'Speakers', isDefault: true, muted: false }],
  };
  const { app, engine } = await boot([
    btn('a', [{ action: 'audio.micMute', params: { mode: 'toggle', device: 'micA' } }]),
    btn('b', [{ action: 'audio.micMute', params: { mode: 'toggle', device: 'micB' } }]),
    btn('spk', [{ action: 'audio.outputMute', params: { mode: 'toggle', device: 'spkA' } }]),
  ], { helperAnswers: { 'audio.snapshot': () => ({ capture: { id: 'micA', muted: false, volume: 100 }, render: { id: 'spkA', muted: false, volume: 50 } }), 'audio.devices': (args) => devices[args.flow] } });
  await waitFor(() => engine.computeButtonStates().b && !engine.computeButtonStates().b.unknown);
  let s = engine.computeButtonStates();
  assert.deepEqual([s.a.active, s.b.active, s.spk.active], [false, true, false], 'each button shows its own device, not the default one');

  // The mic is muted from somewhere else (Windows settings, a hardware button): the button must catch up, not keep its old answer.
  devices.capture[0].muted = true;
  devices.render[0].muted = true;
  await app.providers.get('starter').pollAudio();
  s = engine.computeButtonStates();
  assert.deepEqual([s.a.active, s.b.active, s.spk.active], [true, true, true]);
  devices.capture[1].muted = false;
  await app.providers.get('starter').pollAudio();
  assert.equal(engine.computeButtonStates().b.active, false, 'unmuting one mic changes only that mic\'s button');
  assert.equal(engine.computeButtonStates().a.active, true);
  await app.stop();
});
