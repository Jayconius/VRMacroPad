// Holds the latest known value of everything a button can react to.
//
// Values are stored under a "base" key (e.g. "obs.recording" -> true,
// "obs.scene" -> "Gaming", "proc" -> { "vrchat.exe": true }). A lookup key can
// carry an argument after "=": "obs.scene=Gaming" is true while the scene is
// Gaming, "proc=vrchat.exe" is true while that process runs.
const { EventEmitter } = require('events');

class StateHub extends EventEmitter {
  constructor() {
    super();
    this.values = new Map();
  }

  set(base, value) {
    const prev = this.values.get(base);
    if (JSON.stringify(prev) === JSON.stringify(value)) return false;
    this.values.set(base, value);
    this.emit('change', base);
    return true;
  }

  remove(base) {
    if (this.values.delete(base)) this.emit('change', base);
  }

  // Returns true/false, or undefined while nothing is known about the key yet.
  eval(key) {
    if (!key) return undefined;
    const eq = key.indexOf('=');
    const base = eq === -1 ? key : key.slice(0, eq);
    const arg = eq === -1 ? null : key.slice(eq + 1);
    if (!this.values.has(base)) return undefined;
    const v = this.values.get(base);
    if (arg === null) return Boolean(v);
    if (v && typeof v === 'object') return Boolean(v[arg]);
    return String(v) === arg;
  }

  get(base) {
    return this.values.get(base);
  }
}

module.exports = { StateHub };
