// Live state sources. Each one only runs while a button, widget or trigger needs it,
// so an unused OBS, Twitch or SteamVR setup never generates connection noise.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ObsClient } = require('./obs');
const { OscSender, OscListener } = require('./osc');

const AUDIO_POLL_MS = 1500;
const PROC_POLL_MS = 3000;
const VR_POLL_MS = 3000;
const MEDIA_POLL_MS = 1000;
const TWITCH_POLL_MS = 10000;
const SPOTIFY_POLL_MS = 8000;

// A test hook: while a tool keeps a fresh "fake signal" file in the data folder it stands in for the real
// headset (used by the automated tests; nothing in the product writes it).
const FAKE_VR_FILE = 'fake_vr_signal.json';
const FAKE_VR_MAX_AGE_MS = 3000;
const FAKE_VR_SERVICE = '__steamvr_service__';
const FAKE_VR_CLASS = { HMD: 'hmd', Controller: 'controller', GenericTracker: 'tracker', TrackingReference: 'basestation' };
const VR_KNOWN_MAX = 40;
const VR_KEYS = ['vr.connected', 'vr.lowBattery', 'vr.charging', 'vr.trackingLost', 'vr.hmdWorn', 'vr.dropped', 'vr.device', 'vr.snapshot'];
const VR_TRACKED = new Set(['hmd', 'controller', 'tracker']);

function emptyNeeds() {
  return {
    audio: false, process: false, obs: false, vrc: false, vrcParams: new Set(),
    vr: false, media: new Set(), spotify: false, twitch: false, twitchAds: false, twitchStream: false, twitchModes: false, pear: false,
  };
}

