// The SteamVR overlay's brain: settings, where the panel sits (anchors), sizes, matrix maths, and the
// wire format for pictures. Pure functions only (no SteamVR, no Electron), so it is all unit-tested.
//
// Coordinates follow OpenVR: right-handed, +X right, +Y up, -Z forward. An overlay is a flat picture facing +Z.
// A 3x4 matrix is a plain array of 12 numbers, row by row (the same layout as OpenVR's HmdMatrix34_t).

const ANCHORS = ['front', 'room', 'wrist'];
const HANDS = ['left', 'right'];
const UPLOADS = ['auto', 'raw'];
const RESOLUTIONS = [768, 1024, 1536, 2048]; // picture width in pixels; the height follows the aspect
const ASPECT = 1.6; // width / height of the picture (16:10)
const WIDTH_LIMITS = { min: 0.1, max: 3 }; // meters
const SIZE_STEPS = [0.15, 0.2, 0.3, 0.4, 0.55, 0.7, 0.9, 1.2, 1.6, 2.2, 3];

// Where each anchor puts the panel by default. Position in meters, angles in degrees, relative to the thing it
// follows: your head (front), the play space (room) or a controller (wrist).
// Controllers differ (where their tracking point is), so each controller type and hand also keeps its own adjusted
// wrist position, learned when you snap or turn the panel in VR (see wristKey).
const DEFAULT_OFFSETS = {
  front: { x: 0, y: -0.12, z: -0.9, yaw: 0, pitch: -10, roll: 0 }, // in front, a little below eye level, tilted up to you
  room: { x: 0, y: 1.25, z: -1, yaw: 0, pitch: -5, roll: 0 }, // in the room, 1 m ahead of the play-space centre
  wrist: { x: 0, y: 0.05, z: 0.08, yaw: 0, pitch: -75, roll: 0 }, // on top of the forearm, top edge toward the fingers
};
const DEFAULT_WIDTHS = { front: 0.7, room: 0.9, wrist: 0.28 };
const SNAP_RADIUS = 0.35; // meters: drop the panel this close to a wrist and it snaps onto it
const MAX_WRIST_ADJUSTMENTS = 16;

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

function normalizeOffset(src, def) {
  const o = src && typeof src === 'object' ? src : {};
  return {
    x: round(clampNum(o.x, -5, 5, def.x)), y: round(clampNum(o.y, -5, 5, def.y)), z: round(clampNum(o.z, -5, 5, def.z)),
    yaw: round(clampNum(o.yaw, -180, 180, def.yaw), 2), pitch: round(clampNum(o.pitch, -180, 180, def.pitch), 2), roll: round(clampNum(o.roll, -180, 180, def.roll), 2),
  };
}

