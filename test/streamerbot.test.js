// The Streamer.bot plugin, run against a simulated Streamer.bot HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');
const { StreamerbotRuntime, sha256b64 } = require('../plugins/streamerbot/runtime');
const actions = require('../plugins/streamerbot/actions');
const manifest = require('../plugins/streamerbot/plugin');

const run = actions.find((a) => a.id === 'streamerbot.run');
const ID = '4af4bdef-f396-521f-a1a5-02983ae638cb';

// A simulated Streamer.bot WebSocket server (Hello first, optional password, GetActions, DoAction).
async function fakeStreamerbot({ hang = false, password = '', enforce = true } = {}) {
  const seen = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const salt = 'saltysalt', challenge = 'challenge123';
  wss.on('connection', (ws) => {
    let authed = !password || !enforce;
    const hello = { request: 'Hello', info: { name: 'Streamer.bot' }, authentication: password ? { salt, challenge } : null };
    if (!hang) ws.send(JSON.stringify(hello));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      seen.push(m);
      if (m.request === 'Authenticate') {
        const secret = sha256b64(password + salt);
        authed = m.authentication === sha256b64(secret + challenge);
        return ws.send(JSON.stringify({ id: m.id, status: authed ? 'ok' : 'error', error: authed ? undefined : 'bad' }));
      }
      if (!authed) return ws.send(JSON.stringify({ id: m.id, status: 'error', error: 'Not authenticated' }));
      if (m.request === 'GetActions') return ws.send(JSON.stringify({ id: m.id, status: 'ok', actions: [{ id: ID, name: 'Emote Only On' }, { id: 'b', name: 'clear chat', group: 'Chat' }, { id: 'c', name: 'Slow Mode 30', group: '' }] }));
      if (m.request === 'DoAction') {
        if ((m.action.name || '') === 'Nope') return ws.send(JSON.stringify({ id: m.id, status: 'error', error: 'Action not found' }));
        return ws.send(JSON.stringify({ id: m.id, status: 'ok' }));
      }
    });
  });
  return { seen, port: wss.address().port, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); } };
}

function runtimeFor(port, settings = {}, options = {}) {
  const emitted = [];
  const ctx = { settings: () => ({ host: '127.0.0.1', port, ...settings }), emitStatus: () => emitted.push(1) };
  return { rt: new StreamerbotRuntime(ctx, options), ctx, emitted };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };

test('streamerbot: lists your actions (sorted, by id) for the dropdown and the test button', async () => {
  const sb = await fakeStreamerbot();
  const { rt } = runtimeFor(sb.port);
  assert.deepEqual(await rt.actions(), [{ value: 'clear chat', label: 'clear chat', hint: 'Chat' }, { value: 'Emote Only On', label: 'Emote Only On', hint: '' }, { value: 'Slow Mode 30', label: 'Slow Mode 30', hint: '' }], 'names, not ids, are shown and stored');
  assert.deepEqual(await rt.check(), await rt.actions());
  assert.equal(sb.seen[0].request, 'GetActions');
  assert.equal(rt.status().state, 'connected');
  assert.deepEqual(await manifest.optionLists['streamerbot.actions']({ plugins: { get: () => rt } }), await rt.actions());
  sb.close();
});

test('streamerbot: two actions with the same name are told apart by id', async () => {
  const { rt } = runtimeFor(1);
  rt.request = async () => ({ actions: [{ id: 'a1', name: 'Same' }, { id: 'a2', name: 'Same' }, { id: 'a3', name: 'Solo' }] });
  assert.deepEqual(await rt.actions(), [{ value: 'a1', label: 'Same', hint: '' }, { value: 'a2', label: 'Same', hint: '' }, { value: 'Solo', label: 'Solo', hint: '' }]);
});

