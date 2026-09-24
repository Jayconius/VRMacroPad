// What VRChat leaves on this PC about where you are: its output log (the world, the instance type and region, and every
// player who joins or leaves) and the hidden metadata inside its PNG photos (the world each photo was taken in).
// Everything here is read-only and works offline. It never reads or keeps player NAMES beyond counting them, and it never
// needs a VRChat login. VRChat does not write an instance's maximum size anywhere on disk, so that is not available here.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const defaultDir = () => process.env.VRMP_VRCHAT_LOG_DIR || path.join(process.env.USERPROFILE || '', 'AppData', 'LocalLow', 'VRChat', 'VRChat');
const TAIL_BYTES = 12 * 1024 * 1024; // long sessions make big logs; the latest world is always near the end

function newestLog(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^output_log_.*\.txt$/.test(f)); } catch { return null; }
  const withTime = files.map((f) => { try { return { p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } }).filter(Boolean);
  return withTime.sort((a, b) => b.t - a.t)[0] || null;
}

function readTail(file) {
  const size = fs.statSync(file).size;
  if (size <= TAIL_BYTES) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    return buf.toString('utf8').replace(/^[^\n]*\n/, ''); // drop the (probably cut) first line
  } finally { fs.closeSync(fd); }
}

// "wrld_x:24534~private(usr_y)~canRequestInvite~region(eu)" -> a plain-words access level.
function describeInstance(joining) {
  const flags = new Map();
  for (const m of String(joining).matchAll(/~([A-Za-z]+)(?:\(([^)]*)\))?/g)) flags.set(m[1], m[2] === undefined ? true : m[2]);
  const has = (k) => flags.has(k);
  let type = 'public', label = 'Public';
  if (has('hidden')) { type = 'friends+'; label = 'Friends+'; }
  else if (has('friends')) { type = 'friends'; label = 'Friends'; }
  else if (has('private')) { type = has('canRequestInvite') ? 'invite+' : 'invite'; label = has('canRequestInvite') ? 'Invite+' : 'Invite'; }
  else if (has('group')) {
    const access = String(flags.get('groupAccessType') || '').toLowerCase();
    type = 'group'; label = access === 'public' ? 'Group Public' : access === 'plus' ? 'Group+' : access === 'members' ? 'Group' : 'Group';
  }
  const region = String(flags.get('region') || 'us').toUpperCase();
  return { type, label, region };
}

// Reads the newest log and works out where you are right now.
// -> { inWorld, world, instanceType, instanceLabel, region, players } (players is a number, or null when it cannot be known)
function currentInstance(dir = defaultDir()) {
  const unknown = { inWorld: false, world: '', instanceType: '', instanceLabel: '', region: '', players: null };
  const log = newestLog(dir);
  if (!log) return unknown;
  let text;
  try { text = readTail(log.p); } catch { return unknown; }
  let world = '', inst = null, inWorld = false;
  let players = new Set();
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /\[Behaviour\] Entering Room: (.+?)\s*$/.exec(line))) { world = m[1]; inWorld = true; players = new Set(); }
    else if ((m = /\[Behaviour\] Joining (wrld_[^\s]+)/.exec(line))) inst = describeInstance(m[1].replace(/^wrld_[0-9a-f-]+:[^~\s]*/i, ''));
    else if ((m = /\[Behaviour\] OnPlayerJoined (.+?)\s*$/.exec(line))) players.add(m[1]);
    else if ((m = /\[Behaviour\] OnPlayerLeft (.+?)\s*$/.exec(line))) players.delete(m[1]);
    else if (/\[Behaviour\] OnLeftRoom|\[Behaviour\] Successfully left room/.test(line)) { inWorld = false; players = new Set(); }
  }
  if (!inWorld) return { ...unknown, world };
  return { inWorld, world, instanceType: inst ? inst.type : '', instanceLabel: inst ? inst.label : '', region: inst ? inst.region : '', players: players.size };
}

// PNG text chunks: VRChat writes XMP (world id + name, author) into each photo it saves.
function photoInfo(file) {
  const out = { world: '', worldId: '' };
  let b;
  try { b = fs.readFileSync(file); } catch { return out; }
  if (b.length < 16 || b.toString('latin1', 1, 4) !== 'PNG') return out;
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
    if (type === 'IEND' || i + 12 + len > b.length) break;
    if (type === 'iTXt') {
      const data = b.subarray(i + 8, i + 8 + len);
      const nul = data.indexOf(0);
      if (data.toString('latin1', 0, nul) === 'XML:com.adobe.xmp') {
        try {
          const compressed = data[nul + 1] === 1;
          let j = data.indexOf(0, nul + 3) + 1; j = data.indexOf(0, j) + 1;
          const xml = (compressed ? zlib.inflateSync(data.subarray(j)) : data.subarray(j)).toString('utf8');
          const grab = (tag) => { const m = new RegExp(`<vrc:${tag}>([^<]*)</vrc:${tag}>`).exec(xml); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : ''; };
          out.world = grab('WorldDisplayName');
          out.worldId = grab('WorldID');
        } catch { /* a damaged text chunk: no world name */ }
        break;
      }
    }
    i += 12 + len;
  }
  return out;
}

module.exports = { currentInstance, photoInfo, describeInstance, newestLog };
