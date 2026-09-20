// Mini-screen widgets. Each factory returns { el, update(data), tick() }:
//   update(data)  new data from the core (can be called often, must be cheap)
//   tick()        runs ~5x a second so clocks, timers and progress bars move smoothly
// ctx = { button, params, send(cmd, arg), clock() }  where clock() is the core's time in ms.
import { h } from './util.js';
import * as net from './net.js';

// How a widget reacts to pointers in use mode: 'none' | 'tap' | 'tap-hold' | 'custom'.
export const INTERACTION = {
  clock: 'none', timer: 'tap-hold', stopwatch: 'tap-hold', coin: 'tap', dice: 'tap',
  battery: 'none', media: 'custom', 'twitch.ads': 'tap', 'twitch.stream': 'none',
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtDuration(ms, { tenths = false } = {}) {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const base = hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  return tenths ? `${base}.${Math.floor((total % 1000) / 100)}` : base;
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    for (let i = 0; i < 3; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.32;
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    }
  } catch { /* audio unavailable: the visual cue is enough */ }
}

const caption = (ctx) => (ctx.button.label ? h('div', { class: 'w-cap' }, ctx.button.label) : null);
const inner = (cls, ...kids) => h('div', { class: `w-inner ${cls}` }, ...kids);

// ---- clock ----
function clockWidget(ctx) {
  const { hour12, seconds, date, timezone } = ctx.params;
  const time = h('div', { class: 'w-big' });
  const day = h('div', { class: 'w-sub' });
  const el = inner('w-clock', caption(ctx), time, date === false ? null : day);
  const opts = (extra) => {
    const o = { ...extra };
    if (timezone) o.timeZone = timezone;
    return o;
  };
  const make = (extra) => {
    try { return new Intl.DateTimeFormat(undefined, opts(extra)); } catch { return new Intl.DateTimeFormat(undefined, extra); }
  };
  const tf = make({ hour: '2-digit', minute: '2-digit', second: seconds === false ? undefined : '2-digit', hour12: Boolean(hour12) });
  const df = make({ weekday: 'long', month: 'long', day: 'numeric', ...(timezone ? { timeZoneName: 'short' } : {}) });
  return {
    el,
    update() {},
    tick() {
      const now = new Date();
      time.textContent = tf.format(now);
      day.textContent = df.format(now);
    },
  };
}

// ---- countdown timer ----
function timerWidget(ctx) {
  const time = h('div', { class: 'w-big' });
  const status = h('div', { class: 'w-sub' });
  const bar = h('i');
  const el = inner('w-timer', caption(ctx), time, h('div', { class: 'w-bar' }, bar), status);
  let d = null;
  let lastMode = null;
  const remaining = () => {
    if (!d) return 0;
    if (d.mode === 'running') return Math.max(0, d.endsAt - ctx.clock());
    if (d.mode === 'paused') return d.remainingMs;
    if (d.mode === 'done') return 0;
    return d.durationMs;
  };
  const draw = () => {
    if (!d) return;
    const r = remaining();
    time.textContent = fmtDuration(Math.ceil(r / 1000) * 1000);
    bar.style.width = `${d.durationMs ? (r / d.durationMs) * 100 : 0}%`;
    status.textContent = { idle: 'Tap to start', running: 'Running · tap to pause', paused: 'Paused · tap to resume', done: "Time's up! Tap to clear" }[d.mode] || '';
    el.classList.toggle('done', d.mode === 'done');
    el.classList.toggle('running', d.mode === 'running');
  };
  return {
    el,
    update(data) {
      if (lastMode === 'running' && data.mode === 'done' && ctx.params.beep !== false) beep();
      lastMode = data.mode;
      d = data;
      draw();
    },
    tick: draw,
  };
}

