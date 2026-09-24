// Watches Windows notifications for Discord ones ONLY, applies the user's "ignore" filters, and keeps the most
// recent few. The Discord-only check happens inside the PowerShell listener, so notifications from other apps
// never reach this file. Message text is kept in memory only: never written to disk and never logged.
const { spawn } = require('child_process');
const readline = require('readline');
const script = require('./listener-script');
const { parseNotification } = require('./parse');

const KEEP = 5; // how many recent notifications the "Recent" widget can show

class DiscordNotifyRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.spawn = options.spawn || spawn;
    this.proc = null;
    this.timer = null;
    this.clearTimer = null;
    this.wanted = false;
    this.state = process.platform === 'win32' ? 'off' : 'error';
    this.error = process.platform === 'win32' ? '' : 'Windows notifications only work on Windows.';
    this.recent = []; // newest first: { ...parsed, at }
    this.publish();
  }

  settings() {
    const s = this.ctx.settings();
    return {
      myName: String(s.myName || '').trim(),
      ignoreDms: Boolean(s.ignoreDms),
      ignoreChannel: Boolean(s.ignoreChannel),
      ignoreEveryone: Boolean(s.ignoreEveryone),
      ignoreMentions: Boolean(s.ignoreMentions),
      ignoreEvents: Boolean(s.ignoreEvents),
      clearAfterMin: Number.isFinite(Number(s.clearAfterMin)) ? Number(s.clearAfterMin) : 30,
      showText: s.showText !== false,
    };
  }

  // The user's "ignore" switches: a notification of an ignored type is dropped.
  ignored(n) {
    const s = this.settings();
    if (n.type === 'event') return s.ignoreEvents;
    if (n.type === 'everyone') return s.ignoreEveryone;
    if (n.type === 'mention') return s.ignoreMentions;
    if (n.type === 'dm') return s.ignoreDms;
    if (n.type === 'channel') return s.ignoreChannel;
    return false;
  }

  configure() {
    this.scheduleClear();
    this.ctx.emitStatus();
  }

  sync(needs) {
    this.wanted = Boolean(needs.dnotify);
    if (this.wanted) this.launch(); else this.stop();
  }

  launch() {
    if (this.proc || process.platform !== 'win32') return;
    this.state = 'connecting'; this.error = '';
    let proc;
    try {
      proc = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        env: { ...process.env, VRMP_FILTER: 'discord', VRMP_PARENT: String(process.pid) }, // Discord only, not configurable on purpose
      });
    } catch (err) { this.fail(`Could not start PowerShell: ${err.message}`); return; }
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.on('error', (err) => this.onExit(proc, `Could not start PowerShell: ${err.message}`));
    proc.on('exit', () => this.onExit(proc, 'The notification watcher stopped.'));
    this.ctx.emitStatus();
  }

  onExit(proc, reason) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.wanted && this.state !== 'error') {
      this.fail(reason);
      this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.launch(); }, 10000);
      if (this.timer.unref) this.timer.unref();
    }
  }

  fail(text) {
    this.state = 'error'; this.error = text;
    this.ctx.emitStatus();
  }

  // One line from the listener: { ready }, { error } or a notification { app, title, body }.
  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.error) { this.fail(String(m.error)); return; }
    if (m.ready) { this.state = 'connected'; this.error = ''; this.ctx.emitStatus(); return; }
    const n = parseNotification(String(m.app || ''), m.title, m.body, this.settings().myName);
    if (this.ignored(n)) return; // filtered out: not shown, not kept
    this.recent.unshift({ ...n, at: this.ctx.now() });
    this.recent.length = Math.min(this.recent.length, KEEP);
    this.publish();
    this.scheduleClear();
    this.ctx.emitStatus();
  }

  scheduleClear() {
    clearTimeout(this.clearTimer); this.clearTimer = null;
    const min = this.settings().clearAfterMin;
    if (!this.recent.length || !(min > 0)) return;
    const left = this.recent[0].at + min * 60000 - this.ctx.now();
    this.clearTimer = setTimeout(() => this.clear(), Math.max(0, left));
    if (this.clearTimer.unref) this.clearTimer.unref();
  }

  clear() {
    this.recent = [];
    clearTimeout(this.clearTimer); this.clearTimer = null;
    this.publish();
    this.ctx.emitStatus();
  }

  // The state values buttons and triggers can follow.
  publish() {
    const last = this.recent[0];
    this.hub.set('dnotify.unread', Boolean(last));
    this.hub.set('dnotify.from', last && last.sender ? { [last.sender]: true } : {});
    this.hub.set('dnotify.type', last ? { [last.type]: true } : {});
  }

  // What the widgets draw. Text is left out when the user turned "Show the message text" off.
  snapshot() {
    const { showText } = this.settings();
    const shape = (n) => ({ ...n, body: showText ? n.text : '' });
    return { state: this.state, error: this.error, has: this.recent.length > 0, last: this.recent[0] ? shape(this.recent[0]) : null, recent: this.recent.map(shape) };
  }

  killProc() {
    const p = this.proc; this.proc = null;
    if (p) { try { p.kill(); } catch { /* already gone */ } }
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer); this.timer = null;
    this.killProc();
    if (this.state !== 'error') this.state = 'off';
    this.error = this.state === 'error' ? this.error : '';
  }

  status() {
    return { state: this.state, error: this.error };
  }
}

module.exports = { DiscordNotifyRuntime, parseNotification };
