// The bundled Discord plugin, run against a fake local Discord (a tiny HTTP server that records what it is sent).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { StateHub } = require('../src/core/state');
const { createApp } = require('../src/core');
const { FakeHelper, tempDir } = require('./helpers');
const { DiscordRuntime, expandFolders } = require('../plugins/discord/runtime');
const actions = require('../plugins/discord/actions');
const manifest = require('../plugins/discord/plugin');
const { fill } = require('../plugins/discord/text');

const act = (id) => actions.find((a) => a.id === id);

// A fake Discord. `replies` is a queue of [status, jsonBody]; when empty it answers 200 with a message id.
async function fakeDiscord() {
  const seen = [];
  const replies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'] || '', body: Buffer.concat(chunks) });
      const [status, body] = replies.shift() || [200, { id: '111', channel_id: '42', name: 'Test hook' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/webhooks`;
  return { seen, replies, base, json: (i = seen.length - 1) => JSON.parse(seen[i].body.toString()), close: () => server.close() };
}

function make(fake, extra = {}) {
  const hub = new StateHub();
  const settings = { webhookUrl: `${fake.base}/1/main`, username: 'VR Macro Pad', mainName: 'Main channel', ...extra };
  const rt = new DiscordRuntime({ hub, now: Date.now, settings: () => settings, emitStatus() {} });
  const calls = [];
  const ctx = {
    hub, toast: (t, l) => calls.push(['toast', t, l]),
    plugin: () => rt,
    nowPlaying: () => ({ title: 'Song X', artist: 'Band Y', playing: true }),
    helper: { call: async (name, args) => { calls.push([name, args]); return name === 'proc.list' ? ['discord.exe'] : null; } },
  };
  return { rt, ctx, calls, hub, settings };
}

test('discord: the bundled plugin loads with no errors and lists its actions', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /discord/.test(e.dir)), []);
  const ids = app.registry.get('discord').actions.map((a) => a.id);
  for (const want of ['discord.send', 'discord.embed', 'discord.file', 'discord.vrchat', 'discord.autoshare', 'discord.mute', 'discord.deafen', 'discord.talk']) assert.ok(ids.includes(want), want);
  await app.stop();
});

test('discord: every action offers "start Discord first if it is not running"', () => {
  for (const a of actions) assert.ok(a.params.some((p) => p.key === 'openDiscord'), `${a.id} has the option`);
});

test('discord: sends a message; pings are off unless allowed; placeholders are filled', async () => {
  const fake = await fakeDiscord();
  const { ctx, hub } = make(fake);
  await act('discord.send').run({ message: 'Live at {time}: {track} on {scene}', mentions: 'none' }, { ...ctx, hub: Object.assign(hub, {}) });
  const b = fake.json();
  assert.match(b.content, /^Live at \d\d:\d\d: Band Y - Song X on $/);
  assert.deepEqual(b.allowed_mentions, { parse: [] });
  assert.equal(b.username, 'VR Macro Pad');
  assert.match(fake.seen[0].url, /\/1\/main\?wait=true/);
  assert.equal(hub.eval('discord.lastOk'), true);

  await act('discord.send').run({ message: '@everyone hi', mentions: 'everyone' }, ctx);
  assert.deepEqual(fake.json().allowed_mentions, { parse: ['users', 'roles', 'everyone'] });
  await assert.rejects(act('discord.send').run({ message: '   ' }, ctx), /Type a message/);
  fake.close();
});

test('discord: a card (embed) carries the title, link, picture, footer and color', async () => {
  const fake = await fakeDiscord();
  const { ctx } = make(fake);
  await act('discord.embed').run({ title: "I'm live!", description: 'Playing {scene}', url: 'https://twitch.tv/me', imageUrl: 'https://example.com/a.png', color: '#9146ff', footer: 'VR Macro Pad', message: '@everyone go!', mentions: 'none' }, ctx);
  const b = fake.json();
  assert.equal(b.content, '@everyone go!');
  assert.deepEqual(b.embeds[0], { title: "I'm live!", color: 0x9146ff, description: 'Playing ', url: 'https://twitch.tv/me', image: { url: 'https://example.com/a.png' }, footer: { text: 'VR Macro Pad' } });
  await assert.rejects(act('discord.embed').run({ title: 'x', url: 'javascript:alert(1)' }, ctx), /must start with http/);
  await assert.rejects(act('discord.embed').run({ title: '' }, ctx), /title/);
  fake.close();
});

test('discord: extra channels post through their own webhook and are listed by name', async () => {
  const fake = await fakeDiscord();
  const { rt, ctx } = make(fake, { name2: 'Screenshots', url2: `${fake.base}/2/shots` });
  assert.deepEqual(rt.channels(), [{ value: 'main', label: 'Main channel' }, { value: '2', label: 'Screenshots' }]);
  assert.deepEqual(await manifest.optionLists['discord.channels']({ plugins: { get: () => rt } }), rt.channels());
  await act('discord.send').run({ message: 'hi', channel: '2' }, ctx);
  assert.match(fake.seen[0].url, /\/2\/shots/);
  await assert.rejects(act('discord.send').run({ message: 'hi', channel: '3' }, ctx), /no Webhook URL/);
  fake.close();
});

test('discord: only real Discord (or localhost) webhook links are accepted', async () => {
  const fake = await fakeDiscord();
  for (const [url, re] of [['', /Paste your Webhook URL/], ['nonsense', /not a valid link/], ['https://evil.example/api/webhooks/1/x', /not a Discord webhook/], ['http://discord.com/api/webhooks/1/x', /must start with https/]]) {
    const { ctx } = make(fake, { webhookUrl: url });
    await assert.rejects(act('discord.send').run({ message: 'hi' }, ctx), re, url);
  }
  assert.equal(fake.seen.length, 0, 'nothing was sent anywhere');
  fake.close();
});

test('discord: Discord errors become plain messages, the state goes false, and a rate limit is retried once', async () => {
  const fake = await fakeDiscord();
  const { ctx, hub, rt } = make(fake);
  fake.replies.push([404, { message: 'Unknown Webhook' }]);
  await assert.rejects(act('discord.send').run({ message: 'hi' }, ctx), /no longer exists/);
  assert.equal(hub.eval('discord.lastOk'), false);
  assert.equal(rt.status().state, 'error');
  fake.replies.push([429, { retry_after: 0.01 }]);
  await act('discord.send').run({ message: 'hi again' }, ctx);
  assert.equal(fake.seen.length, 3, 'the rate-limited post was tried again');
  assert.equal(rt.status().state, 'connected');
  fake.replies.push([413, {}]);
  await assert.rejects(act('discord.send').run({ message: 'x' }, ctx), /too big/);
  fake.close();
});

test('discord: "Save and test connection" reads the webhook without posting', async () => {
  const fake = await fakeDiscord();
  const { rt } = make(fake);
  assert.deepEqual(await rt.check(), [{ value: '42', label: 'Test hook' }]);
  assert.equal(fake.seen[0].method, 'GET');
  fake.close();
});

test('discord: sends the newest picture in a folder as an upload, with a caption', async () => {
  const fake = await fakeDiscord();
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '2026-09'));
  fs.writeFileSync(path.join(dir, 'old.png'), 'old');
  fs.utimesSync(path.join(dir, 'old.png'), new Date(2020, 1, 1), new Date(2020, 1, 1));
  fs.writeFileSync(path.join(dir, '2026-09', 'new.png'), 'PNGDATA');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a picture');
  const { ctx } = make(fake);
  await act('discord.file').run({ source: 'newest', path: dir, message: 'Look! {time}' }, ctx);
  assert.match(fake.seen[0].type, /^multipart\/form-data/);
  const raw = fake.seen[0].body.toString();
  assert.ok(raw.includes('filename="new.png"') && raw.includes('PNGDATA'), 'the newest picture, from a sub-folder, was uploaded');
  assert.ok(!raw.includes('old.png') && !raw.includes('notes.txt'));
  assert.match(raw, /"content":"Look! \d\d:\d\d"/);
  await assert.rejects(act('discord.file').run({ source: 'newest', path: path.join(dir, 'nope') }, ctx), /No pictures found/);
  await assert.rejects(act('discord.file').run({ source: 'file', path: path.join(dir, 'nope.png') }, ctx), /not found/);
  fake.close();
});

test('discord: automatic sharing posts only pictures that appear after it is switched on, once each', async () => {
  const fake = await fakeDiscord();
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'before.png'), 'before');
  await new Promise((r) => setTimeout(r, 60)); // the old picture really is older than the moment sharing is switched on
  const { rt, hub } = make(fake, { screenshotFolders: dir, autoCaption: 'New shot' });
  rt.setAutoShare(true);
  assert.equal(hub.eval('discord.autoShare'), true);
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(path.join(dir, 'after.png'), 'after');
  await rt.scan();                       // first look: remembers the size
  assert.equal(fake.seen.length, 0, 'waits until the file stops growing');
  await rt.scan();                       // size unchanged: share it
  assert.equal(fake.seen.length, 1);
  assert.ok(fake.seen[0].body.toString().includes('filename="after.png"'));
  await rt.scan(); await rt.scan();
  assert.equal(fake.seen.length, 1, 'never shared twice, and the old picture was never shared');
  rt.setAutoShare(false);
  assert.equal(hub.eval('discord.autoShare'), false);
  fake.close();
});

test('discord: the auto-share button refuses to start without folders or a webhook', async () => {
  const fake = await fakeDiscord();
  const a = make(fake, { screenshotFolders: path.join(tempDir(), 'missing') });
  await assert.rejects(act('discord.autoshare').run({ mode: 'on' }, a.ctx), /No screenshot folders/);
  const dir = tempDir();
  const b = make(fake, { screenshotFolders: dir, webhookUrl: '' });
  await assert.rejects(act('discord.autoshare').run({ mode: 'on' }, b.ctx), /Paste your Webhook/);
  const c = make(fake, { screenshotFolders: dir });
  await act('discord.autoshare').run({ mode: 'toggle' }, c.ctx);
  assert.equal(c.rt.share.on, true);
  await act('discord.autoshare').run({ mode: 'toggle' }, c.ctx);
  assert.equal(c.rt.share.on, false);
  fake.close();
});

test('discord: mute, deafen and mic press the shortcut from Settings, or one recorded on the button', async () => {
  const fake = await fakeDiscord();
  const { ctx, calls } = make(fake, { muteKey: 'ctrl+shift+m', deafenKey: 'ctrl+shift+d', talkKey: '' });
  await act('discord.mute').run({}, ctx);
  await act('discord.deafen').run({}, ctx);
  await act('discord.talk').run({ keys: 'F13' }, ctx);
  const combos = calls.filter((c) => c[0] === 'keys.combo').map((c) => c[1].vks);
  assert.deepEqual(combos, [[0x11, 0x10, 0x4d], [0x11, 0x10, 0x44], [0x7c]]);
  await assert.rejects(act('discord.talk').run({}, ctx), /No shortcut set/);
  fake.close();
});

test('discord: with "start Discord first" on and Discord already running, nothing is launched', async () => {
  const fake = await fakeDiscord();
  const { ctx, calls } = make(fake);
  await act('discord.send').run({ message: 'hi', openDiscord: true }, ctx);
  assert.deepEqual(calls.filter((c) => c[0] === 'proc.list').length, 1);
  assert.equal(fake.seen.length, 1);
  fake.close();
});

test('discord: folder shortcuts and wildcards find real folders', () => {
  const root = tempDir();
  for (const app of ['111', '222']) fs.mkdirSync(path.join(root, 'remote', app, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(root, 'remote', '333'), { recursive: true }); // a game with no screenshots folder
  const found = expandFolders(path.join(root, 'remote', '*', 'screenshots'));
  assert.deepEqual(found.map((f) => path.basename(path.dirname(f))).sort(), ['111', '222']);
  assert.deepEqual(expandFolders('{steam}\\no\\such\\place'), []);
});

test('discord: placeholders: unknown ones are left alone', () => {
  assert.equal(fill('{hello} {date}', { hub: new StateHub() }, new Date(2026, 8, 5)), '{hello} 2026-09-05');
});

test('discord: "Send the last VRChat photo" posts the newest photo from the VRChat folder setting', async () => {
  const fake = await fakeDiscord();
  const dir = tempDir(); // stands in for the folder VRChat saves to (set as the fallback folder)
  fs.mkdirSync(path.join(dir, '2026-09'));
  fs.writeFileSync(path.join(dir, '2026-09', 'VRChat_old.png'), 'OLDPHOTO');
  fs.utimesSync(path.join(dir, '2026-09', 'VRChat_old.png'), new Date(2021, 1, 1), new Date(2021, 1, 1));
  fs.writeFileSync(path.join(dir, '2026-09', 'VRChat_new.png'), 'NEWPHOTO');
  const { ctx } = make(fake, { vrchatFolder: dir });
  await act('discord.vrchat').run({ message: 'Cool world' }, ctx);
  const raw = fake.seen[0].body.toString();
  assert.ok(raw.includes('filename="VRChat_new.png"') && raw.includes('NEWPHOTO') && !raw.includes('OLDPHOTO'));
  assert.match(raw, /"content":"Cool world"/);
  const empty = make(fake, { vrchatFolder: path.join(dir, 'nothing-here') });
  await assert.rejects(act('discord.vrchat').run({}, empty.ctx), /No VRChat photos found/);
  fake.close();
});

test('discord: the Steam and VRChat folder settings win over auto-detect, and VRChat is not in the auto-share default', () => {
  const steam = tempDir();
  fs.mkdirSync(path.join(steam, 'userdata', '9', '760', 'remote', '55', 'screenshots'), { recursive: true });
  const found = expandFolders(['{steam}', 'userdata', '*', '760', 'remote', '*', 'screenshots'].join(path.sep), { steam });
  assert.equal(found.length, 1);
  assert.ok(found[0].startsWith(path.normalize(steam)));
  const def = manifest.settingsFields.find((f) => f.key === 'screenshotFolders').default;
  assert.ok(!/vrchat/i.test(def), 'photos from VRChat have their own button');
  assert.ok(manifest.settingsFields.some((f) => f.key === 'steamFolder') && manifest.settingsFields.some((f) => f.key === 'vrchatFolder'));
});

test('discord: "Send last Steam screenshot" sends the newest Steam screenshot with no path to type, and explains when there is none', async () => {
  const fake = await fakeDiscord();
  const steam = tempDir();
  const shots = path.join(steam, 'userdata', '9', '760', 'remote', '55', 'screenshots');
  fs.mkdirSync(path.join(shots, 'thumbnails'), { recursive: true });
  fs.writeFileSync(path.join(shots, 'old.jpg'), 'OLDSHOT');
  fs.utimesSync(path.join(shots, 'old.jpg'), new Date(2021, 1, 1), new Date(2021, 1, 1));
  fs.writeFileSync(path.join(shots, 'new.jpg'), 'NEWSHOT');
  fs.writeFileSync(path.join(shots, 'thumbnails', 'thumb.jpg'), 'THUMB');
  const { ctx } = make(fake, { steamFolder: steam });
  const def = act('discord.file');
  assert.match(def.label, /Last Steam screenshot|last Steam screenshot/i, 'the name says what it does');
  await def.run({ message: 'Nice one' }, ctx); // no source chosen: Steam is the default
  const raw = fake.seen[0].body.toString();
  assert.ok(raw.includes('filename="new.jpg"') && raw.includes('NEWSHOT') && !raw.includes('OLDSHOT') && !raw.includes('THUMB'));
  assert.match(raw, /"content":"Nice one"/);
  const none = make(fake, { steamFolder: path.join(steam, 'nowhere') });
  await assert.rejects(def.run({ source: 'steam' }, none.ctx), /No Steam screenshots found/);
  await assert.rejects(def.run({ source: 'newest', path: '' }, ctx), /Choose a folder or file/);
  fake.close();
});

test('discord: automatic sharing uses the channel and caption from the button, and VRChat photos only when switched on', async () => {
  const fake = await fakeDiscord();
  const steam = tempDir();
  const shots = path.join(steam, 'userdata', '9', '760', 'remote', '55', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const vrchat = tempDir();
  const extra = { screenshotFolders: path.join('{steam}', 'userdata', '*', '760', 'remote', '*', 'screenshots'), name2: 'Screenshots', url2: `${fake.base}/2/shots`, name3: 'Event photos', url3: `${fake.base}/3/event`, steamFolder: steam, vrchatFolder: vrchat, autoCaption: 'from settings' };
  const run = async (params, before) => {
    const { rt, ctx } = make(fake, extra);
    fake.seen.length = 0;
    await act('discord.autoshare').run({ mode: 'on', ...params }, ctx);
    await new Promise((r) => setTimeout(r, 40));
    before();
    await rt.scan(); await rt.scan();
    const out = fake.seen.map((s) => ({ url: s.url.split('?')[0], body: s.body.toString() }));
    rt.setAutoShare(false);
    return out;
  };
  const dropPhotos = () => { fs.writeFileSync(path.join(shots, `s${Math.random()}.jpg`), 'STEAMSHOT'); fs.writeFileSync(path.join(vrchat, `v${Math.random()}.png`), 'VRPHOTO'); };

  let out = await run({ channel: '2', message: 'Look at this' }, dropPhotos);
  assert.equal(out.length, 1, 'VRChat photos are NOT shared unless the button says so');
  assert.match(out[0].url, /\/2\/shots$/);
  assert.ok(out[0].body.includes('STEAMSHOT') && out[0].body.includes('"content":"Look at this"'));

  out = await run({ channel: '2', vrchat: true, vrchatChannel: '3' }, dropPhotos);
  assert.equal(out.length, 2);
  const steamPost = out.find((o) => o.body.includes('STEAMSHOT')), vrPost = out.find((o) => o.body.includes('VRPHOTO'));
  assert.match(steamPost.url, /\/2\/shots$/, 'screenshots go to their channel');
  assert.match(vrPost.url, /\/3\/event$/, 'VRChat photos can go to a different channel');
  assert.ok(steamPost.body.includes('"content":"from settings"'), 'no caption on the button: the Settings default is used');

  out = await run({ vrchat: true }, dropPhotos);
  assert.ok(out.every((o) => /\/1\/main$/.test(o.url)), 'no channel chosen anywhere: the main channel');
  assert.equal(out.length, 2);

  out = await run({ steamShots: false, vrchat: true, channel: '2', vrchatChannel: '3' }, dropPhotos);
  assert.equal(out.length, 1, 'VRChat photos only: the Steam screenshot is left alone');
  assert.ok(out[0].body.includes('VRPHOTO') && /\/3\/event$/.test(out[0].url));

  const off = make(fake, extra);
  await assert.rejects(act('discord.autoshare').run({ mode: 'on', steamShots: false }, off.ctx), /at least one/, 'both switches off is not a thing to share');
  fake.close();
});

test('discord: turning automatic sharing on says so with a warning, and needs somewhere to look', async () => {
  const fake = await fakeDiscord();
  const vrchat = tempDir();
  const { ctx, calls, rt } = make(fake, { steamFolder: path.join(tempDir(), 'none'), vrchatFolder: vrchat, name2: 'Event', url2: `${fake.base}/2/e` });
  await assert.rejects(act('discord.autoshare').run({ mode: 'on' }, ctx), /No screenshot folders/, 'no Steam folder and VRChat not switched on');
  await act('discord.autoshare').run({ mode: 'on', vrchat: true, channel: '2' }, ctx);
  const toast = calls.find((c) => c[0] === 'toast');
  assert.equal(toast[2], 'warn', 'a warning, not a plain notice');
  assert.match(toast[1], /Sharing ON: new screenshots and VRChat photos go to Event.*private or adult/);
  await act('discord.autoshare').run({ mode: 'off' }, ctx);
  await act('discord.autoshare').run({ mode: 'on', steamShots: false, vrchat: true }, ctx);
  assert.match(calls.filter((c) => c[0] === 'toast' && c[2] === 'warn').at(-1)[1], /Sharing ON: new VRChat photos go to Main channel/);
  await act('discord.autoshare').run({ mode: 'off' }, ctx);
  assert.equal(rt.share.on, false);
  assert.equal(calls.filter((c) => c[0] === 'toast').at(-1)[1], 'Stopped sharing screenshots');
  fake.close();
});

test('discord: the actions that post pictures warn about private and adult instances, and new buttons ask for a hold', () => {
  for (const id of ['discord.file', 'discord.vrchat', 'discord.autoshare']) {
    const notice = act(id).params.find((p) => p.type === 'notice');
    assert.ok(notice && /private/i.test(notice.text) && /adult/i.test(notice.text) && notice.title, `${id} shows a warning`);
    assert.equal(act(id).params[0], notice, 'and it is the first thing you see');
  }
  assert.match(act('discord.vrchat').description, /private or adult/i);
  assert.equal(act('discord.vrchat').defaults.confirm, 'hold');
  assert.equal(act('discord.file').defaults.confirm, 'hold');
  assert.notEqual(act('discord.autoshare').defaults.confirm, 'hold', 'turning sharing OFF must never be slowed down');
  const auto = act('discord.autoshare').params;
  assert.ok(auto.some((p) => p.key === 'steamShots' && p.default === true), 'Steam screenshots are on by default');
  assert.ok(auto.some((p) => p.key === 'vrchat' && p.default === false), 'VRChat photos are off by default');
  assert.ok(auto.some((p) => p.key === 'channel') && auto.some((p) => p.key === 'vrchatChannel'));
});

// ---------- VRChat details in captions (log + photo metadata; no VRChat login involved) ----------
const vrLog = require('../src/core/vrchat-log');
const { fillVrchat, publicOnly } = require('../plugins/discord/vrchat');

// A VRChat log like the real one: "2026.09.23 21:11:50 Debug      -  [Behaviour] ..."
const logLine = (msg) => `2026.09.23 21:11:50 Debug      -  [Behaviour] ${msg}`;
function writeLog(lines, dir = tempDir()) {
  fs.writeFileSync(path.join(dir, 'output_log_2026-09-23_21-11-46.txt'), lines.map((l) => (l.startsWith('[') ? logLine(l.slice(1, -1)) : l)).join('\n'));
  process.env.VRMP_VRCHAT_LOG_DIR = dir;
  return dir;
}
const WORLD = 'wrld_00000000-0000-4000-8000-000000000000';
const session = (flags, joined = ['A', 'B', 'C'], left = []) => [
  `[Joining ${WORLD}:24534${flags}]`, '[Joining or Creating Room: Idle Defense]', '[Entering Room: Idle Defense]',
  ...joined.map((n) => `[OnPlayerJoined ${n}]`), ...left.map((n) => `[OnPlayerLeft ${n}]`),
];
// A photo like VRChat's: a PNG with an XMP text chunk holding the world.
function fakePhoto(dir, name, world, worldId = WORLD) {
  const xml = `<x:xmpmeta><rdf:Description><xmp:Author>Someone</xmp:Author><vrc:WorldID>${worldId}</vrc:WorldID><vrc:WorldDisplayName>${world}</vrc:WorldDisplayName></rdf:Description></x:xmpmeta>`;
  const data = Buffer.concat([Buffer.from('XML:com.adobe.xmp'), Buffer.alloc(5), Buffer.from(xml)]);
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(type), body, Buffer.alloc(4)]); };
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('iTXt', data), chunk('IEND', Buffer.alloc(0))]));
  return file;
}
const running = (list = ['discord.exe', 'vrchat.exe']) => ({ procs: async () => list });

test('vrchat log: world, players (joins minus leaves), and the instance type in plain words', () => {
  const cases = [
    ['', 'Public', 'public', 'US'], ['~hidden(usr_1)~region(eu)', 'Friends+', 'friends+', 'EU'], ['~friends(usr_1)~region(jp)', 'Friends', 'friends', 'JP'],
    ['~private(usr_1)~region(eu)', 'Invite', 'invite', 'EU'], ['~private(usr_1)~canRequestInvite~region(use)', 'Invite+', 'invite+', 'USE'],
    ['~group(grp_1)~groupAccessType(members)~region(us)', 'Group', 'group', 'US'],
  ];
  for (const [flags, label, type, region] of cases) {
    writeLog(session(flags, ['A', 'B', 'C'], ['B']));
    const i = vrLog.currentInstance();
    assert.deepEqual([i.world, i.instanceLabel, i.instanceType, i.region, i.players], ['Idle Defense', label, type, region, 2], flags || '(public)');
  }
  writeLog([...session('', ['A', 'B']), '[OnLeftRoom]']);
  assert.equal(vrLog.currentInstance().inWorld, false, 'after leaving a world you are not "in" one');
  writeLog([...session('', ['A', 'B', 'C']), '[Entering Room: Another World]', '[OnPlayerJoined Z]']);
  assert.deepEqual([vrLog.currentInstance().world, vrLog.currentInstance().players], ['Another World', 1], 'a new world starts a new count');
  process.env.VRMP_VRCHAT_LOG_DIR = path.join(tempDir(), 'no-vrchat-here');
  assert.deepEqual(vrLog.currentInstance(), { inWorld: false, world: '', instanceType: '', instanceLabel: '', region: '', players: null });
});

test('vrchat log: a photo knows the world it was taken in', () => {
  const dir = tempDir();
  assert.deepEqual(vrLog.photoInfo(fakePhoto(dir, 'a.png', "1's Optimized Box &amp; Co")), { world: "1's Optimized Box & Co", worldId: WORLD });
  fs.writeFileSync(path.join(dir, 'plain.png'), 'not a png');
  assert.deepEqual(vrLog.photoInfo(path.join(dir, 'plain.png')), { world: '', worldId: '' });
  assert.deepEqual(vrLog.photoInfo(path.join(dir, 'missing.png')), { world: '', worldId: '' });
});

test('vrchat captions: {world} {players} {slots} {free} {max} {instance} {region}; "?" when VRChat cannot say', async () => {
  const ctx = { hub: new StateHub() };
  writeLog(session('~private(usr_1)~region(eu)', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']));
  const text = '{world} {players} {instance} {region}';
  assert.equal(await fillVrchat(text, ctx, running()), 'Idle Defense 12 Invite EU');
  assert.equal(await fillVrchat('{slots} {free} {max}', ctx, running()), '{slots} {free} {max}', 'the instance size is not something VRChat tells us, so those placeholders do not exist');
  assert.equal(await fillVrchat('Live from {world}', ctx, { ...running(), file: fakePhoto(tempDir(), 'p.png', 'Older World') }), 'Live from Older World', 'a photo\'s own world wins');
  assert.equal(await fillVrchat(text, ctx, running(['explorer.exe'])), '? ? ? ?', 'VRChat is not running: no stale answers');
  assert.equal(await fillVrchat('no placeholders {time}', ctx, running()).then((s) => /^no placeholders \d\d:\d\d$/.test(s)), true);
});

test('vrchat captions: "only from public instances" refuses everywhere else, and when it cannot tell', async () => {
  writeLog(session(''));
  assert.deepEqual(await publicOnly(running()), { ok: true, reason: '' });
  writeLog(session('~private(usr_1)'));
  const invite = await publicOnly(running());
  assert.equal(invite.ok, false);
  assert.match(invite.reason, /Invite instance.*nothing was sent/);
  writeLog(session('~friends(usr_1)'));
  assert.equal((await publicOnly(running())).ok, false, 'friends-only is not public');
  assert.match((await publicOnly(running(['explorer.exe']))).reason, /Could not tell/, 'VRChat closed: not sent');
});

test('discord: the VRChat photo button puts the world and players in the caption, and its safety switch blocks non-public instances', async () => {
  const fake = await fakeDiscord();
  const photos = tempDir();
  fakePhoto(photos, 'VRChat_new.png', 'Idle Defense');
  const { ctx } = make(fake, { vrchatFolder: photos });
  ctx.helper.call = async (name) => (name === 'proc.list' ? ['discord.exe', 'vrchat.exe'] : null);
  writeLog(session('', ['A', 'B', 'C', 'D']));
  await act('discord.vrchat').run({ message: '{world}: {players} here ({instance}, {region})' }, ctx);
  assert.ok(fake.seen[0].body.toString().includes('"content":"Idle Defense: 4 here (Public, US)"'));
  await act('discord.vrchat').run({ message: '{players} players' }, ctx);
  assert.ok(fake.seen[1].body.toString().includes('"content":"4 players"'));

  writeLog(session('~private(usr_1)'));
  await assert.rejects(act('discord.vrchat').run({ message: 'x', onlyPublic: true }, ctx), /Invite instance/);
  assert.equal(fake.seen.length, 2, 'nothing was posted');
  await act('discord.vrchat').run({ message: 'x', onlyPublic: false }, ctx);
  assert.equal(fake.seen.length, 3, 'the switch is off by default, so it still sends');
  fake.close();
});

test('discord: automatic sharing of VRChat photos fills the caption and can skip non-public instances', async () => {
  const fake = await fakeDiscord();
  const photos = tempDir();
  const extra = { vrchatFolder: photos, screenshotFolders: '' };
  const runShare = async (params, dropPhoto) => {
    const hub = new StateHub();
    const rt = new DiscordRuntime({ hub, now: Date.now, settings: () => ({ webhookUrl: `${fake.base}/1/main`, ...extra }), emitStatus() {}, winHelper: () => ({ call: async () => ['vrchat.exe'] }) });
    fake.seen.length = 0;
    rt.setAutoShare(true, { steam: false, vrchat: true, ...params });
    await new Promise((r) => setTimeout(r, 40));
    dropPhoto();
    await rt.scan(); await rt.scan();
    const out = fake.seen.map((s) => s.body.toString());
    const status = rt.status();
    rt.setAutoShare(false);
    return { out, status };
  };
  const drop = (n) => () => fakePhoto(photos, `VRChat_${n}_${Math.random()}.png`, 'Event Hall');

  writeLog(session('', ['A', 'B', 'C']));
  let r = await runShare({ caption: '{world} {players} ({instance})' }, drop(1));
  assert.equal(r.out.length, 1);
  assert.ok(r.out[0].includes('"content":"Event Hall 3 (Public)"'), `the photo's own world, the live player count and instance type. Got: ${(/"content":"[^"]*"/.exec(r.out[0]) || ['(no content)'])[0]}`);

  writeLog(session('~private(usr_1)'));
  r = await runShare({ onlyPublic: true, caption: 'x' }, drop(2));
  assert.equal(r.out.length, 0, 'not posted from an invite instance');
  assert.equal(r.status.state, 'error');
  assert.match(r.status.error, /Skipped a VRChat photo.*Invite instance/, 'and the connections list says why');
  r = await runShare({ onlyPublic: false, caption: 'x' }, drop(3));
  assert.equal(r.out.length, 1, 'without the switch it posts as before');
  fake.close();
});

test('discord: only messages and cards use {scene} / {song}; picture captions leave them alone, and {scene} switches OBS on', async () => {
  const fake = await fakeDiscord();
  const photos = tempDir();
  fs.writeFileSync(path.join(photos, 'a.png'), 'PIC');
  const { ctx, hub } = make(fake);
  hub.set('obs.scene', 'Just Chatting');
  await act('discord.send').run({ message: 'On {scene}, playing {song}' }, ctx);
  assert.equal(fake.json().content, 'On Just Chatting, playing Song X', 'messages still get them');
  await act('discord.file').run({ source: 'newest', path: photos, message: 'Photo at {time} on {scene} ({song})' }, ctx);
  const body = fake.seen.at(-1).body.toString();
  assert.match(body, /"content":"Photo at \d\d:\d\d on \{scene\} \(\{song\}\)"/, 'a picture caption keeps {scene} and {song} as typed');
  // the button asks for OBS only when it uses {scene}
  assert.deepEqual(act('discord.send').needs({ message: 'Now on {scene}' }), { obs: true });
  assert.deepEqual(act('discord.send').needs({ message: 'Hello' }), {});
  assert.deepEqual(act('discord.embed').needs({ title: 'Live', description: 'Scene: {scene}' }), { obs: true });
  assert.deepEqual(act('discord.embed').needs({ title: 'Live' }), {});
  for (const id of ['discord.file', 'discord.vrchat', 'discord.autoshare']) {
    const help = act(id).params.filter((p) => p.key === 'message').map((p) => p.help).join(' ');
    assert.ok(!/\{scene\}|\{song\}|\{artist\}|\{track\}/.test(help), id + ' no longer advertises OBS or music placeholders');
  }
  fake.close();
});
