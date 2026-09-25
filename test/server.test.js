const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createApp } = require('../src/core');
const { tempDir, FakeHelper, waitFor } = require('./helpers');

const booted = [];
test.after(async () => {
  for (const app of booted) {
    try { await app.stop(); } catch { /* already stopped */ }
  }
});

async function boot(opts = {}) {
  const dir = tempDir();
  const helper = new FakeHelper(opts.helperAnswers);
  const app = createApp({ dataDir: dir, helper, mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, hooks: opts.hooks, twitchOptions: { defaultClientId: '' } });
  booted.push(app);
  const { port } = await app.start();
  return { app, dir, port, token: app.token };
}

function httpGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Resolves with the socket once open, or rejects with the HTTP status of a refused upgrade.
function openWs(port, { token, origin, host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token === undefined ? '' : `?token=${token}`}`, { headers });
    const client = { ws, messages: [], nextRid: 1, waiters: new Map() };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      client.messages.push(msg);
      if (msg.t === 'res' && client.waiters.has(msg.rid)) {
        client.waiters.get(msg.rid)(msg);
        client.waiters.delete(msg.rid);
      }
    });
    ws.on('open', () => resolve(client));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused:${res.statusCode}`)));
    ws.on('error', (err) => { if (!/refused/.test(err.message)) reject(err); });
  });
}

const request = (client, t, payload = {}) => new Promise((resolve) => {
  const rid = client.nextRid++;
  client.waiters.set(rid, resolve);
  client.ws.send(JSON.stringify({ t, rid, ...payload }));
});

const next = (client, type) => waitFor(() => client.messages.find((m) => m.t === type));

test('http: health, the UI shell, shared scripts and hardening headers', async () => {
  const { port } = await boot();
  assert.equal((await httpGet(port, '/api/health')).body, 'ok');
  const index = await httpGet(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.headers['content-security-policy'], /default-src 'self'/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const grid = await httpGet(port, '/shared/grid.js');
  assert.equal(grid.status, 200);
  assert.match(grid.body, /findFreeSpot/);
});

test('http: path traversal and non-GET are refused', async () => {
  const { port } = await boot();
  for (const p of ['/../package.json', '/..%2f..%2fpackage.json', '/shared/../../package.json', '/%2e%2e/package.json', '/shared/..%5c..%5cpackage.json']) {
    const res = await httpGet(port, p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
    assert.doesNotMatch(res.body, /vr-macro-pad/, `${p} leaked package.json`);
  }
  const post = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => resolve(res.statusCode));
    req.end();
  });
  assert.equal(post, 405);
});

test('http: a wrong Host header (DNS rebinding) is refused', async () => {
  const { port } = await boot();
  assert.equal((await httpGet(port, '/', { Host: 'evil.example.com' })).status, 403);
  assert.equal((await httpGet(port, '/', { Host: `evil.example.com:${port}` })).status, 403);
  assert.equal((await httpGet(port, '/', { Host: `localhost:${port}` })).status, 200);
});

test('ws: needs the token, our own Origin and our own Host', async () => {
  const { port, token } = await boot();
  await assert.rejects(openWs(port), /refused:403/);
  await assert.rejects(openWs(port, { token: 'nope' }), /refused:403/);
  await assert.rejects(openWs(port, { token: token.slice(0, -1) }), /refused:403/);
  await assert.rejects(openWs(port, { token, origin: 'https://evil.example.com' }), /refused:403/);
  await assert.rejects(openWs(port, { token, origin: 'http://127.0.0.1:1' }), /refused:403/);
  await assert.rejects(openWs(port, { token, host: 'evil.example.com' }), /refused:403/);
  const ok1 = await openWs(port, { token });
  const ok2 = await openWs(port, { token, origin: `http://127.0.0.1:${port}` });
  const ok3 = await openWs(port, { token, origin: `http://localhost:${port}` });
  for (const c of [ok1, ok2, ok3]) c.ws.close();
});

test('ws: the first message is a full snapshot including the action catalog', async () => {
  const { port, token } = await boot();
  const c = await openWs(port, { token });
  const init = await next(c, 'init');
  assert.equal(init.edit.on, false, 'always starts locked');
  assert.ok(init.config.pages.length >= 1);
  assert.ok(init.catalog.actions.length >= 25);
  const ids = init.catalog.actions.map((a) => a.id);
  for (const want of ['audio.micMute', 'keys.press', 'obs.scene', 'vrc.mic', 'system.shortcut', 'ha.service']) assert.ok(ids.includes(want), want);
  assert.ok(init.catalog.actions.every((a) => typeof a.label === 'string' && Array.isArray(a.params)));
  assert.equal(typeof init.catalog.actions[0].run, 'undefined', 'server code never reaches the browser');
  assert.ok(init.catalog.stateKeys.length > 5);
  c.ws.close();
});