// ---- stopwatch ----
function stopwatchWidget(ctx) {
  const time = h('div', { class: 'w-big mono' });
  const status = h('div', { class: 'w-sub' });
  const el = inner('w-stopwatch', caption(ctx), time, status);
  let d = null;
  const draw = () => {
    if (!d) return;
    const ms = d.running ? d.elapsedMs + (ctx.clock() - d.startedAt) : d.elapsedMs;
    time.textContent = fmtDuration(ms, { tenths: ctx.params.tenths !== false });
    status.textContent = d.running ? 'Running · tap to stop' : ms > 0 ? 'Stopped · tap to resume, hold to reset' : 'Tap to start';
    el.classList.toggle('running', d.running);
  };
  return { el, update(data) { d = data; draw(); }, tick: draw };
}

// ---- coin ----
function coinWidget(ctx) {
  // Drawn in CSS: the coin emoji is missing from Windows 10's emoji font.
  const letter = h('span', null, '?');
  const face = h('div', { class: 'w-coin' }, letter);
  const result = h('div', { class: 'w-big' }, '');
  const sub = h('div', { class: 'w-sub' }, 'Tap to flip');
  const el = inner('w-coinbox', caption(ctx), face, result, sub);
  let lastSeq = null;
  return {
    el,
    update(data) {
      const seq = data.seq || 0;
      if (lastSeq !== null && seq !== lastSeq) {
        face.classList.remove('flip');
        void face.offsetWidth; // restart the animation
        face.classList.add('flip');
      }
      lastSeq = seq;
      if (data.last) {
        result.textContent = data.last.text.toUpperCase();
        sub.textContent = 'Tap to flip again';
        letter.textContent = data.last.text === 'Heads' ? 'H' : 'T';
        face.classList.toggle('tails', data.last.text !== 'Heads');
      }
    },
    tick() {},
  };
}

// ---- dice ----
function diceWidget(ctx) {
  const p = ctx.params;
  const sides = p.sides === 'custom' ? Number(p.customSides) || 6 : Number(p.sides) || 20;
  const count = Number(p.count) || 1;
  const mod = Number(p.modifier) || 0;
  const label = `${count > 1 ? count : ''}d${sides}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}`;
  const chip = h('div', { class: 'w-chip' }, `🎲 ${label}`);
  const result = h('div', { class: 'w-big' }, '—');
  const detail = h('div', { class: 'w-sub' }, 'Tap to roll');
  const el = inner('w-dicebox', caption(ctx), chip, result, detail);
  let lastSeq = null;
  return {
    el,
    update(data) {
      const seq = data.seq || 0;
      if (data.last) {
        result.textContent = data.last.text;
        detail.textContent = count > 1 || mod || (data.last.dice || '').includes('adv') || (data.last.dice || '').includes('dis') ? data.last.detail : 'Tap to roll again';
        el.classList.toggle('crit', data.last.natural === 20);
        el.classList.toggle('fumble', data.last.natural === 1);
      }
      if (lastSeq !== null && seq !== lastSeq) {
        result.classList.remove('pop');
        void result.offsetWidth;
        result.classList.add('pop');
      }
      lastSeq = seq;
    },
    tick() {},
  };
}

// ---- SteamVR battery ----
const CLASS_ICON = { hmd: '🥽', controller: '🎮', tracker: '📡', basestation: '▣' };

// The picture files: "L" after the name = low battery, "DC" on a base station = off (see src/ui/assets/devices).
function devicePicture(d, low) {
  if (!d.picture) return '';
  const suffix = d.class === 'basestation' ? (d.connected ? '' : 'DC') : (low ? 'L' : '');
  return `assets/devices/${d.picture}${suffix}.png`;
}

function batteryText(d, known) {
  if (!d.connected) return known ? `${d.battery}%` : 'off';
  if (known) return `${d.battery}%${d.charging ? ' ⚡' : ''}`;
  return d.class === 'basestation' ? 'on' : '—';
}

