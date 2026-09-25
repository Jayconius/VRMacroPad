// The TeamSpeak 3 plugin, run against a simulated ClientQuery server (the plain-text interface on 127.0.0.1:25639).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createApp } = require('../src/core');
const { StateHub } = require('../src/core/state');
const { FakeHelper, tempDir, waitFor, sleep } = require('./helpers');
const { Ts3Client, escape, unescape, parseRecords } = require('../plugins/teamspeak3/client');
const { Ts3Runtime } = require('../plugins/teamspeak3/runtime');
const actions = require('../plugins/teamspeak3/actions');
const manifest = require('../plugins/teamspeak3/plugin');

const act = (id) => actions.find((a) => a.id === id);
const KEY = 'ABCD-1234-EFGH-5678-IJKL-9012';
const EOL = '\n\r'; // TeamSpeak ends its lines with \n\r

// A stand-in for the ClientQuery plugin: greeting, auth, use, whoami, clientvariable, clientupdate, notifications.
async function fakeTeamSpeak({ key = KEY, connected = true, hang = false, nickname = 'Nova B', port = 0 } = {}) {
  const seen = [];
  const sockets = new Set();
  const flags = { client_input_muted: 0, client_output_muted: 0, client_away: 0 };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding('utf8');
    const send = (s) => sock.write(s + EOL);
    let authed = !key;
    send('TS3 Client');
    send('Welcome to the TeamSpeak 3 ClientQuery interface, type "help" for a list of commands and "help <command>" for information on a specific command.');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line) continue;
        seen.push(line);
        if (hang) continue;
        const ok = () => send('error id=0 msg=ok');
        const [cmd, ...rest] = line.split(' ');
        const args = Object.fromEntries(rest.map((p) => { const j = p.indexOf('='); return j < 0 ? [p, ''] : [p.slice(0, j), p.slice(j + 1)]; }));
        if (cmd === 'auth') { if (args.apikey === key) { authed = true; return ok(); } return send('error id=2568 msg=insufficient\\sclient\\spermissions'); }
        if (!authed) return send('error id=2568 msg=insufficient\\sclient\\spermissions');
        if (cmd === 'clientnotifyregister') return ok();
        if (cmd === 'use') { send('selected schandlerid=' + (args.schandlerid || '1')); return ok(); }
        if (!connected) return send('error id=1794 msg=not\\sconnected');
        if (cmd === 'whoami') { send('clid=5 cid=1 schandlerid=1'); return ok(); }
        if (cmd === 'clientvariable') {
          const fields = rest.filter((p) => !p.startsWith('clid='));
          const out = [`clid=${args.clid}`, ...fields.map((f) => `${f}=${f === 'client_nickname' ? escape(nickname) : flags[f]}`)];
          send(out.join(' '));
          return ok();
        }
        if (cmd === 'clientupdate') {
          for (const [k, v] of Object.entries(args)) if (k in flags) flags[k] = Number(v);
          ok();
          send(`notifyclientupdated schandlerid=1 clid=5 ${rest.filter((p) => p.split('=')[0] in flags).join(' ')}`); // TeamSpeak reports its own change back
          return;
        }
        send('error id=256 msg=command\\snot\\sfound');
      }
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    seen, flags, port: server.address().port,
    push: (line) => { for (const s of sockets) s.write(line + EOL); },
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

function runtimeFor(port, settings = {}, options = {}) {
  const hub = new StateHub();
  const emitted = [];
  const ctx = { hub, settings: () => ({ host: '127.0.0.1', port, apiKey: KEY, ...settings }), emitStatus: () => emitted.push(1) };
  const rt = new Ts3Runtime(ctx, options);
  rt.configure();
  return { rt, hub, emitted };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };

test('teamspeak3: escapes and reads the ClientQuery text format', () => {
  assert.equal(escape('Hi there | a/b\\c\nx'), 'Hi\\sthere\\s\\p\\sa\\/b\\\\c\\nx');
  assert.equal(unescape('Hi\\sthere\\s\\p\\sa\\/b\\\\c\\nx'), 'Hi there | a/b\\c\nx');
  assert.deepEqual(parseRecords('clid=5 client_nickname=Nova\\sB|clid=6 client_nickname=Kai flag'), [{ clid: '5', client_nickname: 'Nova B' }, { clid: '6', client_nickname: 'Kai', flag: '' }]);
});

