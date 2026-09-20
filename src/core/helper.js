// Manages a long-lived Windows helper process and turns it into promise calls.
// There are three: "audio" (keys + audio), "media" (media sessions) and "vr" (SteamVR).
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const { buildHelper } = require('../../scripts/build-helper');

const MAX_QUICK_RESTARTS = 4;

class Helper extends EventEmitter {
  // buildDir: where the compiled exe lives (kept outside app.asar when packaged).
  constructor(buildDir, kind = 'audio') {
    super();
    this.buildDir = buildDir;
    this.kind = kind;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.status = 'off'; // off | starting | ok | error
    this.error = '';
    this.stopped = false;
    this.restarts = 0;
    this.restartTimer = null;
  }

  setStatus(status, error = '') {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.emit('status', status);
  }

  start() {
    if (this.proc || this.stopped) return;
    if (process.platform !== 'win32') {
      this.setStatus('error', 'The Windows helper only runs on Windows');
      return;
    }
    this.setStatus('starting');
    let exe;
    try {
      exe = buildHelper(this.buildDir, this.kind);
    } catch (err) {
      this.setStatus('error', err.message);
      return;
    }
    const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(exe) });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this.onExit(proc, err.message));
    proc.on('exit', (code) => this.onExit(proc, `helper exited (${code})`));
    this.setStatus('ok');
  }

  onExit(proc, reason) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.stopped) return;
    this.setStatus('error', reason);
    // Restart after a pause so one crash does not kill audio/keys for the session, but give up
    // after a few quick failures in a row so a broken helper cannot spin forever.
    if (this.restarts++ < MAX_QUICK_RESTARTS) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.start(), 2000);
    }
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    this.restarts = 0;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'Helper error'));
  }

  call(op, args = {}, timeoutMs = 8000) {
    if (!this.proc) this.start();
    if (!this.proc) return Promise.reject(new Error(this.error || 'Windows helper is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Helper timed out on ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  // Ends the process but lets a later call() start it again (e.g. the SteamVR link is only
  // kept open while a battery widget is on screen).
  release() {
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    this.restarts = 0;
    if (proc) {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Helper released')); }
      this.pending.clear();
      try { proc.stdin.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    }
    this.setStatus('off');
  }

  stop() {
    this.stopped = true;
    this.release();
  }
}

module.exports = { Helper, defaultBuildDir: () => path.join(__dirname, '..', '..', '.helper-build') };
