// VRChat details for captions: {world} {players} {instance} {region}, and an optional "only from public instances" guard.
// All read from files VRChat writes on this PC (see src/core/vrchat-log.js); nothing here needs a VRChat login, the API or OSC.
// Anything VRChat does not give (or when it is not running) shows as "?".
const { currentInstance, photoInfo } = require('../../src/core/vrchat-log');
const { fill } = require('./text');

const TOKEN = /\{(world|players|instance|region)\}/;
const TOKENS = /\{(world|players|instance|region)\}/g;

// Is VRChat actually running? Its log keeps saying "in a world" after it closes, so the log alone cannot tell.
async function vrchatRunning(procs) {
  try { const list = await procs(); return Array.isArray(list) ? list.includes('vrchat.exe') : true; } catch { return true; }
}

// opts: { procs: async () => ['name.exe', ...], file: a photo whose own world name to use }
async function instanceNow(opts) {
  const none = { inWorld: false, world: '', instanceType: '', instanceLabel: '', region: '', players: null };
  return (await vrchatRunning(opts.procs)) ? currentInstance() : none;
}

async function fillVrchat(text, ctx, opts = {}) {
  const base = fill(text, ctx, undefined, ['time', 'date']); // a picture caption: no OBS scene or music here
  if (!TOKEN.test(base)) return base;
  const inst = await instanceNow(opts);
  const photo = opts.file ? photoInfo(opts.file) : { world: '' };
  const players = inst.inWorld && Number.isFinite(inst.players) ? inst.players : null;
  const values = {
    world: photo.world || (inst.inWorld ? inst.world : '') || '?',
    players: players === null ? '?' : String(players),
    instance: inst.instanceLabel || '?',
    region: inst.region || '?',
  };
  return base.replace(TOKENS, (_, k) => values[k]);
}

// The guard for "only send from public instances": { ok, reason }. When it cannot tell where you are, it does NOT send.
async function publicOnly(opts) {
  const inst = await instanceNow(opts);
  if (!inst.inWorld) return { ok: false, reason: 'Could not tell which VRChat instance you are in, so nothing was sent (you asked for public instances only).' };
  if (inst.instanceType !== 'public') return { ok: false, reason: `You are in a ${inst.instanceLabel || 'non-public'} instance, so nothing was sent (you asked for public instances only).` };
  return { ok: true, reason: '' };
}

module.exports = { fillVrchat, publicOnly, vrchatRunning };
