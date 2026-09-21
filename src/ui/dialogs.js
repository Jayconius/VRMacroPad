// Settings, page settings and the info / status dialog.
import { h, clear, clone, fmtTime, uid } from './util.js';
import { state, currentPage, subscribe } from './state.js';
import { openModal, confirmDialog, toast } from './modal.js';
import { saveConfig, setActivePage } from './commands.js';
import * as net from './net.js';
import { field, textInput, selectInput, checkbox, hotkeyField, optionsField, staticMultiField } from './forms.js';

const Grid = window.Grid;

const statusText = {
  off: 'Not in use', starting: 'Starting…', ok: 'Running', error: 'Problem', connecting: 'Connecting…',
  connected: 'Connected', 'auth-failed': 'Wrong password', listening: 'Listening',
  'needs-auth': 'Not connected', authorizing: 'Waiting for you to approve it on Twitch…',
  'awaiting-approval': 'Waiting for you to click Allow in Pear…', denied: 'Denied in Pear', 'not-running': "Can't reach Pear",
};

function statusRow(label, status, detail) {
  return h('div', { class: 'status-row' }, h('span', { class: `dot ${status}` }), h('strong', null, label), h('span', { class: 'muted' }, statusText[status] || status), detail ? h('span', { class: 'field-help' }, detail) : null);
}

// ---- page settings ----
export function openPageDialog(pageId, { isNew = false } = {}) {
  const cfg = state.config;
  const existing = cfg.pages.find((p) => p.id === pageId);
  const draft = existing ? clone(existing) : { id: uid('p'), name: `Page ${cfg.pages.length + 1}`, cols: 8, rows: 4, autoShowProcess: '', buttons: [] };
  const errorEl = h('div', { class: 'field-error', hidden: true });
  const min = Grid.minPageSize(draft);

  async function save() {
    const ok = await saveConfig((c) => {
      const idx = c.pages.findIndex((p) => p.id === draft.id);
      const next = { ...draft, name: draft.name.trim() || 'Page' };
      if (idx >= 0) c.pages[idx] = { ...c.pages[idx], name: next.name, cols: next.cols, rows: next.rows, autoShowProcess: next.autoShowProcess };
      else c.pages.push(next);
    });
    if (ok) { modal.close(); if (isNew) setActivePage(draft.id); }
  }

  async function remove() {
    if (state.config.pages.length < 2) { errorEl.textContent = 'You need at least one page.'; errorEl.hidden = false; return; }
    if (!await confirmDialog({ title: 'Delete this page?', message: `"${draft.name}" and all ${existing.buttons.length} buttons on it will be removed.`, confirmLabel: 'Delete page', danger: true })) return;
    if (await saveConfig((c) => { c.pages = c.pages.filter((p) => p.id !== draft.id); })) modal.close();
  }

  async function move(dir) {
    await saveConfig((c) => {
      const i = c.pages.findIndex((p) => p.id === draft.id);
      const j = i + dir;
      if (j < 0 || j >= c.pages.length) return false;
      [c.pages[i], c.pages[j]] = [c.pages[j], c.pages[i]];
      return true;
    });
  }

  const modal = openModal({
    title: isNew ? 'New page' : 'Page settings',
    body: [
      field('Name', textInput(draft.name, (v) => { draft.name = v; })),
      h('div', { class: 'row gap' },
        field('Columns', textInput(draft.cols, (v) => { draft.cols = Math.max(min.cols, Math.min(24, Number(v) || 1)); }, { type: 'number', min: min.cols, max: 24 })),
        field('Rows', textInput(draft.rows, (v) => { draft.rows = Math.max(min.rows, Math.min(16, Number(v) || 1)); }, { type: 'number', min: min.rows, max: 16 }))),
      h('p', { class: 'field-help' }, existing ? `Buttons already reach column ${min.cols}, row ${min.rows}, so the page can't shrink below that.` : 'More columns and rows mean smaller buttons when the window is small.'),
      field('Show this page when an app starts', optionsField({ kind: 'processes', value: draft.autoShowProcess, allowCustom: true, placeholder: 'e.g. vrchat.exe (optional)', onChange: (v) => { draft.autoShowProcess = v.toLowerCase(); } }),
        { help: 'Handy for a VRChat page that appears when VRChat launches.' }),
      errorEl,
    ],
    footer: [
      isNew ? null : h('button', { class: 'btn-danger', onclick: remove }, 'Delete page'),
      isNew ? null : h('button', { class: 'btn-secondary', title: 'Move left', onclick: () => move(-1) }, '◀'),
      isNew ? null : h('button', { class: 'btn-secondary', title: 'Move right', onclick: () => move(1) }, '▶'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn-secondary', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn-primary', onclick: save }, isNew ? 'Add page' : 'Save'),
    ],
  });
}

