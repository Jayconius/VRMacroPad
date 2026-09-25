// The Mix It Up plugin, run against a simulated Mix It Up Developer API (http://localhost:8911/api/v2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');
const { MixItUpRuntime } = require('../plugins/mixitup/runtime');
const actions = require('../plugins/mixitup/actions');
const manifest = require('../plugins/mixitup/plugin');

const act = (id) => actions.find((a) => a.id === id);
const ID_HELLO = '11111111-2222-3333-4444-555555555555';
const ID_SCENE = '66666666-7777-8888-9999-000000000000';

// A stand-in for Mix It Up. Records every request; answers the way its documentation says it does.
async function fakeMixItUp({ commands, hang = false, status = null } = {}) {
  const list = commands || [
    { ID: ID_SCENE, Name: 'Brb scene', Type: 'Action Group', IsEnabled: true, Unlocked: true, GroupName: 'Scenes' },
    { ID: ID_HELLO, Name: '!hello', Type: 'Chat', IsEnabled: true, Unlocked: true, GroupName: '' },
    { ID: 'aaaaaaaa-0000-0000-0000-000000000001', Name: 'Old thing', Type: 'Event', IsEnabled: false, Unlocked: true, GroupName: 'Misc' },
  ];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : undefined });
      if (hang) return; // never answers
      const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
      if (status) return json(status, { status, title: 'Nope', detail: 'The server said so' });
      if (req.method === 'GET' && url.pathname === '/api/v2/commands') {
        const skip = Number(url.searchParams.get('skip') || 0);
        const size = Number(url.searchParams.get('pageSize') || 25);
        return json(200, { TotalCount: list.length, Commands: list.slice(skip, skip + size) });
      }
      const m = /^\/api\/v2\/commands\/([^/]+)(\/state\/(\d))?$/.exec(url.pathname);
      if (m && (req.method === 'POST' || req.method === 'PATCH')) {
        if (!list.some((c) => c.ID === m[1])) return json(404, { status: 404, title: 'Not Found', detail: 'Command not found' });
        return res.writeHead(200).end();
      }
      if (req.method === 'POST' && (url.pathname === '/api/v2/chat/message' || url.pathname === '/api/v2/chat/clear')) return res.writeHead(200).end();
      json(404, { status: 404, title: 'Not Found', detail: 'no such endpoint' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

function runtimeFor(port, settings = {}, options = {}) {
  const emitted = [];
  const ctx = { settings: () => ({ host: '127.0.0.1', port, ...settings }), emitStatus: () => emitted.push(1) };
  return { rt: new MixItUpRuntime(ctx, options), emitted };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };

test('mixitup: lists your commands (sorted by name, with type and group beside them; names, not ids) for the dropdown and the test button', async () => {
  const mi = await fakeMixItUp();
  const { rt } = runtimeFor(mi.port);
  assert.deepEqual(await rt.commands(), [
    { value: '!hello', label: '!hello', hint: 'Chat' },
    { value: 'Brb scene', label: 'Brb scene', hint: 'Action Group · Scenes' },
    { value: 'Old thing', label: 'Old thing', hint: 'Event · Misc · disabled' },
  ]);
  assert.deepEqual(await rt.check(), await rt.commands());
  assert.equal(rt.status().state, 'connected');
  assert.deepEqual(await manifest.optionLists['mixitup.commands']({ plugins: { get: () => rt } }), await rt.commands());
  mi.close();
});

test('mixitup: two commands with the same name are told apart by id in the list', async () => {
  const mi = await fakeMixItUp({ commands: [
    { ID: 'a0000000-0000-0000-0000-000000000001', Name: 'Same', Type: 'Chat' },
    { ID: 'a0000000-0000-0000-0000-000000000002', Name: 'same', Type: 'Event' },
    { ID: 'a0000000-0000-0000-0000-000000000003', Name: 'Solo', Type: 'Chat' },
  ] });
  const list = await runtimeFor(mi.port).rt.commands();
  assert.deepEqual(list.map((c) => c.value), ['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'Solo']);
  mi.close();
});

test('mixitup: a long list is read page by page', async () => {
  const many = Array.from({ length: 1234 }, (_, i) => ({ ID: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, Name: `cmd ${i}`, Type: 'Chat', IsEnabled: true }));
  const mi = await fakeMixItUp({ commands: many });
  const { rt } = runtimeFor(mi.port);
  assert.equal((await rt.commands()).length, 1234);
  assert.deepEqual(mi.seen.map((s) => s.query.skip), ['0', '500', '1000']);
  assert.ok(mi.seen.every((s) => s.query.pageSize === '500'));
  mi.close();
});

test('mixitup: runs a command by id or by its name (any capitals), with arguments and special identifiers', async () => {
  const mi = await fakeMixItUp();
  const { rt } = runtimeFor(mi.port);
  const { ctx, toasts } = toastCtx(rt);
  const lastPost = () => mi.seen.filter((s) => s.method === 'POST').at(-1);

  await act('mixitup.run').run({ command: ID_HELLO }, ctx);
  assert.deepEqual(lastPost(), { method: 'POST', path: `/api/v2/commands/${ID_HELLO}`, query: {}, body: { IgnoreRequirements: true } }, 'an id goes straight through; requirements are skipped by default');
  assert.equal(mi.seen.filter((s) => s.method === 'GET').length, 0, 'no list was needed for an id');

  await act('mixitup.run').run({ command: 'BRB SCENE', platform: 'Twitch', arguments: 'Nova 30', special: 'user=Nova\n# a note\n amount = 30 ', ignoreRequirements: false }, ctx);
  assert.deepEqual(lastPost().body, { IgnoreRequirements: false, Platform: 'Twitch', Arguments: 'Nova 30', SpecialIdentifiers: { user: 'Nova', amount: '30' } });
  assert.equal(lastPost().path, `/api/v2/commands/${ID_SCENE}`, 'the name was looked up');
  assert.equal(toasts.at(-1)[0], 'Ran Mix It Up command: BRB SCENE');
  mi.close();
});

test('mixitup: says plainly when a command is missing, ambiguous, or the line is badly written', async () => {
  const mi = await fakeMixItUp({ commands: [
    { ID: 'a0000000-0000-0000-0000-000000000001', Name: 'Same', Type: 'Chat' },
    { ID: 'a0000000-0000-0000-0000-000000000002', Name: 'same', Type: 'Event' },
    { ID: 'a0000000-0000-0000-0000-000000000003', Name: 'Solo', Type: 'Chat' },
  ] });
  const { rt } = runtimeFor(mi.port);
  const { ctx } = toastCtx(rt);
  await assert.rejects(act('mixitup.run').run({ command: 'same' }, ctx), /More than one Mix It Up command is called "same"/);
  await assert.rejects(act('mixitup.run').run({ command: 'Nothing' }, ctx), /no command called "Nothing"/);
  await assert.rejects(act('mixitup.run').run({ command: '  ' }, ctx), /Pick a Mix It Up command/);
  await assert.rejects(act('mixitup.run').run({ command: 'Solo', special: 'no equals' }, ctx), /name=value/);
  assert.equal(mi.seen.filter((s) => s.method === 'POST').length, 0, 'none of those reached Mix It Up as a run');
  await assert.rejects(rt.run('a0000000-0000-0000-0000-0000000000ff'), /could not find that \(Command not found\).*renamed or deleted/, 'a stale id gets its 404 explained');
  mi.close();
});

test('mixitup: turns a command on, off, or toggles it', async () => {
  const mi = await fakeMixItUp();
  const { rt } = runtimeFor(mi.port);
  const { ctx, toasts } = toastCtx(rt);
  const lastPatch = () => mi.seen.filter((s) => s.method === 'PATCH').at(-1);
  await act('mixitup.state').run({ command: ID_HELLO, mode: 'disable' }, ctx);
  assert.equal(lastPatch().path, `/api/v2/commands/${ID_HELLO}/state/0`);
  await act('mixitup.state').run({ command: '!hello', mode: 'enable' }, ctx);
  assert.equal(lastPatch().path, `/api/v2/commands/${ID_HELLO}/state/1`);
  await act('mixitup.state').run({ command: ID_HELLO }, ctx);
  assert.equal(lastPatch().path, `/api/v2/commands/${ID_HELLO}/state/2`, 'toggle is the default');
  assert.match(toasts.at(-1)[0], /switched/);
  await assert.rejects(rt.setState(ID_HELLO, 'explode'), /Unknown command state/);
  mi.close();
});

test('mixitup: sends a chat message and clears chat', async () => {
  const mi = await fakeMixItUp();
  const { rt } = runtimeFor(mi.port);
  const { ctx } = toastCtx(rt);
  await act('mixitup.chat').run({ message: '  Thanks for watching!  ', platform: 'YouTube', asStreamer: true }, ctx);
  assert.deepEqual(mi.seen.at(-1), { method: 'POST', path: '/api/v2/chat/message', query: {}, body: { Message: 'Thanks for watching!', SendAsStreamer: true, Platform: 'YouTube' } });
  await act('mixitup.chat').run({ message: 'hi' }, ctx);
  assert.deepEqual(mi.seen.at(-1).body, { Message: 'hi', SendAsStreamer: false }, 'no platform: none is sent');
  await assert.rejects(act('mixitup.chat').run({ message: '   ' }, ctx), /Type the chat message/);
  await act('mixitup.clearChat').run({}, ctx);
  assert.deepEqual(mi.seen.at(-1), { method: 'POST', path: '/api/v2/chat/clear', query: {}, body: undefined });
  mi.close();
});

test('mixitup: explains a closed Mix It Up, an error answer and a stalled server in plain words', async () => {
  const mi = await fakeMixItUp();
  const { rt, emitted } = runtimeFor(mi.port);
  await rt.commands();
  assert.deepEqual(rt.status(), { state: 'connected', error: '' });
  mi.close();
  await assert.rejects(rt.commands(), /Can't reach Mix It Up at 127.0.0.1:\d+.*Developer API connected/);
  assert.equal(rt.status().state, 'error');
  assert.ok(emitted.length >= 2, 'the Settings dot is told about every change');

  const bad = await fakeMixItUp({ status: 500 });
  await assert.rejects(runtimeFor(bad.port).rt.chat('x'), /Mix It Up said no \(500: The server said so\)/);
  bad.close();

  const slow = await fakeMixItUp({ hang: true });
  await assert.rejects(runtimeFor(slow.port, {}, { timeoutMs: 150 }).rt.clearChat(), /did not answer in time/);
  slow.close();
});

test('mixitup: the address and port from Settings are used, and only a host name or address is accepted', async () => {
  const mi = await fakeMixItUp();
  await runtimeFor(mi.port, { host: 'localhost' }).rt.clearChat();
  assert.equal(mi.seen.length, 1);
  for (const bad of ['evil.example/path?x=', 'http://x', 'a b', 'x@y', 'x:1']) {
    await assert.rejects(runtimeFor(mi.port, { host: bad }).rt.clearChat(), /not a valid host name/, bad);
  }
  await assert.rejects(runtimeFor(70000).rt.clearChat(), /between 1 and 65535/);
  assert.equal(mi.seen.length, 1, 'nothing went anywhere else');
  mi.close();
});

test('mixitup: the default port is 8911 on this PC', () => {
  const ports = manifest.settingsFields.reduce((o, f) => ({ ...o, [f.key]: f.default }), {});
  assert.deepEqual(ports, { host: '127.0.0.1', port: 8911 });
  assert.equal(new MixItUpRuntime({ settings: () => ({}), emitStatus() {} }).base().label, '127.0.0.1:8911');
});

test('mixitup: loads like any other plugin, has its Instructions dialog, and needs nothing outside its own folder', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /mixitup/.test(e.dir)), []);
  const m = app.registry.get('mixitup');
  assert.ok(m);
  assert.deepEqual(m.actions.map((a) => a.id).sort(), ['mixitup.chat', 'mixitup.clearChat', 'mixitup.run', 'mixitup.state']);
  assert.equal(m.testOptionKind, 'mixitup.test');
  assert.match(m.instructions(), /Developer API/);
  assert.equal(m.guide.steps.length, 4);
  await app.stop();
  const dir = path.join(__dirname, '..', 'plugins', 'mixitup');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder`);
  }
});
