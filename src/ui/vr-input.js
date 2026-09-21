// Makes the full app usable inside VR (the editor tab of the SteamVR dashboard). That page is drawn off-screen and driven by a
// laser, so three things a normal browser does for free have to be done here:
//   1. drop-down lists and colour pickers are native pop-ups that never appear off-screen: we draw our own,
//   2. typing: a text box getting focus opens SteamVR's on-screen keyboard, and what is typed comes back into the box,
//   3. scrolling: the thumbstick / trackpad scroll arrives as a message and is applied to whatever is under the laser.
import { h } from './util.js';
import * as net from './net.js';

const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel', '']);
const SWATCHES = [
  '#e05252', '#e8734a', '#e39a2e', '#d9b52b', '#a3b93a', '#4fae5c', '#2f9e8f', '#2a9bb8',
  '#3b82c4', '#4c63d2', '#6f55cf', '#9350c7', '#b84fb0', '#d24c85', '#8a5a44', '#66707f',
  '#ff6b6b', '#ff9f68', '#ffc857', '#ffe066', '#c3e26b', '#7bd88f', '#5fd4c4', '#6fd0f0',
  '#74a8ff', '#8f9bff', '#b39dff', '#d39bff', '#f29bd8', '#ff8fb0', '#c39b85', '#a5adba',
  '#992e2e', '#a5502d', '#9b6a14', '#8f7a12', '#647320', '#2c7a38', '#1d6b60', '#1a6478',
  '#234f87', '#2f3f96', '#4a3a91', '#63308a', '#7b2f74', '#8e2c57', '#5b3a2b', '#3d4450',
  '#ffffff', '#d6dae2', '#aab1bf', '#7d8596', '#565d6d', '#3a4050', '#232733', '#000000',
];

let pop = null;
let popFor = null;

function closePop() {
  if (pop) { pop.remove(); pop = null; }
  popFor = null;
}

// Puts a list under (or above, when there is no room) the thing it belongs to.
function showPop(anchor, content) {
  closePop();
  pop = h('div', { class: 'vr-pop' }, content);
  popFor = anchor;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 10;
  const above = r.top - 10;
  const up = pop.offsetHeight > below && above > below;
  pop.style.minWidth = `${Math.max(r.width, 160)}px`;
  pop.style.maxHeight = `${Math.max(160, up ? above : below)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  if (up) pop.style.bottom = `${window.innerHeight - r.top + 4}px`; else pop.style.top = `${r.bottom + 4}px`;
}

function fire(el, names) {
  for (const n of names) el.dispatchEvent(new Event(n, { bubbles: true }));
}

function openSelect(sel) {
  const items = [];
  for (const child of sel.children) {
    const opts = child.tagName === 'OPTGROUP' ? [h('div', { class: 'vr-group' }, child.label), ...[...child.children]] : [child];
    for (const o of opts) {
      if (!(o instanceof HTMLOptionElement)) { items.push(o); continue; }
      items.push(h('button', {
        class: `vr-item${o.selected ? ' on' : ''}`, disabled: o.disabled, type: 'button',
        onclick: () => { sel.value = o.value; fire(sel, ['input', 'change']); closePop(); },
      }, o.textContent));
    }
  }
  showPop(sel, items);
  const on = pop.querySelector('.vr-item.on');
  if (on) on.scrollIntoView({ block: 'center' });
}

function openColor(input) {
  const hex = h('input', { class: 'vr-hex', type: 'text', value: input.value, 'aria-label': 'Colour, like #3b82c4', maxlength: '7' });
  const use = (v) => { if (/^#[0-9a-f]{6}$/i.test(v)) { input.value = v.toLowerCase(); fire(input, ['input', 'change']); closePop(); } };
  showPop(input, [
    h('div', { class: 'vr-swatches' }, SWATCHES.map((c) => h('button', { class: `vr-swatch${c === input.value ? ' on' : ''}`, type: 'button', style: { background: c }, title: c, onclick: () => use(c) }))),
    h('div', { class: 'vr-hexrow' }, hex, h('button', { class: 'vr-item', type: 'button', onclick: () => use(hex.value.trim()) }, 'Use this colour')),
  ]);
}

// ---- typing ----
let active = null;
const isText = (el) => el && ((el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '')) || el.tagName === 'TEXTAREA');
const send = (type, payload) => net.request(type, payload).catch(() => {});

function labelOf(el) {
  const own = el.getAttribute('aria-label') || el.placeholder || el.title || '';
  if (own) return own;
  const field = el.closest('label, .field');
  return field ? (field.querySelector('.field-label, span, label') || field).textContent.trim().slice(0, 80) : '';
}

window.__vrText = (kind, text) => {
  if (!active || !document.contains(active)) return;
  if (kind === 'closed') { fire(active, ['change']); active = null; return; }
  if (active.value !== text) { active.value = text; fire(active, ['input']); }
  if (kind === 'done') { fire(active, ['change']); active.blur(); active = null; }
};

// Applies one scroll step to whatever scrollable thing is under the laser.
window.__vrScroll = (x, y, dy) => {
  if (!dy) return;
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) { el.scrollBy({ top: -dy * 90 }); return; }
    el = el.parentElement;
  }
  window.scrollBy(0, -dy * 90);
};

export function startVrInput() {
  document.documentElement.classList.add('editor');
  document.body.classList.add('editor');

  // Our own lists instead of the native ones (which are invisible off-screen).
  document.addEventListener('mousedown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (pop && t && pop.contains(t)) return; // a click inside our own list
    const sel = t && t.closest('select');
    const color = t && t.closest('input[type="color"]');
    if (!sel && !color) { closePop(); return; }
    e.preventDefault();
    e.stopPropagation();
    const same = pop && popFor === (sel || color);
    closePop();
    if (same) return;
    if (sel && !sel.disabled && !sel.multiple) openSelect(sel); else if (color && !color.disabled) openColor(color);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); }, true);

  // SteamVR's keyboard for text boxes. A page drawn off-screen is never a "focused window", so focus events cannot be relied on:
  // the laser click on the box opens the keyboard (focusin still covers a real keyboard's Tab).
  const openKeyboard = (el) => {
    if (!isText(el) || el.readOnly || el.disabled) return;
    active = el;
    send('dash.keyboard', { text: el.value, multiline: el.tagName === 'TEXTAREA', password: el.type === 'password', desc: labelOf(el) });
  };
  document.addEventListener('mousedown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t && isText(t)) openKeyboard(t);
    else if (active && !(t && pop && pop.contains(t))) { active = null; send('dash.keyboard.hide'); }
  }, true);
  document.addEventListener('focusin', (e) => { if (e.target !== active) openKeyboard(e.target); });
}
