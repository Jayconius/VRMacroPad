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

// ---- option lists (devices, scenes, apps) loaded on demand ----
const optionCache = new Map();

export function loadOptions(kind, { force = false } = {}) {
  const hit = optionCache.get(kind);
  if (hit && !force && Date.now() - hit.at < 5000) return Promise.resolve(hit.list);
  return net.request('options', { kind }).then((list) => {
    optionCache.set(kind, { at: Date.now(), list });
    return list;
  });
}

// A <select> (or free-text input when allowCustom) whose entries arrive asynchronously.
export function optionsField({ kind, value, onChange, allowCustom = false, emptyLabel = '', placeholder = '', unknownSuffix = 'not found' }) {
  const host = h('div', { class: 'options-field' });
  const render = (list, error) => {
    clear(host);
    if (allowCustom) {
      const id = `dl_${Math.random().toString(36).slice(2, 8)}`;
      const input = h('input', { type: 'text', value: value || '', list: id, placeholder: placeholder || 'Type or pick…', spellcheck: 'false' });
      input.addEventListener('input', () => onChange(input.value));
      host.append(input, h('datalist', { id }, (list || []).map((o) => h('option', { value: o.value }, o.label))));
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
    loadOptions(kind, { force }).then((list) => render(list, ''), (err) => render([], err.message));
  };
  start();
  return host;
}

export function multiOptionsField({ kind, value, onChange }) {
  const host = h('div', { class: 'checklist' });
  const selected = new Set(Array.isArray(value) ? value : []);
  loadOptions(kind).then((list) => {
    clear(host);
    for (const o of list) {
      const cb = h('input', { type: 'checkbox', checked: selected.has(o.value) });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(o.value); else selected.delete(o.value);
        onChange([...selected]);
      });
      host.append(h('label', { class: 'check' }, cb, o.label));
    }
    if (!list.length) host.append(h('span', { class: 'muted' }, 'Nothing found'));
  }, (err) => { clear(host); host.append(h('div', { class: 'field-error' }, err.message)); });
  host.append(h('span', { class: 'muted' }, 'Loading…'));
  return host;
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
  const id = `dl_${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { type: 'text', value: value ?? '', list: id, placeholder, spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('input', () => onChange(input.value));
  return h('div', { class: 'options-field' }, input, h('datalist', { id }, suggestions.map((s) => h('option', { value: s }))));
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
  };
  const visible = (p) => !p.showIf || p.showIf.in.includes(params[p.showIf.key]);
  function updateVisibility() {
    for (const { p, el } of rows) el.hidden = !visible(p);
  }
  for (const p of def.params) {
    if (params[p.key] === undefined && p.default !== undefined) params[p.key] = p.default;
    let control;
    if (p.type === 'select' && p.optionsFrom) {
      control = optionsField({ kind: p.optionsFrom, value: params[p.key], onChange: (v) => set(p.key, v), allowCustom: p.allowCustom, emptyLabel: p.emptyLabel, unknownSuffix: p.unknownSuffix });
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
    rows.push({ p, el });
    root.append(el);
  }
  updateVisibility();
  if (!def.params.length) root.append(h('p', { class: 'muted' }, 'This action needs no settings.'));
  return root;
}
