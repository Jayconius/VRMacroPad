// The Voicemod plugin, run against a simulated Voicemod Control API (ws://localhost:59129/v1/).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createApp } = require('../src/core');
const { StateHub } = require('../src/core/state');
const { FakeHelper, tempDir, waitFor } = require('./helpers');
const { VoicemodRuntime } = require('../plugins/voicemod/runtime');
const actions = require('../plugins/voicemod/actions');
const manifest = require('../plugins/voicemod/plugin');

const act = (id) => actions.find((a) => a.id === id);
const KEY = 'my-client-key';

// A stand-in for Voicemod: greeting, registerClient (200 or 401), the status getters, toggles that answer with the new value
// (and, like the real one, tell every client about a change), voices and soundboard.
async function fakeVoicemod({ key = KEY, port = 0, hang = false, voices, memes, boards } = {}) {
  const seen = [];
  const st = { voiceChanger: false, mic: false, hear: false, background: false, voice: 'nofx' };
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((r) => wss.on('listening', r));
  const VOICES = voices || [{ id: 'nofx', friendlyName: 'Clean', enabled: true }, { id: 'cave', friendlyName: 'Cave', enabled: true, favorited: true }, { id: 'fcd21253-0d43-46fa-aa3e-d0d598500b5f', friendlyName: 'Robot Boss', enabled: true, isCustom: true }, { id: 'hidden', friendlyName: 'Locked', enabled: false }];
  const MEMES = memes || [{ Name: 'Airhorn', FileName: '80', Type: 'PlayRestart', Image: 'AAAA' }, { Name: 'Applause', FileName: '12', Type: 'PlayHold', Image: 'BBBB' }, { Name: 'Gong', FileName: '33', Type: 'PlayStop', Image: 'CCCC' }];
  const BOARDS = boards || [
    { id: 'b1', name: 'Party', enabled: true, sounds: [{ id: '80', name: 'Airhorn', favorited: true }, { id: '33', name: 'Gong' }] },
    { id: 'b2', name: 'Calm', enabled: true, sounds: [{ id: '12', name: 'Applause' }, { id: '33', name: 'Gong' }] },
    { id: 'b3', name: 'Off one', enabled: false, sounds: [{ id: '80', name: 'Airhorn' }] },
    { id: 'b4', name: 'Mine', enabled: true, isCustom: true, sounds: [{ id: '80', name: 'Airhorn' }, { id: '12', name: 'Applause' }] },
  ];
  const TOGGLES = { toggleVoiceChanger: 'voiceChanger', toggleMuteMic: 'mic', toggleHearMyVoice: 'hear', toggleBackground: 'background' };
  const STATUS = { getVoiceChangerStatus: 'voiceChanger', getMuteMicStatus: 'mic', getHearMyselfStatus: 'hear', getBackgroundEffectStatus: 'background' };
  wss.on('connection', (ws) => {
    const out = (obj) => ws.send(JSON.stringify({ appVersion: '3.17.18', ...obj }));
    const broadcast = (obj) => { for (const c of wss.clients) c.send(JSON.stringify({ appVersion: '3.17.18', ...obj })); };
    out({ msg: 'Pending authentication', server: 'Kestrel' });
    let authed = false;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      seen.push({ action: m.action, payload: m.payload });
      if (hang) return;
      const reply = (actionObject) => out({ actionType: m.action, actionObject, actionID: m.id, id: m.id });
      if (m.action === 'registerClient') {
        authed = m.payload.clientKey === key;
        out({ action: 'registerClient', actionID: m.id, id: m.id, actionType: 'registerClient', actionObject: { status: authed ? { code: 200, description: 'Authorized' } : { code: 401, description: 'Unauthorized' } }, payload: { status: authed ? { code: 200, description: 'Authorized' } : { code: 401, description: 'Unauthorized' } } });
        if (!authed) ws.close(1000);
        return;
      }
      if (!authed) return;
      if (m.action === 'getVoices') return reply({ voices: VOICES, currentVoice: st.voice });
      if (m.action === 'getCurrentVoice') return reply({ voiceID: st.voice, parameters: [] });
      if (m.action === 'getMemes') return reply({ listOfMemes: MEMES });
      if (m.action === 'getAllSoundboard') return reply({ soundboards: BOARDS });
      if (STATUS[m.action]) return reply({ value: st[STATUS[m.action]] });
      if (TOGGLES[m.action]) { st[TOGGLES[m.action]] = !st[TOGGLES[m.action]]; reply({ value: st[TOGGLES[m.action]] }); return broadcast({ actionType: m.action, actionObject: { value: st[TOGGLES[m.action]] } }); }
      if (m.action === 'loadVoice') { st.voice = m.payload.voiceID; reply({}); return broadcast({ actionType: 'voiceChangedEvent', actionObject: { voiceID: st.voice } }); }
      reply({});
    });
  });
  return { seen, st, port: wss.address().port, push: (obj) => { for (const c of wss.clients) c.send(JSON.stringify({ appVersion: '3.17.18', ...obj })); }, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); } };
}