// "knuckles:left". The controller type is what SteamVR reports (knuckles = Valve Index, oculus_touch = Quest / Touch,
// vive_controller, holographic_controller...). Unknown types share "generic".
const WRIST_KEY = /^[A-Za-z0-9_.-]{1,40}:(left|right)$/;
function wristKey(controllerType, hand) {
  const type = String(controllerType || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'generic';
  return `${type}:${hand === 'right' ? 'right' : 'left'}`;
}

// The wrist position to use for this controller type: yours if you adjusted it, else the default.
function wristOffsetFor(o, controllerType) {
  return o.wristOffsets[wristKey(controllerType, o.hand)] || o.wristOffsets[wristKey('', o.hand)] || o.offsets.wrist;
}

// A small change to an offset: turn it in its own plane (roll), tilt it (pitch), swing it (yaw) or flip it over.
function adjustOffset(offset, kind, amount = 0) {
  const o = { ...offset };
  const wrap = (a) => { let v = a % 360; if (v > 180) v -= 360; if (v <= -180) v += 360; return round(v, 2); };
  if (kind === 'roll') o.roll = wrap(o.roll + amount);
  else if (kind === 'pitch') o.pitch = wrap(o.pitch + amount);
  else if (kind === 'yaw') o.yaw = wrap(o.yaw + amount);
  else if (kind === 'flip') o.roll = wrap(o.roll + 180);
  return normalizeOffset(o, offset);
}

function defaultOverlay() {
  const offsets = {};
  for (const k of ANCHORS) offsets[k] = { ...DEFAULT_OFFSETS[k] };
  return {
    enabled: false,
    anchor: 'front',
    hand: 'left', // which forearm the wrist anchor uses
    wristOffsets: {}, // your adjusted wrist position per "controllerType:hand", e.g. "knuckles:left"
    widths: { ...DEFAULT_WIDTHS }, // meters, one per anchor
    offsets,
    opacity: 1,
    curvature: 0, // 0 flat .. 1 strongly curved
    resolution: 1024,
    locked: false, // the pin: no grabbing while set
    collapsed: false, // shrunk to a small tab
    hidden: false, // not shown at all (hotkey / desktop switch brings it back)
    glance: false, // only visible while you are looking at it (made for the wrist)
    showBar: true, // the little tool strip on the overlay
    pages: [], // which pages the overlay shows; empty = all
    hotkey: '',
    diagnostics: false, // the on-overlay readout used to check everything in one session
    dim: 0, // "dim the view": how dark the black sheet in front of the eyes is (0 to 0.9)
    upload: 'auto', // how pictures reach SteamVR: auto (GPU texture, the smooth way) or raw (copy pixels, the compatible way)
  };
}

// Anything the UI (or a hand-edited config) sends becomes a valid overlay section.
function normalizeOverlay(input) {
  const d = defaultOverlay();
  const o = input && typeof input === 'object' ? input : {};
  const offsets = {};
  const widths = {};
  for (const k of ANCHORS) {
    offsets[k] = normalizeOffset(o.offsets && o.offsets[k], d.offsets[k]);
    widths[k] = round(clampNum(o.widths && o.widths[k], WIDTH_LIMITS.min, WIDTH_LIMITS.max, d.widths[k]), 3);
  }
  const wristOffsets = {};
  if (o.wristOffsets && typeof o.wristOffsets === 'object') {
    for (const key of Object.keys(o.wristOffsets).filter((k) => WRIST_KEY.test(k)).slice(0, MAX_WRIST_ADJUSTMENTS)) wristOffsets[key] = normalizeOffset(o.wristOffsets[key], d.offsets.wrist);
  }
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    anchor: ANCHORS.includes(o.anchor) ? o.anchor : d.anchor,
    hand: HANDS.includes(o.hand) ? o.hand : d.hand,
    wristOffsets,
    widths,
    offsets,
    opacity: round(clampNum(o.opacity, 0.1, 1, d.opacity), 2),
    curvature: round(clampNum(o.curvature, 0, 1, d.curvature), 2),
    resolution: RESOLUTIONS.includes(Number(o.resolution)) ? Number(o.resolution) : d.resolution,
    locked: typeof o.locked === 'boolean' ? o.locked : d.locked,
    collapsed: typeof o.collapsed === 'boolean' ? o.collapsed : d.collapsed,
    hidden: typeof o.hidden === 'boolean' ? o.hidden : d.hidden,
    glance: typeof o.glance === 'boolean' ? o.glance : d.glance,
    showBar: typeof o.showBar === 'boolean' ? o.showBar : d.showBar,
    pages: Array.isArray(o.pages) ? [...new Set(o.pages.filter((p) => typeof p === 'string').map((p) => p.slice(0, 40)))].slice(0, 30) : d.pages,
    hotkey: typeof o.hotkey === 'string' ? o.hotkey.slice(0, 40).trim() : d.hotkey,
    diagnostics: typeof o.diagnostics === 'boolean' ? o.diagnostics : d.diagnostics,
    dim: typeof o.dim === 'number' && Number.isFinite(o.dim) ? Math.round(Math.max(0, Math.min(0.9, o.dim)) * 100) / 100 : d.dim,
    upload: UPLOADS.includes(o.upload) ? o.upload : d.upload,
  };
}

// ---- 3x4 matrices ----
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function mul3(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}

// Rotation = yaw about Y, then pitch about X, then roll about Z (applied to the panel in that order).
function rotation(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(rad(yaw)), Math.sin(rad(yaw)), Math.cos(rad(pitch)), Math.sin(rad(pitch)), Math.cos(rad(roll)), Math.sin(rad(roll))];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  return mul3(mul3(ry, rx), rz);
}

function fromOffset(o) {
  const r = rotation(o.yaw || 0, o.pitch || 0, o.roll || 0);
  return [r[0][0], r[0][1], r[0][2], o.x || 0, r[1][0], r[1][1], r[1][2], o.y || 0, r[2][0], r[2][1], r[2][2], o.z || 0];
}

// The inverse of fromOffset (for turning a grabbed position back into numbers people can read and tweak).
function toOffset(m) {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  const flat = Math.abs(Math.cos(pitch)) < 1e-6; // looking straight up/down: roll and yaw are the same thing
  const yaw = flat ? Math.atan2(-m[8], m[0]) : Math.atan2(m[2], m[10]);
  const roll = flat ? 0 : Math.atan2(m[4], m[5]);
  return { x: round(m[3]), y: round(m[7]), z: round(m[11]), yaw: round(deg(yaw), 2), pitch: round(deg(pitch), 2), roll: round(deg(roll), 2) };
}

// a then b: the result applies b first, then a.
function multiply(a, b) {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
    out[i * 4 + 3] = a[i * 4] * b[3] + a[i * 4 + 1] * b[7] + a[i * 4 + 2] * b[11] + a[i * 4 + 3];
  }
  return out;
}

// Inverse of a rotation + translation matrix.
function invert(m) {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = m[j * 4 + i];
  for (let i = 0; i < 3; i++) out[i * 4 + 3] = -(out[i * 4] * m[3] + out[i * 4 + 1] * m[7] + out[i * 4 + 2] * m[11]);
  return out;
}

const isMatrix = (m) => Array.isArray(m) && m.length === 12 && m.every((v) => Number.isFinite(v));

