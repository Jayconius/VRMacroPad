// The overlay's pure logic: settings, anchors, matrix maths, sizes, and the picture wire format.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/core/overlay-logic');

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);
const nearAll = (a, b, eps = 1e-6, msg = '') => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`)); };
const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];

test('settings: defaults are valid and stable through normalizing', () => {
  const d = L.defaultOverlay();
  assert.deepEqual(L.normalizeOverlay(d), d);
  assert.deepEqual(L.normalizeOverlay(undefined), d);
  assert.deepEqual(L.normalizeOverlay('junk'), d);
  assert.equal(d.enabled, false, 'off until you turn it on');
  assert.equal(d.hand, 'left');
  assert.deepEqual(d.pages, [], 'all pages');
});

test('settings: hostile or broken input is clamped or ignored', () => {
  const o = L.normalizeOverlay({
    enabled: 'yes', anchor: 'ceiling', hand: 'foot', opacity: 9, curvature: -3, resolution: 5000, widths: { front: 99, wrist: 'x', room: -1 },
    offsets: { front: { x: 1e9, y: NaN, z: '2', yaw: 999, pitch: 'a', roll: null }, wrist: 'no' }, pages: ['a', 'a', 5, 'b'], hotkey: 'x'.repeat(200),
    locked: 1, trackerSerial: 5,
    wristOffsets: { 'knuckles:left': { x: 9, yaw: 400, roll: 'no' }, 'bad key': { x: 1 }, 'a:b': { x: 1 }, 'oculus_touch:right': { roll: 20 } },
  });
  assert.equal(o.enabled, false);
  assert.equal(o.anchor, 'front');
  assert.equal(o.hand, 'left');
  assert.equal(o.opacity, 1);
  assert.equal(o.curvature, 0);
  assert.equal(o.resolution, 1024);
  assert.equal(o.widths.front, 3, 'width limited to 3 m');
  assert.equal(o.widths.room, 0.1, 'and at least 10 cm');
  assert.equal(o.widths.wrist, L.DEFAULT_WIDTHS.wrist);
  assert.equal(o.offsets.front.x, 5);
  assert.equal(o.offsets.front.y, L.DEFAULT_OFFSETS.front.y);
  assert.equal(o.offsets.front.z, 2);
  assert.equal(o.offsets.front.yaw, 180);
  assert.equal(o.offsets.front.roll, L.DEFAULT_OFFSETS.front.roll);
  assert.deepEqual(o.offsets.wrist, L.DEFAULT_OFFSETS.wrist);
  assert.deepEqual(o.pages, ['a', 'b']);
  assert.equal(o.hotkey.length, 40);
  assert.equal(o.locked, false);
  assert.equal(o.glance, false);
  assert.equal(o.trackerSerial, undefined, 'there is no tracker anchor');
  assert.deepEqual(Object.keys(o.wristOffsets).sort(), ['knuckles:left', 'oculus_touch:right'], 'only well-formed controller:hand keys are kept');
  assert.equal(o.wristOffsets['knuckles:left'].x, 5);
  assert.equal(o.wristOffsets['knuckles:left'].yaw, 180);
  assert.equal(o.wristOffsets['knuckles:left'].roll, L.DEFAULT_OFFSETS.wrist.roll);
  assert.equal(o.wristOffsets['oculus_touch:right'].roll, 20);
});

test('matrices: an offset turns into a matrix and back into the same numbers', () => {
  for (const o of [{ x: 0.1, y: -0.2, z: 0.3, yaw: 25, pitch: -40, roll: 10 }, { x: 0, y: 0, z: 0, yaw: -170, pitch: 60, roll: -90 }, { x: 1, y: 2, z: -3, yaw: 0, pitch: -75, roll: 0 }, { x: 0, y: 1.25, z: -1, yaw: 90, pitch: -5, roll: 0 }]) {
    const back = L.toOffset(L.fromOffset(o));
    for (const k of Object.keys(o)) near(back[k], o[k], 0.006, k);
  }
  // straight down: yaw and roll are the same turn, so only the result has to agree
  const down = L.fromOffset({ x: 0, y: 0, z: 0, yaw: 30, pitch: -90, roll: 0 });
  nearAll(L.fromOffset(L.toOffset(down)), down, 1e-3);
});

test('matrices: multiply, invert and identity agree with each other', () => {
  const a = L.fromOffset({ x: 0.3, y: 0.4, z: -0.5, yaw: 33, pitch: 12, roll: -20 });
  const b = L.fromOffset({ x: -1, y: 2, z: 0.25, yaw: -80, pitch: 45, roll: 5 });
  nearAll(L.multiply(a, L.invert(a)), L.IDENTITY, 1e-9, 'a * a^-1');
  nearAll(L.multiply(L.invert(a), a), L.IDENTITY, 1e-9, 'a^-1 * a');
  nearAll(L.multiply(L.IDENTITY, b), b, 1e-12);
  const p = [0.7, -0.2, 1.1];
  nearAll(apply(L.multiply(a, b), p), apply(a, apply(b, p)), 1e-9, 'a*b applies b first');
  assert.ok(L.isMatrix(a));
  assert.equal(L.isMatrix([1, 2]), false);
  assert.equal(L.isMatrix(new Array(12).fill(NaN)), false);
});

test('anchors: the panel lands where its name says', () => {
  const o = L.defaultOverlay();
  const front = L.placement(o);
  assert.equal(front.mode, 'device');
  assert.equal(front.role, 'hmd');
  near(front.matrix[11], -0.9, 1e-9, 'front is 0.9 m ahead of the head (-Z)');
  assert.ok(front.matrix[7] < 0, 'and a little below eye level');
  const facing = apply(front.matrix, [0, 0, 1]).map((v, i) => v - front.matrix[[3, 7, 11][i]]);
  assert.ok(facing[2] > 0.9 && facing[1] > 0.1, 'its front faces back toward you, tilted up to your eyes');

  const wrist = L.placement({ ...o, anchor: 'wrist', hand: 'right' });
  assert.equal(wrist.role, 'right');
  assert.equal(wrist.widthMeters, L.DEFAULT_WIDTHS.wrist);
  const up = apply(wrist.matrix, [0, 0, 1]).map((v, i) => v - wrist.matrix[[3, 7, 11][i]]);
  assert.ok(up[1] > 0.9, 'the wrist panel faces up out of the forearm');
  const top = apply(wrist.matrix, [0, 1, 0]).map((v, i) => v - wrist.matrix[[3, 7, 11][i]]);
  assert.ok(top[2] < -0.2, 'and its top edge points toward the fingers (forward = -Z)');

  const room = L.placement({ ...o, anchor: 'room' });
  assert.equal(room.mode, 'absolute');
  near(room.matrix[7], 1.25);
  assert.equal(L.normalizeOverlay({ anchor: 'tracker' }).anchor, 'front', 'an old "tracker" setting falls back to the default');
});

test('wrist: each controller type and hand keeps its own adjusted position, and unknown ones share a generic one', () => {
  assert.equal(L.wristKey('knuckles', 'left'), 'knuckles:left');
  assert.equal(L.wristKey('Oculus_Touch', 'right'), 'oculus_touch:right');
  assert.equal(L.wristKey('', 'left'), 'generic:left');
  assert.equal(L.wristKey('we ird/type!', 'x'), 'weirdtype:left');
  const o = L.normalizeOverlay({ anchor: 'wrist', hand: 'left', wristOffsets: { 'knuckles:left': { ...L.DEFAULT_OFFSETS.wrist, roll: 90 } } });
  assert.equal(L.wristOffsetFor(o, 'knuckles').roll, 90, 'this controller type uses what you set');
  assert.equal(L.wristOffsetFor(o, 'oculus_touch').roll, 0, 'another type still has the default');
  assert.equal(L.placement(o, { controllerType: 'knuckles' }).matrix[4] !== L.placement(o, { controllerType: 'oculus_touch' }).matrix[4], true, 'and the panel really sits differently');
  const right = { ...o, hand: 'right' };
  assert.equal(L.wristOffsetFor(right, 'knuckles').roll, 0, 'the other hand is separate');
  const generic = L.normalizeOverlay({ anchor: 'wrist', wristOffsets: { 'generic:left': { ...L.DEFAULT_OFFSETS.wrist, roll: 45 } } });
  assert.equal(L.wristOffsetFor(generic, 'some_new_headset_controller').roll, 45, 'a type we have never seen falls back to the generic adjustment');
  assert.equal(L.placement(o, {}).role, 'left');
});

test('wrist: turning the panel in place, tilting it and flipping it', () => {
  const base = { ...L.DEFAULT_OFFSETS.wrist };
  assert.equal(L.adjustOffset(base, 'roll', 15).roll, 15);
  assert.equal(L.adjustOffset(L.adjustOffset(base, 'roll', 170), 'roll', 20).roll, -170, 'wraps around instead of passing 180');
  assert.equal(L.adjustOffset(base, 'pitch', -10).pitch, -85);
  assert.equal(L.adjustOffset(base, 'flip').roll, 180);
  assert.equal(L.adjustOffset(L.adjustOffset(base, 'flip'), 'flip').roll, 0, 'flipping twice is back where you were');
  assert.deepEqual(L.adjustOffset(base, 'nonsense', 5), base, 'unknown adjustments change nothing');
  // a roll turns the panel in its own plane: its centre does not move, its top edge does
  const before = L.fromOffset(base);
  const after = L.fromOffset(L.adjustOffset(base, 'roll', 90));
  assert.deepEqual([after[3], after[7], after[11]], [before[3], before[7], before[11]], 'the position stays put');
  const n0 = [before[2], before[6], before[10]];
  const n1 = [after[2], after[6], after[10]];
  n0.forEach((v, i) => assert.ok(Math.abs(v - n1[i]) < 1e-9, 'and it still faces the same way'));
});

test('anchors: "bring it to me" puts the panel ahead of where you look, facing you, at any heading', () => {
  // headset at (1, 1.6, 2) looking down -Z: no turn needed
  const straight = L.inFrontOf(L.fromOffset({ x: 1, y: 1.6, z: 2, yaw: 0, pitch: 0, roll: 0 }), 1);
  near(straight.x, 1); near(straight.y, 1.48); near(straight.z, 1); near(straight.yaw, 0);
  // looking down -X (turned 90 degrees): the panel is on that side, and turned so it faces you
  const left = L.inFrontOf(L.fromOffset({ x: 0, y: 1.5, z: 0, yaw: 90, pitch: 0, roll: 0 }), 2);
  near(left.x, -2); near(left.z, 0, 1e-6); near(left.yaw, 90, 0.01);
  const normal = apply(L.fromOffset(left), [0, 0, 1]);
  near(normal[0] - left.x, 1, 0.01, 'its front points at you (+X), tilted up 5 degrees');
  // tilting the head up or down does not change where it goes
  const tilted = L.inFrontOf(L.fromOffset({ x: 0, y: 1.5, z: 0, yaw: 0, pitch: 40, roll: 0 }), 1);
  near(tilted.z, -1, 1e-6); near(tilted.y, 1.38);
});

test('sizes: steps go up and down the presets and never past the limits', () => {
  assert.equal(L.stepWidth(0.7, 1), 0.9);
  assert.equal(L.stepWidth(0.7, -1), 0.55);
  assert.equal(L.stepWidth(0.75, 1), 0.9, 'from between two presets');
  assert.equal(L.stepWidth(0.75, -1), 0.7);
  assert.equal(L.stepWidth(3, 1), 3);
  assert.equal(L.stepWidth(0.15, -1), 0.15);
  assert.equal(L.stepWidth(50, -1), 2.2, 'out-of-range widths are clamped first');
  assert.equal(L.clampWidth('abc'), 0.1);
  assert.deepEqual(L.pictureSize(1024), { width: 1024, height: 640 });
  assert.deepEqual(L.pictureSize(99), { width: 1024, height: 640 });
  assert.deepEqual(L.pictureSize(1536), { width: 1536, height: 960 });
});

test('pointer: laser positions (origin bottom-left) become page positions (origin top-left)', () => {
  const size = { width: 1024, height: 640 };
  assert.deepEqual(L.toPagePoint(0, 0, size), { x: 0, y: 639 }, 'bottom-left of the picture is the last row');
  assert.deepEqual(L.toPagePoint(512, 640, size), { x: 512, y: 0 }, 'the top edge is row 0');
  assert.deepEqual(L.toPagePoint(100.4, 100, size), { x: 100, y: 540 });
  assert.deepEqual(L.toPagePoint(-5, 9999, size), { x: 0, y: 0 }, 'clamped inside the picture');
  assert.deepEqual(L.toPagePoint(100, 100, size, false), { x: 100, y: 100 }, 'unless the origin is already the top');
});

test('pictures: frames survive the pipe, however the bytes are chopped up', () => {
  const frames = [[4, 2], [3, 3], [8, 1]].map(([w, h], i) => ({ w, h, px: Buffer.alloc(w * h * 4, i + 1) }));
  const stream = Buffer.concat(frames.map((f) => L.encodeFrame(f.w, f.h, f.px)));
  for (const piece of [1, 7, 16, 33, stream.length]) {
    const got = [];
    const reader = new L.FrameReader((f) => got.push(f));
    for (let i = 0; i < stream.length; i += piece) reader.push(stream.subarray(i, i + piece));
    assert.equal(got.length, 3, `pieces of ${piece} bytes`);
    got.forEach((f, i) => { assert.equal(f.width, frames[i].w); assert.equal(f.height, frames[i].h); assert.ok(f.pixels.equals(frames[i].px)); });
  }
  assert.throws(() => L.encodeFrame(2, 2, Buffer.alloc(3)), /expected 16/);
  assert.throws(() => new L.FrameReader(() => {}).push(Buffer.alloc(20, 7)), /Bad frame header/);
});

test('pictures: each frame says which page it is for (the floating deck or the SteamVR dashboard)', () => {
  const stream = Buffer.concat([L.encodeFrame(4, 2, Buffer.alloc(32, 1)), L.encodeFrame(6, 3, Buffer.alloc(72, 2), 1)]);
  const got = [];
  new L.FrameReader((f) => got.push(f)).push(stream);
  assert.deepEqual(got.map((f) => [f.width, f.height, f.target]), [[4, 2, 0], [6, 3, 1]]);
});

test('settings: the picture path is auto or raw, nothing else', () => {
  assert.equal(L.normalizeOverlay({}).upload, 'auto');
  assert.equal(L.normalizeOverlay({ upload: 'raw' }).upload, 'raw');
  assert.equal(L.normalizeOverlay({ upload: 'fast' }).upload, 'auto');
  assert.equal(L.normalizeOverlay({ upload: 7 }).upload, 'auto');
});

test('settings: the dim level is a number from 0 to 0.9 and off by default', () => {
  assert.equal(L.normalizeOverlay({}).dim, 0);
  assert.equal(L.normalizeOverlay({ dim: 0.4 }).dim, 0.4);
  assert.equal(L.normalizeOverlay({ dim: 5 }).dim, 0.9, 'never fully black');
  assert.equal(L.normalizeOverlay({ dim: -1 }).dim, 0);
  assert.equal(L.normalizeOverlay({ dim: 'dark' }).dim, 0);
  assert.equal(L.normalizeOverlay({ dim: NaN }).dim, 0);
});
