// Modal dialogs and toasts.
//
// The desktop window does not take focus when clicked (so key macros reach your
// game). Text fields need focus, so while any dialog is open we ask the app to
// let the window take focus, and give that up again when the last one closes.
import { h, clear } from './util.js';
import * as net from './net.js';

const stack = [];

function setFocusable(on) {
  net.request('window', { focusable: on }).catch(() => {});
}

// Returns { close(), body } . onClose runs after removal (also for Escape / backdrop).
export function openModal({ title, body, footer, wide = false, onClose, closable = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const closeBtn = closable ? h('button', { class: 'icon-btn', title: 'Close', onclick: () => api.close() }, '✕') : null;
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  backdrop.append(box);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && closable) api.close(); });
  const onKey = (e) => {
    if (e.key === 'Escape' && closable && stack[stack.length - 1] === api && !e.defaultPrevented) api.close();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  if (!stack.length) setFocusable(true);
  const api = {
    body: box.querySelector('.modal-body'),
    box,
    close() {
      const i = stack.indexOf(api);
      if (i === -1) return;
      stack.splice(i, 1);
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (!stack.length) setFocusable(false);
      if (onClose) onClose();
    },
  };
  stack.push(api);
  return api;
}

export function anyModalOpen() {
  return stack.length > 0;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } m.close(); };
    const m = openModal({
      title,
      body: h('p', { class: 'muted' }, message),
      footer: [
        h('button', { class: 'btn-secondary', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: danger ? 'btn-danger' : 'btn-primary', onclick: () => finish(true) }, confirmLabel),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

// ---- toasts ----
let toastHost = null;

export function toast(text, level = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${level}`, onclick: () => el.remove() }, text);
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  setTimeout(() => el.remove(), level === 'error' ? 8000 : 4500);
}

export function clearToasts() {
  if (toastHost) clear(toastHost);
}