test('streamerbot: runs an action by its exact name or by id, with arguments', async () => {
  const sb = await fakeStreamerbot();
  const { rt } = runtimeFor(sb.port);
  const { ctx, toasts } = toastCtx(rt);
  await run.run({ action: 'Emote Only On' }, ctx);
  const last = () => { const { id, ...rest } = sb.seen.at(-1); return rest; };
  assert.deepEqual(last(), { request: 'DoAction', action: { name: 'Emote Only On' } }, 'no arguments: none are sent');
  await run.run({ action: ID, args: 'user=Nova\n\n# a note\n seconds = 30 ' }, ctx);
  assert.deepEqual(last(), { request: 'DoAction', action: { id: ID }, args: { user: 'Nova', seconds: '30' } }, 'a GUID goes as an id; arguments are read one per line');
  assert.equal(toasts.at(-1)[0], `Ran Streamer.bot action: ${ID}`);
  await assert.rejects(run.run({ action: '  ' }, ctx), /Pick a Streamer.bot action/);
  await assert.rejects(run.run({ action: 'x', args: 'no equals sign' }, ctx), /name=value/);
  assert.equal(sb.seen.filter((s) => s.request === 'DoAction').length, 2, 'the two invalid ones never reached Streamer.bot');
  sb.close();
});

test('streamerbot: explains a closed or wrong address, an unknown action and a stalled server in plain words', async () => {
  const sb = await fakeStreamerbot();
  const { rt, emitted } = runtimeFor(sb.port);
  await assert.rejects(rt.run('Nope'), /Streamer.bot said no \(Action not found\).*name exactly right/);
  assert.equal(rt.status().state, 'error');
  await rt.run('Emote Only On');
  assert.deepEqual(rt.status(), { state: 'connected', error: '' }, 'a success clears the error');
  assert.ok(emitted.length >= 2, 'the Settings dot is told about every change');
  sb.close();

  const dead = runtimeFor(sb.port);
  await assert.rejects(dead.rt.actions(), /Can't reach Streamer.bot at 127.0.0.1:\d+.*WebSocket Server started/);
  assert.equal(dead.rt.status().state, 'error');

  const slow = await fakeStreamerbot({ hang: true });
  const stalled = runtimeFor(slow.port, {}, { timeoutMs: 150 });
  await assert.rejects(stalled.rt.run('x'), /did not answer in time/);
  slow.close();
});

test('streamerbot: signs in with the WebSocket server password, and explains a missing or wrong one', async () => {
  const sb = await fakeStreamerbot({ password: 'hunter2' });
  assert.equal((await runtimeFor(sb.port, { password: 'hunter2' }).rt.actions()).length, 3);
  await assert.rejects(runtimeFor(sb.port).rt.actions(), /wants its WebSocket Server password.*Settings/);
  await assert.rejects(runtimeFor(sb.port, { password: 'wrong' }).rt.actions(), /did not accept the password/);
  sb.close();
});

test('streamerbot: a password that Streamer.bot does not enforce is not needed', async () => {
  const sb = await fakeStreamerbot({ password: 'hunter2', enforce: false });
  assert.equal((await runtimeFor(sb.port).rt.actions()).length, 3);
  await runtimeFor(sb.port).rt.run('Emote Only On');
  assert.ok(!sb.seen.some((m) => m.request === 'Authenticate'), 'no sign-in was attempted');
  sb.close();
});

test('streamerbot: the address and port from Settings are used, and only a host name or address is accepted', async () => {
  const sb = await fakeStreamerbot();
  const localhost = runtimeFor(sb.port, { host: 'localhost' });
  await localhost.rt.run('ok');
  assert.equal(sb.seen.length, 1);
  for (const bad of ['evil.example/path?x=', 'http://x', 'a b', 'x@y', 'x:1']) {
    await assert.rejects(runtimeFor(sb.port, { host: bad }).rt.run('x'), /not a valid host name/, bad);
  }
  await assert.rejects(runtimeFor(70000).rt.run('x'), /between 1 and 65535/);
  assert.equal(sb.seen.length, 1, 'nothing went anywhere else');
  sb.close();
});

test('streamerbot: loads like any other plugin, and needs nothing outside its own folder', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /streamerbot/.test(e.dir)), []);
  const m = app.registry.get('streamerbot');
  assert.ok(m && m.actions.some((a) => a.id === 'streamerbot.run'));
  assert.equal(m.testOptionKind, 'streamerbot.test');
  assert.match(m.instructions(), /WebSocket Server/);
  await app.stop();
  const dir = path.join(__dirname, '..', 'plugins', 'streamerbot');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder`);
  }
});
