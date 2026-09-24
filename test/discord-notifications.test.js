// The Discord Notifications plugin: what each kind of Discord notification looks like, the "ignore" filters,
// clearing, and (on Windows) that the real PowerShell listener starts and reports ready.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { StateHub } = require('../src/core/state');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');
const { DiscordNotifyRuntime } = require('../plugins/discord-notifications/runtime');
const widgets = require('../plugins/discord-notifications/widgets');
const actions = require('../plugins/discord-notifications/actions');
const script = require('../plugins/discord-notifications/listener-script');
const { parseNotification } = require('../plugins/discord-notifications/parse');

const FSI = '⁨', PDI = '⁩'; // the invisible marks Discord wraps names in
const CHANNEL_TITLE = `${FSI}Nova${PDI} (${FSI}#general${PDI}, ${FSI}Text channels${PDI})`;
const EVENT_TITLE = 'Your event is starting in The Nova Hub';

function make(settings = {}) {
  let t = 1000000;
  const hub = new StateHub();
  const rt = new DiscordNotifyRuntime({ hub, now: () => t, settings: () => settings, emitStatus() {} });
  rt.onLine(JSON.stringify({ ready: true }));
  return { rt, hub, tick: (ms) => { t += ms; } };
}
const say = (rt, title, body) => rt.onLine(JSON.stringify({ app: 'Discord', title, body }));
const [lastWidget, recentWidget] = widgets;
const draw = (w, rt) => w.data({ plugin: () => rt });

test('discord notifications: loads with no errors, and is Discord-specific (no "which app" setting)', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  const m = app.registry.get('discord-notifications');
  assert.ok(m, 'bundled plugin found');
  assert.ok(!app.registry.get('notifications'), 'the old generic plugin is gone');
  assert.deepEqual(app.registry.errors.filter((e) => /discord-notifications/.test(e.dir)), []);
  assert.deepEqual(m.widgets.map((w) => w.id), ['dnotify.last', 'dnotify.recent']);
  assert.deepEqual([...m.widgets, ...m.actions].map((x) => x.category), Array(3).fill('Discord notifications'), 'widgets and the clear action share one heading in the picker');
  assert.ok(!m.settingsFields.some((f) => f.key === 'apps'));
  for (const k of ['ignoreDms', 'ignoreChannel', 'ignoreEveryone', 'ignoreMentions', 'ignoreEvents']) assert.ok(m.settingsFields.some((f) => f.key === k), k);
  for (const k of ['dnotify.unread', 'dnotify.from', 'dnotify.type']) assert.deepEqual(m.matchState(k), { dnotify: true });
  await app.stop();
});

test('discord notifications: parses the real layouts (DM, channel, @everyone, mention, event)', () => {
  assert.deepEqual(parseNotification('Discord', 'Nova', 'what general?'), { app: 'Discord', kind: 'dm', type: 'dm', sender: 'Nova', channel: '', where: '', title: 'Nova', text: 'what general?', everyone: false, mention: false });
  const c = parseNotification('Discord', CHANNEL_TITLE, 'Hey all');
  assert.deepEqual([c.kind, c.type, c.sender, c.channel, c.where, c.text], ['channel', 'channel', 'Nova', '#general', 'Text channels', 'Hey all']);
  assert.equal(parseNotification('Discord', CHANNEL_TITLE, '@everyone').type, 'everyone');
  assert.equal(parseNotification('Discord', CHANNEL_TITLE, 'movie night @here').type, 'everyone');
  assert.equal(parseNotification('Discord', CHANNEL_TITLE, `${FSI}@Jayconius${PDI}`, 'Jayconius').type, 'mention');
  assert.equal(parseNotification('Discord', CHANNEL_TITLE, '@jayconius look', '@Jayconius').type, 'mention', 'case and a leading @ in the name do not matter');
  assert.equal(parseNotification('Discord', CHANNEL_TITLE, `${FSI}@Jayconius${PDI}`).type, 'channel', 'without your name, a mention cannot be told from any channel message');
  const e = parseNotification('Discord', EVENT_TITLE, '"asdasd". Join in!');
  assert.deepEqual([e.kind, e.type, e.sender, e.text], ['event', 'event', 'The Nova Hub', 'asdasd']);
  assert.equal(parseNotification('Discord', '', '').type, 'other', 'an empty notification is not a crash');
});

