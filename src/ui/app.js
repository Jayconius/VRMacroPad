// Entry point: top bar, lock button, and wiring between the core's pushed events and the views.
import { h, clear } from './util.js';
import * as net from './net.js';
import { state, notify, subscribe, currentPage, view, overlayPages, pluginStatus, pluginDot } from './state.js';
import { renderOverlayTopbar, startOverlayExtras } from './overlay-view.js';
import { renderDashboard } from './dashboard-view.js';
import { startVrInput } from './vr-input.js';
import { toast, anyModalOpen } from './modal.js';
import { createGridView } from './grid-view.js';
import { startNewButton, editButton } from './editor.js';
import { openSettings, openPageDialog, openInfo } from './dialogs.js';
import { watchUpdates } from './update-dialog.js';
import { setActivePage, lockEditing, unlockEditing, touchEdit } from './commands.js';

const root = document.getElementById('app');
const topbar = h('header', { class: 'topbar' });
const stage = h('main', { class: 'stage' });
const banner = h('div', { class: 'edit-banner', hidden: true });
root.append(topbar, banner, stage);

// The see-through window has no native edges, so eight thin strips around it do the resizing.
const edges = h('div', { class: 'clean-edges', hidden: true }, ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => {
  const el = h('div', { class: `clean-edge ${edge}` });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const start = { sx: e.screenX, sy: e.screenY, x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
    let queued = null;
    let sending = false;
    const flush = () => {
      if (sending || !queued) return;
      const b = queued;
      queued = null;
      sending = true;
      net.request('window.bounds', b).catch(() => {}).finally(() => { sending = false; flush(); });
    };
    const move = (ev) => {
      const dx = ev.screenX - start.sx;
      const dy = ev.screenY - start.sy;
      const b = { x: start.x, y: start.y, width: start.w, height: start.h };
      if (edge.includes('e')) b.width = start.w + dx;
      if (edge.includes('s')) b.height = start.h + dy;
      if (edge.includes('w')) { b.width = start.w - dx; b.x = start.x + dx; }
      if (edge.includes('n')) { b.height = start.h - dy; b.y = start.y + dy; }
      queued = b;
      flush();
    };
    const done = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', done); el.removeEventListener('pointercancel', done); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  });
  return el;
}));
document.body.append(edges);

const grid = createGridView(stage, {
  onEdit: (id) => editButton(id),
  onAddAt: (x, y) => startNewButton({ x, y }),
});

// ---- lock button ----
function lockButton() {
  const { on, unlockMethod } = state.edit;
  if (on) {
    return h('button', { class: 'lock-btn unlocked', title: 'Lock editing', onclick: () => lockEditing() }, '🔓', h('span', null, 'Lock'));
  }
  if (unlockMethod === 'hotkey') {
    return h('button', { class: 'lock-btn locked disabled', title: `Editing is unlocked with ${state.config.settings.lock.unlockHotkey} or the tray icon` }, '🔒', h('span', null, 'Locked'));
  }
  const holdMs = state.config.settings.lock.holdMs;
  const fill = h('div', { class: 'lock-fill', style: { '--hold-ms': `${holdMs}ms` } });
  const btn = h('button', { class: 'lock-btn locked', title: 'Hold to unlock editing' }, fill, '🔒', h('span', null, 'Hold to edit'));
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    btn.classList.add('holding');
    timer = setTimeout(() => { cancel(); unlockEditing().catch(() => {}); }, holdMs);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, cancel);
  return btn;
}

// The window has no title bar of its own, so it needs its own minimize / maximize / close.
function windowControls() {
  if (!state.app.hasHost || !state.config.settings.window.frameless || state.config.settings.window.cleanView) return null;
  const ctl = (label, title, cmd, cls = '') => h('button', { class: `win-ctl ${cls}`, title, onclick: () => net.request('window.control', { cmd }).catch(() => {}) }, label);
  return h('div', { class: 'win-controls' }, ctl('–', 'Minimize', 'minimize'), ctl('▢', 'Maximize / restore', 'maximize'), ctl('✕', 'Close', 'close', 'close'));
}

// ---- connections: ONE icon in the top bar; clicking it lists every plugin that is connected, connecting or failing ----
// A plugin that is not in use ('off'), switched off, or waiting for a sign-in nobody asked for is not listed.
const GOOD = new Set(['ok', 'connected', 'listening']);
const BUSY = new Set(['connecting', 'starting', 'authorizing']);
const BAD = new Set(['error', 'auth-failed']);
const STATE_TEXT = { ok: 'Connected', connected: 'Connected', listening: 'Listening', connecting: 'Connecting…', starting: 'Starting…', authorizing: 'Waiting for you to approve', error: 'Problem', 'auth-failed': 'Sign-in failed' };

