const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCombo } = require('../src/core/keys');
const { encode, decode, OscSender, OscListener } = require('../src/core/osc');
const { waitFor } = require('./helpers');

test('keys: combos map to virtual-key codes in order', () => {
  assert.deepEqual(parseCombo('ctrl+shift+M').vks, [0x11, 0x10, 0x4d]);
  assert.deepEqual(parseCombo('alt+tab').vks, [0x12, 0x09]);
  assert.deepEqual(parseCombo('F13').vks, [0x7c]);
  assert.deepEqual(parseCombo('f24').vks, [0x87]);
  assert.deepEqual(parseCombo('win+d').vks, [0x5b, 0x44]);
  assert.deepEqual(parseCombo('num5').vks, [0x65]);
  assert.deepEqual(parseCombo('ctrl++').vks, [0x11, 0xbb]);
});

test('keys: unknown or empty keys are rejected with a clear message', () => {
  assert.throws(() => parseCombo('ctrl+banana'), /Unknown key "banana"/);
  assert.throws(() => parseCombo(''), /No keys/);
  assert.throws(() => parseCombo('f25'), /Unknown key/);
});

test('osc: encodes to the exact bytes VRChat expects', () => {
  // "/input/Voice" (12 chars + NUL = 13 -> padded to 16), ",i" padded to 4, int32 1
  const buf = encode('/input/Voice', [{ type: 'i', value: 1 }]);
  assert.equal(buf.length, 16 + 4 + 4);
  assert.equal(buf.toString('latin1', 0, 12), '/input/Voice');
  assert.equal(buf.toString('latin1', 16, 18), ',i');
  assert.equal(buf.readInt32BE(20), 1);
});

test('osc: round-trips every supported type', () => {
  const buf = encode('/chatbox/input', ['hello', true, false, 3, 0.5, { type: 'i', value: 0 }]);
  const [m] = decode(buf);
  assert.equal(m.address, '/chatbox/input');
  assert.deepEqual(m.args, ['hello', true, false, 3, 0.5, 0]);
});

test('osc: message without arguments and unpadded string boundaries decode', () => {
  assert.deepEqual(decode(encode('/ping', []))[0], { address: '/ping', args: [] });
  for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    assert.equal(decode(encode('/s', [s]))[0].args[0], s, `string "${s}"`);
  }
});

test('osc: bundles are unpacked', () => {
  const a = encode('/a', [1]);
  const c = encode('/c', [2]);
  const head = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8)]);
  const sz = (b) => { const x = Buffer.alloc(4); x.writeInt32BE(b.length); return x; };
  const msgs = decode(Buffer.concat([head, sz(a), a, sz(c), c]));
  assert.deepEqual(msgs.map((m) => m.address), ['/a', '/c']);
});

test('osc: rejects bad addresses', () => {
  assert.throws(() => encode('nope', []), /must start/);
});

test('osc: UDP loopback delivers a message to a listener', async () => {
  const listener = new OscListener(0, '127.0.0.1');
  // port 0 = any free port; read it back once bound
  const got = [];
  listener.on('message', (m) => got.push(m));
  listener.start();
  await waitFor(() => listener.socket && listener.socket.address && (() => { try { return listener.socket.address().port; } catch { return 0; } })());
  const sender = new OscSender();
  await sender.send('127.0.0.1', listener.socket.address().port, '/avatar/parameters/MuteSelf', [true]);
  await waitFor(() => got.length);
  assert.deepEqual(got[0], { address: '/avatar/parameters/MuteSelf', args: [true] });
  sender.close();
  listener.stop();
});