// Twitch sends times as RFC3339 text, or (in older payloads) epoch seconds. Returns epoch ms, 0 if none.
function parseTime(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (/^\d+$/.test(String(v))) return parseTime(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

class Providers extends EventEmitter {
  constructor({ helper, media, vr, twitch, pear, spotify = null, hub, now = () => Date.now(), dataDir = '', store = null }) {
    super();
    this.fakeVrPath = dataDir ? path.join(dataDir, FAKE_VR_FILE) : '';
    this.store = store;
    this.vrKnown = new Map(); // serial -> last seen device (survives restarts: runtime.json)
    this.vrKnownSim = new Map(); // same, for simulator devices (never saved)
    this.vrKnownLoaded = false;
    this.vrPresent = new Set();
    this.vrSimActive = false;
    this.helper = helper;
    this.pear = pear;
    this.mediaHelper = media;
    this.vrHelper = vr;
    this.twitch = twitch;
    this.spotify = spotify;
    this.spotTimer = null;
    this.spotBusy = false;
    this.spotLiked = null; // { uri, liked } for the song playing now
    this.spotError = '';
    this.hub = hub;
    this.now = now;
    this.settings = null;
    this.needs = emptyNeeds();
    this.audioTimer = null;
    this.audioBusy = false;
    this.procTimer = null;
    this.procBusy = false;
    this.obs = new ObsClient();
    this.obsCache = { scenes: [], inputs: [] };
    this.obsAdHoc = 0;
    this.obsAdHocTimer = null;
    this.obs.on('status', (s) => this.onObsStatus(s));
    this.obs.on('event', (e) => this.onObsEvent(e));
    this.osc = new OscSender();
    this.listener = null;
    this.vrcStatus = 'off'; // off | listening | error
    this.vrcError = '';
    this.vrcLastHeard = 0;
    this.vrcParams = {};
    this.vrTimer = null;
    this.vrBusy = false;
    this.vrData = { connected: false, error: 'Checking SteamVR…', devices: [] };
    this.mediaTimer = null;
    this.mediaBusy = false;
    this.mediaInfo = new Map(); // app -> info
    this.mediaThumbs = new Map(); // thumbKey -> data URL
    this.twTimer = null;
    this.twBusy = false;
    this.twTick = 0;
    this.twAds = { error: '' };
    this.twStream = { error: '' };
    if (this.pear) {
      this.pear.on('change', () => { this.publishPear(); this.emit('status'); });
    }
    if (this.spotify) {
      this.spotify.on('status', () => {
        if (this.needs.spotify) this.pollSpotify();
        this.emit('status');
      });
    }
    if (this.twitch) {
      this.twitch.on('status', () => {
        if (this.needs.twitch) this.pollTwitch(true);
        this.emit('status');
      });
    }
  }

  // ---- lifecycle ----
  configure(settings) {
    const prev = this.settings;
    this.settings = settings;
    this.obs.configure(settings.obs);
    if (this.twitch) this.twitch.configure({ clientId: settings.twitch.clientId });
    if (this.pear) this.pear.configure(settings.pear);
    if (this.spotify) this.spotify.configure({ clientId: settings.spotify.clientId });
    if (prev && (prev.osc.listenPort !== settings.osc.listenPort || prev.osc.listen !== settings.osc.listen)) this.stopVrc();
    this.sync(this.needs);
  }

  sync(input) {
    const needs = { ...emptyNeeds(), ...input }; // callers may pass only the parts they care about
    this.needs = needs;
    if (needs.audio) this.startAudio(); else this.stopAudio();
    if (needs.process) this.startProc(); else this.stopProc();
    this.obs.want(needs.obs || Date.now() < this.obsAdHoc);
    if (needs.vrc && this.settings && this.settings.osc.listen) this.startVrc(); else this.stopVrc();
    if (needs.vr) this.startVr(); else this.stopVr();
    if (needs.media.size) this.startMedia(); else this.stopMedia();
    if (needs.twitch) this.startTwitch(); else this.stopTwitch();
    if (needs.spotify) this.startSpotify(); else this.stopSpotify();
    if (this.pear) {
      this.pear.want(needs.pear);
      if (!needs.pear) this.clearPear();
    }
  }

  stop() {
    this.stopAudio();
    this.stopProc();
    this.obs.want(false);
    this.stopVrc();
    this.stopVr();
    this.stopMedia();
    this.stopTwitch();
    this.stopSpotify();
    if (this.pear) this.pear.stop();
    this.osc.close();
    clearTimeout(this.obsAdHocTimer);
  }

  // Lets the editor list OBS scenes before any button uses OBS.
  keepObsFor(ms) {
    this.obsAdHoc = Date.now() + ms;
    clearTimeout(this.obsAdHocTimer);
    this.obsAdHocTimer = setTimeout(() => this.sync(this.needs), ms + 50);
    this.obs.want(true);
  }

  status() {
    return {
      helper: this.helper.status,
      helperError: this.helper.error,
      obs: this.obs.status,
      obsError: this.obs.error,
      vrc: this.vrcStatus,
      vrcError: this.vrcError,
      vrcLastHeard: this.vrcLastHeard,
      steamvr: this.needs.vr ? (this.vrData.connected ? 'connected' : 'off') : 'off',
      steamvrError: this.needs.vr ? this.vrData.error : '',
      steamvrSimulated: this.needs.vr && Boolean(this.vrData.simulated),
      media: this.mediaHelper && this.needs.media.size ? this.mediaHelper.status : 'off',
      mediaError: this.mediaHelper ? this.mediaHelper.error : '',
      twitch: this.twitch ? this.twitch.info() : { status: 'off' },
      pear: this.pear ? this.pear.info() : { status: 'off' },
      spotify: this.spotify ? this.spotify.info() : { status: 'off' },
    };
  }

  // ---- audio ----
  startAudio() {
    if (this.audioTimer) return;
    this.pollAudio();
    this.audioTimer = setInterval(() => this.pollAudio(), AUDIO_POLL_MS);
  }

  stopAudio() {
    clearInterval(this.audioTimer);
    this.audioTimer = null;
  }

  async pollAudio() {
    if (this.audioBusy) return;
    this.audioBusy = true;
    try {
      const snap = await this.helper.call('audio.snapshot');
      this.setOrRemove('audio.in.muted', snap.capture ? snap.capture.muted : undefined);
      this.setOrRemove('audio.out.muted', snap.render ? snap.render.muted : undefined);
      this.setOrRemove('audio.in.default', snap.capture ? snap.capture.id : undefined);
      this.setOrRemove('audio.out.default', snap.render ? snap.render.id : undefined);
    } catch { /* helper status already reports the problem */ } finally {
      this.audioBusy = false;
    }
  }

  // Called after an audio action so the button color updates immediately.
  refreshAudio() {
    if (this.needs.audio) this.pollAudio();
  }

  setOrRemove(key, value) {
    if (value === undefined) this.hub.remove(key); else this.hub.set(key, value);
  }

  // ---- processes ----
  startProc() {
    if (this.procTimer) return;
    this.pollProc();
    this.procTimer = setInterval(() => this.pollProc(), PROC_POLL_MS);
  }

  stopProc() {
    clearInterval(this.procTimer);
    this.procTimer = null;
  }

  async pollProc() {
    if (this.procBusy) return;
    this.procBusy = true;
    try {
      const names = await this.helper.call('proc.list');
      const map = {};
      for (const n of names) map[n] = true;
      this.hub.set('proc', map);
    } catch { /* reported through helper status */ } finally {
      this.procBusy = false;
    }
  }

  // ---- SteamVR ----
  startVr() {
    if (this.vrTimer || !this.vrHelper) return;
    this.pollVr();
    this.vrTimer = setInterval(() => this.pollVr(), VR_POLL_MS);
  }

  stopVr() {
    clearInterval(this.vrTimer);
    this.vrTimer = null;
    if (this.vrHelper) this.vrHelper.release(); // drop our connection to SteamVR while nothing needs it
    this.vrData = { connected: false, error: 'Checking SteamVR…', devices: [] };
    this.vrSimActive = false;
    this.vrPresent = new Set();
    this.vrKnownSim.clear();
    for (const k of VR_KEYS) this.hub.remove(k);
  }

  // The simulator's file, as a snapshot in the same shape the real helper returns. null = no fresh file.
  readFakeVr() {
    if (!this.fakeVrPath) return null;
    let stat;
    try { stat = fs.statSync(this.fakeVrPath); } catch { return null; }
    if (Date.now() - stat.mtimeMs > FAKE_VR_MAX_AGE_MS) return null;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.fakeVrPath, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
    const src = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
    const devices = [];
    let service = false;
    for (const [serial, d] of Object.entries(src)) {
      if (!d || typeof d !== 'object') continue;
      if (serial === FAKE_VR_SERVICE) { service = true; continue; }
      const pct = d.battery_pct === null || d.battery_pct === undefined ? NaN : Number(d.battery_pct);
      const role = String(d.role || '').toLowerCase();
      devices.push({
        index: devices.length,
        class: FAKE_VR_CLASS[d.device_class] || 'other',
        role: role === 'left' || role === 'right' ? role : '',
        model: String(d.model || ''),
        serial,
        type: '',
        manufacturer: String(d.manufacturer || ''),
        trackingOk: typeof d.tracking_ok === 'boolean' ? d.tracking_ok : null,
        worn: typeof d.hmd_active === 'boolean' ? d.hmd_active : null,
        hasBattery: Number.isFinite(pct),
        battery: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : -1,
        charging: Boolean(d.charging),
      });
    }
    return service
      ? { connected: true, error: '', devices, simulated: true }
      : { connected: false, error: 'SteamVR is not running (simulated)', devices: [], simulated: true };
  }

  loadVrKnown() {
    if (this.vrKnownLoaded) return;
    this.vrKnownLoaded = true;
    try {
      const saved = this.store ? this.store.readRuntime().vrKnown : null;
      for (const d of Array.isArray(saved) ? saved : []) if (d && d.serial) this.vrKnown.set(String(d.serial), { ...d });
    } catch { /* start with none */ }
  }

  saveVrKnown() {
    if (!this.store) return;
    try { this.store.writeRuntime({ vrKnown: [...this.vrKnown.values()] }); } catch { /* not critical */ }
  }

  // Remembers every device ever seen so one that is switched off or has dropped out can still be listed
  // (with its last battery level), and publishes the values buttons and triggers can react to.
  applyVr(snap) {
    this.loadVrKnown();
    const known = snap.simulated ? this.vrKnownSim : this.vrKnown;
    const list = snap.devices || [];
    const present = new Set();
    let dirty = false;
    if (snap.connected) {
      for (const d of list) {
        if (!d.serial) continue;
        present.add(d.serial);
        if (!known.has(d.serial)) dirty = true;
        known.set(d.serial, {
          serial: d.serial, class: d.class, role: d.role, model: d.model, manufacturer: d.manufacturer || '',
          hasBattery: d.hasBattery, battery: d.battery, charging: d.charging, lastSeen: this.now(),
        });
      }
      if (known.size > VR_KNOWN_MAX) {
        const oldest = [...known.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, known.size - VR_KNOWN_MAX);
        for (const d of oldest) known.delete(d.serial);
        dirty = true;
      }
      // A device that was here on the last poll and is gone now: save its last reading.
      if (!snap.simulated && [...this.vrPresent].some((s) => !present.has(s))) dirty = true;
      if (!snap.simulated) this.vrPresent = present;
    }
    snap.dropped = snap.connected
      ? [...known.values()].filter((d) => !present.has(d.serial) && d.class !== 'other').map((d) => ({ ...d }))
      : [];
    if (dirty && !snap.simulated) this.saveVrKnown();

    const low = this.settings ? this.settings.vr.lowBatteryPercent : 15;
    const devices = snap.connected ? list : [];
    const byId = {};
    for (const d of devices) if (d.serial) byId[d.serial] = true;
    this.hub.set('vr.connected', Boolean(snap.connected));
    this.hub.set('vr.lowBattery', devices.some((d) => d.hasBattery && d.battery >= 0 && d.battery <= low && !d.charging));
    this.hub.set('vr.charging', devices.some((d) => d.hasBattery && d.charging));
    this.hub.set('vr.trackingLost', devices.some((d) => VR_TRACKED.has(d.class) && d.trackingOk === false));
    this.hub.set('vr.hmdWorn', devices.some((d) => d.class === 'hmd' && d.worn === true));
    this.hub.set('vr.dropped', snap.dropped.length > 0);
    this.hub.set('vr.device', byId);
    this.hub.set('vr.snapshot', snap);
    this.vrData = snap;
  }

  async pollVr() {
    if (this.vrBusy) return;
    this.vrBusy = true;
    try {
      const wasConnected = this.vrData.connected;
      const fake = this.readFakeVr();
      if (fake) {
        // A simulator is running: it replaces the real headset, and we let go of SteamVR meanwhile.
        if (!this.vrSimActive) { this.vrSimActive = true; this.vrHelper.release(); }
        this.applyVr(fake);
      } else {
        this.vrSimActive = false;
        this.applyVr(await this.vrHelper.call('snapshot', {}, 6000));
      }
      if (this.vrData.connected !== wasConnected) this.emit('status');
    } catch (err) {
      this.vrData = { connected: false, error: err.message, devices: [], dropped: [] };
      for (const k of VR_KEYS) if (k !== 'vr.snapshot') this.hub.set(k, k === 'vr.device' ? {} : false);
      this.hub.set('vr.snapshot', this.vrData);
    } finally {
      this.vrBusy = false;
    }
  }

  vrSnapshot() {
    return this.vrData;
  }

  // ---- media ----
  startMedia() {
    if (this.mediaTimer || !this.mediaHelper) return;
    this.pollMedia();
    this.mediaTimer = setInterval(() => this.pollMedia(), MEDIA_POLL_MS);
  }

  stopMedia() {
    clearInterval(this.mediaTimer);
    this.mediaTimer = null;
    if (this.mediaHelper) this.mediaHelper.release();
    this.mediaInfo.clear();
    this.hub.remove('media.playing');
    this.hub.remove('media.info');
    this.publishSpotify();
  }

  async pollMedia() {
    if (this.mediaBusy) return;
    this.mediaBusy = true;
    try {
      for (const app of this.needs.media) {
        const known = this.mediaInfo.get(app);
        try {
          const r = await this.mediaHelper.call('get', { app, knownThumbKey: known && known.thumbKey ? known.thumbKey : '' });
          if (r.thumb) {
            this.mediaThumbs.set(r.thumbKey, r.thumb);
            for (const k of [...this.mediaThumbs.keys()].slice(0, -4)) this.mediaThumbs.delete(k);
          }
          this.mediaInfo.set(app, this.viewMedia(r));
        } catch (err) {
          this.mediaInfo.set(app, { available: false, error: err.message });
        }
      }
      const all = Object.fromEntries(this.mediaInfo);
      this.hub.set('media.info', all);
      this.hub.set('media.playing', [...this.mediaInfo.values()].some((i) => i.playing));
      this.publishSpotify();
    } finally {
      this.mediaBusy = false;
    }
  }

  // spotify.* states (buttons that light up with Spotify's own shuffle / repeat / playing).
  publishSpotify() {
    if (!this.needs.media.has('spotify') || !this.mediaTimer) {
      for (const k of ['spotify.playing', 'spotify.shuffle', 'spotify.repeat']) this.hub.remove(k);
      return;
    }
    const i = this.mediaInfo.get('spotify') || {};
    const x = i.extras;
    this.hub.set('spotify.playing', Boolean(i.playing));
    this.hub.set('spotify.shuffle', Boolean(x && x.shuffle));
    this.hub.set('spotify.repeat', Boolean(x && x.repeat && x.repeat !== 'NONE'));
  }

  // What widgets see: no picture data (it is fetched separately), position projected to "now".
  viewMedia(r) {
    const repeatNames = { None: 'NONE', List: 'ALL', Track: 'ONE' };
    if (!r.available) return { available: false, sessions: r.sessions || [], error: '' };
    const playing = r.status === 'Playing';
    const fetchedAt = this.now();
    const live = playing && r.updatedAt ? Math.max(0, r.positionMs + (fetchedAt - r.updatedAt)) : r.positionMs;
    const duration = Math.max(0, r.endMs - r.startMs);
    return {
      available: true, appId: r.appId, sessions: r.sessions, title: r.title, artist: r.artist, album: r.album,
      playing, status: r.status, positionMs: duration ? Math.min(live, duration) : live, durationMs: duration,
      canSeek: Boolean(r.canSeek) && duration > 0, fetchedAt, thumbKey: r.thumbKey, error: '',
      // Only players that report shuffle / repeat to Windows (Spotify does) get the extra buttons.
      extras: r.shuffle === null || r.shuffle === undefined ? undefined : { shuffle: Boolean(r.shuffle), repeat: repeatNames[r.repeat] || 'NONE' },
    };
  }

  mediaData(app) {
    if (app === 'pear' && this.pear) return this.pear.view();
    const info = this.mediaInfo.get(app) || { available: false, error: '', pending: true };
    // Spotify's own like state (Web API) joins the shuffle / repeat that Windows reports.
    if (info.available && /spotify/i.test(app) && this.spotify && this.spotify.isConnected() && this.spotLiked) {
      return { ...info, extras: { shuffle: false, repeat: 'NONE', ...(info.extras || {}), liked: this.spotLiked.liked } };
    }
    return info;
  }

  mediaThumb(key) {
    return this.mediaThumbs.get(key) || '';
  }

  // Album art for either source: Windows media sessions (cached here) or Pear (fetched from YouTube's image hosts).
  async thumb(key) {
    if (/^https:\/\//.test(key) && this.pear) return this.pear.thumbFor(key);
    return this.mediaThumb(key);
  }

  async mediaControl(app, cmd, arg) {
    if (app === 'pear') {
      if (!this.pear) throw new Error('Pear is not available');
      await this.pear.control(cmd, arg);
      return;
    }
    if (cmd === 'like' || cmd === 'dislike') {
      if (!/spotify/i.test(app)) throw new Error('Like works with Spotify (choose Spotify as the player) or Pear');
      if (cmd === 'dislike') throw new Error('Spotify has no dislike');
      await this.spotifyLike('toggle');
      return;
    }
    if (!this.mediaHelper) throw new Error('Media control is not available');
    // seek: an absolute position; seekby: a jump in ms; shuffle / repeat: a mode (nothing = flip / next mode)
    const extra = cmd === 'seek' ? { positionMs: Math.round(Number(arg) || 0) }
      : cmd === 'seekby' ? { deltaMs: Math.round(Number(arg) || 0) }
        : cmd === 'shuffle' || cmd === 'repeat' ? { mode: arg ? String(arg) : '' } : {};
    await this.mediaHelper.call('control', { app, cmd, ...extra });
    setTimeout(() => this.pollMedia(), 250);
  }

  // ---- Spotify Web API (only for "Like") ----
  startSpotify() {
    if (this.spotTimer || !this.spotify) return;
    this.pollSpotify();
    this.spotTimer = setInterval(() => this.pollSpotify(), SPOTIFY_POLL_MS);
  }

  stopSpotify() {
    clearInterval(this.spotTimer);
    this.spotTimer = null;
    this.spotLiked = null;
    this.spotError = '';
    this.hub.remove('spotify.liked');
    this.hub.remove('spotify.connected');
  }

  async pollSpotify() {
    if (this.spotBusy || !this.spotify) return;
    this.spotBusy = true;
    try {
      this.hub.set('spotify.connected', this.spotify.isConnected());
      if (!this.spotify.isConnected()) { this.spotLiked = null; this.hub.set('spotify.liked', false); return; }
      const s = await this.spotify.likedState();
      this.spotLiked = s ? { uri: s.track.uri, liked: s.liked } : null;
      this.spotError = '';
      this.hub.set('spotify.liked', Boolean(s && s.liked));
    } catch (err) {
      this.spotError = err.message;
    } finally {
      this.spotBusy = false;
    }
  }

  // Runs a Spotify Web API call, with a friendly message when it is not set up.
  async spotifyCall(fn) {
    const c = this.spotify;
    if (!c || !c.isConnected()) throw new Error('Spotify likes need a one-time connection: Settings → Connections → Spotify → Connect.');
    return fn(c);
  }

  async spotifyLike(mode) {
    const r = await this.spotifyCall((c) => c.likeCurrent(mode));
    this.spotLiked = { uri: r.track.uri, liked: r.liked };
    this.hub.set('spotify.liked', r.liked);
    setTimeout(() => this.pollMedia(), 250);
    return r;
  }

  // ---- Pear Desktop / YouTube Music ----
  publishPear() {
    const p = this.pear;
    const s = p.state;
    this.hub.set('pear.connected', p.isConnected());
    if (!p.isConnected() || !s) { this.clearPear(false); return; }
    this.hub.set('pear.playing', Boolean(s.isPlaying));
    this.hub.set('pear.shuffle', Boolean(s.shuffle));
    this.hub.set('pear.repeat', Boolean(s.repeat) && s.repeat !== 'NONE');
    this.hub.set('pear.muted', Boolean(s.muted));
    this.hub.set('pear.liked', p.like === 'LIKE');
    this.hub.set('pear.disliked', p.like === 'DISLIKE');
    this.hub.set('pear.info', p.view()); // changing every second keeps widgets moving
  }

  // Runs a Pear call, with a friendly message when it is not set up or not connected.
  async pearCall(fn) {
    const c = this.pear;
    if (!c) throw new Error('Pear is not available');
    if (!c.token) throw new Error('Pear is not connected. Connect it in Settings → Connections (Pear asks you to click Allow once).');
    return fn(c);
  }

  clearPear(includeConnected = true) {
    for (const k of ['pear.playing', 'pear.shuffle', 'pear.repeat', 'pear.muted', 'pear.liked', 'pear.disliked', 'pear.info']) this.hub.remove(k);
    if (includeConnected) this.hub.remove('pear.connected');
  }
  // ---- OBS ----
  onObsStatus(status) {
    if (status === 'connected') this.loadObsState();
    else {
      for (const k of ['obs.recording', 'obs.streaming', 'obs.replay', 'obs.scene', 'obs.inputMuted']) this.hub.remove(k);
    }
    this.emit('status');
  }

  async loadObsState() {
    const ask = (type, data) => this.obs.request(type, data).catch(() => null);
    const [rec, stream, replay, scenes, inputs] = await Promise.all([
      ask('GetRecordStatus'), ask('GetStreamStatus'), ask('GetReplayBufferStatus'), ask('GetSceneList'), ask('GetInputList'),
    ]);
    this.hub.set('obs.recording', Boolean(rec && rec.outputActive));
    this.hub.set('obs.streaming', Boolean(stream && stream.outputActive));
    this.hub.set('obs.replay', Boolean(replay && replay.outputActive));
    if (scenes) {
      this.obsCache.scenes = scenes.scenes.map((s) => s.sceneName).reverse();
      this.hub.set('obs.scene', scenes.currentProgramSceneName);
    }
    if (inputs) {
      const names = inputs.inputs.map((i) => i.inputName);
      this.obsCache.inputs = names;
      const muted = {};
      await Promise.all(names.slice(0, 60).map(async (name) => {
        const r = await ask('GetInputMute', { inputName: name });
        if (r) muted[name] = r.inputMuted;
      }));
      this.hub.set('obs.inputMuted', muted);
    }
  }

  onObsEvent({ type, data }) {
    if (type === 'RecordStateChanged') this.hub.set('obs.recording', Boolean(data.outputActive));
    else if (type === 'StreamStateChanged') this.hub.set('obs.streaming', Boolean(data.outputActive));
    else if (type === 'ReplayBufferStateChanged') this.hub.set('obs.replay', Boolean(data.outputActive));
    else if (type === 'CurrentProgramSceneChanged') this.hub.set('obs.scene', data.sceneName);
    else if (type === 'InputMuteStateChanged') this.hub.set('obs.inputMuted', { ...(this.hub.get('obs.inputMuted') || {}), [data.inputName]: data.inputMuted });
    else if (type === 'SceneListChanged' || type === 'InputCreated' || type === 'InputRemoved') this.loadObsState();
  }

  // ---- VRChat OSC ----
  startVrc() {
    if (this.listener) return;
    const { host, listenPort } = this.settings.osc;
    const l = new OscListener(listenPort, host === 'localhost' ? '127.0.0.1' : host);
    this.listener = l;
    l.on('listening', () => { this.vrcStatus = 'listening'; this.vrcError = ''; this.emit('status'); });
    l.on('error', (err) => {
      this.vrcStatus = 'error';
      this.vrcError = err.code === 'EADDRINUSE' ? `Port ${listenPort} is already used by another app` : err.message;
      this.emit('status');
    });
    l.on('message', (m) => this.onOsc(m));
    l.start();
  }

  stopVrc() {
    if (this.listener) this.listener.stop();
    this.listener = null;
    this.vrcStatus = 'off';
    this.vrcError = '';
    for (const k of ['vrc.MuteSelf', 'vrc.avatar']) this.hub.remove(k);
    this.emit('status');
  }

  onOsc({ address, args }) {
    this.vrcLastHeard = Date.now();
    if (address === '/avatar/change') { this.hub.set('vrc.avatar', String(args[0])); return; }
    const prefix = '/avatar/parameters/';
    if (!address.startsWith(prefix)) return;
    const name = address.slice(prefix.length);
    const value = args[0];
    if (name === 'MuteSelf') { this.hub.set('vrc.MuteSelf', Boolean(value)); return; }
    // Avatars stream dozens of parameters per second; only publish the ones something watches.
    if (this.needs.vrcParams.has(name) || name in this.vrcParams) this.remember(name, value);
  }

  remember(name, value) {
    this.vrcParams[name] = value;
    this.hub.set('vrc.param', { ...this.vrcParams });
  }

  // ---- Twitch ----
  startTwitch() {
    if (this.twTimer || !this.twitch) return;
    this.twTick = 0;
    this.pollTwitch(true);
    this.twTimer = setInterval(() => this.pollTwitch(false), TWITCH_POLL_MS);
  }

  stopTwitch() {
    clearInterval(this.twTimer);
    this.twTimer = null;
    for (const k of ['twitch.connected', 'twitch.live', 'twitch.adSoon', 'twitch.emoteOnly', 'twitch.followersOnly', 'twitch.subsOnly', 'twitch.slowMode', 'twitch.uniqueChat', 'twitch.shield', 'twitch.ads', 'twitch.stream']) this.hub.remove(k);
  }

  refreshTwitch() {
    if (this.needs.twitch) this.pollTwitch(true);
  }

  // Runs a Twitch call, with a friendly message when it is not set up.
  async twitchCall(fn) {
    const t = this.twitch;
    if (!t || t.status === 'off') throw new Error('Twitch is not set up. Add your Client ID in Settings → Connections.');
    if (!t.isConnected()) throw new Error('Twitch is not connected. Connect it in Settings → Connections.');
    return fn(t);
  }

  async pollTwitch(force) {
    const t = this.twitch;
    if (!t || this.twBusy) return;
    this.twBusy = true;
    try {
      this.hub.set('twitch.connected', t.isConnected());
      if (!t.isConnected()) {
        for (const k of ['twitch.live', 'twitch.adSoon', 'twitch.emoteOnly', 'twitch.followersOnly', 'twitch.subsOnly', 'twitch.slowMode', 'twitch.uniqueChat', 'twitch.shield', 'twitch.ads', 'twitch.stream']) this.hub.remove(k);
        return;
      }
      const tick = this.twTick++;
      if (this.needs.twitchModes && (force || tick % 2 === 0)) {
        try {
          const s = await t.getChatSettings();
          if (s) {
            this.hub.set('twitch.emoteOnly', Boolean(s.emote_mode));
            this.hub.set('twitch.followersOnly', Boolean(s.follower_mode));
            this.hub.set('twitch.subsOnly', Boolean(s.subscriber_mode));
            this.hub.set('twitch.slowMode', Boolean(s.slow_mode));
            this.hub.set('twitch.uniqueChat', Boolean(s.unique_chat_mode));
          }
        } catch { /* stays "unknown"; the action reports the error if used */ }
        try { this.hub.set('twitch.shield', await t.getShield()); } catch { /* same */ }
      }
      if (this.needs.twitchAds && (force || tick % 3 === 0)) {
        try {
          const a = await t.getAds();
          this.twAds = a ? {
            error: '', nextAdAt: parseTime(a.next_ad_at), lastAdAt: parseTime(a.last_ad_at), durationSec: Number(a.duration) || 0,
            snoozeCount: Number(a.snooze_count) || 0, snoozeRefreshAt: parseTime(a.snooze_refresh_at),
          } : { error: '' };
        } catch (err) { this.twAds = { error: err.message }; }
      }
      if (this.needs.twitchStream && (force || tick % 6 === 0)) {
        try {
          const s = await t.getStream();
          this.twStream = s ? { error: '', live: true, viewers: Number(s.viewer_count) || 0, startedAt: parseTime(s.started_at), title: s.title || '', game: s.game_name || '' } : { error: '', live: false };
        } catch (err) { this.twStream = { error: err.message, live: false }; }
      }
      if (this.needs.twitchAds) {
        const warn = ((this.settings && this.settings.twitch.adWarnMinutes) || 5) * 60000;
        const until = this.twAds.nextAdAt ? this.twAds.nextAdAt - this.now() : -1;
        this.hub.set('twitch.adSoon', until > 0 && until <= warn);
        this.hub.set('twitch.ads', { ...this.twAds });
      }
      if (this.needs.twitchStream) {
        this.hub.set('twitch.live', Boolean(this.twStream.live));
        this.hub.set('twitch.stream', { ...this.twStream });
      }
    } catch { /* the client reports its own status */ } finally {
      this.twBusy = false;
    }
  }

  twitchAdsData() {
    const t = this.twitch;
    return { connected: Boolean(t && t.isConnected()), status: t ? t.status : 'off', ...this.twAds };
  }

  twitchStreamData() {
    const t = this.twitch;
    return { connected: Boolean(t && t.isConnected()), status: t ? t.status : 'off', ...this.twStream };
  }

  // ---- for the editor's dropdowns ----
  async options(kind) {
    const dev = (list) => list.map((d) => ({ value: d.id, label: d.isDefault ? `${d.name} (default)` : d.name }));
    switch (kind) {
      case 'audio.render': return dev(await this.helper.call('audio.devices', { flow: 'render' }));
      case 'audio.capture': return dev(await this.helper.call('audio.devices', { flow: 'capture' }));
      case 'audio.sessions': return (await this.helper.call('audio.sessions')).map((s) => ({ value: s.name, label: s.name }));
      case 'vr.devices': {
        this.loadVrKnown();
        const map = new Map();
        for (const d of [...this.vrKnown.values(), ...(this.vrData.devices || [])]) if (d.serial && d.class !== 'other') map.set(d.serial, d);
        return [...map.values()].map((d) => ({ value: d.serial, label: `${d.model || d.class} (${d.serial})` }));
      }
      case 'media.players': {
        const list = [
          { value: 'auto', label: 'Automatic: a playing music app first, then a browser tab (recommended)' },
          { value: 'any', label: 'Whatever Windows shows (the last app that played)' },
        ];
        let found = [];
        try {
          found = await this.mediaHelper.call('list', {}, 6000);
        } catch { /* the helper is not available: offer the fixed choices only */ } finally {
          if (!this.needs.media.size) this.mediaHelper.release();
        }
        for (const p of Array.isArray(found) ? found : []) {
          const key = String(p.id).replace(/\.exe$/i, '').toLowerCase();
          const name = key.charAt(0).toUpperCase() + key.slice(1);
          const what = p.title ? `${String(p.status).toLowerCase()}: ${p.title}${p.artist ? ` - ${p.artist}` : ''}` : String(p.status).toLowerCase();
          list.push({ value: key, label: `${name}  (${what})` });
        }
        list.push({ value: 'pear', label: 'YouTube Music through the Pear API (album, like, shuffle, volume)' });
        return list;
      }
      case 'processes': return (await this.helper.call('proc.list')).sort().map((n) => ({ value: n, label: n }));
      case 'obs.scenes':
      case 'obs.inputs': {
        this.keepObsFor(60000);
        if (this.obs.status !== 'connected') {
          await new Promise((r) => {
            const done = () => { this.obs.off('status', done); clearTimeout(t); r(); };
            const t = setTimeout(done, 2500);
            this.obs.on('status', done);
          });
        }
        if (this.obs.status !== 'connected') {
          throw new Error(this.obs.status === 'auth-failed' ? 'OBS password is wrong (Settings → Connections)' : 'OBS is not reachable. Is it running with WebSocket enabled? (Tools → WebSocket Server Settings)');
        }
        await this.loadObsState();
        const list = kind === 'obs.scenes' ? this.obsCache.scenes : this.obsCache.inputs;
        return list.map((n) => ({ value: n, label: n }));
      }
      default: throw new Error(`Unknown option list "${kind}"`);
    }
  }
}

module.exports = { Providers, emptyNeeds, parseTime };