test('discord notifications: every kind reads clearly on the widget; pings stand out', () => {
  const { rt } = make({ myName: 'Jayconius' });
  assert.equal(draw(lastWidget, rt).subtitle, 'No new notifications');
  say(rt, 'Nova', 'what general?');
  assert.deepEqual(draw(lastWidget, rt), { value: 'Nova', subtitle: 'what general?', status: 'ok' });
  say(rt, CHANNEL_TITLE, 'Hey all');
  assert.deepEqual(draw(lastWidget, rt), { value: 'Nova', subtitle: '#general: Hey all', status: 'ok' });
  say(rt, CHANNEL_TITLE, '@everyone');
  assert.deepEqual(draw(lastWidget, rt), { value: 'Nova', subtitle: '#general: @everyone', status: 'warn' });
  say(rt, CHANNEL_TITLE, `${FSI}@Jayconius${PDI}`);
  assert.deepEqual(draw(lastWidget, rt), { value: 'Nova', subtitle: '#general: @Jayconius', status: 'warn' });
  say(rt, EVENT_TITLE, '"asdasd". Join in!');
  assert.deepEqual(draw(lastWidget, rt), { value: 'Event: asdasd', subtitle: 'starting in The Nova Hub', status: 'ok' });
});

test('discord notifications: each ignore filter drops only its own kind', () => {
  const cases = [
    ['ignoreDms', ['Nova', 'hi'], true],
    ['ignoreChannel', [CHANNEL_TITLE, 'Hey all'], true],
    ['ignoreEveryone', [CHANNEL_TITLE, '@everyone'], true],
    ['ignoreMentions', [CHANNEL_TITLE, '@Jayconius'], true],
    ['ignoreEvents', [EVENT_TITLE, '"x". Join in!'], true],
  ];
  const all = cases.map((c) => c[1]);
  for (const [setting, dropped] of cases) {
    const { rt } = make({ myName: 'Jayconius', [setting]: true });
    for (const [title, body] of all) say(rt, title, body);
    const kept = rt.recent.length;
    assert.equal(kept, all.length - 1, `${setting} drops exactly one of the five kinds`);
    assert.ok(!rt.recent.some((n) => n.title === parseNotification('Discord', dropped[0], dropped[1], 'Jayconius').title && n.text === parseNotification('Discord', dropped[0], dropped[1], 'Jayconius').text), `${setting} dropped the right one`);
  }
  // A dropped notification changes nothing: not the widget, not the state.
  const { rt, hub } = make({ ignoreEvents: true });
  say(rt, EVENT_TITLE, '"x". Join in!');
  assert.equal(hub.eval('dnotify.unread'), false);
  assert.equal(draw(lastWidget, rt).subtitle, 'No new notifications');
  // With every filter off, everything shows.
  const open = make({ myName: 'Jayconius' });
  for (const [title, body] of all) say(open.rt, title, body);
  assert.equal(open.rt.recent.length, 5);
});

test('discord notifications: state keys follow the latest notification (unread, sender, type)', () => {
  const { rt, hub } = make({ myName: 'Jayconius' });
  assert.equal(hub.eval('dnotify.unread'), false);
  say(rt, CHANNEL_TITLE, '@everyone');
  assert.equal(hub.eval('dnotify.unread'), true);
  assert.equal(hub.eval('dnotify.from=Nova'), true);
  assert.equal(hub.eval('dnotify.type=everyone'), true);
  assert.equal(hub.eval('dnotify.type=dm'), false);
  say(rt, 'Sam', 'yo');
  assert.equal(hub.eval('dnotify.from=Nova'), false);
  assert.equal(hub.eval('dnotify.type=dm'), true);
  say(rt, EVENT_TITLE, '"party". Join in!');
  assert.equal(hub.eval('dnotify.type=event'), true);
});

