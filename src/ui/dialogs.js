// Settings, page settings and the info / status dialog.
import { h, clear, clone, fmtTime, uid } from './util.js';
import { state, currentPage, subscribe, pluginStatus, pluginDot } from './state.js';
import { openModal, confirmDialog, toast } from './modal.js';
import { saveConfig, setActivePage } from './commands.js';
import * as net from './net.js';
import { openUpdateDialog, checkNow } from './update-dialog.js';
import { field, textInput, selectInput, checkbox, hotkeyField, optionsField, staticMultiField, buildParamForm } from './forms.js';

const Grid = window.Grid;

const statusText = {
  off: 'Not in use', starting: 'Starting…', ok: 'Running', error: 'Problem', connecting: 'Connecting…',
  connected: 'Connected', 'auth-failed': 'Wrong password', listening: 'Listening',
  'needs-auth': 'Not connected', authorizing: 'Waiting for you to approve it…',
  'awaiting-approval': 'Waiting for you to click Allow in Pear…', denied: 'Denied in Pear', 'not-running': "Can't reach Pear",
  disabled: 'Disabled',
};

function statusRow(label, status, detail) {
  return h('div', { class: 'status-row' }, h('span', { class: `dot ${status}` }), h('strong', null, label), h('span', { class: 'muted' }, statusText[status] || status), detail ? h('span', { class: 'field-help' }, detail) : null);
}

// A plugin's status object carries whatever extra fields it wants (user, lastHeard, simulated...); this is
// the one place that turns those into the one line of detail text shown next to its dot, shared by the
// Plugins tab and the Info dialog's Status tab.
function pluginDetail(id, s) {
  if (id === 'vrchat') return s.error || (s.lastHeard ? `Last message ${fmtTime(s.lastHeard)}` : '');
  if (id === 'steamvr') return s.simulated ? 'Showing a SIMULATED rig (fake signal file)' : s.error;
  if (s.status === 'connected' && s.user) return `Signed in as ${s.user.name}`;
  return s.error || '';
}

