// Follows Voicemod while something needs it: the voice changer, your microphone mute, hear-myself, background effects
// and the current voice, and does the switching. The connection itself is client.js.
const { VoicemodClient } = require('./client');

// name -> the status question, the toggle, and the state key a button follows
const SWITCHES = {
  changer: { status: 'getVoiceChangerStatus', toggle: 'toggleVoiceChanger', key: 'voicemod.voiceChanger' },
  mic: { status: 'getMuteMicStatus', toggle: 'toggleMuteMic', key: 'voicemod.micMuted' },
  hear: { status: 'getHearMyselfStatus', toggle: 'toggleHearMyVoice', key: 'voicemod.hearMyself' },
  background: { status: 'getBackgroundEffectStatus', toggle: 'toggleBackground', key: 'voicemod.background' },
};
const KEYS = [...Object.values(SWITCHES).map((s) => s.key), 'voicemod.voice'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Voicemod answers a yes/no as { value: true }; be forgiving about the exact shape.
const asBool = (o) => (o && typeof o === 'object' ? (typeof o.value === 'boolean' ? o.value : (typeof o.enabled === 'boolean' ? o.enabled : undefined)) : undefined);

class VoicemodRuntime {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new VoicemodClient(options);
    this.cache = { voices: [], sounds: [], boards: [] };
    this.adHoc = 0;
    this.adHocTimer = null;
    this.lastNeeds = {};
    this.client.on('status', (s) => this.onStatus(s));
    this.client.on('event', (type, obj) => this.onEvent(type, obj));
  }

  configure() {
    this.client.configure(this.ctx.settings());
  }

  sync(needs) {
    this.lastNeeds = needs;
    this.client.want(Boolean(needs.voicemod) || Date.now() < this.adHoc);
  }

  stop() {
    this.client.want(false);
    clearTimeout(this.adHocTimer);
  }

  status() {
    return { state: this.client.status, error: this.client.error };
  }

  // Keeps the connection up a little longer, for the editor's lists and "Save and test connection".
  keepAliveFor(ms) {
    this.adHoc = Date.now() + ms;
    clearTimeout(this.adHocTimer);
    this.adHocTimer = setTimeout(() => this.sync(this.lastNeeds), ms + 50);
    this.client.want(true);
  }

  onStatus(status) {
    if (status === 'connected') this.loadState().catch(() => {});
    else for (const k of KEYS) this.hub.remove(k);
    this.ctx.emitStatus();
  }

  ask(action, payload) {
    return this.client.request(action, payload).catch(() => null);
  }

  async loadState() {
    const [voices, cur, memes, boards, ...flags] = await Promise.all([
      this.ask('getVoices'), this.ask('getCurrentVoice'), this.ask('getMemes'), this.ask('getAllSoundboard'),
      ...Object.values(SWITCHES).map((s) => this.ask(s.status)),
    ]);
    if (voices && Array.isArray(voices.voices)) this.cache.voices = voices.voices.filter((v) => v && v.id && v.enabled !== false).map((v) => ({ id: String(v.id), name: String(v.friendlyName || v.id), custom: Boolean(v.isCustom) }));
    if ((memes && Array.isArray(memes.listOfMemes)) || (boards && Array.isArray(boards.soundboards))) {
      // Sounds come from two places, and both are used: Voicemod's sound list (getMemes), and each soundboard's own list. A sound
      // you have just added to a soundboard is on the soundboard at once, but Voicemod only adds it to its sound list later (once it
      // has been played), so going by the sound list alone would miss it. On a soundboard, a sound's id is its FileName.
      const byFile = new Map();
      for (const m of (memes && memes.listOfMemes) || []) if (m && m.FileName) byFile.set(String(m.FileName), { file: String(m.FileName), name: String(m.Name || m.FileName), type: String(m.Type || ''), board: '' });
      this.cache.boards = [];
      for (const b of (boards && boards.soundboards) || []) {
        if (!b || b.enabled === false) continue;
        const files = [];
        for (const so of b.sounds || []) {
          if (!so || !so.id) continue;
          const file = String(so.id);
          files.push(file);
          if (!byFile.has(file)) byFile.set(file, { file, name: String(so.name || file), type: String(so.playbackMode || ''), board: '' });
          const entry = byFile.get(file);
          if (!entry.board) entry.board = String(b.name || '');
        }
        this.cache.boards.push({ name: String(b.name || b.id || ''), files, custom: Boolean(b.isCustom) });
      }
      this.cache.sounds = [...byFile.values()];
    }
    const current = (cur && cur.voiceID) || (voices && voices.currentVoice);
    if (current) this.setCurrentVoice(current);
    Object.values(SWITCHES).forEach((s, i) => { const v = asBool(flags[i]); if (v !== undefined) this.hub.set(s.key, v); });
  }

  onEvent(type, obj) {
    const sw = Object.values(SWITCHES).find((s) => s.toggle === type);
    if (sw) { const v = asBool(obj); if (v !== undefined) this.hub.set(sw.key, v); return; }
    if (type === 'voiceChangedEvent' && obj.voiceID) this.setCurrentVoice(obj.voiceID);
    else if (type === 'voiceChangerEnabledEvent') this.hub.set('voicemod.voiceChanger', true);
    else if (type === 'voiceChangerDisabledEvent') this.hub.set('voicemod.voiceChanger', false);
  }

  // "voicemod.voice=Cave" and "voicemod.voice=<id>" are both true while that voice is the one in use.
  setCurrentVoice(id) {
    const v = this.cache.voices.find((x) => x.id === String(id));
    const marks = { [String(id)]: true };
    if (v) marks[v.name] = true;
    this.hub.set('voicemod.voice', marks);
  }

  // What a button stores and the list shows: the first naming (a name, then "name (soundboard)") that is unique. Whatever is
  // still ambiguous is numbered in the order Voicemod lists it ("Yes (Space Troopers) #1"), so the list never shows raw ids.
  static values(items, ...namers) {
    const counts = namers.map((f) => { const m = new Map(); for (const i of items) { const k = f(i).toLowerCase(); m.set(k, (m.get(k) || 0) + 1); } return m; });
    const picked = items.map((i) => { for (let n = 0; n < namers.length; n++) { const v = namers[n](i); if (counts[n].get(v.toLowerCase()) === 1) return v; } return null; });
    const last = namers[namers.length - 1];
    const seen = new Map();
    return picked.map((v, idx) => {
      if (v !== null) return v;
      const base = last(items[idx]);
      const key = base.toLowerCase();
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return `${base} #${n}`;
    });
  }

  // Each voice / sound with the value a button stores for it.
  voiceChoices() {
    const voices = this.cache.voices;
    const values = VoicemodRuntime.values(voices, (v) => v.name);
    return voices.map((v, i) => ({ ...v, value: values[i] }));
  }

  soundChoices() {
    const sounds = this.cache.sounds;
    const values = VoicemodRuntime.values(sounds, (x) => x.name, (x) => (x.board ? `${x.name} (${x.board})` : x.name));
    return sounds.map((x, i) => ({ ...x, value: values[i] }));
  }

  // A voice id from what a button stores: an id, the value the list gave it, or a voice's name in any capitals.
  resolveVoice(value) {
    const v = String(value || '').trim();
    if (!v) throw new Error('Pick a Voicemod voice first.');
    const voices = this.cache.voices;
    if (!voices.length) return v; // the list is not known: let Voicemod decide
    if (voices.some((x) => x.id === v)) return v;
    const low = v.toLowerCase();
    const exact = this.voiceChoices().filter((c) => c.value.toLowerCase() === low);
    if (exact.length === 1) return exact[0].id;
    const byName = voices.filter((x) => x.name.toLowerCase() === low);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1 || exact.length > 1) throw new Error(`More than one Voicemod voice is called "${v}". Pick the right one from the list (they are numbered) instead of typing the name.`);
    throw new Error(`Voicemod has no voice called "${v}". Pick one from the list (it fills in when Voicemod is running).`);
  }

  resolveSound(value) {
    const v = String(value || '').trim();
    if (!v) throw new Error('Pick a Voicemod sound first.');
    const sounds = this.cache.sounds;
    if (!sounds.length) return v;
    if (sounds.some((x) => x.file === v)) return v;
    const low = v.toLowerCase();
    const exact = this.soundChoices().filter((c) => c.value.toLowerCase() === low);
    if (exact.length === 1) return exact[0].file;
    const byName = sounds.filter((x) => x.name.toLowerCase() === low);
    if (byName.length === 1) return byName[0].file;
    if (byName.length > 1 || exact.length > 1) throw new Error(`More than one Voicemod sound is called "${v}". Pick the right one from the list (they show their soundboard) instead of typing the name.`);
    throw new Error(`Voicemod has no sound called "${v}". Pick one from the list (it fills in when Voicemod is running).`);
  }

  // Waits a moment for the connection (a button pressed right after start-up), then says plainly what is wrong.
  async whenConnected(ms = 3000) {
    this.keepAliveFor(60000);
    const end = Date.now() + ms;
    while (this.client.status !== 'connected' && this.client.status !== 'auth-failed' && Date.now() < end) await sleep(50);
    if (this.client.status === 'connected') return;
    throw new Error(this.client.error || 'Voicemod is not reachable. Is it running?');
  }

  // ---- the lists the editor shows ----
  // Every voice / sound button has ONE "List" dropdown, and it always starts on the complete list:
  //   voices: All voices · Voicemod voices · Community voices
  //   sounds: All sounds · then your soundboards · then Voicemod's soundboards (all found by themselves, on any PC)
  // (Voicemod's API lists which SOUNDS are on a soundboard, but never which VOICES, so voices have no soundboard lists.)

  // The voices a List value stands for ('all', 'voicemod' or 'community').
  voicesIn(list) {
    const choices = this.voiceChoices();
    const l = String(list || 'all');
    if (l === 'all') return choices;
    if (l === 'voicemod') return choices.filter((v) => !v.custom);
    if (l === 'community') return choices.filter((v) => v.custom);
    return [];
  }

  // The sounds a List value stands for ('all', or 'board:<soundboard>').
  soundsIn(list) {
    const choices = this.soundChoices();
    const l = String(list || 'all');
    if (l === 'all') return choices;
    const name = (l.startsWith('board:') ? l.slice(6) : l).trim().toLowerCase();
    const b = this.cache.boards.find((x) => x.name.toLowerCase() === name);
    if (!b) return [];
    const files = new Set(b.files);
    return choices.filter((c) => files.has(c.file));
  }

  async fresh() {
    await this.whenConnected();
    await this.loadState();
  }

  // The voice List dropdown, with how many voices each holds.
  async voiceLists() {
    await this.fresh();
    const n = (list) => this.voicesIn(list).length;
    return [
      { value: 'all', label: `All voices (${n('all')})` },
      { value: 'voicemod', label: `Voicemod voices (${n('voicemod')})` },
      { value: 'community', label: `Community voices (${n('community')})` },
    ];
  }

  // The sound List dropdown: all sounds, then your soundboards, then Voicemod's, each with how many sounds it holds.
  async soundLists() {
    await this.fresh();
    const boards = [...this.cache.boards.filter((b) => b.custom), ...this.cache.boards.filter((b) => !b.custom)];
    return [
      { value: 'all', label: `All sounds (${this.cache.sounds.length})` },
      ...boards.map((b) => ({ value: `board:${b.name}`, label: `${b.name} (${b.files.length} sound${b.files.length === 1 ? '' : 's'})${b.custom ? ' · yours' : ''}` })),
    ];
  }

  // The Voice picker: [{ value, label, hint }], A to Z. "community" marks a voice you added from Voicemod's Community tab.
  async voices(args = {}) {
    await this.fresh();
    return this.voicesIn(args.list)
      .map((v) => ({ value: v.value, label: v.name, hint: v.custom ? 'community' : '' }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  // The Sound picker: [{ value, label, hint }], A to Z. In "All sounds" the hint says which soundboard a sound is on; inside one
  // soundboard it would only confuse (a sound on two boards would name the other one), so there is none.
  async sounds(args = {}) {
    await this.fresh();
    const everything = !args.list || args.list === 'all';
    return this.soundsIn(args.list)
      .map((c) => ({ value: c.value, label: c.value, hint: everything ? c.board : '' }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  async check() {
    return this.voices();
  }

  // which: 'changer' | 'mic' | 'hear' | 'background'; mode: 'toggle' | 'on' | 'off'. Voicemod only has toggles, so on / off
  // ask first and only toggle when it is not already the way you want. Returns the new state.
  async setSwitch(which, mode) {
    const sw = SWITCHES[which];
    if (!sw) throw new Error('Unknown Voicemod setting.');
    await this.whenConnected();
    if (mode === 'on' || mode === 'off') {
      const now = asBool(await this.client.request(sw.status));
      if (now === (mode === 'on')) { this.hub.set(sw.key, now); return now; }
    }
    const result = asBool(await this.client.request(sw.toggle));
    const value = result === undefined ? !(this.hub.get(sw.key) === true) : result;
    this.hub.set(sw.key, value);
    return value;
  }

  async loadVoice(voice) {
    if (!String(voice || '').trim()) throw new Error('Pick a Voicemod voice first.');
    await this.whenConnected();
    if (!this.cache.voices.length) await this.loadState();
    const id = this.resolveVoice(voice);
    await this.client.request('loadVoice', { voiceID: id });
    this.setCurrentVoice(id);
  }

  // list: a voice List value. 'all' lets Voicemod pick; any other list is picked from here.
  async randomVoice(list = 'all') {
    await this.whenConnected();
    if (!list || list === 'all') { await this.client.request('selectRandomVoice', {}); return ''; }
    await this.loadState();
    const pool = this.voicesIn(list);
    if (!pool.length) throw new Error('That voice list is empty. Pick another list.');
    const pick = pool[Math.floor(Math.random() * pool.length)];
    await this.loadVoice(pick.value);
    return pick.name;
  }

  // A sound from the soundboard: a press, then a short moment later the release (Voicemod plays "hold" sounds only while held).
  async playSound(sound) {
    if (!String(sound || '').trim()) throw new Error('Pick a Voicemod sound first.');
    await this.whenConnected();
    if (!this.cache.sounds.length) await this.loadState();
    const f = this.resolveSound(sound);
    await this.client.request('playMeme', { FileName: f, IsKeyDown: true });
    await sleep(120);
    this.client.request('playMeme', { FileName: f, IsKeyDown: false }).catch(() => {});
  }

  async stopSounds() {
    await this.whenConnected();
    await this.client.request('stopAllMemeSounds');
  }
}

module.exports = { VoicemodRuntime, SWITCHES };
