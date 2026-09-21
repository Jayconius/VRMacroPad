// VRChat over OSC: game controls, movement, the chatbox with the time and the song, avatar parameter steps,
// custom OSC messages, and the extra states VRChat reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { defs, STATE_KEYS } = require('../src/core/actions');
const { fillTemplate } = require('../src/core/actions/vrchat');
const { createApp } = require('../src/core');
const { encode } = require('../src/core/osc');
const { tempDir, FakeHelper, waitFor, sleep } = require('./helpers');

function fakeCtx({ hub = {}, playing = null } = {}) {
  const sent = [];
  const remembered = {};
  const ctx = {
    sent,
    remembered,
    hub: { get: (k) => hub[k] },
    osc: { send: async (address, args) => { sent.push({ address, args }); } },
    oscTo: async (host, port, address, args) => { sent.push({ host, port, address, args }); },
    vrc: { remember: (n, v) => { remembered[n] = v; } },
    nowPlaying: () => playing,
  };
  return ctx;
}
const run = (id, p, ctx) => defs.get(id).run(p, ctx);
const ints = (ctx) => ctx.sent.map((s) => s.args[0].value);

test('vrchat: every new action is in the catalog and the extra states exist', () => {
  for (const id of ['input', 'axis', 'chatboxLive', 'chatboxClear', 'typing', 'paramStep']) assert.equal(defs.get(`vrc.${id}`).category, 'VRChat', id);
  assert.ok(defs.get('osc.custom'));
  for (const key of ['vrc.VRMode', 'vrc.AFK', 'vrc.Seated', 'vrc.Earmuffs', 'vrc.InStation']) assert.ok(STATE_KEYS.some((k) => k.key === key), key);
});

test('vrchat: a game control is let go, pressed, held for the right time and released, as VRChat needs', async () => {
  const ctx = fakeCtx();
  const t0 = Date.now();
  await run('vrc.input', { control: 'Jump', how: 'tap' }, ctx);
  assert.deepEqual(ctx.sent.map((s) => s.address), ['/input/Jump', '/input/Jump', '/input/Jump']);
  assert.deepEqual(ints(ctx), [0, 1, 0]);
  assert.ok(ctx.sent.every((s) => s.args[0].type === 'i'), 'buttons are whole numbers');
  assert.ok(Date.now() - t0 >= 100, 'a tap lasts a moment');

  const held = fakeCtx();
  const t1 = Date.now();
  await run('vrc.input', { control: 'Run', how: 'hold', ms: 250 }, held);
  assert.deepEqual(ints(held), [0, 1, 0]);
  assert.ok(Date.now() - t1 >= 240);

  const down = fakeCtx();
  await run('vrc.input', { control: 'MoveForward', how: 'down' }, down);
  assert.deepEqual(ints(down), [0, 1], 'stays pressed');
  const up = fakeCtx();
  await run('vrc.input', { control: 'MoveForward', how: 'up' }, up);
  assert.deepEqual(ints(up), [0]);

  await assert.rejects(() => run('vrc.input', { control: 'Jump; drop table', how: 'tap' }, fakeCtx()), /Pick a control/);
  await assert.rejects(() => run('vrc.input', { control: '../avatar/parameters/x', how: 'tap' }, fakeCtx()), /Pick a control/, 'only the known controls can be sent');
});

test('vrchat: movement runs for its time then stops, and the values stay in range', async () => {
  const ctx = fakeCtx();
  await run('vrc.axis', { axis: 'Vertical', value: 1, ms: 120 }, ctx);
  assert.deepEqual(ctx.sent.map((s) => [s.address, s.args[0].type, s.args[0].value]), [['/input/Vertical', 'f', 1], ['/input/Vertical', 'f', 0]]);
  const big = fakeCtx();
  await run('vrc.axis', { axis: 'LookHorizontal', value: -7, ms: 60 }, big);
  assert.equal(big.sent[0].args[0].value, -1, 'clamped to the range');
  const keep = fakeCtx();
  await run('vrc.axis', { axis: 'Horizontal', value: 0.5, ms: 0 }, keep);
  assert.equal(keep.sent.length, 1, 'time 0 leaves it on');
  await assert.rejects(() => run('vrc.axis', { axis: 'Nope', value: 1, ms: 10 }, fakeCtx()), /Pick a movement/);
  await assert.rejects(() => run('vrc.axis', { axis: 'Vertical', value: 'fast', ms: 10 }, fakeCtx()), /number/);
});