// ---- page settings ----
export function openPageDialog(pageId, { isNew = false } = {}) {
  const cfg = state.config;
  const existing = cfg.pages.find((p) => p.id === pageId);
  const draft = existing ? clone(existing) : { id: uid('p'), name: `Page ${cfg.pages.length + 1}`, cols: 8, rows: 4, fit: true, autoShowProcess: '', buttons: [] };
  const errorEl = h('div', { class: 'field-error', hidden: true });
  const min = Grid.minPageSize(draft);

  async function save() {
    const ok = await saveConfig((c) => {
      const idx = c.pages.findIndex((p) => p.id === draft.id);
      const next = { ...draft, name: draft.name.trim() || 'Page' };
      if (idx >= 0) c.pages[idx] = { ...c.pages[idx], name: next.name, cols: next.cols, rows: next.rows, fit: Boolean(next.fit), autoShowProcess: next.autoShowProcess };
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
        field('Columns', textInput(draft.cols, (v) => { draft.cols = Math.max(min.cols, Math.min(100, Number(v) || 1)); }, { type: 'number', min: min.cols, max: 100 })),
        field('Rows', textInput(draft.rows, (v) => { draft.rows = Math.max(min.rows, Math.min(100, Number(v) || 1)); }, { type: 'number', min: min.rows, max: 100 }))),
      h('p', { class: 'field-help' }, existing ? `Buttons already reach column ${min.cols}, row ${min.rows}, so the page can't shrink below that.` : 'More columns and rows mean smaller buttons when the window is small.'),
      checkbox('Fit the whole page on screen', draft.fit, (v) => { draft.fit = v; }),
      h('p', { class: 'field-help' }, 'Shrinks the buttons so every row and column is always visible, with no scrolling. Handy for very big grids. On by default. Turn it off to keep buttons a comfortable size on a very big grid (the page scrolls instead).'),
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

// A connect/disconnect/sign-in flow for ANY plugin, built-in or not — reads only what the manifest and
// status() declare (connections[].flow, clientMethods, pending/redirectUri/hasToken/encrypted on status).
// Nothing here is keyed by plugin id: OBS, Twitch, your own plugin, all go through the same function.
function openExternal(url) {
  const fallback = () => window.open(url, '_blank', 'noopener');
  net.request('open.external', { url }).then((ok) => { if (!ok) fallback(); }, fallback);
}
// A plugin's step-by-step set-up guide (manifest.guide) in a dialog: numbered steps, each with optional link buttons that open
// in the normal browser and an optional "Copy" button for text you have to paste somewhere.
function openGuide(m) {
  const g = m.guide;
  const copyButton = (c) => h('button', { class: 'btn-secondary small', onclick: async () => {
    try { await navigator.clipboard.writeText(c.text); toast('Copied.', 'info'); } catch { toast('Could not copy. Select the text in the step and copy it by hand.', 'warn'); }
  } }, c.label);
  const modal = openModal({
    title: g.title || `${m.name}: set-up guide`,
    wide: true,
    body: [
      g.intro ? h('p', { class: 'field-help guide-text' }, g.intro) : null,
      h('ol', { class: 'guide-steps' }, g.steps.map((st, i) => h('li', { class: 'guide-step' },
        h('div', { class: 'guide-num' }, String(i + 1)),
        h('div', { class: 'guide-body' },
          st.title ? h('strong', null, st.title) : null,
          st.text ? h('p', { class: 'guide-text' }, st.text) : null,
          st.links.length || st.copy ? h('div', { class: 'row gap wrap' },
            st.links.map((l) => h('button', { class: 'btn-secondary small', onclick: () => openExternal(l.url) }, `${l.label} ↗`)),
            st.copy ? copyButton(st.copy) : null) : null)))),
      g.outro ? h('p', { class: 'field-help guide-text' }, g.outro) : null,
    ],
    footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn-primary', onclick: () => modal.close() }, 'Close')],
  });
}
function callMethod(id, method) {
  return net.request('plugin.call', { plugin: id, method });
}
function describeMethodResult(r) {
  if (r == null) return 'Done.';
  if (typeof r === 'string') return r;
  if (Array.isArray(r.missing)) return r.missing.length ? `Missing permissions: ${r.missing.join(', ')}.` : 'All permissions granted.';
  try { return JSON.stringify(r); } catch { return 'Done.'; }
}
function connectionArea(m, st, saveSettings, bag) {
  const nodes = [];
  const conn = m.connections && m.connections[0];
  const methods = m.clientMethods || [];
  if (conn && methods.includes('connect') && bag) {
    nodes.push(checkbox('Auto-connect on startup', bag.autoConnect === true, (v) => { bag.autoConnect = v; }));
    nodes.push(h('p', { class: 'field-help' }, `Reconnects automatically when the app starts, without waiting for a button to need it — and again as soon as ${m.name} becomes reachable, if it isn't yet. Signing in for the first time always needs you to press Connect.`));
  }
  if (conn && conn.flow === 'redirect' && st.redirectUri) {
    nodes.push(field(`Redirect URI to add in the ${m.name} dashboard`, (() => { const i = h('input', { type: 'text', readonly: true, value: st.redirectUri }); i.addEventListener('focus', () => i.select()); return i; })()));
  }
  const statusValue = st.state || st.status;
  if (st.note) nodes.push(h('p', { class: 'field-help status-note' }, st.note));
  if (conn && st.pending && st.pending.userCode) {
    nodes.push(h('div', { class: 'code-box' },
      h('div', { class: 'muted small' }, `Go to ${m.name} and enter this code:`),
      h('div', { class: 'code' }, st.pending.userCode),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn-primary', onclick: () => openExternal(st.pending.verificationUri) }, `Open ${m.name} to approve`),
        methods.includes('disconnect') ? h('button', { class: 'btn-secondary', onclick: () => callMethod(m.id, 'disconnect').catch((e) => toast(e.message, 'error')) }, 'Cancel') : null),
      h('p', { class: 'field-help' }, 'This page updates by itself once you approve.')));
  } else if (conn && statusValue === 'authorizing') {
    nodes.push(h('div', { class: 'code-box' },
      h('div', { class: 'muted small' }, `Waiting for you to approve on ${m.name}…`),
      methods.includes('disconnect') ? h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary', onclick: () => callMethod(m.id, 'disconnect').catch((e) => toast(e.message, 'error')) }, 'Cancel')) : null,
      h('p', { class: 'field-help' }, 'This page updates by itself once you approve.')));
  } else if (conn && (statusValue === 'connected' || statusValue === 'ok' || st.hasToken)) {
    const extra = methods.filter((x) => x !== 'connect' && x !== 'disconnect');
    const result = h('span', { class: 'muted small' });
    nodes.push(h('div', { class: 'row gap' },
      ...extra.map((method) => h('button', { class: 'btn-secondary', onclick: async () => {
        result.textContent = 'Working…';
        try { result.textContent = describeMethodResult(await callMethod(m.id, method)); } catch (err) { result.textContent = err.message; }
      } }, method.charAt(0).toUpperCase() + method.slice(1))),
      methods.includes('disconnect') ? h('button', { class: 'btn-secondary', onclick: () => callMethod(m.id, 'disconnect').catch((e) => toast(e.message, 'error')) }, 'Disconnect') : null,
      result));
  } else if (conn && methods.includes('connect')) {
    nodes.push(h('button', { class: 'btn-primary', disabled: statusValue === 'awaiting-approval', onclick: async () => {
      if (!await saveSettings(false)) return;
      try {
        const r = await callMethod(m.id, 'connect');
        const url = r && (r.verificationUri || r.url);
        if (url) openExternal(url);
      } catch (err) { toast(err.message, 'error'); }
    } }, `Connect ${conn.label || m.name}`));
  }
  const hint = (m.statusHints && m.statusHints[statusValue]) || (statusValue === 'connected' && st.user ? `Signed in as ${st.user.name}` : pluginDetail(m.id, st));
  nodes.push(statusRow(m.name, pluginDot(st), hint));
  if (st.encrypted !== undefined && statusValue !== 'off') {
    nodes.push(h('p', { class: 'field-help' }, st.encrypted ? `Your ${m.name} login is stored encrypted with your Windows account.` : `Your ${m.name} login is stored in your data folder (not encrypted in this mode).`));
  }
  return nodes;
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
    for (const [id, label] of [['general', 'General'], ['editing', 'Editing lock'], ['window', 'Window'], ['connections', 'Plugins'], ['overlay', 'VR overlay'], ['data', 'Backup & data'], ['about', 'About']]) {
      tabsEl.append(h('button', { class: `tab${tab === id ? ' on' : ''}`, onclick: () => { tab = id; renderTabs(); renderContent(); } }, label));
    }
  };

  const general = () => h('div', { class: 'stack' },
    field('Theme', selectInput([['dark', 'Dark'], ['light', 'Light']], draft.theme, (v) => { draft.theme = v; })),
    field('Accent color', (() => { const i = h('input', { type: 'color', value: draft.accent }); i.addEventListener('input', () => { draft.accent = i.value; }); return i; })()),
    checkbox('Play button animations (pulse, flash, glow...)', draft.animations !== false, (v) => { draft.animations = v; }),
    field(`Space between buttons`, textInput(draft.gap, (v) => { draft.gap = Math.max(0, Math.min(40, Number(v) || 0)); }, { type: 'number', min: 0, max: 40 }), { help: 'In pixels.' }),
    h('hr'),
    updatesSection());

  // ---- updates: off until you turn it on ----
  function updatesSection() {
    const line = h('span', { class: 'muted small' });
    const paint = () => {
      const u = state.update || {};
      if (u.status === 'checking') line.textContent = 'Checking…';
      else if (u.status === 'error') line.textContent = u.error || 'The check failed.';
      else if (['available', 'downloading', 'ready'].includes(u.status) && u.latest) line.textContent = `Version ${u.latest} is available.`;
      else if (u.status === 'uptodate' && u.checkedAt) line.textContent = u.note || (u.latest ? `You are up to date (${u.current}).` : 'Nothing newer found.');
      else line.textContent = '';
    };
    paint();
    const off = subscribe(() => { if (line.isConnected) paint(); else off(); });
    const u0 = state.update || {};
    const showBtn = () => ['available', 'downloading', 'ready'].includes((state.update || {}).status) ? openUpdateDialog() : null;
    return h('div', { class: 'stack' },
      checkbox('Check for updates', Boolean(draft.updates.check), (v) => { draft.updates.check = v; }),
      h('p', { class: 'field-help' }, 'Off by default. When this is on, the app asks GitHub once after it starts, and again every few hours, whether there is a newer version, and pops up a box with a link, a Download button and a Skip button if there is. It only asks: nothing is downloaded until you press Download, and nothing about you is sent. Save to apply.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn-secondary small', onclick: () => { checkNow().catch((err) => { line.textContent = err.message; }); } }, 'Check now'),
        ['available', 'downloading', 'ready'].includes(u0.status) ? h('button', { class: 'btn-secondary small', onclick: showBtn }, 'Show the update') : null,
        line));
  }

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

  // ---- Plugins tab: every plugin — built-in or dropped into the plugins folder — is one card, built the
  // same way from its manifest: icon, name, status dot, an Enabled toggle, its settings (settingsFields),
  // rare shared-setting fields (coreFields, only VRChat's OSC ports use this), a "test connection" button
  // (testOptionKind), and a full Connect/Disconnect/sign-in flow (connectionArea, above). No plugin id is
  // ever checked here — a built-in's card looks the way it does only because of what its own manifest
  // declares (instructions, statusHints, builtInAware...), the same declarations a third-party plugin has
  // available to it. See docs/PLUGIN-GUIDE.md.
  function corePath(path) {
    const parts = path.split('.');
    const key = parts.pop();
    return [parts.reduce((o, k) => o[k], draft), key];
  }
  function coreField(f) {
    const [obj, key] = corePath(f.path);
    const onChange = (v) => { obj[key] = v; };
    if (f.type === 'number') return field(f.label, textInput(obj[key], (v) => onChange(Math.max(f.min ?? -1e9, Math.min(f.max ?? 1e9, Number(v) || 0))), { type: 'number', min: f.min, max: f.max }), { help: f.help });
    if (f.type === 'boolean') return checkbox(f.label, Boolean(obj[key]), onChange);
    return field(f.label, textInput(obj[key], onChange), { help: f.help });
  }
  function settingField(m, f, st0) {
    const bag = draft.plugins[m.id];
    const onChange = (v) => { bag[f.key] = v; };
    const placeholder = f.builtInAware && st0 && st0.hasBuiltIn ? 'leave empty to use the built-in one' : f.placeholder;
    if (f.type === 'number') return field(f.label, textInput(bag[f.key], (v) => onChange(Math.max(f.min ?? -1e9, Math.min(f.max ?? 1e9, Number(v) || 0))), { type: 'number', min: f.min, max: f.max }), { help: f.help });
    if (f.type === 'boolean') return checkbox(f.label, Boolean(bag[f.key]), onChange);
    if (f.type === 'select' && f.options) return field(f.label, selectInput(f.options, bag[f.key], onChange), { help: f.help });
    // The richer types (a recorded shortcut, several lines, a list the plugin fills in) are drawn by the same code the button editor uses.
    if (['textarea', 'keys', 'multiselect'].includes(f.type) || (f.type === 'select' && f.optionsFrom)) return buildParamForm({ params: [f] }, bag, () => {});
    return field(f.label, textInput(bag[f.key], onChange, { type: f.type === 'password' ? 'password' : 'text', placeholder }), { help: f.help });
  }
  function testConnectionButton(m) {
    const result = h('div', { class: 'muted small' });
    return h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary small', onclick: async () => {
      result.textContent = 'Saving and testing…';
      if (!await saveSettings(false)) { result.textContent = ''; return; }
      try { const list = await net.request('options', { kind: m.testOptionKind }); result.textContent = `Connected. Found ${list.length} result(s).`; } catch (err) { result.textContent = err.message; }
    } }, 'Save and test connection'), result);
  }

  function pluginCard(m) {
    const bag = draft.plugins[m.id];
    const st0 = pluginStatus(m.id);
    const enabledBox = h('input', { type: 'checkbox', checked: bag.enabled !== false });
    enabledBox.addEventListener('change', () => { bag.enabled = enabledBox.checked; });
    const help = m.instructions || '';
    const normalFields = [];
    const advancedFields = [];
    // A field is tucked under "Advanced" when the plugin says so (advanced: true), or when it only matters if you are
    // replacing the plugin's built-in app (builtInAware, while the plugin reports hasBuiltIn).
    const builtInMode = Boolean(st0.hasBuiltIn) && (m.settingsFields || []).some((f) => f.builtInAware);
    for (const f of m.settingsFields || []) (f.advanced || (f.builtInAware && st0.hasBuiltIn) ? advancedFields : normalFields).push(settingField(m, f, st0));
    const summaryDot = h('span', { class: 'dot' });
    // Only the tail (Connect/Disconnect, status row) needs to live-update as the server pushes status
    // changes — everything else above it is built once, so the accordion's own open/closed state never
    // resets under the user.
    const tail = h('div', { class: 'stack tight' });
    const draw = () => {
      const st = pluginStatus(m.id);
      summaryDot.className = `dot ${pluginDot(st)}`;
      clear(tail);
      for (const n of connectionArea(m, st, saveSettings, bag)) if (n) tail.append(n);
    };
    const off = subscribe(() => { if (summaryDot.isConnected) draw(); else off(); });
    draw();
    return h('details', { class: 'advanced plugin-card' },
      h('summary', null, `${m.icon || '🔌'} ${m.name}`, summaryDot),
      h('div', { class: 'stack' },
        m.description ? h('p', { class: 'field-help' }, m.description) : null,
        h('label', { class: 'check' }, enabledBox, 'Enabled'),
        help ? h('p', { class: 'field-help plugin-instructions' }, help) : null,
        m.guide ? h('div', { class: 'row gap' }, h('button', { class: 'btn-secondary', onclick: () => openGuide(m) }, m.guide.button || 'Instructions')) : null,
        ...(m.coreFields || []).map(coreField),
        ...normalFields,
        advancedFields.length ? h('details', { class: 'advanced' }, h('summary', null, builtInMode ? `Advanced: use your own ${m.name} app instead` : (m.advancedLabel || 'Advanced')), ...advancedFields) : null,
        m.testOptionKind ? testConnectionButton(m) : null,
        tail));
  }

  // Plugins that could not be loaded (a typo in plugin.js, a duplicate id...) are listed first, with the reason
  // and the folder, so a plugin that "doesn't show up" always explains itself.
  const loadFailures = () => {
    const bad = state.catalog.pluginErrors || [];
    if (!bad.length) return null;
    return h('div', { class: 'load-failures' },
      h('strong', null, `${bad.length} plugin${bad.length === 1 ? '' : 's'} could not be loaded`),
      h('p', { class: 'field-help' }, 'Fix the problem, then restart the app. Everything else keeps working.'),
      ...bad.map((e) => h('div', { class: 'load-failure' }, h('div', null, h('strong', null, e.name)), h('div', { class: 'small' }, e.error), h('div', { class: 'muted small' }, e.dir))));
  };
  const connections = () => h('div', { class: 'stack' },
    loadFailures(),
    (state.catalog.plugins || []).map((m) => pluginCard(m)));

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
      const names = { obs: 'OBS Studio', vrchat: 'VRChat OSC', steamvr: 'SteamVR link (battery)', pear: 'YouTube Music (Pear)', spotify: 'Spotify (Like)', twitch: 'Twitch', starter: 'Media (Spotify & more)', voicemeeter: 'Voicemeeter' };
      const rows = [statusRow('Windows helper (audio & keys)', st.helper || 'off', st.helperError)];
      for (const m of state.catalog.plugins || []) {
        const s = pluginStatus(m.id);
        rows.push(statusRow(names[m.id] || m.name, pluginDot(s), pluginDetail(m.id, s)));
      }
      rows.push(h('p', { class: 'muted small' }, `VR Macro Pad ${state.app.version}${state.app.devMode ? ' (dev server)' : ''}. OBS and VRChat are only contacted when a button or trigger uses them.`));
      content.append(h('div', { class: 'stack' }, rows));
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
