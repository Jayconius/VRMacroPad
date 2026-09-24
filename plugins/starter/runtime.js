// Polls Windows audio, the running-process list, and media sessions (Spotify, browsers, most players) —
// moved unchanged from the old core Providers class. This is the one plugin the app cannot really do
// without, so it has no "off" state of its own: it is just quiet whenever nothing needs it.
const AUDIO_POLL_MS = 1500;
const PROC_POLL_MS = 3000;
const MEDIA_POLL_MS = 1000;

class StarterRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.now = ctx.now;
    this.audioTimer = null;
    this.audioBusy = false;
    this.procTimer = null;
    this.procBusy = false;
    this.mediaTimer = null;
    this.mediaBusy = false;
    this.mediaInfo = new Map(); // app -> info
    this.mediaThumbs = new Map(); // thumbKey -> data URL
    this.neededMedia = new Set();
  }

  get helper() { return this.ctx.winHelper('audio'); }
  get mediaHelper() { return this.ctx.winHelper('media'); }

  sync(needs) {
    this.audioApps = Boolean(needs.audio && needs.audioApps); // per-app mute state is only read while a button follows it
    if (!this.audioApps) this.hub.remove('audio.app.muted');
    if (needs.audio) this.startAudio(); else this.stopAudio();
    if (needs.process) this.startProc(); else this.stopProc();
    this.neededMedia = needs.media instanceof Set ? needs.media : new Set();
    if (this.neededMedia.size) this.startMedia(); else this.stopMedia();
  }

  stop() {
    this.stopAudio();
    this.stopProc();
    this.stopMedia();
  }

  // For the Info dialog only: the Windows media-session helper's own connection state, while something
  // actually needs it (Spotify, YouTube Music, media widgets...).
  status() {
    const h = this.neededMedia.size ? this.mediaHelper : null;
    return { state: h ? h.status : 'off', error: h ? h.error : '' };
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
      // The real mute state of every individual device, for buttons tied to one specific microphone or speaker
      // ("audio.in.mutedBy=<device id>"). A failure here must not stop the default-device state above.
      for (const [flow, key] of [['capture', 'audio.in.mutedBy'], ['render', 'audio.out.mutedBy']]) {
        try {
          const list = await this.helper.call('audio.devices', { flow });
          if (!Array.isArray(list)) continue;
          const map = {};
          for (const d of list) if (d && typeof d.muted === 'boolean') map[d.id] = d.muted;
          this.hub.set(key, map);
        } catch { /* leave the last known value */ }
      }
      if (this.audioApps) {
        try {
          const sessions = await this.helper.call('audio.sessions');
          if (Array.isArray(sessions)) {
            const map = {};
            for (const s of sessions) if (s && typeof s.muted === 'boolean') map[String(s.name).toLowerCase()] = s.muted;
            this.hub.set('audio.app.muted', map); // an app that is not running is simply "not muted"
          }
        } catch { /* leave the last known value */ }
      }
    } catch { /* helper status already reports the problem */ } finally {
      this.audioBusy = false;
    }
  }

  // Called after an audio action so the button color updates immediately.
  refreshAudio() {
    if (this.audioTimer) this.pollAudio();
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
      for (const app of this.neededMedia) {
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

  // spotify.* states (buttons that light up with Spotify's own shuffle / repeat / playing). Spotify itself
  // needs no plugin-specific polling: it is just another app on the generic Windows media session list.
  publishSpotify() {
    if (!this.neededMedia.has('spotify') || !this.mediaTimer) {
      for (const k of ['spotify.playing', 'spotify.shuffle', 'spotify.repeat']) this.hub.remove(k);
      return;
    }
    const i = this.mediaInfo.get('spotify') || {};
    const x = i.extras;
    this.hub.set('spotify.playing', Boolean(i.playing));
    this.hub.set('spotify.shuffle', Boolean(x && x.shuffle));
    this.hub.set('spotify.repeat', Boolean(x && x.repeat && x.repeat !== 'NONE'));
  }

  // What widgets see: no picture data (fetched separately), position projected to "now".
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
      extras: r.shuffle === null || r.shuffle === undefined ? undefined : { shuffle: Boolean(r.shuffle), repeat: repeatNames[r.repeat] || 'NONE' },
    };
  }

  // What is playing on this PC right now (the first player that is playing, else the first with a title).
  nowPlaying() {
    const list = [...this.mediaInfo.values()].filter((i) => i && i.available && i.title);
    const p = list.find((i) => i.playing) || list[0];
    return p ? { title: p.title, artist: p.artist || '', playing: Boolean(p.playing) } : null;
  }

  mediaData(app) {
    return this.mediaInfo.get(app) || { available: false, error: '', pending: true };
  }

  mediaThumb(key) {
    return this.mediaThumbs.get(key) || '';
  }

  async thumb(key) {
    return this.mediaThumb(key);
  }

  // seek: an absolute position; seekby: a jump in ms; shuffle / repeat: a mode (nothing = flip / next mode)
  async control(app, cmd, arg) {
    if (!this.mediaHelper) throw new Error('Media control is not available');
    const extra = cmd === 'seek' ? { positionMs: Math.round(Number(arg) || 0) }
      : cmd === 'seekby' ? { deltaMs: Math.round(Number(arg) || 0) }
        : cmd === 'shuffle' || cmd === 'repeat' ? { mode: arg ? String(arg) : '' } : {};
    await this.mediaHelper.call('control', { app, cmd, ...extra });
    setTimeout(() => this.pollMedia(), 250);
  }

  // ---- for the editor's dropdowns ----
  async options(kind) {
    const dev = (list) => list.map((d) => ({ value: d.id, label: d.isDefault ? `${d.name} (default)` : d.name }));
    switch (kind) {
      case 'audio.render': return dev(await this.helper.call('audio.devices', { flow: 'render' }));
      case 'audio.capture': return dev(await this.helper.call('audio.devices', { flow: 'capture' }));
      case 'audio.sessions': return (await this.helper.call('audio.sessions')).map((s) => ({ value: s.name, label: s.name }));
      case 'processes': return (await this.helper.call('proc.list')).sort().map((n) => ({ value: n, label: n }));
      case 'media.players': {
        const list = [
          { value: 'auto', label: 'Automatic: a playing music app first, then a browser tab (recommended)' },
          { value: 'any', label: 'Whatever Windows shows (the last app that played)' },
        ];
        let found = [];
        try {
          found = await this.mediaHelper.call('list', {}, 6000);
        } catch { /* the helper is not available: offer the fixed choices only */ } finally {
          if (!this.neededMedia.size) this.mediaHelper.release();
        }
        for (const p of Array.isArray(found) ? found : []) {
          const key = String(p.id).replace(/\.exe$/i, '').toLowerCase();
          const name = key.charAt(0).toUpperCase() + key.slice(1);
          const what = p.title ? `${String(p.status).toLowerCase()}: ${p.title}${p.artist ? ` - ${p.artist}` : ''}` : String(p.status).toLowerCase();
          list.push({ value: key, label: `${name}  (${what})` });
        }
        if (this.ctx.plugins.get('pear')) list.push({ value: 'pear', label: 'YouTube Music through the Pear API (album, like, shuffle, volume)' });
        return list;
      }
      default: throw new Error(`Unknown option list "${kind}"`);
    }
  }
}

module.exports = { StarterRuntime };
