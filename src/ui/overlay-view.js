// The SteamVR overlay's face. It is this same page, loaded off-screen with ?view=overlay, so everything set up on
// the desktop shows here live. What differs: it is always in use mode (never editing), it picks its own page,
// and it has a grab handle and a tool strip (size, anchor, pin, bring-to-me, collapse) instead of window chrome.
import { h, clear } from './util.js';
import * as net from './net.js';
import { state, overlayPages, subscribe } from './state.js';
import { setActivePage } from './commands.js';

const send = (type, payload) => net.request(type, payload).catch(() => {});
const ANCHOR_LABELS = { front: 'Front', room: 'Room', wrist: 'Wrist' };
const ANCHOR_HELP = { front: 'Float in front of me', room: 'Stay where it is in the room', wrist: 'Sit on my wrist' };

let signature = '';

export function renderOverlayTopbar(topbar) {
  const o = state.config.settings.overlay;
  const pages = overlayPages();
  const sig = JSON.stringify([o.anchor, o.hand, o.locked, o.collapsed, o.showBar, pages.map((p) => [p.id, p.name]), state.activePage]);
  if (sig === signature) return; // rebuilding while a laser is pressed on the bar would swallow the click
  signature = sig;
  clear(topbar);

  if (o.collapsed) {
    topbar.append(h('button', { class: 'ov-expand', title: 'Show VR Macro Pad', onclick: () => send('overlay.toggle', { key: 'collapsed', on: false }) }, '🎛️'));
    return;
  }

  const handle = h('div', { class: 'ov-handle', title: o.locked ? 'Pinned: unpin it to move it' : 'Hold the trigger here and move your hand' }, o.locked ? '📌 pinned' : '⋮⋮⋮⋮⋮⋮');
  handle.addEventListener('pointerdown', () => { if (!o.locked) send('overlay.grab', { on: true }); });
  const btn = (label, title, onclick, on = false) => h('button', { class: `ov-btn${on ? ' on' : ''}`, title, onclick }, label);
  const row = [handle];
  if (!o.showBar) {
    // The strip is hidden: one small button stays so it can be brought back without leaving VR.
    row.push(btn('⚙', 'Show the options (size, anchor, pin...)', () => send('overlay.toggle', { key: 'showBar', on: true })));
  } else {
    row.push(
      btn('−', 'Smaller', () => send('overlay.size', { dir: -1 })),
      btn('+', 'Bigger', () => send('overlay.size', { dir: 1 })),
      ...Object.keys(ANCHOR_LABELS).map((a) => { const b = btn(ANCHOR_LABELS[a], ANCHOR_HELP[a], () => send('overlay.anchor', { anchor: a }), o.anchor === a); b.dataset.anchor = a; return b; }),
      btn('📌', o.locked ? 'Unpin' : 'Pin in place', () => send('overlay.toggle', { key: 'locked' }), o.locked),
      btn('↻', 'Bring it back to me', () => send('overlay.bring')),
      btn('–', 'Shrink the whole deck to a small tab', () => send('overlay.toggle', { key: 'collapsed', on: true })),
      btn('Hide options', 'Hide these buttons (the macros stay). The ⚙ button brings them back.', () => send('overlay.toggle', { key: 'showBar', on: false })),
    );
  }
  topbar.append(h('div', { class: 'ov-row' }, ...row));
  if (o.showBar && o.anchor === 'wrist') {
    // Turning the panel so it reads properly without twisting your wrist. Remembered per controller type and hand.
    const adj = (kind, amount) => () => send('overlay.adjust', { kind, amount });
    topbar.append(h('div', { class: 'ov-row ov-wrist' },
      h('span', { class: 'ov-label' }, `${o.hand === 'left' ? 'Left' : 'Right'} wrist`),
      btn('↺', 'Turn it counter-clockwise (15°)', adj('roll', -15)),
      btn('↻', 'Turn it clockwise (15°)', adj('roll', 15)),
      btn('▲', 'Tilt the top edge away from me', adj('pitch', -10)),
      btn('▼', 'Tilt the top edge toward me', adj('pitch', 10)),
      btn('Flip', 'Turn it upside down', adj('flip')),
      btn('Other wrist', 'Move it to the other wrist', adj('hand')),
      btn('Reset', 'Back to the standard wrist position', adj('reset'))));
  }
  if (pages.length > 1) {
    topbar.append(h('nav', { class: 'page-tabs' }, pages.map((p) => h('button', { class: `page-tab${p.id === state.activePage ? ' on' : ''}`, onclick: () => setActivePage(p.id) }, p.name))));
  }
}

// The self-check readout: what the app thinks the laser is doing, and where SteamVR says things are.
// It lets one short session in the headset check everything at once (and gives me numbers instead of "it feels off").
export function startOverlayExtras() {
  const diag = h('pre', { class: 'ov-diag', hidden: true });
  const dot = h('div', { class: 'ov-dot', hidden: true });
  document.body.append(diag, dot);
  let pointer = { x: -1, y: -1 };
  document.addEventListener('pointermove', (e) => {
    pointer = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
    dot.style.left = `${pointer.x}px`;
    dot.style.top = `${pointer.y}px`;
  }, true);
  const draw = () => {
    if (!state.config) return;
    const o = state.config.settings.overlay;
    diag.hidden = !o.diagnostics;
    dot.hidden = !o.diagnostics;
    if (!o.diagnostics) return;
    const s = state.status.overlay || {};
    const d = s.diag || {};
    const lines = [
      `overlay ${s.state || '?'}${s.error ? ` (${s.error})` : ''} | ${s.frame || 'no picture'} | ${d.fps || 0} fps, sent ${d.sent || 0}, dropped ${d.dropped || 0}`,
      `anchor ${o.anchor}${o.anchor === 'wrist' ? ` (${o.hand})` : ''} | width ${o.widths[o.anchor]} m | ${o.locked ? 'pinned' : 'free'} | ${s.grabbing ? 'GRABBING' : 'not grabbing'}${s.snap ? ` | near the ${s.snap} wrist: let go to snap` : ''}`,
      `controllers: left ${((d.hands || {}).left) || '-'}, right ${((d.hands || {}).right) || '-'}`,
      `laser (from SteamVR) x=${d.pointer ? d.pointer.x : '-'} y=${d.pointer ? d.pointer.y : '-'}  device ${d.pointer ? d.pointer.device : '-'}`,
      `page pointer         x=${pointer.x} y=${pointer.y}   (the yellow ring should sit under the laser tip)`,
      `picture ${window.innerWidth}x${window.innerHeight} | upload ${(s.upload && s.upload.path) || '-'}: ${s.upload ? s.upload.ms : 0} ms avg, ${s.upload ? s.upload.maxMs : 0} ms worst, ${s.upload ? s.upload.count : 0} sent`,
      ...(d.devices || []).map((v) => `#${v.index} ${v.class}${v.role ? ` ${v.role}` : ''} ${v.controllerType || v.model || ''}${v.valid ? '' : ' (no pose)'}`),
      ...(d.events || []).slice(-6),
    ];
    diag.textContent = lines.join('\n');
  };
  const showSnap = () => { const snap = (state.status.overlay || {}).snap || ''; document.body.classList.toggle('snap-wrist', Boolean(snap)); };
  subscribe(showSnap);
  subscribe(draw);
  showSnap();
  draw();
}