function runtimeFor(port, settings = {}, options = {}) {
  const hub = new StateHub();
  const emitted = [];
  const ctx = { hub, settings: () => ({ host: '127.0.0.1', port, clientKey: KEY, ...settings }), emitStatus: () => emitted.push(1) };
  const rt = new VoicemodRuntime(ctx, options);
  rt.configure();
  return { rt, hub, emitted };
}
const toastCtx = (rt) => { const toasts = []; return { toasts, ctx: { plugin: () => rt, toast: (t, l) => toasts.push([t, l]) } }; };

test('voicemod: registers with the client key, then follows the voice changer, mute, hear-myself, background and current voice', async () => {
  const vm = await fakeVoicemod();
  const { rt, hub } = runtimeFor(vm.port);
  rt.sync({ voicemod: true });
  await waitFor(() => rt.status().state === 'connected' && hub.eval('voicemod.voice=nofx') === true);
  assert.deepEqual(vm.seen[0], { action: 'registerClient', payload: { clientKey: KEY } });
  for (const k of ['voicemod.voiceChanger', 'voicemod.micMuted', 'voicemod.hearMyself', 'voicemod.background']) assert.equal(hub.get(k), false, k);
  // changed in Voicemod itself: the events reach the buttons
  vm.push({ actionType: 'toggleMuteMic', actionObject: { value: true } });
  await waitFor(() => hub.get('voicemod.micMuted') === true);
  vm.push({ actionType: 'voiceChangedEvent', actionObject: { voiceID: 'cave' } });
  await waitFor(() => hub.eval('voicemod.voice=cave') === true);
  assert.equal(hub.eval('voicemod.voice=Cave'), true, 'a button that stores the voice name lights up too');
  assert.equal(hub.eval('voicemod.voice=Clean'), false);
  vm.push({ actionType: 'voiceChangerEnabledEvent', actionObject: {} });
  await waitFor(() => hub.get('voicemod.voiceChanger') === true);
  vm.push({ actionType: 'voiceChangerDisabledEvent', actionObject: {} });
  await waitFor(() => hub.get('voicemod.voiceChanger') === false);
  rt.stop();
  await waitFor(() => rt.status().state === 'off');
  assert.equal(hub.get('voicemod.micMuted'), undefined, 'state is forgotten when nothing needs Voicemod');
  vm.close();
});