// The live part of the Twitch sign-in: status, the code to type on twitch.tv, connect/disconnect.
// It redraws itself as the core reports progress, while the Client ID field stays untouched.
function twitchPanel(saveSettings) {
  const box = h('div', { class: 'stack' });
  const result = h('div', { class: 'muted small' });
  const draw = () => {
    clear(box);
    const tw = state.status.twitch || { status: 'off' };
    box.append(statusRow('Twitch', tw.status, tw.status === 'connected' && tw.user ? `Signed in as ${tw.user.name}` : tw.error));
    if (tw.status === 'authorizing' && tw.pending) {
      box.append(h('div', { class: 'code-box' },
        h('div', { class: 'muted small' }, 'Go to Twitch and enter this code:'),
        h('div', { class: 'code' }, tw.pending.userCode),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn-primary', onclick: () => net.request('open.external', { url: tw.pending.verificationUri }).then((ok) => { if (!ok) window.open(tw.pending.verificationUri, '_blank', 'noopener'); }, () => window.open(tw.pending.verificationUri, '_blank', 'noopener')) }, 'Open Twitch to approve'),
          h('button', { class: 'btn-secondary', onclick: () => net.request('twitch.disconnect').catch((e) => toast(e.message, 'error')) }, 'Cancel')),
        h('p', { class: 'field-help' }, 'This page updates by itself once you approve.')));
    } else if (tw.status === 'connected') {
      box.append(h('div', { class: 'row gap' },
        h('button', { class: 'btn-secondary', onclick: async () => {
          result.textContent = 'Checking…';
          try {
            const c = await net.request('twitch.check');
            result.textContent = c.missing.length ? `Signed in as ${c.login}. Missing permissions: ${c.missing.join(', ')}. Disconnect and connect again.` : `Signed in as ${c.login}. All permissions granted.`;
          } catch (err) { result.textContent = err.message; }
        } }, 'Check permissions'),
        h('button', { class: 'btn-secondary', onclick: () => net.request('twitch.disconnect').catch((e) => toast(e.message, 'error')) }, 'Disconnect')), result);
    } else {
      box.append(h('button', { class: 'btn-primary', onclick: async () => {
        if (!await saveSettings(false)) return;
        try {
          const flow = await net.request('twitch.connect');
          // Open Twitch's approval page straight away (its link already contains the code), so signing in is just "click Authorize".
          const fallback = () => window.open(flow.verificationUri, '_blank', 'noopener');
          net.request('open.external', { url: flow.verificationUri }).then((ok) => { if (!ok) fallback(); }, fallback);
        } catch (err) { toast(err.message, 'error'); }
      } }, state.app.twitchBuiltIn ? 'Connect Twitch' : 'Save and connect to Twitch'));
    }
    if (tw.status !== 'off') box.append(h('p', { class: 'field-help' }, tw.encrypted ? 'Your Twitch login is stored encrypted with your Windows account.' : 'Your Twitch login is stored in your data folder (not encrypted in this mode).'));
  };
  const off = subscribe(() => { if (box.isConnected) draw(); else off(); });
  draw();
  return box;
}

