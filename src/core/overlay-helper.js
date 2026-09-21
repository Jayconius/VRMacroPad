// Talks to the overlay helper program (src/helper/VrOverlay.cs): requests with answers, plus a stream of
// events (laser mouse, scroll, quit, log). Unlike the other helpers it also owns the local pipe that carries
// the picture, because the two go together.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { buildHelper } = require('../../scripts/build-helper');
const { encodeFrame } = require('./overlay-logic');

class OverlayHelper extends EventEmitter {
  constructor(buildDir) {
    super();
    this.buildDir = buildDir;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.status = 'off'; // off | ok | error
    this.error = '';
    this.pipeName = '';
    this.pipeServer = null;
    this.pipeSocket = null;
    this.framesSent = 0;
    this.framesDropped = 0;
    this.latest = new Map(); // target -> the newest picture that could not be written yet
  }

  get running() {
    return Boolean(this.proc);
  }

  start() {
    if (this.proc) return true;
    let exe;
    try {
      exe = buildHelper(this.buildDir, 'overlay');
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      return false;
    }
    const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(exe) });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this.onExit(proc, err.message));
    proc.on('exit', (code) => this.onExit(proc, `overlay helper exited (${code})`));
    this.status = 'ok';
    this.error = '';
    this.openPipe();
    return true;
  }

  onExit(proc, reason) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.closePipe();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
    if (this.status === 'ok') { this.status = 'error'; this.error = reason; }
    this.emit('exit', reason);
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ev) { this.emit('event', msg); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'Overlay helper request failed'));
  }

  call(op, args = {}, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('The overlay helper is not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Overlay helper did not answer ${op}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ---- the picture pipe ----
  openPipe() {
    this.pipeName = `vrmd-overlay-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.pipeServer = net.createServer((socket) => {
      if (this.pipeSocket) this.pipeSocket.destroy();
      this.pipeSocket = socket;
      socket.on('error', () => {});
      socket.on('drain', () => this.flushLatest());
      socket.on('close', () => { if (this.pipeSocket === socket) this.pipeSocket = null; });
      this.emit('pipe', true);
    });
    this.pipeServer.on('error', () => {});
    this.pipeServer.listen(`\\\\.\\pipe\\${this.pipeName}`, () => {
      this.call('frames', { pipe: this.pipeName }).catch(() => {});
    });
  }

  closePipe() {
    this.latest.clear();
    if (this.pipeSocket) { this.pipeSocket.destroy(); this.pipeSocket = null; }
    if (this.pipeServer) { try { this.pipeServer.close(); } catch { /* already closed */ } this.pipeServer = null; }
  }

  get pipeConnected() {
    return Boolean(this.pipeSocket);
  }

  // Sends one picture (BGRA). A picture that arrives while the last one is still being read is not queued behind
  // it (the next one is newer anyway), but the newest one is kept and goes out as soon as the pipe is free, so
  // the last change is never lost (a stuck hover highlight, say).
  sendFrame(width, height, bgra, target = 0) {
    const s = this.pipeSocket;
    if (!s || s.destroyed) return false;
    if (s.writableNeedDrain) {
      this.framesDropped++;
      this.latest.set(target, { width, height, bgra });
      return false;
    }
    this.latest.delete(target);
    s.write(encodeFrame(width, height, bgra, target));
    this.framesSent++;
    return true;
  }

  flushLatest() {
    for (const [target, f] of [...this.latest]) {
      if (!this.sendFrame(f.width, f.height, f.bgra, target)) return;
    }
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    try { await this.call('shutdown', {}, 1500); } catch { /* going away anyway */ }
    try { proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 800).unref();
    this.closePipe();
    this.proc = null;
    this.status = 'off';
  }
}

module.exports = { OverlayHelper };
