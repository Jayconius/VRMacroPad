// Forms generated from an action's parameter description, plus shared form widgets.
import { h, clear } from './util.js';
import * as net from './net.js';

// ---- hotkey recording ----
const CODE_NAMES = {
  Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PrintScreen: 'printscreen',
  Pause: 'pause', ScrollLock: 'scrolllock', CapsLock: 'capslock', NumLock: 'numlock', ContextMenu: 'apps',
  Semicolon: 'semicolon', Equal: 'equals', Comma: 'comma', Minus: 'minus', Period: 'period', Slash: 'slash',
  Backquote: 'backtick', BracketLeft: 'lbracket', Backslash: 'backslash', BracketRight: 'rbracket', Quote: 'quote',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummul', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

function keyNameFromEvent(e) {
  if (CODE_NAMES[e.code]) return CODE_NAMES[e.code];
  let m = /^Key([A-Z])$/.exec(e.code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(e.code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(e.code);
  if (m) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) return e.code.toLowerCase();
  return null;
}

// Two output formats: the macro format ("ctrl+shift+m") and Electron's accelerator ("Ctrl+Shift+M").
function comboFromEvent(e, format) {
  const key = keyNameFromEvent(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('win');
  if (format === 'macro') return [...mods, key].join('+');
  const accelKey = { esc: 'Escape', enter: 'Return', pageup: 'PageUp', pagedown: 'PageDown', printscreen: 'PrintScreen', backtick: '`', plus: 'Plus', minus: '-', comma: ',', period: '.', slash: '/', semicolon: ';', equals: '=', lbracket: '[', rbracket: ']', backslash: '\\', quote: "'", left: 'Left', right: 'Right', up: 'Up', down: 'Down', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End' }[key];
  const name = accelKey || (/^f\d+$/.test(key) ? key.toUpperCase() : /^num\d$/.test(key) ? `num${key.slice(3)}` : key.length === 1 ? key.toUpperCase() : key);
  const accelMods = mods.map((m) => ({ ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Super' })[m]);
  return [...accelMods, name].join('+');
}

export function hotkeyField({ value, onChange, format = 'macro', placeholder = '' }) {
  const input = h('input', { type: 'text', value: value || '', placeholder, spellcheck: 'false' });
  const rec = h('button', { type: 'button', class: 'btn-secondary small' }, '● Record');
  let stop = null;
  const finish = () => {
    if (stop) { stop(); stop = null; }
    rec.textContent = '● Record';
    rec.classList.remove('recording');
  };
  input.addEventListener('input', () => onChange(input.value.trim()));
  rec.addEventListener('click', () => {
    if (stop) { finish(); return; }
    rec.textContent = 'Press keys… (Esc cancels)';
    rec.classList.add('recording');
    const handler = (e) => {
      if (MOD_CODES.has(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) { finish(); return; }
      const combo = comboFromEvent(e, format);
      if (combo) {
        input.value = combo;
        onChange(combo);
      }
      finish();
    };
    window.addEventListener('keydown', handler, true);
    stop = () => window.removeEventListener('keydown', handler, true);
  });
  return h('div', { class: 'row gap' }, input, rec);
}

// A box you can type in that also drops down a list of choices. The list is drawn by the page itself (a browser's own
// <datalist> pop-up cannot be scrolled in every window, only shows what matches what is typed, and is not part of the page, so
// it cannot be seen in a VR overlay). Opening it always shows EVERYTHING and scrolls to the current choice; typing narrows it.
// items: [{ value, label, hint }]; a choice puts its value in the box. Free typing is still allowed.
export function comboBox({ value = '', placeholder = '', onChange }) {
  let items = [];
  let typed = false; // true once you type: only then does the list narrow
  let active = -1;
  const input = h('input', { type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false' });
  const arrow = h('button', { type: 'button', class: 'combo-arrow', tabindex: '-1', 'aria-label': 'Show the list' }, '▾');
  const list = h('div', { class: 'combo-list', role: 'listbox', hidden: true });
  const root = h('div', { class: 'combo' }, input, arrow, list);
  const isOpen = () => !list.hidden;

  const shown = () => {
    // every word you type has to appear somewhere in the name or its note, in any order ("demon radio" finds "Radio Demon")
    const words = typed ? input.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    return words.length ? items.filter((o) => { const hay = `${o.value} ${o.hint || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); }) : items;
  };
  function place() {
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 200 && above > below;
    Object.assign(list.style, { left: `${r.left}px`, width: `${r.width}px`, maxHeight: `${Math.max(120, Math.min(340, up ? above : below))}px`, top: up ? 'auto' : `${r.bottom + 2}px`, bottom: up ? `${window.innerHeight - r.top + 2}px` : 'auto' });
  }
  function draw({ scrollToCurrent = false } = {}) {
    clear(list);
    const rows = shown();
    if (!rows.length) list.append(h('div', { class: 'combo-empty' }, items.length ? 'Nothing matches. What you typed is used as it is.' : 'The list is empty (or still loading).'));
    rows.forEach((o, i) => {
      const el = h('div', { class: `combo-item${o.value === input.value ? ' on' : ''}${i === active ? ' active' : ''}`, role: 'option', 'data-i': String(i) },
        h('span', { class: 'combo-value' }, o.value), o.hint ? h('span', { class: 'combo-hint' }, o.hint) : null);
      list.append(el);
    });
    if (scrollToCurrent) { const cur = list.querySelector('.combo-item.on'); if (cur) cur.scrollIntoView({ block: 'center' }); }
  }
  function openList() {
    typed = typed && isOpen();
    active = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    place();
    draw({ scrollToCurrent: !typed });
  }
  function closeList() {
    list.hidden = true;
    typed = false;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
  }
  function choose(i) {
    const o = shown()[i];
    if (!o) return;
    input.value = o.value;
    closeList();
    onChange(o.value);
  }
  const move = (d) => {
    const n = shown().length;
    if (!n) return;
    active = (active + d + n) % n;
    draw();
    const el = list.querySelector('.combo-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', () => { typed = false; openList(); });
  input.addEventListener('input', () => { typed = true; active = -1; onChange(input.value); if (!isOpen()) openList(); else { place(); draw(); } });
  input.addEventListener('blur', closeList);
  input.addEventListener('click', () => { if (!isOpen()) { typed = false; openList(); } }); // the box may already have focus (after a choice)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen()) openList(); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen()) move(-1); }
    else if (e.key === 'Enter' && isOpen() && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); closeList(); }
  });
  // pointerdown (not click) and preventDefault: the box keeps focus, so the list does not close before the choice lands
  list.addEventListener('pointerdown', (e) => { e.preventDefault(); const el = e.target.closest('.combo-item'); if (el) choose(Number(el.dataset.i)); });
  list.addEventListener('pointermove', (e) => { const el = e.target.closest('.combo-item'); const i = el ? Number(el.dataset.i) : -1; if (i !== active && i >= 0) { active = i; for (const x of list.children) x.classList.toggle('active', x === el); } });
  arrow.addEventListener('pointerdown', (e) => { e.preventDefault(); if (isOpen()) closeList(); else { input.focus(); openList(); } });
  const reposition = () => { if (isOpen()) place(); };
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true); // the dialog body scrolls under it

  root.input = input;
  root.setItems = (next) => { items = next || []; if (isOpen()) draw(); };
  return root;
}

// ---- option lists (devices, scenes, apps) loaded on demand ----
const optionCache = new Map();

export function loadOptions(kind, { force = false, args } = {}) {
  const cacheKey = args && Object.keys(args).length ? `${kind}\u0000${JSON.stringify(args)}` : kind;
  const hit = optionCache.get(cacheKey);
  if (hit && !force && Date.now() - hit.at < 5000) return Promise.resolve(hit.list);
  return net.request('options', args && Object.keys(args).length ? { kind, args } : { kind }).then((list) => {
    optionCache.set(cacheKey, { at: Date.now(), list });
    return list;
  });
}

// A <select> (or free-text input when allowCustom) whose entries arrive asynchronously.
// args: an optional function giving the values of other fields this list depends on; host.reload() asks again.
export function optionsField({ kind, value, onChange, allowCustom = false, emptyLabel = '', placeholder = '', unknownSuffix = 'not found', args = null }) {
  const host = h('div', { class: 'options-field' });
  const render = (list, error) => {
    clear(host);
    if (allowCustom) {
      const combo = comboBox({ value: value || '', placeholder: placeholder || 'Type or pick…', onChange });
      combo.setItems((list || []).map((o) => ({ value: o.value, hint: o.hint !== undefined ? o.hint : (o.label !== o.value ? o.label : '') })));
      host.append(combo);
    } else {
      const select = h('select', null,
        emptyLabel || !value ? h('option', { value: '' }, emptyLabel || 'Choose…') : null,
        (list || []).map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
        value && !(list || []).some((o) => o.value === value) ? h('option', { value, selected: true }, `${value} (${unknownSuffix})`) : null);
      select.value = value || '';
      select.addEventListener('change', () => onChange(select.value));
      host.append(select);
    }
    const refresh = h('button', { type: 'button', class: 'icon-btn small', title: 'Reload list', onclick: () => start(true) }, '⟳');
    host.append(refresh);
    if (error) host.append(h('div', { class: 'field-error' }, error));
  };
  const start = (force = false) => {
    clear(host);
    host.append(h('span', { class: 'muted' }, 'Loading…'));
    loadOptions(kind, { force, args: args ? args() : undefined }).then((list) => render(list, ''), (err) => render([], err.message));
  };
  start();
  host.reload = () => start(true);
  return host;
}

// A tick-list of choices loaded on demand. With a long list (dozens of voices) a filter box appears: every word you type has to
// appear in an entry's name or note, in any order. Ticked entries stay ticked while they are filtered out of sight.
export function multiOptionsField({ kind, value, onChange }) {
  const selected = new Set(Array.isArray(value) ? value : []);
  const host = h('div', { class: 'checklist' });
  const filter = h('input', { type: 'text', class: 'multi-filter', placeholder: 'Type to filter the list…', spellcheck: 'false', autocomplete: 'off', hidden: true });
  const count = h('span', { class: 'muted small' });
  const root = h('div', { class: 'multi-field' }, filter, host, count);
  let rows = [];
  const paintCount = () => { count.textContent = selected.size ? `${selected.size} selected` : ''; };
  const applyFilter = () => {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) r.el.hidden = !words.every((w) => r.text.includes(w));
  };
  filter.addEventListener('input', applyFilter);
  loadOptions(kind).then((list) => {
    clear(host);
    rows = [];
    for (const o of list) {
      const cb = h('input', { type: 'checkbox', checked: selected.has(o.value) });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(o.value); else selected.delete(o.value);
        onChange([...selected]);
        paintCount();
      });
      const el = h('label', { class: 'check' }, cb, o.label, o.hint ? h('span', { class: 'muted small' }, ` ${o.hint}`) : null);
      rows.push({ el, text: `${o.label} ${o.hint || ''}`.toLowerCase() });
      host.append(el);
    }
    if (!list.length) host.append(h('span', { class: 'muted' }, 'Nothing found'));
    filter.hidden = list.length < 12;
    paintCount();
  }, (err) => { clear(host); host.append(h('div', { class: 'field-error' }, err.message)); });
  host.append(h('span', { class: 'muted' }, 'Loading…'));
  paintCount();
  return root;
}

// A checklist whose entries are known up front (no loading).
export function staticMultiField({ options, value, onChange }) {
  const selected = new Set(Array.isArray(value) ? value : []);
  return h('div', { class: 'checklist plain' }, options.map(([v, label]) => {
    const cb = h('input', { type: 'checkbox', checked: selected.has(v) });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(v); else selected.delete(v);
      onChange([...selected]);
    });
    return h('label', { class: 'check' }, cb, label);
  }));
}

// Text input with a drop-down of suggestions, but free typing still allowed.
export function suggestInput(value, suggestions, onChange, placeholder = '') {
  const combo = comboBox({ value: value ?? '', placeholder, onChange });
  combo.setItems(suggestions.map((v) => ({ value: v })));
  return h('div', { class: 'options-field' }, combo);
}

// ---- generic labelled field ----
export function field(label, control, { help = '', required = false } = {}) {
  // A div, not a label: a label would forward stray clicks to its first control (e.g. open a color picker).
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, label, required ? h('span', { class: 'req' }, ' *') : null),
    control,
    help ? h('span', { class: 'field-help' }, help) : null);
}

export function textInput(value, onChange, { type = 'text', placeholder = '', min, max, step } = {}) {
  const input = h('input', { type, value: value ?? '', placeholder, min, max, step, spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('input', () => onChange(type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value));
  return input;
}

export function selectInput(options, value, onChange) {
  const select = h('select', null, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function checkbox(label, checked, onChange) {
  const cb = h('input', { type: 'checkbox', checked: Boolean(checked) });
  cb.addEventListener('change', () => onChange(cb.checked));
  return h('label', { class: 'check' }, cb, label);
}

// ---- action parameter form ----
export function buildParamForm(def, params, onChange) {
  const root = h('div', { class: 'param-form' });
  const rows = [];
  const set = (key, value) => {
    params[key] = value;
    onChange();
    updateVisibility();
    for (const r of rows) if (r.control && r.control.reload && (r.p.optionsFilter || []).includes(key)) r.control.reload(); // a list that depends on this field
  };
  const visible = (p) => !p.showIf || p.showIf.in.includes(params[p.showIf.key]);
  function updateVisibility() {
    for (const { p, el } of rows) el.hidden = !visible(p);
  }
  for (const p of def.params) {
    // A "notice" is only a highlighted message (a warning, a tip): it holds no value and saves nothing.
    if (p.type === 'notice') {
      const el = h('div', { class: `param-notice ${p.level === 'info' ? 'info' : 'warn'}`, role: 'note' }, h('strong', null, p.title || (p.level === 'info' ? 'Good to know' : 'Careful')), h('span', null, p.text || ''));
      rows.push({ p, el });
      root.append(el);
      continue;
    }
    if (params[p.key] === undefined && p.default !== undefined) params[p.key] = p.default;
    let control;
    if (p.type === 'select' && p.optionsFrom) {
      control = optionsField({ kind: p.optionsFrom, value: params[p.key], onChange: (v) => set(p.key, v), allowCustom: p.allowCustom, emptyLabel: p.emptyLabel, unknownSuffix: p.unknownSuffix, args: p.optionsFilter ? () => Object.fromEntries(p.optionsFilter.map((k) => [k, params[k] ?? ''])) : null });
    } else if (p.type === 'select') {
      control = selectInput(p.options, params[p.key] ?? p.options[0][0], (v) => set(p.key, v));
      if (params[p.key] === undefined) params[p.key] = p.options[0][0];
    } else if (p.type === 'multiselect' && p.options) {
      control = staticMultiField({ options: p.options, value: params[p.key], onChange: (v) => set(p.key, v) });
    } else if (p.type === 'multiselect') {
      control = multiOptionsField({ kind: p.optionsFrom, value: params[p.key], onChange: (v) => set(p.key, v) });
    } else if (p.type === 'boolean') {
      control = checkbox(p.label, params[p.key], (v) => set(p.key, v));
    } else if (p.type === 'keys') {
      control = hotkeyField({ value: params[p.key], onChange: (v) => set(p.key, v), format: 'macro', placeholder: 'e.g. ctrl+shift+m' });
    } else if (p.type === 'textarea') {
      const ta = h('textarea', { rows: 3, placeholder: p.placeholder || '', spellcheck: 'false' });
      ta.value = params[p.key] ?? '';
      ta.addEventListener('input', () => set(p.key, ta.value));
      control = ta;
    } else if (p.type === 'number') {
      control = textInput(params[p.key], (v) => set(p.key, v), { type: 'number', min: p.min, max: p.max, placeholder: p.placeholder });
    } else if (p.type === 'text' && p.suggestions) {
      control = suggestInput(params[p.key], p.suggestions, (v) => set(p.key, v), p.placeholder);
    } else {
      control = textInput(params[p.key], (v) => set(p.key, v), { type: p.type === 'password' ? 'password' : 'text', placeholder: p.placeholder });
    }
    const el = p.type === 'boolean'
      ? h('div', { class: 'field' }, control, p.help ? h('span', { class: 'field-help' }, p.help) : null)
      : field(p.label, control, { help: p.help, required: p.required });
    rows.push({ p, el, control });
    root.append(el);
  }
  updateVisibility();
  if (!def.params.length) root.append(h('p', { class: 'muted' }, 'This action needs no settings.'));
  return root;
}
