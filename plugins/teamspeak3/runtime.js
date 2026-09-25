// Follows your TeamSpeak 3 client while something needs it: whether your microphone or speakers are muted, whether you are
// away, and whether you are talking right now. Also does the muting. The connection itself is client.js.
const { Ts3Client, escape } = require('./client');

const KEYS = ['ts3.micMuted', 'ts3.speakersMuted', 'ts3.away', 'ts3.speaking'];
const FLAGS = { mic: 'client_input_muted', speakers: 'client_output_muted', away: 'client_away' };
const HUB_KEY = { client_input_muted: 'ts3.micMuted', client_output_muted: 'ts3.speakersMuted', client_away: 'ts3.away' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Ts3Runtime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new Ts3Client(options);
    this.clid = null;
    this.handler = null; // the server tab (schandlerid) that is in front, once TeamSpeak has said so
    this.nickname = '';
    this.adHoc = 0;
    this.adHocTimer = null;
    this.lastNeeds = {};
    this.client.on('status', (s) => this.onStatus(s));
    this.client.on('notify', (name, rec) => this.onNotify(name, rec));
  }

  configure() {
    this.client.configure(this.ctx.settings());
  }

  sync(needs) {
    this.lastNeeds = needs;
    this.client.want(Boolean(needs.ts3) || Date.now() < this.adHoc);
  }

  stop() {
    this.client.want(false);
    clearTimeout(this.adHocTimer);
  }

  status() {
    return { state: this.client.status, error: this.client.error };
  }

  // Keeps the connection up a little longer, for "Save and test connection".
  keepAliveFor(ms) {
    this.adHoc = Date.now() + ms;
    clearTimeout(this.adHocTimer);
    this.adHocTimer = setTimeout(() => this.sync(this.lastNeeds), ms + 50);
    this.client.want(true);
  }

  onStatus(status) {
    if (status === 'connected') this.loadState().catch(() => {});
    else { for (const k of KEYS) this.hub.remove(k); this.clid = null; }
    this.ctx.emitStatus();
  }

  // Which server tab the next commands are about: the one in front, or the one TeamSpeak last told us about.
  use() {
    return this.client.request(this.handler ? `use schandlerid=${this.handler}` : 'use');
  }

  // Who you are on the server in front. TeamSpeak answers "not connected" while it is not on any server.
  async whoami() {
    let who;
    try { who = (await this.client.request('whoami'))[0]; } catch (err) { if (err.id === 1794) who = null; else throw err; }
    if (!who || !who.clid) throw new Error('TeamSpeak is running, but not connected to a server yet. Connect to one first.');
    return who;
  }

  async loadState() {
    await this.use();
    const who = await this.whoami();
    this.clid = String(who.clid);
    const v = (await this.client.request(`clientvariable clid=${this.clid} client_input_muted client_output_muted client_away client_nickname`))[0] || {};
    this.nickname = v.client_nickname || '';
    for (const [field, key] of Object.entries(HUB_KEY)) this.hub.set(key, v[field] === '1');
    this.hub.set('ts3.speaking', false);
  }

  onNotify(name, rec) {
    if (name === 'notifycurrentserverconnectionchanged') {
      this.handler = rec.schandlerid || null;
      this.loadState().catch(() => { for (const k of KEYS) this.hub.remove(k); });
    } else if (name === 'notifyconnectstatuschange') {
      if (rec.status === 'connection_established' || rec.status === 'disconnected') this.loadState().catch(() => { for (const k of KEYS) this.hub.remove(k); });
    } else if (name === 'notifyclientupdated') {
      if (rec.clid !== this.clid) return;
      for (const [field, key] of Object.entries(HUB_KEY)) if (field in rec) this.hub.set(key, rec[field] === '1');
    } else if (name === 'notifytalkstatuschange') {
      if (rec.clid === this.clid) this.hub.set('ts3.speaking', rec.status === '1' || rec.status === '2');
    }
  }

  // Waits a moment for the connection (a button pressed right after start-up), then says plainly what is wrong.
  async whenConnected(ms = 3000) {
    this.keepAliveFor(60000);
    const end = Date.now() + ms;
    while (this.client.status !== 'connected' && this.client.status !== 'auth-failed' && Date.now() < end) await sleep(50);
    if (this.client.status === 'connected') return;
    throw new Error(this.client.error || 'TeamSpeak is not reachable. Is it running, with the ClientQuery plugin switched on (Tools → Options → Addons)?');
  }

  // "Save and test connection": returns [{ value, label }], one entry naming who you are on TeamSpeak.
  async check() {
    await this.whenConnected();
    await this.use();
    const who = await this.whoami();
    const v = (await this.client.request(`clientvariable clid=${who.clid} client_nickname`))[0] || {};
    const name = v.client_nickname || `client ${who.clid}`;
    return [{ value: name, label: name }];
  }

  // mode: 'toggle' | 'on' | 'off' (on = muted / away). field: 'mic' | 'speakers' | 'away'.
  async set(field, mode, awayMessage = '') {
    const name = FLAGS[field];
    if (!name) throw new Error('Unknown TeamSpeak setting.');
    await this.whenConnected();
    await this.use();
    const who = await this.whoami();
    let target;
    if (mode === 'on') target = 1;
    else if (mode === 'off') target = 0;
    else {
      const v = (await this.client.request(`clientvariable clid=${who.clid} ${name}`))[0] || {};
      target = v[name] === '1' ? 0 : 1; // read fresh, so a toggle is right even if TeamSpeak was changed elsewhere
    }
    let command = `clientupdate ${name}=${target}`;
    if (field === 'away' && target === 1 && awayMessage) command += ` client_away_message=${escape(String(awayMessage).slice(0, 80))}`;
    await this.client.request(command);
    this.hub.set(HUB_KEY[name], target === 1);
    return target === 1;
  }
}

module.exports = { Ts3Runtime };