function batteryWidget(ctx) {
  const list = h('div', { class: 'w-batlist' });
  const pics = h('div', { class: 'w-batpics', hidden: true });
  const msg = h('div', { class: 'w-sub w-center' });
  const sim = h('div', { class: 'w-batsim', hidden: true }, 'SIMULATED');
  const el = inner('w-battery', caption(ctx), list, pics, msg, sim);
  let sig = '';
  let last = null;
  let size = '';
  // As many columns as suit the shape of the button: a wide one gets a row, a tall one a stack.
  const columns = (n) => {
    const w = el.clientWidth; const hgt = el.clientHeight;
    const aspect = w && hgt ? w / hgt : 1.5;
    return Math.max(1, Math.min(n, Math.round(Math.sqrt((n * aspect) / 0.9))));
  };
  return {
    el,
    update(data) {
      last = data;
      size = `${el.clientWidth}x${el.clientHeight}`;
      const cols = data.layout === 'pictures' && data.devices ? columns(data.devices.length) : 0;
      const next = `${cols}|${JSON.stringify(data)}`;
      if (next === sig) return; // nothing changed: leave the pictures alone so they never flicker
      sig = next;
      list.replaceChildren();
      pics.replaceChildren();
      msg.textContent = '';
      sim.hidden = !data.simulated;
      const usePics = data.layout === 'pictures';
      list.hidden = usePics;
      pics.hidden = !usePics;
      if (!data.connected) { msg.textContent = data.error || 'SteamVR is not running'; return; }
      if (!data.devices || !data.devices.length) { msg.textContent = 'No devices found'; return; }
      if (usePics) {
        pics.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      }
      for (const d of data.devices) {
        const known = d.hasBattery && d.battery >= 0;
        const low = known && d.battery <= data.lowPercent && !d.charging && d.connected;
        const lost = d.connected && d.trackingOk === false;
        const state = `${low ? ' low' : ''}${known ? '' : ' unknown'}${d.connected ? '' : ' off'}${lost ? ' lost' : ''}`;
        if (usePics) {
          const src = devicePicture(d, low);
          pics.append(h('div', { class: `w-batpic${state}` },
            src ? h('img', { src, alt: '', draggable: 'false' }) : h('div', { class: 'w-batpicfb' }, CLASS_ICON[d.class] || '🔌'),
            h('div', { class: 'w-batname' }, d.name),
            known || d.class === 'basestation' || !d.connected
              ? h('div', { class: 'w-batpct' }, batteryText(d, known))
              : h('div', { class: 'w-batpct' }, '—'),
            known ? h('span', { class: 'w-bar small' }, h('i', { style: { width: `${d.battery}%` } })) : null,
            lost ? h('div', { class: 'w-batflag' }, 'tracking lost') : null));
        } else {
          list.append(h('div', { class: `w-batrow${state}` },
            h('span', { class: 'w-baticon' }, CLASS_ICON[d.class] || '🔌'),
            h('span', { class: 'w-batname' }, lost ? `${d.name} · tracking lost` : d.name),
            h('span', { class: 'w-bar small' }, h('i', { style: { width: `${known ? d.battery : 0}%` } })),
            h('span', { class: 'w-batpct' }, batteryText(d, known))));
        }
      }
    },
    tick() {
      // The button was resized (edit mode): lay the pictures out again.
      if (last && last.layout === 'pictures' && `${el.clientWidth}x${el.clientHeight}` !== size) this.update(last);
    },
  };
}

// ---- now playing (Spotify and other players) ----
const thumbs = new Map(); // thumbKey -> data URL
const thumbLoading = new Set();

