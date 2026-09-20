// Renders the active page as a grid of buttons that scales to the window, and
// handles pressing (use mode) and drag / resize (edit mode).
import { h, clear, clamp, contrastText, shade } from './util.js';
import { state, currentPage } from './state.js';
import { press, saveConfig, touchEdit, widgetCommand } from './commands.js';
import { createWidget, INTERACTION } from './widgets-ui.js';

const Grid = window.Grid;
const MIN_CELL = 40;
const HOLD_MS = 800;
const WIDGET_HOLD_MS = 650;
const DRAG_THRESHOLD = 6;
const ARM_MS = 2500;

export function createGridView(container, { onEdit, onAddAt }) {
  const gridEl = h('div', { class: 'grid' });
  container.append(gridEl);

  let cell = 80;
  let gap = 10;
  let drag = null;
  let pendingRender = false;
  let lastSignature = '';
  const els = new Map(); // button id -> element, for in-place updates
  const widgetObjs = new Map(); // button id -> widget renderer
  let armed = null; // { id, timer } for "tap twice to confirm"

  function measure(page) {
    gap = state.config.settings.gap;
    const availW = container.clientWidth - 24;
    const availH = container.clientHeight - 24;
    const byW = (availW - (page.cols - 1) * gap) / page.cols;
    const byH = (availH - (page.rows - 1) * gap) / page.rows;
    cell = Math.max(MIN_CELL, Math.floor(Math.min(byW, byH)));
  }

  const px = (n) => `${n}px`;
  const pos = (v) => v * (cell + gap);
  const span = (v) => v * cell + (v - 1) * gap;

  // Geometry and fixed look: only applied when the layout is rebuilt.
  function baseStyle(b) {
    const min = Math.min(span(b.w), span(b.h));
    return {
      left: px(pos(b.x)), top: px(pos(b.y)), width: px(span(b.w)), height: px(span(b.h)),
      '--icon-size': px(clamp(min * (b.label || b.labelOn ? 0.36 : 0.5), 18, 120)),
      '--label-size': px(clamp(min * 0.15, 11, 30)),
      '--hold-ms': `${HOLD_MS}ms`,
    };
  }

  // Anything driven by live state. Applied in place so pointers held on a button
  // are never interrupted by a state update.
  function applyDynamic(el, b) {
    if (b.widget) {
      // Widgets draw their own state; only their data needs pushing in.
      el.style.setProperty('--bg', b.color);
      el.style.setProperty('--fg', contrastText(b.color));
      const w = widgetObjs.get(b.id);
      const data = state.widgetData[b.id];
      if (w && data) w.update(data);
      return;
    }
    const st = state.buttonStates[b.id];
    const active = Boolean(st && st.active);
    const isArmed = Boolean(armed && armed.id === b.id);
    el.classList.toggle('active', active);
    el.classList.toggle('unknown', Boolean(st && st.unknown));
    el.classList.toggle('running', state.running.has(b.id));
    el.classList.toggle('armed', isArmed);
    const bg = active ? (b.colorOn || shade(b.color, 0.28)) : b.color;
    el.style.setProperty('--bg', bg);
    el.style.setProperty('--fg', contrastText(bg));
    const label = el.querySelector('.btn-label');
    if (label) label.textContent = isArmed ? 'Tap again to confirm' : (active && b.labelOn ? b.labelOn : b.label);
    const dot = el.querySelector('.offline-dot');
    if (dot) dot.hidden = !(st && st.unknown);
  }

  function makeWidget(b) {
    const params = b.widget.params || {};
    const w = createWidget(b.widget.type, {
      button: b, params,
      send: (cmd, arg) => widgetCommand(b.id, cmd, arg),
      clock: () => Date.now() + state.clockOffset,
    });
    if (w) widgetObjs.set(b.id, w);
    return w;
  }

  function buildButton(b) {
    const editing = state.edit.on;
    const w = b.widget ? makeWidget(b) : null;
    const widgetClass = b.widget ? ` widget widget-${b.widget.type.replace('.', '-')}` : '';
    const el = h('div', {
      class: `btn${widgetClass}${b.widget || b.steps.length ? '' : ' empty-btn'}`,
      style: baseStyle(b),
      'data-id': b.id,
      title: editing ? 'Drag to move. Click to edit.' : undefined,
    },
    b.widget
      ? (w ? w.el : h('div', { class: 'w-inner' }, h('div', { class: 'w-sub w-center' }, 'This widget is not available in this version')))
      : [b.icon ? h('div', { class: 'btn-icon' }, b.icon) : null, b.label || b.labelOn ? h('div', { class: 'btn-label' }) : null],
    h('div', { class: 'hold-fill' }),
    h('div', { class: 'offline-dot', title: 'Waiting for the app this button follows', hidden: true }),
    editing ? h('div', { class: 'handle', title: 'Drag to resize' }) : null);
    applyDynamic(el, b);
    if (editing) wireEdit(el, b);
    else if (b.widget) wireWidget(el, b);
    else wireUse(el, b);
    els.set(b.id, el);
    return el;
  }

  // Taps and long-presses on widgets. Media (and other 'custom') widgets have their own buttons inside.
  function wireWidget(el, b) {
    const mode = INTERACTION[b.widget.type] || 'none';
    if (mode === 'tap') { wireUse(el, b, () => widgetCommand(b.id, 'tap')); return; }
    if (mode !== 'tap-hold') return;
    let timer = null;
    let held = false;
    const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('holding'); };
    el.style.setProperty('--hold-ms', `${WIDGET_HOLD_MS}ms`);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      held = false;
      el.classList.add('pressed', 'holding');
      timer = setTimeout(() => { held = true; cancel(); el.classList.remove('pressed'); widgetCommand(b.id, 'hold'); }, WIDGET_HOLD_MS);
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const wasHolding = timer !== null;
      cancel();
      el.classList.remove('pressed');
      if (wasHolding && !held) widgetCommand(b.id, 'tap');
    });
    for (const ev of ['pointerleave', 'pointercancel']) el.addEventListener(ev, () => { cancel(); el.classList.remove('pressed'); });
  }

  // ---- use mode ----
  // fire() is what a confirmed press does (run the button, or tap a widget).
  function wireUse(el, b, fire = () => press(b.id)) {
    if (b.confirm === 'hold') {
      let timer = null;
      const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('holding'); };
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        el.classList.add('pressed', 'holding');
        timer = setTimeout(() => { cancel(); el.classList.remove('pressed'); fire(); }, HOLD_MS);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => { cancel(); el.classList.remove('pressed'); });
      return;
    }
    el.addEventListener('pointerdown', (e) => { if (e.button === 0) el.classList.add('pressed'); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => el.classList.remove('pressed'));
    el.addEventListener('click', () => {
      if (b.confirm === 'double') {
        if (armed && armed.id === b.id) {
          clearTimeout(armed.timer);
          armed = null;
          render();
          fire();
        } else {
          if (armed) clearTimeout(armed.timer);
          armed = { id: b.id, timer: setTimeout(() => { armed = null; render(); }, ARM_MS) };
          render();
        }
        return;
      }
      fire();
    });
  }

  // ---- edit mode ----
  function ghostFor(rect, valid) {
    return h('div', { class: `ghost ${valid ? 'ok' : 'bad'}`, style: { left: px(pos(rect.x)), top: px(pos(rect.y)), width: px(span(rect.w)), height: px(span(rect.h)) } });
  }

  function wireEdit(el, b) {
    const handle = el.querySelector('.handle');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === handle) return;
      touchEdit();
      beginDrag(e, el, b, 'move');
    });
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      touchEdit();
      beginDrag(e, el, b, 'resize');
    });
  }

  function beginDrag(e, el, b, mode) {
    const page = currentPage();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = pos(b.x);
    const startTop = pos(b.y);
    let moved = false;
    let ghost = null;
    let target = { x: b.x, y: b.y, w: b.w, h: b.h };
    let valid = true;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        drag = { id: b.id };
        el.classList.add('dragging');
        ghost = ghostFor(target, true);
        gridEl.append(ghost);
      }
      if (mode === 'move') {
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        target = {
          x: clamp(Math.round((startLeft + dx) / (cell + gap)), 0, page.cols - b.w),
          y: clamp(Math.round((startTop + dy) / (cell + gap)), 0, page.rows - b.h),
          w: b.w, h: b.h,
        };
      } else {
        const wpx = Math.max(cell * 0.6, span(b.w) + dx);
        const hpx = Math.max(cell * 0.6, span(b.h) + dy);
        el.style.width = px(wpx);
        el.style.height = px(hpx);
        target = {
          x: b.x, y: b.y,
          w: clamp(Math.round((wpx + gap) / (cell + gap)), 1, page.cols - b.x),
          h: clamp(Math.round((hpx + gap) / (cell + gap)), 1, page.rows - b.y),
        };
      }
      valid = Grid.fits(page, target, b.id);
      const g = ghostFor(target, valid);
      ghost.className = g.className;
      ghost.style.cssText = g.style.cssText;
    };

    const finish = (commit) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      const wasDrag = moved;
      drag = null;
      lastSignature = ''; // the dragged element carries temporary styles; rebuild it cleanly
      if (!wasDrag) {
        if (commit) onEdit(b.id);
        return;
      }
      const changed = target.x !== b.x || target.y !== b.y || target.w !== b.w || target.h !== b.h;
      if (commit && valid && changed) {
        saveConfig((cfg) => {
          const pg = cfg.pages.find((p) => p.id === page.id);
          Object.assign(pg.buttons.find((x) => x.id === b.id), target);
        });
      }
      render();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  // ---- render ----
  // Rebuild only when the layout itself changed; live state is patched in place.
  function render() {
    if (drag) { pendingRender = true; return; }
    pendingRender = false;
    const page = currentPage();
    if (!page) return;
    measure(page);
    const signature = JSON.stringify([page.id, page.cols, page.rows, gap, cell, state.edit.on, page.buttons]);
    if (signature === lastSignature) {
      for (const b of page.buttons) {
        const el = els.get(b.id);
        if (el) applyDynamic(el, b);
      }
      return;
    }
    lastSignature = signature;
    els.clear();
    widgetObjs.clear();
    container.classList.toggle('editing', state.edit.on);
    clear(gridEl);
    gridEl.style.width = px(span(page.cols));
    gridEl.style.height = px(span(page.rows));
    if (state.edit.on) {
      for (let y = 0; y < page.rows; y++) {
        for (let x = 0; x < page.cols; x++) {
          if (page.buttons.some((b) => Grid.overlaps({ x, y, w: 1, h: 1 }, b))) continue;
          const c = h('div', { class: 'cell', title: 'Add a button here', style: { left: px(pos(x)), top: px(pos(y)), width: px(cell), height: px(cell) } }, '+');
          c.addEventListener('click', () => onAddAt(x, y));
          gridEl.append(c);
        }
      }
    }
    for (const b of page.buttons) gridEl.append(buildButton(b));
    if (!page.buttons.length && !state.edit.on) {
      gridEl.append(h('div', { class: 'empty-note' }, 'This page is empty.', h('br'), 'Hold the 🔒 button to unlock editing, then press + to add a button.'));
    }
  }

  function flash(id, ok) {
    const el = gridEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const cls = ok ? 'flash-ok' : 'flash-err';
    el.classList.remove('flash-ok', 'flash-err');
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 700);
  }

  new ResizeObserver(() => { if (!drag) render(); }).observe(container);

  // Clocks, timers and progress bars advance on their own between data updates.
  setInterval(() => { for (const w of widgetObjs.values()) w.tick(); }, 200);

  return { render, flash };
}
