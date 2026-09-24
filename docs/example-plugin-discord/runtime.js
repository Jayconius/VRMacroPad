// The live part: validates the webhook URL, does the HTTP call, and remembers whether the last one worked.
// No polling and no connection to keep alive, so there is no sync()/stop() here at all — a plugin only
// implements the lifecycle methods it actually needs.
const HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com', '127.0.0.1', 'localhost']);

class DiscordRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.last = { state: 'off', error: '' }; // off | connected | error
    this.hub.set('mydiscord.lastOk', false);       // known from the start, so the button isn't dimmed as "unknown"
  }

  status() {
    return { state: this.last.state, error: this.last.error };
  }

  // Only ever talk to Discord (localhost is allowed so the plugin can be tested against a local fake).
  url() {
    const raw = String(this.ctx.settings().webhookUrl || '').trim();
    if (!raw) throw new Error('Paste your Webhook URL first (Settings → Plugins → My Discord Webhook).');
    let u;
    try { u = new URL(raw); } catch { throw new Error('That Webhook URL is not a valid link.'); }
    if (!HOSTS.has(u.hostname)) throw new Error('That is not a Discord webhook URL.');
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('The Webhook URL must start with https://');
    return u.toString();
  }

  record(ok, error = '') {
    this.last = { state: ok ? 'connected' : 'error', error };
    this.hub.set('mydiscord.lastOk', ok);
    this.ctx.emitStatus();
  }

  async send(text) {
    const url = this.url();
    const body = { content: String(text).slice(0, 2000), username: this.ctx.settings().username || 'VR Macro Pad' };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      this.record(false, err.message);
      throw new Error(`Could not reach Discord: ${err.message}`);
    }
    if (!res.ok) {
      const msg = res.status === 404 ? 'Discord says that webhook no longer exists.' : `Discord answered ${res.status}.`;
      this.record(false, msg);
      throw new Error(msg);
    }
    this.record(true);
  }

  // For "Save and test connection": asks Discord about the webhook without posting anything.
  async check() {
    const res = await fetch(this.url());
    if (!res.ok) { this.record(false, `Discord answered ${res.status}.`); throw new Error(`Discord answered ${res.status}. Is the URL right?`); }
    const info = await res.json().catch(() => ({}));
    this.record(true);
    return [{ value: info.channel_id || 'ok', label: info.name || 'webhook' }];
  }
}

module.exports = { DiscordRuntime };