function mediaWidget(ctx) {
  const cover = h('img', { class: 'w-coverimg', alt: '' });
  const coverBox = h('div', { class: 'w-cover' }, h('span', { class: 'w-coverph' }, '🎵'), cover);
  const title = h('div', { class: 'w-title' }, 'Nothing playing');
  const artist = h('div', { class: 'w-artist' }, '');
  const tPos = h('span', { class: 'w-time' }, '0:00');
  const tEnd = h('span', { class: 'w-time' }, '0:00');
  const fill = h('i');
  const bar = h('div', { class: 'w-bar seek' }, fill);
  const progress = ctx.params.progress === false ? null : h('div', { class: 'w-progress' }, tPos, bar, tEnd);
  const btn = (label, cmd, big) => h('button', { class: `w-ctl${big ? ' big' : ''}`, title: cmd, onclick: (e) => { e.stopPropagation(); ctx.send(cmd); } }, label);
  const playBtn = btn('▶', 'toggle', true);
  const controls = ctx.params.controls === false ? null : h('div', { class: 'w-controls' }, btn('⏮', 'previous'), playBtn, btn('⏭', 'next'));
  // Only Pear (YouTube Music) reports these, so the row stays hidden for other players.
  const likeBtn = btn('♡', 'like');
  const shuffleBtn = btn('🔀', 'shuffle');
  const repeatBtn = btn('🔁', 'repeat');
  const extraRow = ctx.params.controls === false ? null : h('div', { class: 'w-controls extras', hidden: true }, likeBtn, shuffleBtn, repeatBtn);
  const meta = h('div', { class: 'w-meta' }, title, artist, progress, controls, extraRow);
  const el = inner('w-media', coverBox, meta);
  let d = null;
  let shownKey = '';

  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!d || !d.canSeek || !d.durationMs) return;
    const r = bar.getBoundingClientRect();
    ctx.send('seek', Math.round(((e.clientX - r.left) / r.width) * d.durationMs));
  });

  const loadThumb = (key) => {
    if (thumbs.has(key)) { cover.src = thumbs.get(key); coverBox.classList.add('has'); return; }
    if (thumbLoading.has(key)) return;
    thumbLoading.add(key);
    net.request('media.thumb', { key }).then((data) => {
      thumbLoading.delete(key);
      if (data) thumbs.set(key, data);
      if (data && shownKey === key) { cover.src = data; coverBox.classList.add('has'); }
    }, () => thumbLoading.delete(key));
  };

  const draw = () => {
    if (!d) return;
    if (!d.available) {
      title.textContent = d.error || 'Nothing playing';
      artist.textContent = d.pending ? '' : 'Start music in Spotify (or any player)';
      coverBox.classList.remove('has');
      playBtn.textContent = '▶';
      fill.style.width = '0%';
      tPos.textContent = tEnd.textContent = '0:00';
      return;
    }
    title.textContent = d.title || 'Unknown title';
    artist.textContent = [d.artist, d.album].filter(Boolean).join(' · ');
    playBtn.textContent = d.playing ? '⏸' : '▶';
    if (extraRow) {
      const x = d.extras;
      extraRow.hidden = !x;
      if (x) {
        likeBtn.hidden = x.liked === undefined; // Windows players (Spotify) have no like through Windows
        likeBtn.textContent = x.liked ? '♥' : x.disliked ? '👎' : '♡';
        likeBtn.classList.toggle('on', x.liked);
        shuffleBtn.classList.toggle('on', x.shuffle);
        repeatBtn.classList.toggle('on', x.repeat && x.repeat !== 'NONE');
        repeatBtn.textContent = x.repeat === 'ONE' ? '🔂' : '🔁';
      }
    }
    const pos = d.durationMs ? Math.min(d.durationMs, d.positionMs + (d.playing ? ctx.clock() - d.fetchedAt : 0)) : d.positionMs;
    fill.style.width = d.durationMs ? `${(pos / d.durationMs) * 100}%` : '0%';
    tPos.textContent = fmtDuration(pos);
    tEnd.textContent = d.durationMs ? fmtDuration(d.durationMs) : '--:--';
    bar.classList.toggle('noseek', !d.canSeek);
  };

  return {
    el,
    update(data) {
      d = data;
      if (data.available && data.thumbKey !== shownKey) {
        shownKey = data.thumbKey;
        cover.removeAttribute('src');
        coverBox.classList.remove('has');
        loadThumb(shownKey);
      }
      draw();
    },
    tick: draw,
  };
}