test('lock: while locked, nothing that edits or tests can run; pressing still works', async () => {
  const { port, token } = await boot();
  const c = await openWs(port, { token });
  const init = await next(c, 'init');
  const cfg = JSON.parse(JSON.stringify(init.config));
  cfg.pages[0].name = 'HACKED';
  for (const [t, payload] of [['config.set', { config: cfg }], ['config.import', { config: cfg }], ['test', { steps: [{ action: 'system.toast', params: { message: 'x' } }] }], ['backups.restore', { name: 'config-x.json' }]]) {
    const res = await request(c, t, payload);
    assert.equal(res.ok, false, t);
    assert.match(res.error, /locked/i, t);
  }
  const btn = init.config.pages[0].buttons.find((b) => b.steps[0].action === 'system.toast');
  assert.equal((await request(c, 'press', { id: btn.id })).ok, true);
  const toast = await next(c, 'toast');
  assert.match(toast.entry.text, /Hello from VR Macro Pad/);
  c.ws.close();
});

test('lock: unlock, edit, persist, broadcast to other clients, relock', async () => {
  const { port, token, dir, app } = await boot();
  const a = await openWs(port, { token });
  const b = await openWs(port, { token });
  const init = await next(a, 'init');
  assert.equal((await request(a, 'edit.set', { on: true })).ok, true);
  await waitFor(() => b.messages.some((m) => m.t === 'edit' && m.edit.on));
  const cfg = JSON.parse(JSON.stringify(init.config));
  cfg.pages[0].name = 'Renamed';
  const res = await request(a, 'config.set', { config: cfg });
  assert.equal(res.ok, true);
  const pushed = await waitFor(() => b.messages.find((m) => m.t === 'config'));
  assert.equal(pushed.config.pages[0].name, 'Renamed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).pages[0].name, 'Renamed');
  assert.equal((await request(a, 'test', { steps: [{ action: 'system.toast', params: { message: 'tested' } }] })).ok, true);
  assert.equal((await request(a, 'edit.set', { on: false })).ok, true);
  assert.equal((await request(a, 'config.set', { config: cfg })).ok, false);
  assert.equal(app.engine.editing, false);
  a.ws.close();
  b.ws.close();
});

test('lock: a config sent by the UI is validated, not trusted', async () => {
  const { port, token } = await boot();
  const c = await openWs(port, { token });
  await next(c, 'init');
  await request(c, 'edit.set', { on: true });
  const res = await request(c, 'config.set', { config: { pages: [{ cols: 999, buttons: [{ id: 'x', x: 5000, w: 999, color: '<script>' }] }], settings: { theme: 'evil' } } });
  assert.equal(res.ok, true);
  const pushed = await waitFor(() => c.messages.filter((m) => m.t === 'config').at(-1));
  assert.equal(pushed.config.pages[0].cols, 100);
  assert.equal(pushed.config.pages[0].buttons[0].color, '#3b4a63');
  assert.equal(pushed.config.settings.theme, 'dark');
  c.ws.close();
});

test('lock: "hotkey only" unlock refuses UI unlock requests', async () => {
  const { port, token, app } = await boot();
  app.engine.patchSettings((s) => { s.lock.unlockMethod = 'hotkey'; });
  const c = await openWs(port, { token });
  await next(c, 'init');
  const res = await request(c, 'edit.set', { on: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /hotkey only/);
  assert.equal(app.engine.editing, false);
  app.engine.setEditing(true); // what the tray/hotkey does
  await waitFor(() => c.messages.some((m) => m.t === 'edit' && m.edit.on));
  c.ws.close();
});

test('api: options, export without secrets, page switching, bad messages', async () => {
  const { port, token, app } = await boot({
    helperAnswers: { 'audio.devices': () => [{ id: 'a', name: 'Headset', isDefault: true }, { id: 'b', name: 'Speakers', isDefault: false }] },
  });
  const c = await openWs(port, { token });
  await next(c, 'init');
  const opts = await request(c, 'options', { kind: 'audio.render' });
  assert.deepEqual(opts.result, [{ value: 'a', label: 'Headset (default)' }, { value: 'b', label: 'Speakers' }]);
  assert.equal((await request(c, 'options', { kind: 'nonsense' })).ok, false);
  assert.equal((await request(c, 'bogus.message')).ok, false);
  c.ws.send('this is not json');
  c.ws.send(JSON.stringify({ t: null }));
  assert.equal((await request(c, 'status.get')).ok, true, 'server survives garbage');

  app.engine.patchSettings((s) => { s.plugins.obs.password = 'topsecret'; });
  const exported = await request(c, 'config.export');
  assert.equal(exported.result.settings.plugins.obs.password, '');

  await request(c, 'edit.set', { on: true });
  const cfg = JSON.parse(JSON.stringify(app.engine.config));
  cfg.pages.push({ id: 'p2', name: 'Two', cols: 4, rows: 2, buttons: [] });
  await request(c, 'config.set', { config: cfg });
  assert.equal((await request(c, 'page.set', { id: 'p2' })).ok, true);
  const page = await waitFor(() => c.messages.find((m) => m.t === 'page'));
  assert.equal(page.id, 'p2');
  c.ws.close();
});

test('api: button state changes are pushed to clients', async () => {
  const snap = { capture: { id: 'mic', muted: false, volume: 100 }, render: null };
  const { port, token } = await boot({ helperAnswers: { 'audio.snapshot': () => snap } });
  const c = await openWs(port, { token });
  const init = await next(c, 'init');
  const mic = init.config.pages[0].buttons.find((b) => b.steps[0].action === 'audio.micMute');
  // The first poll usually lands before the client connects, so it arrives inside the snapshot.
  await waitFor(() => (init.buttonStates[mic.id] && init.buttonStates[mic.id].unknown === false)
    || c.messages.some((m) => m.t === 'buttonStates' && m.states[mic.id] && m.states[mic.id].unknown === false));
  assert.equal(init.buttonStates[mic.id] ? init.buttonStates[mic.id].active : false, false);
  snap.capture.muted = true;
  await waitFor(() => c.messages.some((m) => m.t === 'buttonStates' && m.states[mic.id] && m.states[mic.id].active === true), 4000);
  c.ws.close();
});

test('widgets: data arrives with the snapshot, taps work while locked, and results are pushed', async () => {
  const { port, token } = await boot();
  const c = await openWs(port, { token });
  const init = await next(c, 'init');
  assert.ok(init.catalog.widgets.length >= 9);
  for (const id of ['clock', 'timer', 'stopwatch', 'coin', 'dice', 'battery', 'media', 'twitch.ads', 'twitch.stream']) assert.ok(init.catalog.widgets.some((w) => w.id === id), id);
  assert.ok(init.catalog.actions.some((a) => a.id === 'twitch.chat') && init.catalog.actions.some((a) => a.id === 'media.control'));
  const coin = init.config.pages.flatMap((p) => p.buttons).find((b) => b.widget && b.widget.type === 'coin');
  assert.ok(coin, 'the starter Tools page has a coin');
  assert.equal(init.widgetData[coin.id].last, null);
  assert.equal(init.edit.on, false);
  const res = await request(c, 'widget', { id: coin.id, cmd: 'tap' });
  assert.equal(res.ok, true);
  const pushed = await waitFor(() => c.messages.find((m) => m.t === 'widgetData' && m.data[coin.id] && m.data[coin.id].last));
  assert.ok(['Heads', 'Tails'].includes(pushed.data[coin.id].last.text));
  assert.equal((await request(c, 'widget', { id: 'nope', cmd: 'tap' })).ok, false);
  assert.equal((await request(c, 'media.thumb', { key: 'unknown' })).result, '');
  c.ws.close();
});

test('window, links and Twitch sign-in: guarded messages', async () => {
  const seen = { windowCmds: [], opened: [] };
  const { port, token, app } = await boot({ hooks: { windowControl: (cmd) => seen.windowCmds.push(cmd), openExternal: (u) => { seen.opened.push(u); return true; } } });
  const c = await openWs(port, { token });
  await next(c, 'init');
  for (const cmd of ['minimize', 'maximize', 'close']) assert.equal((await request(c, 'window.control', { cmd })).ok, true);
  assert.deepEqual(seen.windowCmds, ['minimize', 'maximize', 'close']);
  assert.equal((await request(c, 'window.control', { cmd: 'format-c' })).ok, false);

  // only Twitch's own https pages can be opened
  for (const url of ['https://evil.example.com/activate', 'http://www.twitch.tv/activate', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'https://www.twitch.tv.evil.com/', 'not a url']) {
    assert.equal((await request(c, 'open.external', { url })).ok, false, url);
  }
  assert.equal((await request(c, 'open.external', { url: 'https://www.twitch.tv/activate?public=true&device-code=ABCD' })).ok, true);
  assert.deepEqual(seen.opened, ['https://www.twitch.tv/activate?public=true&device-code=ABCD']);

  // linking or unlinking an account needs the edit lock open
  for (const method of ['connect', 'disconnect', 'check']) {
    const r = await request(c, 'plugin.call', { plugin: 'twitch', method });
    assert.equal(r.ok, false, method);
    assert.match(r.error, /locked/i, method);
  }
  await request(c, 'edit.set', { on: true });
  const noId = await request(c, 'plugin.call', { plugin: 'twitch', method: 'connect' });
  assert.equal(noId.ok, false);
  assert.match(noId.error, /Client ID/);
  assert.equal(app.twitch.status, 'off');
  c.ws.close();
});

test('buttons-only view: switching is allowed while locked, is saved, tells the window to rebuild, and resizing is validated', async () => {
  const boundsCalls = [];
  const { app, port, token } = await boot({ hooks: { setWindowBounds: (b) => boundsCalls.push(b) } });
  const client = await openWs(port, { token });
  await next(client, 'init');
  assert.equal(app.engine.editing, false, 'editing is locked');
  assert.equal(app.engine.config.settings.window.cleanView, false);
  assert.equal(app.engine.config.settings.window.cleanViewHotkey, 'Ctrl+Alt+Shift+V');

  let configEvents = 0;
  app.engine.on('config', () => { configEvents++; });
  assert.equal((await request(client, 'view.clean', { on: true })).ok, true);
  assert.equal(app.engine.config.settings.window.cleanView, true);
  assert.equal(configEvents, 1, 'the desktop shell hears about it and rebuilds the window');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.store.dir, 'config.json'), 'utf8')).settings.window.cleanView, true, 'remembered for the next launch');
  assert.equal((await request(client, 'view.clean', { on: false })).ok, true);
  assert.equal(app.engine.config.settings.window.cleanView, false);

  assert.equal((await request(client, 'window.bounds', { x: 10, y: 20, width: 500.4, height: 300 })).ok, true);
  assert.deepEqual(boundsCalls, [{ x: 10, y: 20, width: 500, height: 300 }]);
  for (const bad of [{ x: 'a', y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: null }, {}]) {
    assert.equal((await request(client, 'window.bounds', bad)).ok, false);
  }
  assert.equal(boundsCalls.length, 1);
  client.ws.close();
});