function connections() {
  const list = [];
  for (const p of state.catalog.plugins || []) {
    const st = pluginStatus(p.id);
    const s = pluginDot(st);
    if (GOOD.has(s) || BUSY.has(s) || BAD.has(s)) list.push({ name: p.name, state: s, detail: BAD.has(s) ? (st.error || '') : '' });
  }
  if (state.status.helper === 'error') list.push({ name: 'Windows helper', state: 'error', detail: '' });
  return list;
}
// One color for the icon: red if anything is wrong, amber while something is still connecting, otherwise green.
const summaryState = (list) => (list.some((c) => BAD.has(c.state)) ? 'error' : list.some((c) => BUSY.has(c.state)) ? 'connecting' : 'ok');

let connPop = null; // the open list, if any: { el, off }
function closeConnections() {
  if (!connPop) return;
  connPop.off();
  connPop.el.remove();
  connPop = null;
}
function openConnections(anchor) {
  closeConnections();
  const list = connections();
  const rows = list.map((c) => h('div', { class: 'conn-row' },
    h('span', { class: `dot ${c.state}` }),
    h('span', { class: 'conn-name' }, c.name),
    h('span', { class: 'conn-state muted small' }, c.detail || STATE_TEXT[c.state] || c.state)));
  const el = h('div', { class: 'conn-pop', role: 'dialog', 'aria-label': 'Connections' },
    h('div', { class: 'conn-title' }, 'Connections'),
    rows.length ? rows : h('div', { class: 'muted small' }, 'Nothing is connected right now.'));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 8)}px`;
  el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  const away = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeConnections(); };
  const key = (e) => { if (e.key === 'Escape') closeConnections(); };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key);
  connPop = { el, off: () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); } };
}

// The single icon. Hidden when nothing is connected, so a quiet setup keeps a quiet bar.
function connectionsButton() {
  const list = connections();
  if (!list.length) { closeConnections(); return null; }
  const s = summaryState(list);
  const btn = h('button', { class: `conn-btn ${s}`, title: `Connections: ${list.length} active. Click for details.`, 'aria-label': 'Connections', onclick: () => (connPop ? closeConnections() : openConnections(btn)) },
    h('span', { class: `dot ${s}` }), h('span', { class: 'conn-count' }, String(list.length)));
  if (connPop) queueMicrotask(() => { if (btn.isConnected) openConnections(btn); else closeConnections(); }); // the bar was rebuilt while the list was open: refresh it
  return btn;
}

// Rebuilding the bar while a finger/laser is down on it would swallow the click or
// cancel a press-and-hold, so only rebuild when something it shows has changed.
let topbarSignature = '';

function renderTopbar() {
  if (view.overlay) { renderOverlayTopbar(topbar); return; }
  const st = state.status;
  const conn = connections().map((c) => [c.name, c.state, c.detail]);
  const signature = JSON.stringify([
    state.config.pages.map((p) => [p.id, p.name]), state.activePage, state.edit.on, state.edit.unlockMethod,
    state.config.settings.lock, conn, st.helper, state.config.settings.window.frameless, state.config.settings.window.cleanView, state.app.hasHost,
  ]);
  if (signature === topbarSignature) return;
  topbarSignature = signature;
  clear(topbar);
  const editing = state.edit.on;
  const clean = state.app.hasHost && state.config.settings.window.cleanView;
  const tabs = h('nav', { class: 'page-tabs' }, state.config.pages.map((p) => {
    const active = p.id === (currentPage() || {}).id;
    return h('button', { class: `page-tab${active ? ' on' : ''}`, onclick: () => (editing && active ? openPageDialog(p.id) : setActivePage(p.id)), title: editing && active ? 'Page settings' : undefined },
      p.name, editing && active ? h('span', { class: 'gear' }, '⚙') : null);
  }));
  if (clean) {
    closeConnections();
    // Buttons only: the pages, and one faint button to bring everything back.
    topbar.append(tabs, h('span', { class: 'spacer' }),
      h('button', { class: 'clean-exit', title: 'Show the full window again', onclick: () => net.request('view.clean', { on: false }).catch(() => {}) }, '⋯'));
    return;
  }
  // Native append() would print the word "null", so drop the empty slots first.
  topbar.append(...[
    tabs,
    editing ? h('button', { class: 'btn-secondary small', title: 'Add a page', onclick: () => openPageDialog(null, { isNew: true }) }, '＋ Page') : null,
    h('span', { class: 'spacer' }),
    connectionsButton(),
    editing ? h('button', { class: 'btn-primary', onclick: () => startNewButton(null) }, '＋ Add button') : null,
    editing ? h('button', { class: 'icon-btn', title: 'Settings', onclick: openSettings }, '⚙️') : null,
    h('button', { class: 'icon-btn', title: 'Status, activity and VR help', onclick: openInfo }, 'ⓘ'),
    state.app.hasHost ? h('button', { class: 'icon-btn', title: 'Buttons only: hide everything except the pages and buttons (see-through window)', onclick: () => net.request('view.clean', { on: true }).catch(() => {}) }, '👁') : null,
    lockButton(),
    windowControls(),
  ].filter(Boolean));
}

function renderBanner() {
  const on = state.edit.on && !view.overlay;
  banner.hidden = !on;
  if (!on) return;
  const left = state.edit.relockAt ? Math.max(0, Math.round((state.edit.relockAt - Date.now()) / 1000)) : 0;
  banner.textContent = `EDITING — drag buttons to move, drag the corner to resize, click one to edit it${left ? `. Locks again in ${left}s` : ''}`;
}

let cleanExitRequested = false;

function applyTheme() {
  const s = state.config.settings;
  const clean = Boolean(!view.overlay && state.app.hasHost && s.window.cleanView);
  document.body.classList.toggle('no-fx', s.animations === false);
  document.body.classList.toggle('overlay', view.overlay);
  document.documentElement.classList.toggle('overlay', view.overlay);
  document.body.classList.toggle('collapsed', Boolean(view.overlay && s.overlay && s.overlay.collapsed));
  document.body.classList.toggle('frameless', Boolean(!view.overlay && state.app.hasHost && (s.window.frameless || s.window.cleanView)));
  document.body.classList.toggle('clean', clean);
  document.documentElement.classList.toggle('clean', clean);
  edges.hidden = !clean;
  // Unlocking editing (tray or hotkey) needs the normal window: its dialogs and the Add button live there.
  if (clean && state.edit.on && !cleanExitRequested) { cleanExitRequested = true; net.request('view.clean', { on: false }).catch(() => {}); }
  if (!clean) cleanExitRequested = false;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty('--accent', s.accent);
}

function render() {
  if (!state.ready) return;
  if (view.overlay) {
    // its own page, chosen from the ones the overlay is allowed to show
    const allowed = overlayPages();
    if (!allowed.some((p) => p.id === state.activePage) && allowed[0]) state.activePage = allowed[0].id;
  }
  applyTheme();
  if (view.dashboard) { document.body.classList.add('dashboard'); renderDashboard(); return; }
  renderTopbar();
  renderBanner();
  grid.render();
}

subscribe(render);
setInterval(renderBanner, 1000);

// Keep the automatic re-lock from firing in the middle of an edit: any activity, or just
// having a dialog open, counts as "still editing" (commands.touchEdit throttles the traffic).
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => touchEdit(), true);
setInterval(() => { if (anyModalOpen()) touchEdit(); }, 15000);

// ---- connection + pushed events ----
const overlay = h('div', { class: 'conn-overlay', hidden: true });
document.body.append(overlay);

net.on('conn', (c) => {
  overlay.hidden = c.connected;
  clear(overlay);
  if (c.connected) return;
  overlay.append(c.error === 'missing-token'
    ? h('div', null, h('h2', null, 'Open this from the VR Macro Pad app'), h('p', { class: 'muted' }, 'This page needs the secret link the app prints (or its tray menu → “Copy browser link”).'))
    : h('div', null, h('h2', null, 'Reconnecting…'), h('p', { class: 'muted' }, 'Is VR Macro Pad still running?')));
});

// Timers count against the core's clock, so remember how far this page's clock is from it.
function syncClock(data) {
  for (const d of Object.values(data || {})) {
    if (d && typeof d.now === 'number') { state.clockOffset = d.now - Date.now(); return; }
  }
}

net.on('init', (m) => {
  Object.assign(state, {
    ready: true, config: m.config, catalog: m.catalog, buttonStates: m.buttonStates, widgetData: m.widgetData || {}, activePage: m.activePage,
    edit: m.edit, status: m.status, update: m.update || null, log: m.log, app: m.app,
  });
  if (view.overlay) state.edit = { on: false, relockAt: 0, unlockMethod: 'hold' }; // the overlay is always in use mode
  if (view.editor) state.app.hasHost = false; // no window buttons or see-through view inside VR
  syncClock(state.widgetData);
  notify();
});
net.on('widgetData', (m) => { state.widgetData = m.data; syncClock(m.data); notify(); });
net.on('config', (m) => { state.config = m.config; notify(); });
net.on('buttonStates', (m) => { state.buttonStates = m.states; notify(); });
net.on('page', (m) => { if (!view.overlay) state.activePage = m.id; notify(); });
net.on('edit', (m) => { state.edit = view.overlay ? { ...m.edit, on: false } : m.edit; notify(); });
net.on('status', (m) => { state.status = m.status; notify(); });
net.on('update', (m) => { state.update = m.update; notify(); });
net.on('running', (m) => { if (m.on) state.running.add(m.id); else state.running.delete(m.id); notify(); });
net.on('pressResult', (m) => grid.flash(m.id, m.ok));
net.on('toast', (m) => {
  state.log.push(m.entry);
  if (state.log.length > 200) state.log.shift();
  toast(m.entry.text, m.entry.level);
});

watchUpdates();
if (view.overlay) startOverlayExtras();
if (view.editor) startVrInput();
net.connect();

// Test hook for automated UI checks.
window.__vrmd = { state };