// The live part of the Pear sign-in: status plus Connect / Disconnect.
function pearPanel(saveSettings) {
  const box = h('div', { class: 'stack' });
  const draw = () => {
    clear(box);
    const p = state.status.pear || { status: 'off' };
    const detail = p.status === 'connected' ? 'Live from Pear' : p.error || ({ 'awaiting-approval': 'A prompt is showing in Pear. Click Allow.', denied: 'Press Connect again and click Allow.', 'not-running': 'Is Pear open with its API Server plugin on?', 'needs-auth': 'Press Connect below.' }[p.status] || '');
    box.append(statusRow('YouTube Music (Pear)', p.status, detail));
    box.append(h('div', { class: 'row gap' },
      p.hasToken || p.status === 'connected'
        ? h('button', { class: 'btn-secondary', onclick: () => net.request('pear.disconnect').catch((e) => toast(e.message, 'error')) }, 'Disconnect')
        : h('button', { class: 'btn-primary', disabled: p.status === 'awaiting-approval', onclick: async () => {
          if (!await saveSettings(false)) return;
          try { await net.request('pear.connect'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Connect Pear')));
  };
  const off = subscribe(() => { if (box.isConnected) draw(); else off(); });
  draw();
  return box;
}

// Spotify (only for the Like button): status plus Connect / Disconnect.
function spotifyPanel(saveSettings) {
  const box = h('div', { class: 'stack' });
  const openIt = (url) => {
    const fallback = () => window.open(url, '_blank', 'noopener');
    net.request('open.external', { url }).then((ok) => { if (!ok) fallback(); }, fallback);
  };
  const draw = () => {
    clear(box);
    const sp = state.status.spotify || { status: 'off' };
    box.append(statusRow('Spotify (Like)', sp.status, sp.status === 'connected' && sp.user ? `Signed in as ${sp.user.name}` : sp.error));
    if (sp.status === 'authorizing') {
      box.append(h('div', { class: 'code-box' },
        h('div', { class: 'muted small' }, 'Waiting for you to approve on Spotify…'),
        h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary', onclick: () => net.request('spotify.disconnect').catch((e) => toast(e.message, 'error')) }, 'Cancel')),
        h('p', { class: 'field-help' }, 'The approval page opened in your browser. This updates by itself once you click Agree.')));
    } else if (sp.status === 'connected') {
      box.append(h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary', onclick: () => net.request('spotify.disconnect').catch((e) => toast(e.message, 'error')) }, 'Disconnect')));
    } else {
      box.append(h('button', { class: 'btn-primary', onclick: async () => {
        if (!await saveSettings(false)) return;
        try {
          const flow = await net.request('spotify.connect');
          openIt(flow.url);
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Connect Spotify'));
    }
    if (sp.status !== 'off') box.append(h('p', { class: 'field-help' }, sp.encrypted ? 'Your Spotify login is stored encrypted with your Windows account.' : 'Your Spotify login is stored in your data folder (not encrypted in this mode).'));
  };
  const off = subscribe(() => { if (box.isConnected) draw(); else off(); });
  draw();
  return box;
}

// ---- settings ----
export function openSettings() {
  const draft = clone(state.config.settings);
  let tab = 'general';
  const tabsEl = h('div', { class: 'tabs' });
  const content = h('div', { class: 'tab-content' });
  const errorEl = h('div', { class: 'field-error', hidden: true });

  const renderTabs = () => {
    clear(tabsEl);
    for (const [id, label] of [['general', 'General'], ['editing', 'Editing lock'], ['window', 'Window'], ['connections', 'Connections'], ['overlay', 'VR overlay'], ['data', 'Backup & data'], ['about', 'About']]) {
      tabsEl.append(h('button', { class: `tab${tab === id ? ' on' : ''}`, onclick: () => { tab = id; renderTabs(); renderContent(); } }, label));
    }
  };

  const general = () => h('div', { class: 'stack' },
    field('Theme', selectInput([['dark', 'Dark'], ['light', 'Light']], draft.theme, (v) => { draft.theme = v; })),
    field('Accent color', (() => { const i = h('input', { type: 'color', value: draft.accent }); i.addEventListener('input', () => { draft.accent = i.value; }); return i; })()),
    checkbox('Play button animations (pulse, flash, glow...)', draft.animations !== false, (v) => { draft.animations = v; }),
    field(`Space between buttons`, textInput(draft.gap, (v) => { draft.gap = Math.max(0, Math.min(40, Number(v) || 0)); }, { type: 'number', min: 0, max: 40 }), { help: 'In pixels.' }));

  const editing = () => h('div', { class: 'stack' },
    field('How editing is unlocked', selectInput([['hold', 'Hold the lock button'], ['hotkey', 'Only with a hotkey or the tray icon (safest in VR)']], draft.lock.unlockMethod, (v) => { draft.lock.unlockMethod = v; renderContent(); }),
      { help: draft.lock.unlockMethod === 'hotkey' ? 'The lock button in the window will do nothing, so nobody can start editing from inside VR by accident.' : 'A press-and-hold prevents accidental unlocks from a stray laser click.' }),
    draft.lock.unlockMethod === 'hold' ? field('Hold time (ms)', textInput(draft.lock.holdMs, (v) => { draft.lock.holdMs = Number(v) || 1200; }, { type: 'number', min: 300, max: 5000 })) : null,
    field('Unlock hotkey', hotkeyField({ value: draft.lock.unlockHotkey, format: 'accel', onChange: (v) => { draft.lock.unlockHotkey = v; } }), { help: state.app.hasHost ? 'Press it anywhere in Windows to toggle editing.' : 'Only works in the desktop app.' }),
    field('Lock again automatically after (seconds)', textInput(draft.lock.autoRelockSec, (v) => { draft.lock.autoRelockSec = Number(v) || 0; }, { type: 'number', min: 0, max: 3600 }), { help: '0 = never. Resets whenever you make a change.' }));

  const windowTab = () => h('div', { class: 'stack' },
    !state.app.hasHost ? h('p', { class: 'muted' }, 'These options only apply in the desktop app.') : null,
    checkbox('Borderless window (no title bar)', draft.window.frameless, (v) => { draft.window.frameless = v; }),
    checkbox('Buttons only: hide everything except the pages and buttons (see-through window)', draft.window.cleanView, (v) => { draft.window.cleanView = v; }),
    field('Hotkey to switch the buttons-only view', textInput(draft.window.cleanViewHotkey, (v) => { draft.window.cleanViewHotkey = v.trim(); }, { placeholder: 'Ctrl+Alt+Shift+V (empty = none)' }),
      { help: 'Also on the eye button in the top bar and in the tray menu. Everything but the pages and buttons turns see-through, so it floats over your game or desktop; use the faint ⋯ button or this hotkey to bring the rest back.' }),
    h('p', { class: 'field-help' }, 'Drag the top bar to move it and the edges to resize. The window is rebuilt when you save.'),
    checkbox('Show in the taskbar like a normal app', draft.window.showInTaskbar, (v) => { draft.window.showInTaskbar = v; }),
    checkbox('Start with no window (only the tray icon), for using it only in VR', draft.window.startHidden, (v) => { draft.window.startHidden = v; }),
    draft.window.startHidden ? h('p', { class: 'field-help' }, 'The deck still runs and shows in SteamVR. Click the tray icon (or start the app again) to bring this window up when you want to edit. The tray icon may be inside the ^ arrow next to the clock.') : null,
    field('Closing the window', selectInput([['quit', 'Quits the app'], ['tray', 'Hides it to the tray (hotkeys and triggers keep working)']], draft.window.closeToTray ? 'tray' : 'quit', (v) => { draft.window.closeToTray = v === 'tray'; })),
    checkbox('Clicking the window does not steal focus from your game', draft.window.nonActivating, (v) => { draft.window.nonActivating = v; }),
    h('p', { class: 'field-help' }, 'Keep this on. Otherwise keystroke macros go to this window instead of your game. The window still takes focus while a dialog with text fields is open.'),
    checkbox('Keep the window on top of other windows', draft.window.alwaysOnTop, (v) => { draft.window.alwaysOnTop = v; }),
    h('p', { class: 'field-help' }, 'Useful on the desktop. For VR you usually want the window visible (not minimized) so your overlay app can show it.'));

  const connections = () => {
    const st = state.status;
    const obsTest = h('div', { class: 'muted small' });
    return h('div', { class: 'stack' },
      h('h3', null, 'OBS Studio'),
      h('p', { class: 'field-help' }, 'In OBS: Tools → WebSocket Server Settings → enable it, then enter the same port and password here.'),
      h('div', { class: 'row gap' },
        field('Address', textInput(draft.obs.host, (v) => { draft.obs.host = v; })),
        field('Port', textInput(draft.obs.port, (v) => { draft.obs.port = Number(v) || 4455; }, { type: 'number', min: 1, max: 65535 }))),
      field('Password', textInput(draft.obs.password, (v) => { draft.obs.password = v; }, { type: 'password' }), { help: 'Stored in plain text in your config. Leave empty if OBS has no password.' }),
      h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary small', onclick: async () => {
        obsTest.textContent = 'Saving and testing…';
        if (!await saveSettings(false)) { obsTest.textContent = ''; return; }
        try { const scenes = await net.request('options', { kind: 'obs.scenes' }); obsTest.textContent = `Connected. Found ${scenes.length} scene(s).`; } catch (err) { obsTest.textContent = err.message; }
      } }, 'Save and test connection'), obsTest),
      statusRow('OBS', st.obs || 'off', st.obsError),
      h('hr'),
      h('h3', null, 'VRChat (OSC)'),
      h('p', { class: 'field-help' }, 'In VRChat: Action Menu → Options → OSC → Enabled. The default ports rarely need changing.'),
      h('div', { class: 'row gap' },
        field('Send to port', textInput(draft.osc.sendPort, (v) => { draft.osc.sendPort = Number(v) || 9000; }, { type: 'number', min: 1, max: 65535 })),
        field('Listen on port', textInput(draft.osc.listenPort, (v) => { draft.osc.listenPort = Number(v) || 9001; }, { type: 'number', min: 1, max: 65535 }))),
      checkbox('Listen for VRChat state (needed for the mic-mute color)', draft.osc.listen, (v) => { draft.osc.listen = v; }),
      statusRow('VRChat OSC', st.vrc || 'off', st.vrcError),
      h('hr'),
      h('h3', null, 'Twitch'),
      ...(state.app.twitchBuiltIn
        ? [
          h('p', { class: 'field-help' }, 'Press Connect, then approve access on twitch.tv with the short code shown. You stay in control: Twitch lists exactly what you are allowing, and you can revoke it any time in your Twitch settings.'),
          twitchPanel(saveSettings),
          h('details', { class: 'advanced' }, h('summary', null, 'Advanced: use my own Twitch app instead'),
            h('p', { class: 'field-help' }, 'Only needed if you registered your own application at dev.twitch.tv/console (Client Type "Public", OAuth Redirect URL http://localhost). Leave empty to use the built-in one.'),
            field('Client ID', textInput(draft.twitch.clientId, (v) => { draft.twitch.clientId = v.trim(); }, { placeholder: 'leave empty to use the built-in app' }))),
        ]
        : [
          h('p', { class: 'field-help' }, 'Create a free app at dev.twitch.tv/console: Client Type "Public", OAuth Redirect URL http://localhost. Paste its Client ID here. You approve access once on twitch.tv with a short code; no secret is needed.'),
          field('Client ID', textInput(draft.twitch.clientId, (v) => { draft.twitch.clientId = v.trim(); }, { placeholder: 'from the Twitch developer console' })),
          twitchPanel(saveSettings),
        ]),
      field('Warn about an upcoming ad this many minutes ahead', textInput(draft.twitch.adWarnMinutes, (v) => { draft.twitch.adWarnMinutes = Math.max(1, Math.min(60, Number(v) || 5)); }, { type: 'number', min: 1, max: 60 }), { help: 'Used by the "ad break is coming up" trigger.' }),
      h('hr'),
      h('h3', null, 'YouTube Music (Pear Desktop)'),
      h('p', { class: 'field-help' }, 'In Pear: Plugins → API Server → enable it (set the hostname to 127.0.0.1 so only this PC can reach it). Then press Connect and click Allow in the Pear window. Adds the album, like, shuffle, repeat and volume.'),
      h('div', { class: 'row gap' },
        field('Address', textInput(draft.pear.host, (v) => { draft.pear.host = v.trim(); })),
        field('Port', textInput(draft.pear.port, (v) => { draft.pear.port = Number(v) || 26538; }, { type: 'number', min: 1, max: 65535 }))),
      pearPanel(saveSettings),
      h('hr'),
      h('h3', null, 'Spotify (only needed for the Like button)'),
      h('p', { class: 'field-help' }, 'Play, pause, skip, shuffle, repeat and seek for Spotify need no setup at all. Only "Like" does, because Windows has no like button. To set it up: at developer.spotify.com/dashboard create an app, add this exact Redirect URI, tick "Web API", and paste its Client ID here. Spotify currently only lets an app in development mode work while its owner has Premium, for up to 5 people you add under User Management.'),
      field('Redirect URI to add in the Spotify dashboard', (() => { const i = h('input', { type: 'text', readonly: true, value: (state.status.spotify && state.status.spotify.redirectUri) || 'http://127.0.0.1:17422/callback' }); i.addEventListener('focus', () => i.select()); return i; })()),
      field('Client ID', textInput(draft.spotify.clientId, (v) => { draft.spotify.clientId = v.trim(); }, { placeholder: 'from the Spotify developer dashboard' })),
      spotifyPanel(saveSettings),
      h('hr'),
      h('h3', null, 'SteamVR'),
      field('Low-battery warning (%)', textInput(draft.vr.lowBatteryPercent, (v) => { draft.vr.lowBatteryPercent = Math.max(1, Math.min(90, Number(v) || 15)); }, { type: 'number', min: 1, max: 90 }), { help: 'Used by the "battery is low" trigger and color. Needs SteamVR running.' }),
      statusRow('SteamVR link', st.steamvr || 'off', st.steamvrSimulated ? 'Showing a SIMULATED rig (fake signal file). Close the simulator to go back to real SteamVR.' : st.steamvrError));
  };

  // ---- the SteamVR overlay ----
  const overlayTab = () => {
    const o = draft.overlay;
    const st = state.status.overlay || { state: 'off' };
    const dot = { off: 'off', starting: 'connecting', waiting: 'connecting', connected: 'connected', error: 'error', unavailable: 'off' }[st.state] || 'off';
    const detail = {
      waiting: 'Waiting for SteamVR to start. It never starts SteamVR itself.',
      connected: st.shown ? 'Showing in SteamVR.' : 'Connected to SteamVR.',
      unavailable: 'Only available in the desktop app.',
    }[st.state] || st.error || '';
    const num = (get, set, opts) => textInput(get(), (v) => { if (v !== '' && Number.isFinite(v)) set(v); }, { type: 'number', ...opts });
    const anchorNames = [['front', 'In front of me (follows my head)'], ['room', 'In the room (stays where I leave it)'], ['wrist', 'On my wrist']];
    const offset = o.offsets[o.anchor];
    const off = (key, label, opts) => field(label, num(() => offset[key], (v) => { offset[key] = v; }, { step: 0.01, ...opts }));
    return h('div', { class: 'stack' },
      h('p', { class: 'field-help' }, 'Shows this same deck as a panel inside SteamVR (works next to XSOverlay and OVR Toolkit). Everything you change in the app appears in it live. You can grab it, move it, anchor it to your wrist and resize it from inside VR. It is always in use mode: editing stays here on the desktop.'),
      checkbox('Show the deck in SteamVR', o.enabled, (v) => { o.enabled = v; }),
      statusRow('SteamVR overlay', dot, detail),
      h('hr'),
      field('Where it sits', selectInput(anchorNames, o.anchor, (v) => { o.anchor = v; renderContent(); })),
      o.anchor === 'wrist' ? field('Which wrist', selectInput([['left', 'Left'], ['right', 'Right']], o.hand, (v) => { o.hand = v; })) : null,
      o.anchor === 'wrist' ? h('p', { class: 'field-help' }, 'In VR: hold the trigger on the handle, carry the panel to your wrist and let go: it snaps on (the Wrist button lights up when you are close enough). Let go near the same wrist again after turning it to fix the angle, or use the turn / tilt / flip buttons that appear on the overlay. Drop it anywhere else and it leaves the wrist and stays in the room.') : null,
      field(`Size (${o.anchor}), in meters wide`, num(() => o.widths[o.anchor], (v) => { o.widths[o.anchor] = v; }, { min: 0.1, max: 3, step: 0.05 }), { help: 'About 0.7 is a comfortable size in front of you, 0.3 suits a wrist. Bigger is easier to hit with the laser. You can also use − and + on the overlay itself.' }),
      h('div', { class: 'row gap' },
        field('Opacity (%)', num(() => Math.round(o.opacity * 100), (v) => { o.opacity = v / 100; }, { min: 10, max: 100, step: 5 })),
        field('Curve (%)', num(() => Math.round(o.curvature * 100), (v) => { o.curvature = v / 100; }, { min: 0, max: 100, step: 5 })),
        field('Sharpness', selectInput([['768', 'Low (768 px)'], ['1024', 'Normal (1024 px)'], ['1536', 'High (1536 px)'], ['2048', 'Very high (2048 px)']], String(o.resolution), (v) => { o.resolution = Number(v); }))),
      field('Dim the view (percent dark)', num(() => Math.round(o.dim * 100), (v) => { o.dim = Math.max(0, Math.min(90, v)) / 100; }, { min: 0, max: 90, step: 5 }), { help: 'A dark sheet in front of your eyes for any headset; the deck and dashboard stay bright. Also on the dashboard and as a button.' }),
      field('Pages shown in VR', staticMultiField({ options: state.config.pages.map((p) => [p.id, p.name]), value: o.pages, onChange: (v) => { o.pages = v; } }), { help: 'Leave all unticked to show every page. The overlay keeps its own current page, separate from the one in this window.' }),
      checkbox('Show the tool strip on the overlay (size, anchor, pin, bring back, collapse)', o.showBar, (v) => { o.showBar = v; }),
      checkbox('Pinned: it cannot be grabbed and moved', o.locked, (v) => { o.locked = v; }),
      checkbox('Only show it while I am looking at it (made for the wrist)', o.glance, (v) => { o.glance = v; }),
      checkbox('Hidden for now', o.hidden, (v) => { o.hidden = v; }),
      field('Hotkey to hide / show it', textInput(o.hotkey, (v) => { o.hotkey = v.trim(); }, { placeholder: 'e.g. Ctrl+Alt+Shift+O (empty = none)' })),
      h('details', { class: 'advanced' }, h('summary', null, `Fine position (${o.anchor})`),
        h('p', { class: 'field-help' }, o.anchor === 'wrist' ? 'The standard wrist position, used until you adjust it in VR. Each controller type (Index, Quest, Vive...) and hand remembers its own adjustment.' : 'Grabbing it in VR sets these for you. Meters and degrees, relative to what it follows.'),
        o.anchor === 'wrist' && Object.keys(o.wristOffsets || {}).length ? h('div', { class: 'row gap' }, h('span', { class: 'muted small' }, `Adjusted for: ${Object.keys(o.wristOffsets).join(', ')}`), h('button', { class: 'btn-secondary small', onclick: () => { o.wristOffsets = {}; renderContent(); } }, 'Forget my adjustments')) : null,
        h('div', { class: 'row gap' }, off('x', 'Right (m)'), off('y', 'Up (m)'), off('z', 'Toward me (m)')),
        h('div', { class: 'row gap' }, off('yaw', 'Turn (°)', { step: 1 }), off('pitch', 'Tilt (°)', { step: 1 }), off('roll', 'Roll (°)', { step: 1 })),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn-secondary small', onclick: () => { Object.assign(offset, state.app.overlayDefaults[o.anchor]); renderContent(); } }, 'Reset to the default spot'),
          h('button', { class: 'btn-secondary small', onclick: () => net.request('overlay.bring').then(() => toast('Brought back to you (Save first if you changed things here).'), (e) => toast(e.message, 'error')) }, 'Bring it back to me now'))),
      field('How pictures reach SteamVR', selectInput([['auto', 'Smooth (GPU texture)'], ['raw', 'Compatible (copies pixels; can flicker)']], o.upload, (v) => { o.upload = v; }), { help: 'Smooth is the default. Switch to Compatible only if the deck does not show up at all.' }),
      checkbox('Show the self-check readout on the overlay (for testing)', o.diagnostics, (v) => { o.diagnostics = v; }),
      h('p', { class: 'field-help' }, 'The readout shows where the app thinks your laser is (a yellow ring follows it), which controllers SteamVR sees, and what just happened. It is also written to overlay.log in the data folder.'));
  };

  // A link that opens in your normal browser (the app window itself never navigates away).
  const outLink = (url) => {
    const a = h('a', { href: url, class: 'about-link', title: url }, url.replace(/^https:\/\//, ''));
    a.addEventListener('click', (e) => {
      e.preventDefault();
      net.request('open.external', { url }).then((ok) => { if (!ok) window.open(url, '_blank', 'noopener'); }, () => window.open(url, '_blank', 'noopener'));
    });
    return a;
  };

  const aboutTab = () => {
    const about = state.app.about || {};
    const row = (label, value) => h('div', { class: 'about-row' }, h('span', { class: 'about-label' }, label), h('span', { class: 'about-value' }, value));
    return h('div', { class: 'stack about' },
      h('div', { class: 'about-head' }, h('div', { class: 'about-name' }, 'VR Macro Pad'), h('div', { class: 'muted small' }, 'Colored push-button macros and live mini screens, for the desktop and for VR.')),
      row('Version', `${state.app.version || '?'}${state.app.devMode ? ' (dev server)' : ''}`),
      row('Author', about.author || 'Jayconius'),
      row('GitHub', about.github ? outLink(about.github) : h('span', { class: 'muted' }, 'not published yet')),
      row('Contact me', about.website ? outLink(about.website) : h('span', { class: 'muted' }, '—')));
  };

  const dataTab = () => {
    const backups = h('div', { class: 'stack tight' }, h('span', { class: 'muted' }, 'Loading…'));
    net.request('backups.list').then((list) => {
      clear(backups);
      if (!list.length) backups.append(h('span', { class: 'muted' }, 'No backups yet.'));
      for (const b of list.slice(0, 8)) {
        backups.append(h('div', { class: 'row gap between' }, h('span', { class: 'small' }, new Date(b.mtime).toLocaleString()),
          h('button', { class: 'btn-secondary small', onclick: async () => {
            if (!await confirmDialog({ title: 'Restore this backup?', message: 'Your current layout will be replaced (a new backup is kept).', confirmLabel: 'Restore' })) return;
            try { const res = await net.request('backups.restore', { name: b.name }); (res.warnings || []).forEach((w) => toast(w, 'warn')); toast('Backup restored.'); modal.close(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Restore')));
      }
    }, (err) => { clear(backups); backups.append(h('span', { class: 'field-error' }, err.message)); });
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        if (!await confirmDialog({ title: 'Import this layout?', message: 'This replaces all your pages and settings with the file’s contents.', confirmLabel: 'Import', danger: true })) return;
        const res = await net.request('config.import', { config: parsed });
        (res.warnings || []).forEach((w) => toast(w, 'warn'));
        toast('Imported.');
        modal.close();
      } catch (err) { toast(`Import failed: ${err.message}`, 'error'); }
    });
    return h('div', { class: 'stack' },
      h('h3', null, 'Share or move your layout'),
      h('p', { class: 'field-help' }, 'Export leaves out passwords and tokens.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn-secondary', onclick: async () => {
          try {
            const data = await net.request('config.export');
            const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'vr-macro-pad-layout.json' });
            document.body.append(a); a.click(); a.remove();
          } catch (err) { toast(err.message, 'error'); }
        } }, '⬇ Export layout'),
        h('button', { class: 'btn-secondary', onclick: () => file.click() }, '⬆ Import layout'), file),
      h('hr'),
      h('h3', null, 'Automatic backups'),
      h('p', { class: 'field-help' }, 'A backup is kept every few minutes while you edit (the last 20).'),
      backups);
  };

  function renderContent() {
    clear(content);
    content.append({ general, editing, window: windowTab, connections, overlay: overlayTab, data: dataTab, about: aboutTab }[tab]());
  }

  async function saveSettings(closeAfter = true) {
    errorEl.hidden = true;
    const ok = await saveConfig((c) => { c.settings = { ...c.settings, ...clone(draft) }; });
    if (ok && closeAfter) modal.close();
    return ok;
  }

  const modal = openModal({
    title: 'Settings',
    wide: true,
    body: [tabsEl, content, errorEl],
    footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn-secondary', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn-primary', onclick: () => saveSettings(true) }, 'Save settings')],
  });
  renderTabs();
  renderContent();
}

// ---- info: status, log, how to pin ----
export function openInfo() {
  let tab = 'status';
  const tabsEl = h('div', { class: 'tabs' });
  const content = h('div', { class: 'tab-content' });
  const renderTabs = () => {
    clear(tabsEl);
    for (const [id, label] of [['status', 'Status'], ['log', 'Activity'], ['vr', 'Use in VR']]) {
      tabsEl.append(h('button', { class: `tab${tab === id ? ' on' : ''}`, onclick: () => { tab = id; renderTabs(); renderContent(); } }, label));
    }
  };
  const renderContent = () => {
    clear(content);
    const st = state.status;
    if (tab === 'status') {
      content.append(h('div', { class: 'stack' },
        statusRow('Windows helper (audio & keys)', st.helper || 'off', st.helperError),
        statusRow('OBS Studio', st.obs || 'off', st.obsError),
        statusRow('VRChat OSC', st.vrc || 'off', st.vrcError || (st.vrcLastHeard ? `Last message ${fmtTime(st.vrcLastHeard)}` : '')),
        statusRow('SteamVR link (battery)', st.steamvr || 'off', st.steamvrSimulated ? 'Showing a SIMULATED rig (fake signal file)' : st.steamvrError),
        statusRow('Media (Spotify & more)', st.media || 'off', st.mediaError),
        statusRow('YouTube Music (Pear)', (st.pear && st.pear.status) || 'off', st.pear && st.pear.error),
        statusRow('Spotify (Like)', (st.spotify && st.spotify.status) || 'off', st.spotify && st.spotify.status === 'connected' && st.spotify.user ? `Signed in as ${st.spotify.user.name}` : (st.spotify && st.spotify.error) || ''),
        statusRow('Twitch', (st.twitch && st.twitch.status) || 'off', st.twitch && st.twitch.status === 'connected' && st.twitch.user ? `Signed in as ${st.twitch.user.name}` : (st.twitch && st.twitch.error) || ''),
        h('p', { class: 'muted small' }, `VR Macro Pad ${state.app.version}${state.app.devMode ? ' (dev server)' : ''}. OBS and VRChat are only contacted when a button or trigger uses them.`)));
    } else if (tab === 'log') {
      const rows = [...state.log].reverse();
      content.append(h('div', { class: 'log' }, rows.length ? rows.map((e) => h('div', { class: `log-row ${e.level}` }, h('span', { class: 'muted' }, fmtTime(e.t)), e.text)) : h('p', { class: 'muted' }, 'Nothing has happened yet.')));
    } else {
      content.append(h('div', { class: 'stack prose' },
        h('h3', null, 'Pin it in VR'),
        h('p', null, 'This is a normal Windows window, so any desktop-overlay tool can show it in VR:'),
        h('ul', null,
          h('li', null, h('strong', null, 'OVR Toolkit / XSOverlay / Desktop+'), ': add a window capture and pick “VR Macro Pad”. Pin it to your wrist, a controller or the world.'),
          h('li', null, 'Keep the window open and not minimized. It can sit on a second monitor or behind other windows.'),
          h('li', null, 'Clicking a button does not take focus away from your game, so key presses still reach it.')),
        h('h3', null, 'Stay safe in VR'),
        h('ul', null,
          h('li', null, 'Editing is locked by default. Set “Only with a hotkey” in Settings → Editing lock so it cannot be unlocked from the overlay.'),
          h('li', null, 'Mark risky buttons (stop stream, quit SteamVR) as “hold” or “tap twice”.'))));
    }
  };
  let timer = null;
  openModal({ title: 'Info', wide: true, body: [tabsEl, content], onClose: () => clearInterval(timer) });
  renderTabs();
  renderContent();
  timer = setInterval(() => { if (tab === 'status' || tab === 'log') renderContent(); }, 2000);
}