test('discord notifications: the recent widget lists the last five, newest first', () => {
  const { rt } = make();
  for (const n of ['one', 'two', 'three', 'four', 'five', 'six']) say(rt, 'Nova', n);
  const d = draw(recentWidget, rt);
  assert.equal(d.value, '5');
  assert.deepEqual(d.items.map((i) => i.value), ['six', 'five', 'four', 'three', 'two']);
  say(rt, EVENT_TITLE, '"party". Join in!');
  assert.deepEqual(draw(recentWidget, rt).items[0], { label: 'Event · The Nova Hub', value: 'party' });
  assert.equal(draw(recentWidget, rt).status, 'ok');
  say(rt, CHANNEL_TITLE, '@everyone');
  assert.equal(draw(recentWidget, rt).status, 'warn');
});

test('discord notifications: tapping a widget and the clear action forget everything', async () => {
  const { rt, hub } = make();
  say(rt, 'Nova', 'hi');
  await lastWidget.command({ plugin: () => rt }, {}, {}, 'tap');
  assert.equal(hub.eval('dnotify.unread'), false);
  assert.equal(rt.recent.length, 0);
  say(rt, 'Nova', 'hi');
  say(rt, 'Sam', 'hi');
  await recentWidget.command({ plugin: () => rt }, {}, {}, 'tap');
  assert.equal(rt.recent.length, 0);
  say(rt, 'Nova', 'hi');
  await actions[0].run({}, { plugin: () => rt });
  assert.equal(hub.eval('dnotify.unread'), false);
});

test('discord notifications: hiding the text, and forgetting after the set time', async () => {
  const a = make({ showText: false });
  say(a.rt, 'Nova', 'secret');
  assert.equal(draw(lastWidget, a.rt).subtitle, 'Discord');
  assert.ok(!JSON.stringify(draw(lastWidget, a.rt)).includes('secret') && !JSON.stringify(draw(recentWidget, a.rt)).includes('secret'));
  a.rt.stop();

  const b = make({ clearAfterMin: 1 });
  say(b.rt, 'Nova', 'x');
  b.tick(61000);
  b.rt.scheduleClear();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.rt.recent.length, 0);
  b.rt.stop();
});

test('discord notifications: an error becomes the plugin status and the widgets say so; junk lines are ignored', () => {
  const { rt } = make();
  rt.onLine('not json');
  rt.onLine('42');
  rt.onLine(JSON.stringify({ error: 'Windows did not allow notification access (Denied).' }));
  assert.equal(rt.status().state, 'error');
  for (const w of widgets) { assert.match(draw(w, rt).subtitle, /did not allow/); assert.equal(draw(w, rt).status, 'error'); }
  assert.match(widgets[0].data({ plugin: () => null }).subtitle, /switched off/);
});

test('discord notifications: the listener is always started for Discord only, and stopped again', () => {
  if (process.platform !== 'win32') return;
  const calls = [];
  const killed = [];
  const fake = { stdout: new (require('stream').PassThrough)(), on() {}, kill() { killed.push(1); } };
  const rt = new DiscordNotifyRuntime({ hub: new StateHub(), now: Date.now, settings: () => ({ apps: '*' }), emitStatus() {} }, { spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fake; } });
  rt.sync({ dnotify: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.equal(calls[0].opts.env.VRMP_FILTER, 'discord', 'not changeable from settings');
  assert.equal(rt.status().state, 'connecting');
  rt.sync({});
  assert.equal(killed.length, 1);
  assert.equal(rt.status().state, 'off');
});

test('discord notifications: the real PowerShell listener starts and reports ready (Windows only)', { timeout: 40000 }, async () => {
  if (process.platform !== 'win32') return;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, VRMP_FILTER: 'no-such-app-zzz', VRMP_PARENT: String(process.pid) },
  });
  const first = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve('timeout'), 30000);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); resolve(buf.split('\n')[0].trim()); } });
    child.on('exit', () => { clearTimeout(timer); resolve(buf.trim() || 'exited'); });
  });
  child.kill();
  const msg = JSON.parse(first);
  assert.ok(msg.ready === true || /notification access/i.test(msg.error || ''), `unexpected first line: ${first}`);
});
