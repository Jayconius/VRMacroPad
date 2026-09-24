// The reusable part of a "real account login" plugin: request a device code, poll until a human approves
// it, keep the resulting token (refreshing or re-checking it as your real service requires), and survive
// an app restart without asking again. This is the same shape as plugins/twitch/client.js, plugins/spotify/
// client.js and plugins/pear/client.js — copy whichever of those three patterns (device code, PKCE redirect,
// local token exchange) actually matches your service, and use this file as the simplest one to start from.
const { EventEmitter } = require('events');
const fakeService = require('./fake-service'); // swap this for real fetch() calls to your own service

class ExampleLoginClient extends EventEmitter {
  // secrets: ctx.secrets from your plugin's createRuntime(ctx) — see runtime.js. Keeping the constructor's
  // only required dependency be `secrets` (not `ctx` itself) is what lets a test construct one directly
  // with a fake secrets store, the same way test/twitch.test.js does for the real Twitch client.
  constructor({ secrets }) {
    super();
    this.secrets = secrets;
    this.status = 'needs-auth'; // needs-auth | authorizing | connected | denied | error
    this.error = '';
    this.user = null;
    this.token = null;
    this.pending = null; // { userCode, verificationUri } while authorizing
    this.pollTimer = null;
    this.restore();
  }

  setStatus(status, error = '') {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.emit('status', status);
  }

  info() {
    return { status: this.status, error: this.error, user: this.user, pending: this.pending };
  }

  isConnected() {
    return this.status === 'connected';
  }

  // A saved token survives a restart without asking again — the same reason plugins/twitch/client.js and
  // plugins/spotify/client.js both check secrets before ever showing "needs-auth".
  restore() {
    const saved = this.secrets.get('token');
    if (!saved) return;
    try {
      const { token, user } = JSON.parse(saved);
      this.token = token;
      this.user = user;
      this.setStatus('connected');
    } catch { /* corrupt or old-shape save: ask again */ }
  }

  // ---- what the browser's "Connect" button calls (see plugin.js's clientMethods) ----
  // Returns as soon as there is a code to show — it must NOT wait for the human to actually approve, or
  // the browser would have nothing to open and no code to display until it's already too late to need
  // either. Polling continues in the background; status 'connected' (or 'denied') arrives later as a
  // 'status' event, same as plugins/twitch/client.js's startDeviceFlow()/pollOnce() split.
  async connect() {
    clearTimeout(this.pollTimer);
    const { code, userCode, verificationUri, intervalMs } = fakeService.requestCode();
    this.pending = { userCode, verificationUri };
    this.setStatus('authorizing');
    this.schedulePoll(code, intervalMs);
    return { verificationUri, userCode }; // the browser opens verificationUri for the human right away
  }

  schedulePoll(code, intervalMs) {
    this.pollTimer = setTimeout(() => {
      const r = fakeService.poll(code);
      if (r.status === 'pending') { this.schedulePoll(code, intervalMs); return; }
      this.pending = null;
      if (r.status === 'approved') {
        this.token = r.accessToken;
        this.user = r.user;
        this.secrets.set('token', JSON.stringify({ token: this.token, user: this.user }));
        this.setStatus('connected');
      } else {
        this.setStatus('denied', 'Denied on example.com');
      }
    }, intervalMs);
  }

  async disconnect() {
    clearTimeout(this.pollTimer);
    if (this.token) fakeService.revoke(this.token);
    this.token = null;
    this.user = null;
    this.pending = null;
    this.secrets.delete('token');
    this.setStatus('needs-auth');
    return true;
  }

  stop() {
    clearTimeout(this.pollTimer);
  }

  // A stand-in for a real authenticated API call your actions/widgets would make.
  async whoAmI() {
    if (!this.isConnected()) throw new Error('Not connected. Settings → Plugins → Example Login → Connect.');
    return this.user;
  }
}

module.exports = { ExampleLoginClient };
