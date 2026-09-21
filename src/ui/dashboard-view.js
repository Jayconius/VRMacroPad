// The page shown inside SteamVR's dashboard (the bar at the bottom of the VR menu). Two tabs:
//   Controls: big buttons for the deck itself (show / hide, reset, where it goes, size, options). Works even when the deck is lost.
//   Editor:   the full app (the same page as the desktop window), so layouts can be edited without leaving VR.
import { h, clear } from './util.js';
import * as net from './net.js';
import { state } from './state.js';

const send = (type, payload) => net.request(type, payload).catch(() => {});
const ANCHORS = [['front', 'In front of me', 'Follows your head'], ['room', 'In the room', 'Stays where you leave it'], ['wrist', 'On my wrist', 'Sits on your wrist']];

let shell = null;
let tabsEl = null;
let controlsEl = null;
let editorEl = null;
let frame = null;
let tab = 'controls';
let signature = '';

function editorWindow() {
  return frame && frame.contentWindow;
}

// The laser and the keyboard talk to this page; the editor lives in a frame inside it.
window.__vrKeyboard = (kind, text) => { const w = editorWindow(); if (w && w.__vrText) w.__vrText(kind, text); };
window.__vrScroll = (x, y, dy) => {
  const w = editorWindow();
  if (tab !== 'editor' || !w || !w.__vrScroll || !frame) return;
  const r = frame.getBoundingClientRect();
  w.__vrScroll(x - r.left, y - r.top, dy);
};

function setTab(next) {
  tab = next;
  signature = '';
  if (next === 'editor' && !frame) {
    const u = new URL(location.href);
    u.searchParams.set('view', 'editor');
    frame = h('iframe', { class: 'dash-frame', src: u.toString(), title: 'Editor' });
    editorEl.append(frame);
  }
  renderDashboard();
}

function build() {
  tabsEl = h('div', { class: 'dash-tabs' });
  controlsEl = h('div', { class: 'dash-controls' });
  editorEl = h('div', { class: 'dash-editor' });
  shell = h('div', { class: 'dash' }, tabsEl, controlsEl, editorEl);
  document.body.append(shell);
}

export function renderDashboard() {
  if (!shell) build();
  const o = state.config.settings.overlay;
  const st = state.status.overlay || {};
  const d = st.diag || {};
  const upload = st.upload && st.upload.path ? (st.upload.path === 'gpu' ? 'smooth (GPU)' : 'compatible') : '-';
  const hands = d.hands || {};
  const sig = JSON.stringify([tab, o.anchor, o.hand, o.hidden, o.locked, o.collapsed, o.showBar, o.glance, o.widths[o.anchor], o.dim, st.state, st.error, hands, upload]);
  if (sig === signature) return; // rebuilding while a laser is pressed would swallow the click
  signature = sig;

  clear(tabsEl);
  const tabBtn = (id, label) => h('button', { class: `dash-tab${tab === id ? ' on' : ''}`, onclick: () => setTab(id) }, label);
  const connected = st.state === 'connected';
  tabsEl.append(tabBtn('controls', 'Controls'), tabBtn('editor', 'Editor'), h('span', { class: `dash-status${connected ? ' ok' : ''}` }, connected ? 'Connected to SteamVR' : st.error || 'Waiting for SteamVR'));
  controlsEl.hidden = tab !== 'controls';
  editorEl.hidden = tab !== 'editor';
  if (tab === 'editor') return;

  clear(controlsEl);
  const big = (label, sub, onclick, on = false) => h('button', { class: `dash-btn${on ? ' on' : ''}`, onclick }, h('span', { class: 'dash-main' }, label), sub ? h('span', { class: 'dash-sub' }, sub) : null);
  const toggle = (label, key, value, hint) => big(`${label}: ${value ? 'on' : 'off'}`, hint, () => send('overlay.toggle', { key }), value);
  const adj = (kind, amount) => () => send('overlay.adjust', { kind, amount });

  controlsEl.append(
    h('div', { class: 'dash-row' },
      big(o.hidden ? 'Show the deck' : 'Hide the deck', o.hidden ? 'It is hidden right now' : 'It is showing right now', () => send('overlay.toggle', { key: 'hidden' }), !o.hidden),
      big('Turn the overlay off', 'Also removes this entry. Switch it on again from the tray or the desktop app', () => send('overlay.toggle', { key: 'enabled', on: false }))),
    h('div', { class: 'dash-label' }, 'Lost it, or not right?'),
    h('div', { class: 'dash-row' },
      big('Reset position', o.anchor === 'room' ? 'Puts it 1 m in front of you' : 'Back to the standard spot', () => send('overlay.bring')),
      big('Reset size', 'Standard size for this placement', () => send('overlay.size', { reset: true })),
      big('Reset everything', 'Shown, full size, back in reach', () => send('overlay.reset'))),
    h('div', { class: 'dash-label' }, `Dim the view (${Math.round(o.dim * 100)} % dark)`),
    h('div', { class: 'dash-row' }, big('Lighter', '', () => send('overlay.dim', { dir: -1 })), big('Darker', 'Works on any headset', () => send('overlay.dim', { dir: 1 })), big('Off', 'Full brightness', () => send('overlay.dim', { level: 0 }), o.dim === 0)),
    h('div', { class: 'dash-label' }, 'Where it goes'),
    h('div', { class: 'dash-row' }, ANCHORS.map(([id, label, hint]) => big(label, hint, () => send('overlay.anchor', { anchor: id }), o.anchor === id))),
    h('div', { class: 'dash-label' }, `Size (${o.widths[o.anchor].toFixed(2)} m wide)`),
    h('div', { class: 'dash-row' }, big('Smaller', '', () => send('overlay.size', { dir: -1 })), big('Bigger', '', () => send('overlay.size', { dir: 1 }))),
    h('div', { class: 'dash-label' }, 'On the deck'),
    h('div', { class: 'dash-row' },
      toggle('Options strip', 'showBar', o.showBar, 'Size, anchor, pin...'),
      toggle('Pinned', 'locked', o.locked, 'Cannot be moved'),
      toggle('Small tab', 'collapsed', o.collapsed, 'Shrink to a tab')),
    o.anchor === 'wrist' ? h('div', { class: 'dash-row' },
      toggle('Only when I look', 'glance', o.glance, 'Wrist: show when raised'),
      big('Turn ↺', '', adj('roll', -15)), big('Turn ↻', '', adj('roll', 15)),
      big('Flip', 'Upside down', adj('flip')), big('Other wrist', '', adj('hand')), big('Reset wrist', '', adj('reset'))) : null,
    h('div', { class: 'dash-foot' }, `Controllers: left ${hands.left || '-'}, right ${hands.right || '-'}   ·   Pictures: ${upload}`));
}