// ---- Twitch ----
function adsWidget(ctx) {
  const head = h('div', { class: 'w-chip' }, '📺 Next ad');
  const time = h('div', { class: 'w-big' }, '--:--');
  const sub = h('div', { class: 'w-sub' }, '');
  const el = inner('w-ads', caption(ctx), head, time, sub);
  let d = null;
  const draw = () => {
    if (!d) return;
    if (!d.connected) {
      head.textContent = '📺 Twitch';
      time.textContent = '—';
      sub.textContent = d.status === 'off' ? 'Add your Client ID in Settings' : 'Connect Twitch in Settings';
      el.classList.remove('soon', 'live');
      return;
    }
    if (d.error) { time.textContent = '—'; sub.textContent = d.error; return; }
    const now = ctx.clock();
    const adEnd = d.lastAdAt ? d.lastAdAt + d.durationSec * 1000 : 0;
    const snoozes = d.snoozeCount === undefined ? '' : ` · ${d.snoozeCount} snooze${d.snoozeCount === 1 ? '' : 's'} left`;
    if (adEnd > now && d.lastAdAt <= now) {
      head.textContent = '📺 AD BREAK';
      time.textContent = fmtDuration(adEnd - now);
      sub.textContent = 'Ad running';
      el.classList.add('live'); el.classList.remove('soon');
    } else if (d.nextAdAt > now) {
      const left = d.nextAdAt - now;
      head.textContent = '📺 Next ad in';
      time.textContent = fmtDuration(left);
      sub.textContent = `${ctx.params.tapAction === 'none' ? '' : 'Tap to snooze'}${snoozes}`.replace(/^ · /, '');
      el.classList.toggle('soon', left <= 5 * 60000); el.classList.remove('live');
    } else {
      head.textContent = '📺 Ads';
      time.textContent = 'None';
      sub.textContent = `No ad scheduled${snoozes}`;
      el.classList.remove('soon', 'live');
    }
  };
  return { el, update(data) { d = data; draw(); }, tick: draw };
}

function streamWidget(ctx) {
  const badge = h('div', { class: 'w-badge' }, 'OFFLINE');
  const viewers = h('div', { class: 'w-big' }, '—');
  const sub = h('div', { class: 'w-sub' }, '');
  const el = inner('w-stream', caption(ctx), badge, viewers, sub);
  let d = null;
  const draw = () => {
    if (!d) return;
    if (!d.connected) { badge.textContent = 'TWITCH'; viewers.textContent = '—'; sub.textContent = d.status === 'off' ? 'Add your Client ID in Settings' : 'Connect Twitch in Settings'; el.classList.remove('live'); return; }
    if (d.error) { badge.textContent = 'ERROR'; viewers.textContent = '—'; sub.textContent = d.error; return; }
    if (d.live) {
      badge.textContent = '● LIVE';
      viewers.textContent = `👁 ${d.viewers}`;
      sub.textContent = d.startedAt ? `Up ${fmtDuration(ctx.clock() - d.startedAt)}` : '';
      el.classList.add('live');
    } else {
      badge.textContent = 'OFFLINE';
      viewers.textContent = '—';
      sub.textContent = 'Not streaming';
      el.classList.remove('live');
    }
  };
  return { el, update(data) { d = data; draw(); }, tick: draw };
}

const FACTORIES = {
  clock: clockWidget, timer: timerWidget, stopwatch: stopwatchWidget, coin: coinWidget, dice: diceWidget,
  battery: batteryWidget, media: mediaWidget, 'twitch.ads': adsWidget, 'twitch.stream': streamWidget,
};

// Returns null for a widget type this version does not know.
export function createWidget(type, ctx) {
  const make = FACTORIES[type];
  if (!make) return null;
  const w = make(ctx);
  w.tick();
  return w;
}