test('teamspeak3: signs in with the API key, registers for events and follows your mute, deafen and away state', async () => {
  const ts = await fakeTeamSpeak();
  const { rt, hub } = runtimeFor(ts.port);
  rt.sync({ ts3: true });
  await waitFor(() => rt.status().state === 'connected' && hub.get('ts3.micMuted') !== undefined);
  assert.deepEqual(ts.seen.slice(0, 3), [`auth apikey=${KEY}`, 'clientnotifyregister schandlerid=0 event=any', 'use']);
  assert.equal(hub.get('ts3.micMuted'), false);
  assert.equal(hub.get('ts3.speakersMuted'), false);
  assert.equal(hub.get('ts3.away'), false);
  assert.equal(hub.get('ts3.speaking'), false);
  // changed in TeamSpeak itself: the notification reaches the button
  ts.push('notifyclientupdated schandlerid=1 clid=5 client_input_muted=1');
  await waitFor(() => hub.get('ts3.micMuted') === true);
  ts.push('notifyclientupdated schandlerid=1 clid=99 client_input_muted=0'); // someone else: ignored
  ts.push('notifytalkstatuschange schandlerid=1 status=1 isreceivedwhisper=0 clid=5');
  await waitFor(() => hub.get('ts3.speaking') === true);
  ts.push('notifytalkstatuschange schandlerid=1 status=0 isreceivedwhisper=0 clid=5');
  await waitFor(() => hub.get('ts3.speaking') === false);
  assert.equal(hub.get('ts3.micMuted'), true, 'another client\'s update did not touch your state');
  rt.stop();
  await waitFor(() => rt.status().state === 'off');
  assert.equal(hub.get('ts3.micMuted'), undefined, 'the state is forgotten when nothing needs TeamSpeak');
  ts.close();
});

test('teamspeak3: mutes, unmutes and toggles your microphone and speakers, and goes away with a message', async () => {
  const ts = await fakeTeamSpeak();
  const { rt, hub } = runtimeFor(ts.port);
  const { ctx, toasts } = toastCtx(rt);
  rt.sync({ ts3: true });
  await act('ts3.mic').run({ mode: 'toggle' }, ctx);
  assert.equal(ts.flags.client_input_muted, 1);
  assert.ok(ts.seen.includes('clientupdate client_input_muted=1'));
  assert.equal(hub.get('ts3.micMuted'), true);
  assert.equal(toasts.at(-1)[0], 'TeamSpeak microphone muted');
  await act('ts3.mic').run({ mode: 'toggle' }, ctx);
  assert.equal(ts.flags.client_input_muted, 0, 'the second press unmutes');
  await act('ts3.mic').run({ mode: 'on' }, ctx);
  await act('ts3.mic').run({ mode: 'on' }, ctx);
  assert.equal(ts.flags.client_input_muted, 1, '"mute" twice stays muted');
  await act('ts3.mic').run({ mode: 'off' }, ctx);
  assert.equal(ts.flags.client_input_muted, 0);

  await act('ts3.speakers').run({ mode: 'on' }, ctx);
  assert.equal(ts.flags.client_output_muted, 1);
  assert.equal(hub.get('ts3.speakersMuted'), true);
  assert.equal(toasts.at(-1)[0], 'TeamSpeak speakers muted');

  await act('ts3.away').run({ mode: 'on', message: 'Back in 5 | brb' }, ctx);
  assert.ok(ts.seen.includes('clientupdate client_away=1 client_away_message=Back\\sin\\s5\\s\\p\\sbrb'), 'the message is escaped');
  assert.equal(hub.get('ts3.away'), true);
  await act('ts3.away').run({ mode: 'off', message: 'ignored' }, ctx);
  assert.ok(ts.seen.includes('clientupdate client_away=0'), 'no message is sent when coming back');
  rt.stop();
  ts.close();
});

test('teamspeak3: a toggle reads the real state first, so it is right even after you changed it in TeamSpeak', async () => {
  const ts = await fakeTeamSpeak();
  const { rt } = runtimeFor(ts.port);
  const { ctx } = toastCtx(rt);
  rt.sync({ ts3: true });
  await waitFor(() => rt.status().state === 'connected');
  ts.flags.client_input_muted = 1; // muted behind our back, with no notification
  await act('ts3.mic').run({ mode: 'toggle' }, ctx);
  assert.equal(ts.flags.client_input_muted, 0, 'it unmuted, not muted again');
  rt.stop();
  ts.close();
});