test('about: the snapshot carries the version, author and links, and only the app\'s own links can be opened', async () => {
  const opened = [];
  const { port, token } = await boot({ hooks: { openExternal: (u) => { opened.push(u); return true; } } });
  const c = await openWs(port, { token });
  const init = await next(c, 'init');
  assert.equal(init.app.version, require('../package.json').version);
  assert.equal(init.app.version, require('../package.json').version);
  assert.equal(init.app.about.author, 'Jayconius');
  assert.equal(init.app.about.website, 'https://jayconius.com');
  assert.equal(init.app.about.github, 'https://github.com/Jayconius/VRMacroPad');

  assert.equal((await request(c, 'open.external', { url: 'https://jayconius.com' })).ok, true);
  assert.equal((await request(c, 'open.external', { url: 'https://jayconius.com/' })).ok, true);
  assert.equal((await request(c, 'open.external', { url: 'https://github.com/Jayconius/VRMacroPad' })).ok, true);
  assert.equal((await request(c, 'open.external', { url: 'https://github.com/Jayconius/VRMacroPad/releases/latest' })).ok, true);
  for (const bad of ['http://jayconius.com', 'https://jayconius.com.evil.example/', 'https://evil.example/jayconius.com', 'https://github.com/someone-else/repo', 'https://github.com/Jayconius/SomethingElse', 'https://sub.jayconius.com/']) {
    assert.equal((await request(c, 'open.external', { url: bad })).ok, false, bad);
  }
  assert.deepEqual(opened, ['https://jayconius.com/', 'https://jayconius.com/', 'https://github.com/Jayconius/VRMacroPad', 'https://github.com/Jayconius/VRMacroPad/releases/latest']);
  c.ws.close();
});

test('options: a list that depends on other fields is asked with their values (a few short strings, nothing else)', async () => {
  const { app, port } = await boot();
  app.registry.get('obs').optionLists['t.args'] = (ctx, args) => [{ value: JSON.stringify(args), label: 'args' }];
  const client = await openWs(port, { token: app.token });
  const plain = await request(client, 'options', { kind: 't.args' });
  assert.deepEqual(JSON.parse(plain.result[0].value), {}, 'no fields: an empty object');
  const sent = await request(client, 'options', { kind: 't.args', args: { board: 'Anime', n: 5, sneaky: { a: 1 }, list: [1], long: 'x'.repeat(500) } });
  const got = JSON.parse(sent.result[0].value);
  assert.equal(got.board, 'Anime');
  assert.equal(got.n, '5');
  assert.ok(!('sneaky' in got) && !('list' in got), 'objects and lists are dropped');
  assert.equal(got.long.length, 200, 'long values are cut');
  const bad = await request(client, 'options', { kind: 't.args', args: 'not an object' });
  assert.deepEqual(JSON.parse(bad.result[0].value), {});
  client.ws.close();
});
