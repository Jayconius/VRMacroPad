// The "new version available" pop-up. It only ever appears when Settings → General → "Check for updates" is on
// (or you pressed "Check now"). Download / Skip / the release link are its three actions; closing it means "later".
import { h, clear } from './util.js';
import { state, subscribe, view } from './state.js';
import { openModal, toast } from './modal.js';
import * as net from './net.js';

let dialog = null;
let dismissed = ''; // the version this page was told about and closed: not shown again until the app restarts

const percent = (u) => `${Math.round((u.progress || 0) * 100)}%`;

function releaseLink(url) {
  const a = h('a', { href: url, class: 'about-link' }, 'See what is new on GitHub');
  a.addEventListener('click', (e) => {
    e.preventDefault();
    net.request('open.external', { url }).then((ok) => { if (!ok) window.open(url, '_blank', 'noopener'); }, () => window.open(url, '_blank', 'noopener'));
  });
  return a;
}

function draw(body, footer) {
  const u = state.update;
  clear(body);
  clear(footer);
  if (!u || !u.latest || !['available', 'downloading', 'ready'].includes(u.status)) { body.append(h('p', { class: 'muted' }, 'You are up to date.')); return; }
  const closeBtn = (label = 'Later') => h('button', { class: 'btn-secondary', onclick: () => dialog && dialog.close() }, label);
  body.append(
    h('p', null, h('strong', null, `VR Macro Pad ${u.latest}`), ` is out. You have ${u.current}.`),
    u.notes ? h('pre', { class: 'update-notes' }, u.notes) : null,
    u.releaseUrl ? releaseLink(u.releaseUrl) : null);
  if (u.error) body.append(h('div', { class: 'field-error' }, u.error));

  if (u.status === 'downloading') {
    body.append(h('div', { class: 'update-bar' }, h('div', { class: 'update-bar-fill', style: `width:${percent(u)}` })), h('p', { class: 'muted small' }, `Downloading… ${percent(u)}`));
    footer.append(h('button', { class: 'btn-primary', disabled: true }, 'Downloading…'));
    return;
  }
  if (u.status === 'ready') {
    if (u.mode === 'installer') {
      body.append(h('p', { class: 'field-help' }, 'Downloaded. "Install and restart" closes VR Macro Pad, installs the new version over this one (your buttons and settings are kept) and opens it again.'));
      footer.append(closeBtn(), h('button', { class: 'btn-primary', onclick: () => net.request('update.install').catch((e) => toast(e.message, 'error')) }, 'Install and restart'));
    } else {
      body.append(h('p', { class: 'field-help' }, 'The new version was saved next to this one:'), h('code', { class: 'update-path' }, u.file),
        h('p', { class: 'field-help' }, 'Your old copy is untouched, so you can delete it once you are happy with the new one.'));
      footer.append(closeBtn(),
        state.app.hasHost ? h('button', { class: 'btn-secondary', onclick: () => net.request('update.reveal').catch((e) => toast(e.message, 'error')) }, 'Show in folder') : null,
        state.app.hasHost ? h('button', { class: 'btn-primary', onclick: () => net.request('update.install').catch((e) => toast(e.message, 'error')) }, 'Quit and open the new version') : null);
    }
    return;
  }
  // available
  const canDownload = state.app.hasHost && u.asset && u.mode !== 'manual';
  if (!canDownload) body.append(h('p', { class: 'field-help' }, u.mode === 'manual' ? 'This copy is not an installed or portable build, so it cannot update itself. Use the link above.' : (state.app.hasHost ? 'This release has no file for your kind of copy. Use the link above.' : 'Open the app on the desktop to download it.')));
  footer.append(
    h('button', { class: 'btn-secondary', onclick: () => net.request('update.skip').then(() => { dismissed = u.latest; if (dialog) dialog.close(); }, (e) => toast(e.message, 'error')) }, 'Skip this version'),
    closeBtn(),
    canDownload ? h('button', { class: 'btn-primary', onclick: () => net.request('update.download').catch((e) => toast(e.message, 'error')) }, u.error ? 'Try again' : 'Download') : null);
}

export function openUpdateDialog() {
  if (dialog) return;
  const body = h('div', { class: 'stack' });
  const footer = h('div', { class: 'row gap' });
  let unsub = () => {};
  dialog = openModal({
    title: 'Update available',
    body,
    footer,
    onClose: () => { unsub(); if (state.update && state.update.latest) dismissed = state.update.latest; dialog = null; },
  });
  draw(body, footer);
  unsub = subscribe(() => { if (dialog) draw(body, footer); });
}

// Pops the dialog up when the app says there is something new (once per version per run of the app).
export function watchUpdates() {
  let last = '';
  subscribe(() => {
    const u = state.update;
    if (view.overlay || view.dashboard || !u) return;
    if (last === 'downloading' && u.status === 'ready' && !dialog) toast('The update finished downloading.');
    last = u.status;
    if (u.announce && u.status === 'available' && u.latest && u.latest !== dismissed && !dialog) openUpdateDialog();
  });
}

// Settings → General: allow the pop-up again for a manual "Check now".
export function checkNow() {
  dismissed = '';
  return net.request('update.check').then((u) => { if (u.status === 'available') openUpdateDialog(); return u; });
}