test('teamspeak3: "Save and test connection" says who you are, and explains a wrong key, a missing key or a TeamSpeak that is not on a server', async () => {
  const ts = await fakeTeamSpeak();
  const ok = runtimeFor(ts.port);
  assert.deepEqual(await ok.rt.check(), [{ value: 'Nova B', label: 'Nova B' }]);
  ok.rt.stop();

  const wrong = runtimeFor(ts.port, { apiKey: 'AAAA-BBBB' });
  await assert.rejects(wrong.rt.check(), /did not accept the API key/);
  assert.equal(wrong.rt.status().state, 'auth-failed');
  wrong.rt.stop();

  const none = runtimeFor(ts.port, { apiKey: '' });
  await assert.rejects(none.rt.check(), /wants an API key/);
  none.rt.stop();
  ts.close();

  const lonely = await fakeTeamSpeak({ connected: false });
  const l = runtimeFor(lonely.port);
  await assert.rejects(l.rt.check(), /not connected to a server/);
  l.rt.stop();
  lonely.close();
});

test('teamspeak3: explains a closed TeamSpeak in plain words, then finds it by itself when it starts', async () => {
  const first = await fakeTeamSpeak();
  const port = first.port;
  first.close();
  const { rt, hub, emitted } = runtimeFor(port);
  const { ctx } = toastCtx(rt);
  rt.sync({ ts3: true });
  await waitFor(() => rt.status().state === 'error');
  assert.match(rt.status().error, /Can't reach TeamSpeak at 127.0.0.1:\d+.*ClientQuery plugin/);
  assert.ok(emitted.length >= 1, 'the Settings dot is told');
  await assert.rejects(act('ts3.mic').run({ mode: 'on' }, ctx), /Can't reach TeamSpeak/);

  // TeamSpeak starts a little later, on the same port: the retry (every second or two) finds it and the state appears
  const later = await fakeTeamSpeak({ port });
  await waitFor(() => rt.status().state === 'connected' && hub.get('ts3.micMuted') === false, 8000, 50);
  assert.equal(rt.status().error, '');
  rt.stop();
  later.close();
});

test('teamspeak3: a stalled TeamSpeak is reported, and nothing is left hanging', async () => {
  const ts = await fakeTeamSpeak({ hang: true });
  const { rt } = runtimeFor(ts.port, {}, { timeoutMs: 150 });
  rt.sync({ ts3: true });
  await waitFor(() => rt.status().state === 'error' || rt.status().state === 'connecting', 2000);
  await sleep(400);
  assert.notEqual(rt.status().state, 'connected');
  rt.stop();
  ts.close();
});

test('teamspeak3: the address, port and key from Settings are checked before anything is sent', async () => {
  const ts = await fakeTeamSpeak();
  for (const bad of ['evil.example/path', 'http://x', 'a b', 'x@y', 'x:1']) {
    const c = new Ts3Client();
    c.configure({ host: bad, port: ts.port, apiKey: KEY });
    assert.throws(() => c.target(), /not a valid host name/, bad);
  }
  const c = new Ts3Client();
  c.configure({ host: '127.0.0.1', port: ts.port, apiKey: 'KEY\nclientupdate client_input_muted=1' });
  assert.throws(() => c.target(), /characters a key never has/, 'a line break in the key can never become a second command');
  c.configure({ host: '127.0.0.1', port: 70000, apiKey: KEY });
  assert.throws(() => c.target(), /between 1 and 65535/);
  await assert.rejects(new Ts3Client().request('whoami\nclientupdate client_away=1'), /line break|Not connected/);
  assert.equal(ts.seen.length, 0, 'nothing reached TeamSpeak');
  ts.close();
});

test('teamspeak3: the default is 127.0.0.1:25639, and the plugin loads like any other with its Instructions and needs nothing outside its own folder', async () => {
  const defaults = manifest.settingsFields.reduce((o, f) => ({ ...o, [f.key]: f.default }), {});
  assert.deepEqual(defaults, { apiKey: '', host: '127.0.0.1', port: 25639 });
  assert.equal(manifest.settingsFields.find((f) => f.key === 'apiKey').type, 'password');

  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /teamspeak3/.test(e.dir)), []);
  const m = app.registry.get('teamspeak3');
  assert.ok(m);
  assert.deepEqual(m.actions.map((a) => a.id).sort(), ['ts3.away', 'ts3.mic', 'ts3.speakers']);
  assert.equal(m.testOptionKind, 'ts3.test');
  assert.deepEqual(m.matchState('ts3.micMuted'), { ts3: true });
  assert.equal(m.matchState('obs.recording'), null);
  assert.match(m.instructions(), /TeamSpeak 5 and 6/);
  assert.equal(m.guide.steps.length, 3);
  await app.stop();
  const dir = path.join(__dirname, '..', 'plugins', 'teamspeak3');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder`);
  }
});