test('voicemod: lists your voices and soundboard by NAME (never internal ids), only the usable ones, no pictures', async () => {
  const vm = await fakeVoicemod();
  const { rt } = runtimeFor(vm.port);
  assert.deepEqual(await rt.voices(), [
    { value: 'Cave', label: 'Cave', hint: '' },
    { value: 'Clean', label: 'Clean', hint: '' },
    { value: 'Robot Boss', label: 'Robot Boss', hint: 'community' },
  ]);
  assert.ok((await rt.voices()).every((v) => v.value === v.label), 'what the list shows and stores is the name');
  assert.ok(!(await rt.voices()).some((v) => v.value.includes('fcd21253')), 'no raw id in the list');
  assert.deepEqual(await rt.sounds(), [
    { value: 'Airhorn', label: 'Airhorn', hint: 'Party' },
    { value: 'Applause', label: 'Applause', hint: 'Calm' },
    { value: 'Gong', label: 'Gong', hint: 'Party' },
  ], 'the note is the soundboard (the first one, for a sound on two)');
  assert.deepEqual(await rt.check(), await rt.voices());
  assert.deepEqual(await manifest.optionLists['voicemod.voices']({ plugins: { get: () => rt } }), await rt.voices());
  rt.stop();
  vm.close();
});

test('voicemod: two voices or sounds with the same name are told apart by id in the list', async () => {
  const vm = await fakeVoicemod({
    voices: [{ id: 'a-1', friendlyName: 'Deep', enabled: true }, { id: 'a-2', friendlyName: 'deep', enabled: true }, { id: 'a-3', friendlyName: 'Solo', enabled: true }],
    memes: [{ Name: 'Pop', FileName: '1', Type: 'PlayRestart' }, { Name: 'POP', FileName: '2', Type: 'PlayRestart' }, { Name: 'Bang', FileName: '3', Type: 'PlayRestart' }, { Name: 'Twin', FileName: '4', Type: 'PlayRestart' }, { Name: 'Twin', FileName: '5', Type: 'PlayRestart' }],
    boards: [{ id: 'A', name: 'Alpha', enabled: true, sounds: [{ id: '1' }, { id: '4' }, { id: '5' }, { id: '3' }] }, { id: 'B', name: 'Beta', enabled: true, sounds: [{ id: '2' }] }],
  });
  const { rt } = runtimeFor(vm.port);
  const { ctx } = toastCtx(rt);
  assert.deepEqual((await rt.voices()).map((v) => v.value).sort(), ['Deep #1', 'Solo', 'deep #2'], 'two voices with one name are numbered, never shown as an id');
  assert.deepEqual((await rt.sounds()).map((v) => v.value).sort(), ['Bang', 'POP (Beta)', 'Pop (Alpha)', 'Twin (Alpha) #1', 'Twin (Alpha) #2'], 'a repeated name is told apart by soundboard, and numbered when the soundboard is the same too');
  await assert.rejects(act('voicemod.voice').run({ voice: 'DEEP' }, ctx), /More than one Voicemod voice is called "DEEP"/);
  await assert.rejects(act('voicemod.sound').run({ sound: 'pop' }, ctx), /More than one Voicemod sound is called "pop"/);
  await act('voicemod.voice').run({ voice: 'a-2' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'loadVoice').at(-1).payload, { voiceID: 'a-2' });
  await act('voicemod.voice').run({ voice: 'deep #2' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'loadVoice').at(-1).payload, { voiceID: 'a-2' }, 'the numbered value the list gave finds the right voice');
  await act('voicemod.sound').run({ sound: 'twin (alpha) #2' }, ctx);
  await waitFor(() => vm.seen.filter((s) => s.action === 'playMeme').filter((x) => x.payload.FileName === '5').length === 2);
  await act('voicemod.sound').run({ sound: 'POP (beta)' }, ctx);
  await waitFor(() => vm.seen.filter((s) => s.action === 'playMeme').filter((x) => x.payload.FileName === '2').length === 2);
  assert.ok(vm.seen.some((s) => s.action === 'playMeme' && s.payload.FileName === '2'), 'the name with its soundboard finds the right sound');
  rt.stop();
  vm.close();
});