// ---- where the panel goes ----
// What the SteamVR side needs to place the panel:
//   { mode: 'device', role: 'hmd'|'left'|'right', serial, matrix }  follows a device (matrix = offset from it)
//   { mode: 'absolute', matrix }                                             fixed in the room
// ctx.controllerType: what the wrist controller is (from SteamVR), so its own adjusted position is used.
function placement(o, ctx = {}) {
  const offset = o.anchor === 'wrist' ? wristOffsetFor(o, ctx.controllerType) : o.offsets[o.anchor];
  const matrix = fromOffset(offset);
  if (o.anchor === 'room') return { mode: 'absolute', role: '', serial: '', matrix, widthMeters: o.widths.room };
  if (o.anchor === 'front') return { mode: 'device', role: 'hmd', serial: '', matrix, widthMeters: o.widths.front };
  return { mode: 'device', role: o.hand, serial: '', matrix, widthMeters: o.widths.wrist };
}

// "Bring it to me" for the room anchor: 1 m ahead of where you are looking (level, ignoring head tilt),
// a little below eye height, facing you. `hmd` is the headset's pose in the room.
function inFrontOf(hmd, distance = 1) {
  const fx = -hmd[2]; // the headset's forward (-Z) direction on the floor plane
  const fz = -hmd[10];
  const len = Math.hypot(fx, fz) || 1;
  const [dx, dz] = [fx / len, fz / len];
  const yaw = deg(Math.atan2(-dx, -dz)); // turns the panel's +Z (its front) toward you
  return { x: round(hmd[3] + dx * distance), y: round(hmd[7] - 0.12), z: round(hmd[11] + dz * distance), yaw: round(yaw, 2), pitch: -5, roll: 0 };
}

// ---- sizes ----
function clampWidth(w) {
  return round(Math.min(WIDTH_LIMITS.max, Math.max(WIDTH_LIMITS.min, Number(w) || WIDTH_LIMITS.min)), 3);
}

// One step bigger (dir > 0) or smaller (dir < 0) along the preset sizes.
function stepWidth(current, dir) {
  const w = clampWidth(current);
  if (dir > 0) return SIZE_STEPS.find((s) => s > w + 0.005) || SIZE_STEPS[SIZE_STEPS.length - 1];
  return [...SIZE_STEPS].reverse().find((s) => s < w - 0.005) || SIZE_STEPS[0];
}

function pictureSize(resolution) {
  const width = RESOLUTIONS.includes(resolution) ? resolution : 1024;
  return { width, height: Math.round(width / ASPECT) };
}

// Overlay mouse events use the picture's own coordinates with the origin at the BOTTOM left (OpenGL style);
// a web page wants the top left.
function toPagePoint(x, y, size, flipY = true) {
  return { x: Math.round(Math.max(0, Math.min(size.width - 1, x))), y: Math.round(Math.max(0, Math.min(size.height - 1, flipY ? size.height - y : y))) };
}

// ---- the picture wire format (Electron -> SteamVR helper, over a local pipe) ----
// 16-byte header: 'VRMF', width u32, height u32, target u32 (0 = the floating deck, 1 = the SteamVR dashboard entry);
// then width*height*4 bytes of BGRA pixels.
const FRAME_MAGIC = 'VRMF';
const FRAME_HEADER = 16;

function encodeFrame(width, height, bgra, target = 0) {
  if (bgra.length !== width * height * 4) throw new Error(`Frame is ${bgra.length} bytes, expected ${width * height * 4}`);
  const head = Buffer.alloc(FRAME_HEADER);
  head.write(FRAME_MAGIC, 0, 'ascii');
  head.writeUInt32LE(width, 4);
  head.writeUInt32LE(height, 8);
  head.writeUInt32LE(target, 12);
  return Buffer.concat([head, bgra]);
}

// Pulls whole frames out of a stream of chunks (a pipe delivers them in arbitrary pieces).
class FrameReader {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < FRAME_HEADER) return;
      if (this.buf.toString('ascii', 0, 4) !== FRAME_MAGIC) throw new Error('Bad frame header');
      const width = this.buf.readUInt32LE(4);
      const height = this.buf.readUInt32LE(8);
      const total = FRAME_HEADER + width * height * 4;
      if (this.buf.length < total) return;
      this.onFrame({ width, height, target: this.buf.readUInt32LE(12), pixels: this.buf.subarray(FRAME_HEADER, total) });
      this.buf = this.buf.subarray(total);
    }
  }
}

module.exports = {
  ANCHORS, HANDS, UPLOADS, RESOLUTIONS, ASPECT, WIDTH_LIMITS, SIZE_STEPS, DEFAULT_OFFSETS, DEFAULT_WIDTHS, IDENTITY,
  SNAP_RADIUS, MAX_WRIST_ADJUSTMENTS, wristKey, wristOffsetFor, adjustOffset, normalizeOffset,
  defaultOverlay, normalizeOverlay, fromOffset, toOffset, multiply, invert, isMatrix, placement, inFrontOf,
  clampWidth, stepWidth, pictureSize, toPagePoint, encodeFrame, FrameReader, FRAME_HEADER,
};
