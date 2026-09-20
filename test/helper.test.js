// Talks to the real compiled Windows helper. Read-only: nothing here mutes, switches
// devices, or types into a window.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Helper } = require('../src/core/helper');
const { tempDir } = require('./helpers');

const onWindows = process.platform === 'win32';
let helper;

test.before(() => {
  if (!onWindows) return;
  helper = new Helper(path.join(tempDir('vrmd-helper-'), 'build'));
  helper.start();
});

test.after(() => { if (helper) helper.stop(); });

test('helper: builds with the Windows compiler and answers ping', { skip: !onWindows }, async () => {
  assert.equal(helper.status, 'ok');
  assert.equal(await helper.call('ping'), 'pong');
});

test('helper: lists audio devices with ids, names and exactly one default per direction', { skip: !onWindows }, async () => {
  for (const flow of ['render', 'capture']) {
    const list = await helper.call('audio.devices', { flow });
    assert.ok(Array.isArray(list));
    for (const d of list) {
      assert.equal(typeof d.id, 'string');
      assert.equal(typeof d.name, 'string');
      assert.ok(d.name.length > 0);
    }
    if (list.length) assert.equal(list.filter((d) => d.isDefault).length, 1, `${flow}: one default`);
  }
});

test('helper: snapshot reports mute state and a 0-100 volume for the default devices', { skip: !onWindows }, async () => {
  const snap = await helper.call('audio.snapshot');
  for (const flow of ['render', 'capture']) {
    if (!snap[flow]) continue; // no such device on this machine
    assert.equal(typeof snap[flow].muted, 'boolean');
    assert.ok(snap[flow].volume >= 0 && snap[flow].volume <= 100);
  }
});

test('helper: per-app sessions and process list', { skip: !onWindows }, async () => {
  const sessions = await helper.call('audio.sessions');
  assert.ok(Array.isArray(sessions));
  for (const s of sessions) assert.ok(typeof s.name === 'string' && s.volume >= 0 && s.volume <= 100);
  const procs = await helper.call('proc.list');
  assert.ok(procs.length > 10);
  assert.ok(procs.every((n) => n === n.toLowerCase() && n.endsWith('.exe')));
  assert.ok(procs.includes('node.exe'), 'sees this very test process');
});

test('helper: errors come back as messages and the helper keeps working', { skip: !onWindows }, async () => {
  await assert.rejects(helper.call('nope'), /Unknown op/);
  await assert.rejects(helper.call('audio.devices', { flow: 'sideways' }), /flow must be/);
  await assert.rejects(helper.call('audio.setSession', { process: 'definitely-not-running-xyz', volume: 50 }), /No audio session/);
  assert.equal(await helper.call('ping'), 'pong');
});

test('helper: SendInput works (a reserved no-op key code, so nothing visible happens)', { skip: !onWindows }, async () => {
  // 0xFF is not assigned to any key; this proves the injection path without typing anything.
  assert.equal(await helper.call('keys.combo', { vks: [0xff], holdMs: 5, scan: false }), true);
});

test('helper: handles a burst of concurrent calls', { skip: !onWindows }, async () => {
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => helper.call(i % 2 ? 'ping' : 'audio.snapshot')));
  assert.equal(results.length, 40);
  assert.equal(results[1], 'pong');
});

test('media helper: reads the current media session (read-only) or reports nothing playing', { skip: !onWindows }, async () => {
  const media = new Helper(path.join(tempDir('vrmd-media-'), 'build'), 'media');
  try {
    assert.equal(await media.call('ping'), 'pong');
    const info = await media.call('get', { app: 'any' });
    assert.equal(typeof info.available, 'boolean');
    assert.ok(Array.isArray(info.sessions));
    if (info.available) {
      for (const k of ['appId', 'title', 'artist', 'album', 'status', 'thumbKey']) assert.equal(typeof info[k], 'string', k);
      assert.ok(['Playing', 'Paused', 'Stopped', 'Opened', 'Changing', 'Closed'].includes(info.status));
      assert.ok(info.positionMs >= 0);
      if (info.thumb) assert.match(info.thumb, /^data:image\/[a-z]+;base64,/);
      const again = await media.call('get', { app: 'any', knownThumbKey: info.thumbKey });
      assert.equal(again.thumb, '', 'the picture is not sent again when the caller already has it');
    }
    // an app that is not running is "not available", not an error
    const none = await media.call('get', { app: 'definitely-not-running-xyz' });
    assert.equal(none.available, false);
    await assert.rejects(media.call('control', { app: 'definitely-not-running-xyz', cmd: 'toggle' }), /No media player is running/);
    await assert.rejects(media.call('bogus'), /Unknown op/);
  } finally { media.stop(); }
});

test('SteamVR helper: connects only if SteamVR is already running, and never starts it', { skip: !onWindows }, async () => {
  const vr = new Helper(path.join(tempDir('vrmd-vr-'), 'build'), 'vr');
  try {
    assert.equal(await vr.call('ping'), 'pong');
    const snap = await vr.call('snapshot');
    assert.equal(typeof snap.connected, 'boolean');
    assert.ok(Array.isArray(snap.devices));
    if (!snap.connected) {
      assert.match(snap.error, /SteamVR/);
      assert.equal(snap.devices.length, 0);
    } else {
      for (const d of snap.devices) {
        assert.ok(['hmd', 'controller', 'tracker', 'basestation', 'other'].includes(d.class));
        assert.equal(typeof d.serial, 'string');
        if (d.hasBattery) assert.ok(d.battery >= -1 && d.battery <= 100);
      }
    }
    await assert.rejects(vr.call('bogus'), /Unknown op/);
  } finally { vr.stop(); }
});