test('voicemod: ONE List dropdown for sounds: all sounds first, then your soundboards, then Voicemod\'s, with true counts', async () => {
  const vm = await fakeVoicemod();
  const { rt } = runtimeFor(vm.port);
  assert.deepEqual(await rt.soundLists(), [
    { value: 'all', label: 'All sounds (3)' },
    { value: 'board:Mine', label: 'Mine (2 sounds) · yours' },
    { value: 'board:Party', label: 'Party (2 sounds)' },
    { value: 'board:Calm', label: 'Calm (2 sounds)' },
  ], 'switched-off soundboards are left out; no made-up entries');
  assert.deepEqual((await rt.sounds({ list: 'all' })).map((x) => x.label), ['Airhorn', 'Applause', 'Gong'], 'All sounds is everything');
  assert.deepEqual((await rt.sounds({})).map((x) => x.label), ['Airhorn', 'Applause', 'Gong'], 'no list chosen yet: still everything');
  assert.deepEqual((await rt.sounds({ list: 'board:Party' })).map((x) => x.label), ['Airhorn', 'Gong']);
  assert.deepEqual((await rt.sounds({ list: 'board:Calm' })).map((x) => x.hint), ['', ''], 'inside one soundboard there is no note naming a different one');
  assert.deepEqual((await rt.sounds({ list: 'board:calm' })).map((x) => x.label), ['Applause', 'Gong'], 'any capitals');
  assert.deepEqual(await rt.sounds({ list: 'board:Nothing here' }), []);
  for (const l of await rt.soundLists()) {
    const n = Number(/\((\d+)/.exec(l.label)[1]);
    assert.equal((await rt.sounds({ list: l.value })).length, n, `"${l.label}" really holds ${n} sounds`);
  }
  assert.deepEqual((await manifest.optionLists['voicemod.sounds']({ plugins: { get: () => rt } }, { list: 'board:Calm' })).map((x) => x.label), ['Applause', 'Gong']);
  const params = act('voicemod.sound').params;
  assert.deepEqual(params.map((x) => x.key), ['list', 'sound']);
  assert.equal(params[0].default, 'all', 'a new button starts on the complete list');
  assert.equal(params[1].optionsFilter[0], 'list');
  rt.stop();
  vm.close();
});

test('voicemod: a sound you have just added to a soundboard shows up at once (before Voicemod puts it in its sound list)', async () => {
  const vm = await fakeVoicemod({
    memes: [{ Name: 'Old', FileName: '1', Type: 'PlayRestart' }],
    boards: [{ id: 'M', name: 'asdasdasdasd', enabled: true, isCustom: true, sounds: [{ id: '1', name: 'Old' }, { id: 'new-9', name: 'GGEZ', playbackMode: 'PlayRestart' }] }],
  });
  const { rt } = runtimeFor(vm.port);
  const { ctx } = toastCtx(rt);
  assert.deepEqual(await rt.soundLists(), [{ value: 'all', label: 'All sounds (2)' }, { value: 'board:asdasdasdasd', label: 'asdasdasdasd (2 sounds) · yours' }]);
  assert.deepEqual((await rt.sounds({ list: 'board:asdasdasdasd' })).map((x) => x.label), ['GGEZ', 'Old']);
  assert.deepEqual((await rt.sounds({ list: 'all' })).map((x) => [x.label, x.hint]), [['GGEZ', 'asdasdasdasd'], ['Old', 'asdasdasdasd']]);
  await act('voicemod.sound').run({ list: 'board:asdasdasdasd', sound: 'GGEZ' }, ctx);
  await waitFor(() => vm.seen.some((x) => x.action === 'playMeme' && x.payload.FileName === 'new-9'));
  rt.stop();
  vm.close();
});

test('voicemod: ONE List dropdown for voices: all, Voicemod\'s, Community, with true counts', async () => {
  const vm = await fakeVoicemod();
  const { rt } = runtimeFor(vm.port);
  const { ctx } = toastCtx(rt);
  assert.deepEqual(await rt.voiceLists(), [
    { value: 'all', label: 'All voices (3)' },
    { value: 'voicemod', label: 'Voicemod voices (2)' },
    { value: 'community', label: 'Community voices (1)' },
  ]);
  const all = await rt.voices({ list: 'all' });
  assert.deepEqual(all.map((v) => v.label), ['Cave', 'Clean', 'Robot Boss'], 'All voices is everything');
  assert.deepEqual(await rt.voices({}), all, 'no list chosen yet: still everything');
  assert.deepEqual((await rt.voices({ list: 'voicemod' })).map((v) => v.label), ['Cave', 'Clean']);
  assert.deepEqual((await rt.voices({ list: 'community' })).map((v) => v.label), ['Robot Boss']);
  assert.deepEqual(await rt.voices({ list: 'nonsense' }), []);
  for (const l of await rt.voiceLists()) {
    const n = Number(/\((\d+)/.exec(l.label)[1]);
    const got = await rt.voices({ list: l.value });
    assert.equal(got.length, n, `"${l.label}" really holds ${n} voices`);
    for (const v of got) assert.deepEqual(v, all.find((x) => x.label === v.label), 'a narrowed list gives every voice exactly the value it has in the full list');
  }
  assert.equal(all.find((v) => v.label === 'Robot Boss').hint, 'community', 'a community voice is tagged');
  const params = act('voicemod.voice').params;
  assert.deepEqual(params.map((x) => x.key), ['list', 'voice']);
  assert.equal(params[0].default, 'all', 'a new button starts on the complete list');
  assert.equal(params[0].optionsFrom, 'voicemod.voiceLists');
  assert.equal(params[1].optionsFilter[0], 'list');
  assert.deepEqual(act('voicemod.random').params.map((x) => [x.key, x.optionsFrom, x.default]), [['list', 'voicemod.voiceLists', 'all']], 'Random voice uses the same List');
  // a list is only a way to find a voice: pressing the button works the same
  await act('voicemod.voice').run({ list: 'community', voice: 'Robot Boss' }, ctx);
  assert.deepEqual(vm.seen.filter((x) => x.action === 'loadVoice').at(-1).payload, { voiceID: 'fcd21253-0d43-46fa-aa3e-d0d598500b5f' });
  // random from a list is picked here, from exactly that list
  for (let i = 0; i < 6; i++) await act('voicemod.random').run({ list: 'voicemod' }, ctx);
  const picked = new Set(vm.seen.filter((x) => x.action === 'loadVoice').slice(-6).map((x) => x.payload.voiceID));
  assert.ok([...picked].every((id) => ['cave', 'nofx'].includes(id)), 'only voices from that list');
  await assert.rejects(act('voicemod.random').run({ list: 'nonsense' }, ctx), /list is empty/);
  rt.stop();
  vm.close();
});

test('voicemod: switches the voice changer, mute, hear-myself and background on, off or by toggling (Voicemod itself only toggles)', async () => {
  const vm = await fakeVoicemod();
  const { rt, hub } = runtimeFor(vm.port);
  const { ctx, toasts } = toastCtx(rt);
  rt.sync({ voicemod: true });
  await act('voicemod.mute').run({ mode: 'toggle' }, ctx);
  assert.equal(vm.st.mic, true);
  assert.equal(hub.get('voicemod.micMuted'), true);
  assert.equal(toasts.at(-1)[0], 'Voicemod microphone muted');
  await act('voicemod.mute').run({ mode: 'toggle' }, ctx);
  assert.equal(vm.st.mic, false, 'the second press unmutes');

  const toggles = () => vm.seen.filter((s) => /^toggle/.test(s.action)).length;
  const before = toggles();
  await act('voicemod.mute').run({ mode: 'off' }, ctx);
  assert.equal(toggles(), before, '"off" while already off sends no toggle');
  await act('voicemod.mute').run({ mode: 'on' }, ctx);
  await act('voicemod.mute').run({ mode: 'on' }, ctx);
  assert.equal(vm.st.mic, true, '"on" twice ends on, not off');
  assert.equal(toggles(), before + 1, 'only one toggle was needed');

  await act('voicemod.changer').run({ mode: 'on' }, ctx);
  assert.equal(vm.st.voiceChanger, true);
  await act('voicemod.hear').run({ mode: 'toggle' }, ctx);
  assert.equal(vm.st.hear, true);
  await act('voicemod.background').run({}, ctx);
  assert.equal(vm.st.background, true, 'toggle is the default');
  assert.equal(hub.get('voicemod.background'), true);
  rt.stop();
  vm.close();
});

test('voicemod: changes voice, picks a random one, plays a sound (press then release) and stops the sounds', async () => {
  const vm = await fakeVoicemod();
  const { rt, hub } = runtimeFor(vm.port);
  const { ctx, toasts } = toastCtx(rt);
  rt.sync({ voicemod: true });
  await act('voicemod.voice').run({ voice: 'Cave' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'loadVoice').at(-1).payload, { voiceID: 'cave' }, 'a name is turned into the id Voicemod uses');
  assert.equal(hub.eval('voicemod.voice=Cave'), true);
  assert.equal(act('voicemod.voice').state({ voice: 'Cave' }), 'voicemod.voice=Cave', 'the button lights up while that voice is in use');
  await act('voicemod.voice').run({ voice: 'robot BOSS' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'loadVoice').at(-1).payload, { voiceID: 'fcd21253-0d43-46fa-aa3e-d0d598500b5f' }, 'any capitals, and a long id is found from the name');
  assert.equal(hub.eval('voicemod.voice=Robot Boss'), true);
  await act('voicemod.voice').run({ voice: 'nofx' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'loadVoice').at(-1).payload, { voiceID: 'nofx' }, 'an id typed by hand still works');
  await assert.rejects(act('voicemod.voice').run({ voice: '  ' }, ctx), /Pick a Voicemod voice/);
  await assert.rejects(act('voicemod.voice').run({ voice: 'Nonexistent' }, ctx), /no voice called "Nonexistent"/);
  assert.equal(vm.seen.filter((s) => s.action === 'loadVoice').length, 3, 'the wrong ones never reached Voicemod');

  await act('voicemod.random').run({ list: 'all' }, ctx);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'selectRandomVoice').at(-1).payload, {});

  await act('voicemod.sound').run({ sound: 'airhorn' }, ctx);
  await waitFor(() => vm.seen.filter((s) => s.action === 'playMeme').length === 2);
  assert.deepEqual(vm.seen.filter((s) => s.action === 'playMeme').map((s) => s.payload), [{ FileName: '80', IsKeyDown: true }, { FileName: '80', IsKeyDown: false }], 'a sound name is turned into its file');
  await assert.rejects(act('voicemod.sound').run({ sound: '' }, ctx), /Pick a Voicemod sound/);
  await assert.rejects(act('voicemod.sound').run({ sound: 'Nope' }, ctx), /no sound called "Nope"/);
  await act('voicemod.stopSounds').run({}, ctx);
  assert.ok(vm.seen.some((s) => s.action === 'stopAllMemeSounds'));
  assert.equal(toasts.at(-1)[0], 'Stopped the Voicemod sounds');
  rt.stop();
  vm.close();
});

