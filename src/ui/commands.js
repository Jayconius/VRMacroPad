// Things the UI asks the core to do. Config edits are applied optimistically and
// rolled back with a message if the core refuses them (e.g. editing is locked).
import * as net from './net.js';
import { state, notify, view } from './state.js';
import { clone } from './util.js';
import { toast } from './modal.js';

export function press(id) {
  net.request('press', { id }).catch((err) => toast(err.message, 'error'));
}

export function widgetCommand(id, cmd, arg) {
  return net.request('widget', { id, cmd, arg }).catch((err) => toast(err.message, 'error'));
}

export async function saveConfig(mutate) {
  const before = state.config;
  const next = clone(before);
  const result = mutate(next);
  if (result === false) return false;
  state.config = next;
  notify();
  try {
    const res = await net.request('config.set', { config: next });
    for (const w of res.warnings || []) toast(w, 'warn');
    return true;
  } catch (err) {
    state.config = before;
    notify();
    toast(err.message, 'error');
    return false;
  }
}

export function setActivePage(id) {
  state.activePage = id;
  notify();
  if (view.overlay) return; // the overlay picks its own page; the desktop's page is not affected
  net.request('page.set', { id }).catch(() => {});
}

export function lockEditing() {
  return net.request('edit.set', { on: false }).catch((err) => toast(err.message, 'error'));
}

export function unlockEditing() {
  return net.request('edit.set', { on: true }).catch((err) => { toast(err.message, 'error'); throw err; });
}

let lastTouch = 0;
// Any interaction while unlocked postpones the automatic re-lock.
export function touchEdit() {
  if (!state.edit.on || Date.now() - lastTouch < 5000) return;
  lastTouch = Date.now();
  net.request('edit.touch').catch(() => {});
}