test('vrchat: the chatbox fills in the time and the song, and does nothing when nothing is playing', () => {
  const now = new Date(2026, 8, 21, 7, 5);
  const ctx = fakeCtx({ playing: { title: 'Song A', artist: 'Band B', playing: true } });
  assert.deepEqual(fillTemplate('It is {time} on {date}: {song} by {artist}', ctx, now), { text: 'It is 07:05 on 2026-09-21: Song A by Band B', playing: true });
  assert.equal(fillTemplate('{song}', fakeCtx(), now).playing, false);
});

test('vrchat: "chatbox with the song" sends the message, respects the 144 limit, and can insist on a playing song', async () => {
  const ctx = fakeCtx({ playing: { title: 'Song A', artist: 'Band B', playing: true } });
  await run('vrc.chatboxLive', { text: 'Now: {song} - {artist}', onlyPlaying: true, sound: false }, ctx);
  assert.deepEqual(ctx.sent[0], { address: '/chatbox/input', args: ['Now: Song A - Band B', true, false] });
  const long = fakeCtx({ playing: { title: 'x'.repeat(300), artist: '', playing: true } });
  await run('vrc.chatboxLive', { text: '{song}' }, long);
  assert.equal(long.sent[0].args[0].length, 144);
  const none = fakeCtx();
  await assert.rejects(() => run('vrc.chatboxLive', { text: 'Now: {song}', onlyPlaying: true }, none), /Nothing is playing/);
  await run('vrc.chatboxLive', { text: 'Time {time}', onlyPlaying: true }, none);
  assert.match(none.sent[0].args[0], /^Time \d\d:\d\d$/, 'a message without the song needs no music');
  assert.equal(defs.get('vrc.chatboxLive').needs({}).media[0], 'any', 'the song is only looked up when a button wants it');
  const clear = fakeCtx();
  await run('vrc.chatboxClear', {}, clear);
  assert.deepEqual(clear.sent[0], { address: '/chatbox/input', args: ['', true, false] });
  await run('vrc.typing', { on: true }, clear);
  assert.deepEqual(clear.sent[1], { address: '/chatbox/typing', args: [true] });
});

test('vrchat: parameter steps go up, down and around, from what VRChat last said', async () => {
  const p = { name: 'Outfit', type: 'int', mode: 'up', step: 1, min: 0, max: 3, wrap: true };
  const ctx = fakeCtx({ hub: { 'vrc.param': { Outfit: 2 } } });
  await run('vrc.paramStep', p, ctx);
  assert.deepEqual(ctx.sent[0], { address: '/avatar/parameters/Outfit', args: [{ type: 'i', value: 3 }] });
  assert.equal(ctx.remembered.Outfit, 3, 'the next press continues from here');
  const wrap = fakeCtx({ hub: { 'vrc.param': { Outfit: 3 } } });
  await run('vrc.paramStep', p, wrap);
  assert.equal(wrap.sent[0].args[0].value, 0, 'around to the start');
  const stop = fakeCtx({ hub: { 'vrc.param': { Outfit: 3 } } });
  await run('vrc.paramStep', { ...p, wrap: false }, stop);
  assert.equal(stop.sent[0].args[0].value, 3, 'or stop at the end');
  const down = fakeCtx({ hub: { 'vrc.param': { Outfit: 0 } } });
  await run('vrc.paramStep', { ...p, mode: 'down' }, down);
  assert.equal(down.sent[0].args[0].value, 3, 'down from the start goes around to the end');
  const slider = fakeCtx({ hub: { 'vrc.param': { Glow: 0.25 } } });
  await run('vrc.paramStep', { name: 'Glow', type: 'float', mode: 'up', step: 0.1, min: 0, max: 1, wrap: false }, slider);
  assert.deepEqual(slider.sent[0].args[0], { type: 'f', value: 0.35 });
  const fresh = fakeCtx();
  await run('vrc.paramStep', { ...p, name: 'New' }, fresh);
  assert.equal(fresh.sent[0].args[0].value, 1, 'unknown starts from the lowest');
  assert.deepEqual([...defs.get('vrc.paramStep').needs(p).vrcParams], ['Outfit']);
  await assert.rejects(() => run('vrc.paramStep', { ...p, name: '' }, fakeCtx()), /parameter name/);
  await assert.rejects(() => run('vrc.paramStep', { ...p, min: 5, max: 1 }, fakeCtx()), /highest/);
});