test('voicemod: explains a wrong key, a missing key and a Voicemod that is not running, in plain words', async () => {
  const vm = await fakeVoicemod();
  const wrong = runtimeFor(vm.port, { clientKey: 'nope' });
  await assert.rejects(wrong.rt.check(), /did not accept the client key/);
  assert.equal(wrong.rt.status().state, 'auth-failed');
  wrong.rt.stop();

  const none = runtimeFor(vm.port, { clientKey: '' });
  await assert.rejects(none.rt.check(), /needs a client key.*Instructions/);
  assert.equal(vm.seen.length >= 1, true);
  none.rt.stop();

  const port = vm.port;
  vm.close();
  const off = runtimeFor(port);
  const { ctx } = toastCtx(off.rt);
  off.rt.sync({ voicemod: true });
  await waitFor(() => off.rt.status().state === 'error');
  assert.match(off.rt.status().error, /Can't reach Voicemod at 127.0.0.1:\d+.*running/);
  assert.ok(off.emitted.length >= 1, 'the Settings dot is told');
  await assert.rejects(act('voicemod.mute').run({}, ctx), /Can't reach Voicemod/);
  off.rt.stop();
});

test('voicemod: finds Voicemod by itself when it starts later', async () => {
  const first = await fakeVoicemod();
  const port = first.port;
  first.close();
  const { rt, hub } = runtimeFor(port);
  rt.sync({ voicemod: true });
  await waitFor(() => rt.status().state === 'error');
  const later = await fakeVoicemod({ port });
  await waitFor(() => rt.status().state === 'connected' && hub.eval('voicemod.voice=nofx') === true, 8000, 50);
  assert.equal(rt.status().error, '');
  rt.stop();
  later.close();
});

test('voicemod: a stalled Voicemod is reported and nothing is left hanging', async () => {
  const vm = await fakeVoicemod({ hang: true });
  const { rt } = runtimeFor(vm.port, {}, { timeoutMs: 200 });
  rt.sync({ voicemod: true });
  await new Promise((r) => setTimeout(r, 500));
  assert.notEqual(rt.status().state, 'connected', 'it never registered, so it never claims to be connected');
  await assert.rejects(rt.client.request('getVoices'), /Not connected/);
  rt.stop();
  vm.close();
});

test('voicemod: the address and port from Settings are checked, and the defaults are localhost:59129', () => {
  const defaults = manifest.settingsFields.reduce((o, f) => ({ ...o, [f.key]: f.default }), {});
  assert.equal(defaults.clientKey, '');
  assert.equal(defaults.host, 'localhost');
  assert.equal(defaults.port, 59129);
  assert.ok(Object.entries(defaults).filter(([k]) => /^group\d/.test(k)).every(([k, v]) => (/Name$/.test(k) ? v === '' : Array.isArray(v) && v.length === 0)), 'the voice soundboards start empty');
  assert.equal(manifest.settingsFields.find((f) => f.key === 'clientKey').type, 'password');
  for (const bad of ['evil.example/path', 'http://x', 'a b', 'x@y', 'x:1']) {
    const { rt } = runtimeFor(1, { host: bad });
    assert.throws(() => rt.client.target(), /not a valid host name/, bad);
  }
  const { rt } = runtimeFor(70000);
  assert.throws(() => rt.client.target(), /between 1 and 65535/);
});

test('voicemod: loads like any other plugin, has its Instructions, and needs nothing outside its own folder', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  await app.start();
  assert.deepEqual(app.registry.errors.filter((e) => /voicemod/.test(e.dir)), []);
  const m = app.registry.get('voicemod');
  assert.ok(m);
  assert.deepEqual(m.actions.map((a) => a.id).sort(), ['voicemod.background', 'voicemod.changer', 'voicemod.hear', 'voicemod.mute', 'voicemod.random', 'voicemod.sound', 'voicemod.stopSounds', 'voicemod.voice']);
  assert.equal(m.testOptionKind, 'voicemod.test');
  assert.deepEqual(m.matchState('voicemod.micMuted'), { voicemod: true });
  assert.equal(m.matchState('ts3.micMuted'), null);
  assert.equal(m.guide.steps.length, 3);
  assert.deepEqual(m.settingsFields.map((f) => f.key), ['clientKey', 'host', 'port'], 'settings are just the key and the connection');
  assert.deepEqual(m.settingsFields.filter((f) => f.advanced).map((f) => f.key), ['host', 'port'], 'Advanced only holds the connection');
  assert.ok(m.guide.steps[0].links.every((l) => m.externalDomains.includes(new URL(l.url).hostname)), 'every link opens on a domain the plugin declares');
  await app.stop();
  const dir = path.join(__dirname, '..', 'plugins', 'voicemod');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const outside = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]).filter((p) => p.startsWith('.') && !p.startsWith('./'));
    assert.deepEqual(outside, [], `${f} only requires files inside its own folder`);
  }
});