test('vrchat: a custom OSC message goes to VRChat by default, or to any host and port, with the right value type', async () => {
  const ctx = fakeCtx();
  await run('osc.custom', { address: '/avatar/parameters/Toggle', type: 'bool', value: '1' }, ctx);
  await run('osc.custom', { address: '/avatar/parameters/Toggle', type: 'bool', value: 'off' }, ctx);
  await run('osc.custom', { address: '/a/i', type: 'int', value: '7' }, ctx);
  await run('osc.custom', { address: '/a/f', type: 'float', value: '0.5' }, ctx);
  await run('osc.custom', { address: '/a/s', type: 'string', value: 'hello' }, ctx);
  assert.deepEqual(ctx.sent.map((s) => s.args[0]), [true, false, { type: 'i', value: 7 }, { type: 'f', value: 0.5 }, 'hello']);
  assert.ok(ctx.sent.every((s) => s.host === undefined), 'no host means the VRChat address from Settings');
  await run('osc.custom', { address: '/x', type: 'int', value: '1', host: '192.168.1.9', port: 7000 }, ctx);
  assert.deepEqual([ctx.sent.at(-1).host, ctx.sent.at(-1).port], ['192.168.1.9', 7000]);
  await assert.rejects(() => run('osc.custom', { address: 'no-slash', type: 'int', value: '1' }, ctx), /starts with/);
  await assert.rejects(() => run('osc.custom', { address: '/has space', type: 'int', value: '1' }, ctx), /no spaces/);
  await assert.rejects(() => run('osc.custom', { address: '/x', type: 'int', value: 'abc' }, ctx), /not a number/);
  await assert.rejects(() => run('osc.custom', { address: '/x', type: 'int', value: '1', host: '10.0.0.1' }, ctx), /port/);
});

// ---- real messages on the wire, and the states VRChat reports ----
test('vrchat: real UDP: a game control arrives as the OSC messages VRChat expects, and reported states reach buttons', async () => {
  const catcher = dgram.createSocket('udp4');
  const got = [];
  catcher.on('message', (buf) => got.push(buf));
  await new Promise((r) => catcher.bind(0, '127.0.0.1', r));
  const port = catcher.address().port;
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    const cfg = JSON.parse(JSON.stringify(app.engine.config));
    cfg.settings.osc.sendPort = port;
    cfg.settings.osc.listenPort = 0;
    cfg.pages = [{ id: 'p', name: 'P', cols: 4, rows: 2, buttons: [{ id: 'j', x: 0, y: 0, w: 1, h: 1, label: 'J', steps: [{ action: 'vrc.input', params: { control: 'Jump', how: 'tap' }, delayMs: 0 }] }] }];
    app.engine.updateConfig(cfg);
    await app.engine.press('j');
    await waitFor(() => got.length >= 3, 2000);
    assert.deepEqual(got.slice(0, 3).map((b) => b.toString('latin1', 0, 12)), Array(3).fill('/input/Jump\0'));
    assert.deepEqual(got[1].subarray(got[1].length - 4), Buffer.from([0, 0, 0, 1]), 'the middle message is the press');

    // messages VRChat sends about itself
    app.providers.onOsc({ address: '/avatar/parameters/AFK', args: [true] });
    app.providers.onOsc({ address: '/avatar/parameters/VRMode', args: [1] });
    app.providers.onOsc({ address: '/avatar/parameters/Seated', args: [false] });
    assert.equal(app.hub.eval('vrc.AFK'), true);
    assert.equal(app.hub.eval('vrc.VRMode'), true);
    assert.equal(app.hub.eval('vrc.Seated'), false);
    assert.ok(encode('/x', [1]).length > 0);
  } finally {
    catcher.close();
    await app.stop();
  }
});

test('vrchat: what is playing is found from the media players', async () => {
  const app = createApp({ dataDir: tempDir(), helper: new FakeHelper(), mediaHelper: new FakeHelper(), vrHelper: new FakeHelper(), port: 0, twitchOptions: { defaultClientId: '' }, pearOptions: { retryMs: 60000 } });
  try {
    await app.start();
    assert.equal(app.providers.nowPlaying(), null);
    app.providers.mediaInfo.set('a', { available: true, title: 'Paused one', artist: 'A', playing: false });
    app.providers.mediaInfo.set('b', { available: true, title: 'Playing one', artist: 'B', playing: true });
    assert.deepEqual(app.providers.nowPlaying(), { title: 'Playing one', artist: 'B', playing: true }, 'the one that is playing wins');
    app.providers.mediaInfo.delete('b');
    assert.equal(app.providers.nowPlaying().title, 'Paused one');
    await sleep(1);
  } finally { await app.stop(); }
});
