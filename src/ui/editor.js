// Add / edit button dialogs: action picker, step list, triggers, look.
import { h, clear, clone, uid, contrastText, shade } from './util.js';
import { state, actionDef, currentPage } from './state.js';
import { openModal, confirmDialog, toast } from './modal.js';
import { saveConfig } from './commands.js';
import * as net from './net.js';
import { buildParamForm, field, textInput, selectInput, checkbox, hotkeyField, optionsField } from './forms.js';
import { INTERACTION } from './widgets-ui.js';
import { applyLook, imageUrl } from './button-look.js';

const Grid = window.Grid;
const Effects = window.Effects;

const EMOJIS = ['🎙️', '🎤', '🔇', '🔈', '🔉', '🔊', '🎧', '🎚️', '🎛️', '📻', '🎬', '📹', '🎥', '⏺️', '⏹️', '⏯️', '⏭️', '⏮️', '📡', '📎',
  '📷', '🖥️', '🔀', '⌨️', '🖱️', '🎮', '🕹️', '🥽', '🌐', '🔗', '🚀', '🔄', '🔁', '🔒', '🔓', '⚙️', '🛠️', '💬', '📢', '🔔',
  '🏠', '💡', '🕯️', '🌙', '☀️', '❄️', '🔥', '💤', '⏱️', '⏰', '🧍', '🎭', '🕺', '👋', '👍', '❤️', '⭐', '✅', '❌', '⚠️',
  '🔴', '🟢', '🔵', '🟡', '🟣', '⚫', '➕', '➖', '▶️', '⏸️'];

const SWATCHES = ['#2f855a', '#c53030', '#2b6cb0', '#6b46c1', '#b7791f', '#3b5b8f', '#4a5568', '#9b2c2c', '#0e7490', '#be185d', '#3b4a63', '#111827'];

const TRIGGER_LABELS = {
  hotkey: 'Global hotkey',
  processStart: 'When an app starts',
  processStop: 'When an app closes',
  state: 'When something changes',
  time: 'At a time of day',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function defaultParams(def) {
  const p = {};
  for (const spec of def.params) if (spec.default !== undefined) p[spec.key] = spec.default;
  return p;
}

// ---- action picker ----
// onPick(def, kind): kind is 'action', 'widget' or null for a blank button.
export function openActionPicker({ title = 'Choose an action', onPick, allowBlank = false, includeWidgets = false }) {
  const search = h('input', { type: 'search', placeholder: 'Search actions…', spellcheck: 'false' });
  const list = h('div', { class: 'picker-list' });
  let modal;
  const render = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const groups = new Map();
    const entries = [
      ...(includeWidgets ? (state.catalog.widgets || []).map((w) => ({ ...w, kind: 'widget' })) : []),
      ...state.catalog.actions.map((a) => ({ ...a, kind: 'action' })),
    ];
    const actionGroups = new Set(state.catalog.actions.map((a) => a.category));
    for (const cat of [...new Set(entries.map((e) => e.category))].sort((a, b) => Number(actionGroups.has(a)) - Number(actionGroups.has(b)))) groups.set(cat, []);
    for (const a of entries) {
      if (q && !`${a.label} ${a.description} ${a.category}`.toLowerCase().includes(q)) continue;
      groups.get(a.category).push(a);
    }
    for (const [cat, items] of [...groups]) if (!items.length) groups.delete(cat);
    if (allowBlank && !q) {
      list.append(h('div', { class: 'picker-group' }, h('button', { class: 'picker-item', onclick: () => { modal.close(); onPick(null, null); } },
        h('span', { class: 'picker-icon' }, '⬜'), h('span', null, h('strong', null, 'Blank button'), h('small', null, 'Set everything up yourself')))));
    }
    for (const [cat, items] of groups) {
      list.append(h('div', { class: 'picker-group' }, h('h3', null, cat),
        items.map((a) => h('button', { class: 'picker-item', onclick: () => { modal.close(); onPick(a, a.kind); } },
          h('span', { class: 'picker-icon' }, a.icon), h('span', null, h('strong', null, a.label), h('small', null, a.description))))));
    }
    if (!groups.size) list.append(h('p', { class: 'muted' }, 'No actions match.'));
  };
  search.addEventListener('input', render);
  modal = openModal({ title, body: [search, list], wide: true });
  render();
  search.focus();
  return modal;
}

// ---- state key picker (used by "state changes" triggers and custom state source) ----
export function stateKeyField({ value, onChange }) {
  const [base, ...rest] = (value || '').split('=');
  const arg = rest.join('=');
  const keys = state.catalog.stateKeys;
  const current = keys.find((k) => k.key === base) || keys[0];
  const host = h('div', { class: 'stack' });
  let curBase = current.key;
  let curArg = arg;
  const emit = () => onChange(curBase + (keys.find((k) => k.key === curBase).arg ? `=${curArg}` : ''));
  const draw = () => {
    clear(host);
    const def = keys.find((k) => k.key === curBase);
    const sel = h('select', null, keys.map((k) => h('option', { value: k.key, selected: k.key === curBase }, `${k.group}: ${k.label}`)));
    sel.value = curBase;
    sel.addEventListener('change', () => { curBase = sel.value; curArg = ''; draw(); emit(); });
    host.append(sel);
    if (def.arg === 'text') host.append(textInput(curArg, (v) => { curArg = v; emit(); }, { placeholder: 'Name' }));
    else if (def.arg) host.append(optionsField({ kind: def.arg, value: curArg, allowCustom: true, onChange: (v) => { curArg = v; emit(); } }));
  };
  draw();
  emit();
  return host;
}

// ---- button editor ----
// The preferred size is tried first, then progressively smaller ones.
function fitSize(page, x, y, ignoreId, preferred = { w: 2, h: 2 }) {
  const tries = [[preferred.w, preferred.h], [2, 2], [2, 1], [1, 1]];
  for (const [w, hh] of tries) if (Grid.fits(page, { x, y, w, h: hh }, ignoreId)) return { w, h: hh };
  return { w: 1, h: 1 };
}

export function startNewButton(at) {
  openActionPicker({
    title: 'Add a button: what should it do?',
    allowBlank: true,
    includeWidgets: true,
    onPick: (def, kind) => {
      const page = currentPage();
      const isWidget = kind === 'widget';
      const want = isWidget ? def.size : { w: 1, h: 1 };
      // Prefer the clicked cell, but a big widget may need a roomier spot elsewhere.
      let spot = at && Grid.fits(page, { x: at.x, y: at.y, w: want.w, h: want.h }) ? at : Grid.findFreeSpot(page, want.w, want.h);
      if (!spot) spot = at && Grid.fits(page, { x: at.x, y: at.y, w: 1, h: 1 }) ? at : Grid.findFreeSpot(page, 1, 1);
      if (!spot) { toast('This page is full. Add rows or columns in the page settings first.', 'warn'); return; }
      const size = fitSize(page, spot.x, spot.y, undefined, want);
      const d = def ? def.defaults : {};
      const draft = {
        id: uid('b'), x: spot.x, y: spot.y, ...size,
        label: isWidget ? '' : d.label || (def ? def.label : 'Button'), labelOn: d.labelOn || '', icon: isWidget ? '' : d.icon || (def ? def.icon : ''),
        color: d.color || '#3b4a63', colorOn: d.colorOn || '',
        image: '', imageOn: '', imageFit: 'cover', anim: 'none', animOn: 'none', animSpeed: 'normal',
        widget: isWidget ? { type: def.id, params: defaultParams(def) } : null,
        steps: def && !isWidget ? [{ action: def.id, params: defaultParams(def), delayMs: 0 }] : [],
        triggers: [], state: { source: isWidget ? 'none' : 'auto', key: '' }, confirm: d.confirm || 'none',
      };
      openButtonEditor(draft, true);
    },
  });
}

export function editButton(id) {
  const page = currentPage();
  const b = page.buttons.find((x) => x.id === id);
  if (b) openButtonEditor(clone(b), false);
}

function openButtonEditor(draft, isNew) {
  const page = currentPage();
  let tab = 'actions';
  const tabsEl = h('div', { class: 'tabs' });
  const content = h('div', { class: 'tab-content' });
  const errorEl = h('div', { class: 'field-error', hidden: true });

  const renderTabs = () => {
    clear(tabsEl);
    for (const [id, label] of [['actions', draft.widget ? 'Widget' : 'Actions'], ['triggers', 'Triggers'], ['look', 'Look']]) {
      tabsEl.append(h('button', { class: `tab${tab === id ? ' on' : ''}`, onclick: () => { tab = id; renderTabs(); renderContent(); } },
        label, id === 'actions' && draft.steps.length ? h('span', { class: 'count' }, draft.steps.length) : null,
        id === 'triggers' && draft.triggers.length ? h('span', { class: 'count' }, draft.triggers.length) : null));
    }
  };

  // -- actions tab --
  const stepCard = (step, i) => {
    const def = actionDef(step.action);
    const move = (dir) => { const j = i + dir; if (j < 0 || j >= draft.steps.length) return; [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; renderContent(); };
    return h('div', { class: 'step' },
      h('div', { class: 'step-head' },
        h('span', { class: 'step-num' }, i + 1),
        h('strong', null, def ? `${def.icon} ${def.label}` : `⚠️ Unknown action (${step.action})`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn small', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, '▲'),
        h('button', { class: 'icon-btn small', title: 'Move down', disabled: i === draft.steps.length - 1, onclick: () => move(1) }, '▼'),
        h('button', { class: 'icon-btn small danger', title: 'Remove step', onclick: () => { draft.steps.splice(i, 1); renderTabs(); renderContent(); } }, '🗑')),
      h('div', { class: 'step-body' },
        i > 0 || step.delayMs ? field('Wait before this step (ms)', textInput(step.delayMs || 0, (v) => { step.delayMs = Number(v) || 0; }, { type: 'number', min: 0, max: 600000 })) : null,
        def ? buildParamForm(def, step.params, () => {}) : h('p', { class: 'muted' }, 'This action is not available in this version.')));
  };

  const renderActions = (emptyText = 'No actions yet. A button does nothing until you add at least one.') => {
    const host = h('div', { class: 'stack' });
    if (!draft.steps.length) host.append(h('p', { class: 'muted' }, emptyText));
    draft.steps.forEach((s, i) => host.append(stepCard(s, i)));
    host.append(h('button', { class: 'btn-secondary', onclick: () => openActionPicker({ title: 'Add a step', onPick: (def) => {
      draft.steps.push({ action: def.id, params: defaultParams(def), delayMs: draft.steps.length ? 200 : 0 });
      renderTabs();
      renderContent();
    } }) }, '＋ Add ' + (draft.steps.length ? 'another step' : 'an action')));
    if (draft.steps.length > 1) host.append(h('p', { class: 'muted small' }, 'Steps run top to bottom when the button is pressed.'));
    return host;
  };

  // -- widget tab (mini screens) --
  const renderWidgetTab = () => {
    const wdef = (state.catalog.widgets || []).find((w) => w.id === draft.widget.type);
    const host = h('div', { class: 'stack' });
    if (!wdef) {
      host.append(h('p', { class: 'muted' }, 'This widget is not available in this version.'));
      return host;
    }
    host.append(h('div', null, h('strong', null, `${wdef.icon} ${wdef.label}`), h('p', { class: 'muted' }, wdef.description)));
    host.append(buildParamForm(wdef, draft.widget.params, () => {}));
    if (wdef.hasFinishSteps) {
      host.append(h('hr'), h('h3', null, 'When the timer finishes'), renderActions('Optional: run actions when the timer ends, for example send a Twitch chat message.'));
    }
    return host;
  };

  // -- triggers tab --
  const triggerBody = (t) => {
    if (t.type === 'hotkey') {
      return [
        hotkeyField({ value: t.accelerator, format: 'accel', placeholder: 'e.g. Ctrl+Alt+F13', onChange: (v) => { t.accelerator = v; } }),
        h('p', { class: 'field-help' }, state.app.hasHost ? 'Works anywhere in Windows, even while a game has focus. F13–F24 are ideal since nothing else uses them.' : 'Global hotkeys only work in the desktop app, not in a browser tab.'),
      ];
    }
    if (t.type === 'processStart' || t.type === 'processStop') {
      return field('App (process name)', optionsField({ kind: 'processes', value: t.process, allowCustom: true, placeholder: 'e.g. vrchat.exe', onChange: (v) => { t.process = v.toLowerCase(); } }));
    }
    if (t.type === 'state') {
      return [
        field('Watch', stateKeyField({ value: t.key, onChange: (v) => { t.key = v; } })),
        field('Run when it becomes', selectInput([['true', 'On / true'], ['false', 'Off / false']], String(t.becomes), (v) => { t.becomes = v === 'true'; })),
      ];
    }
    const time = h('input', { type: 'time', value: t.at });
    time.addEventListener('input', () => { t.at = time.value || '00:00'; });
    return [
      field('Time', time),
      h('div', { class: 'row gap wrap' }, DAY_NAMES.map((n, d) => checkbox(n, t.days.includes(d), (on) => {
        t.days = on ? [...new Set([...t.days, d])].sort() : t.days.filter((x) => x !== d);
      }))),
    ];
  };

  const renderTriggers = () => {
    const host = h('div', { class: 'stack' });
    host.append(h('p', { class: 'muted' }, 'Triggers press this button for you, without touching it. Clicking always works too.'));
    draft.triggers.forEach((t, i) => host.append(h('div', { class: 'step' },
      h('div', { class: 'step-head' }, h('strong', null, TRIGGER_LABELS[t.type]), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn small danger', title: 'Remove trigger', onclick: () => { draft.triggers.splice(i, 1); renderTabs(); renderContent(); } }, '🗑')),
      h('div', { class: 'step-body' }, triggerBody(t)))));
    const adder = h('select', null, h('option', { value: '' }, '＋ Add a trigger…'),
      Object.entries(TRIGGER_LABELS).map(([v, l]) => h('option', { value: v }, l)));
    adder.addEventListener('change', () => {
      const type = adder.value;
      if (!type) return;
      const base = { hotkey: { accelerator: '' }, processStart: { process: '' }, processStop: { process: '' }, state: { key: 'audio.in.muted', becomes: true }, time: { at: '22:00', days: [0, 1, 2, 3, 4, 5, 6] } }[type];
      draft.triggers.push({ type, ...base });
      renderTabs();
      renderContent();
    });
    host.append(adder);
    host.append(h('p', { class: 'muted small' }, 'SteamVR triggers (low battery, charging, headset put on, a tracker lost or dropped) are under "A state changes". Controller buttons and bindings are not part of this version.'));
    return host;
  };

  // -- look tab --
  const previewBtn = (active) => {
    const bg = active ? (draft.colorOn || shade(draft.color, 0.28)) : draft.color;
    const el = h('div', { class: `btn preview${active ? ' active' : ''}`, style: { '--bg': bg, '--fg': contrastText(bg), '--icon-size': '34px', '--label-size': '14px' } },
      draft.icon ? h('div', { class: 'btn-icon' }, draft.icon) : null,
      h('div', { class: 'btn-label' }, (active && draft.labelOn) || draft.label || ''));
    applyLook(el, draft, active);
    return el;
  };

  // A picture (or animated GIF) for one state: choose a file, see it, take it away again.
  const pictureField = (label, key, help) => {
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('That picture is over 8 MB. Pick a smaller one.', 'warn'); return; }
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = () => reject(new Error('Could not read that file'));
          r.readAsDataURL(f);
        });
        draft[key] = await net.request('image.add', { data });
        renderContent();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return field(label, h('div', { class: 'stack tight' },
      h('div', { class: 'row gap' },
        draft[key] ? h('img', { class: 'pic-thumb', src: imageUrl(draft[key]), alt: '' }) : h('span', { class: 'muted small' }, 'None'),
        h('button', { type: 'button', class: 'btn-secondary small', onclick: () => file.click() }, draft[key] ? 'Change…' : 'Choose a picture…'),
        draft[key] ? h('button', { type: 'button', class: 'btn-secondary small', onclick: () => { draft[key] = ''; renderContent(); } }, 'Remove') : null,
        file)), help ? { help } : {});
  };

  const effectField = (label, key) => {
    const sel = selectInput(Effects.EFFECTS.map((e) => [e.id, e.label]), draft[key] || 'none', (v) => { draft[key] = v; renderContent(); });
    const cur = Effects.EFFECTS.find((e) => e.id === (draft[key] || 'none'));
    return field(label, sel, cur && cur.help ? { help: cur.help } : {});
  };

  const colorField = (label, key, optional) => {
    const input = h('input', { type: 'color', value: draft[key] || '#3b4a63' });
    const clearBtn = optional ? h('button', { type: 'button', class: 'btn-secondary small', onclick: () => { draft[key] = ''; renderContent(); } }, 'Auto') : null;
    input.addEventListener('input', () => { draft[key] = input.value; updatePreview(); });
    const sw = h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', style: { '--c': c }, title: c, onclick: () => { draft[key] = c; renderContent(); } })));
    return field(label, h('div', { class: 'stack tight' }, h('div', { class: 'row gap' }, input, clearBtn, optional && !draft[key] ? h('span', { class: 'muted small' }, 'Automatic (lighter shade)') : null), sw));
  };

  let previewHost;
  const updatePreview = () => {
    if (!previewHost) return;
    clear(previewHost);
    previewHost.append(h('div', null, h('small', { class: 'muted' }, 'Normal'), previewBtn(false)), h('div', null, h('small', { class: 'muted' }, 'Active'), previewBtn(true)));
  };

  // Widgets draw themselves, so the look options are just a caption, a background and a size.
  const renderWidgetLook = () => {
    const gridSize = h('div', { class: 'row gap' },
      field('Width', textInput(draft.w, (v) => { draft.w = Math.max(1, Math.min(page.cols, Number(v) || 1)); }, { type: 'number', min: 1, max: page.cols })),
      field('Height', textInput(draft.h, (v) => { draft.h = Math.max(1, Math.min(page.rows, Number(v) || 1)); }, { type: 'number', min: 1, max: page.rows })));
    return h('div', { class: 'stack' },
      field('Caption (optional)', textInput(draft.label, (v) => { draft.label = v; }, { placeholder: 'Small title shown at the top' })),
      colorField('Background color', 'color', false),
      h('p', { class: 'muted small' }, 'Drag the corner handle on the grid to resize too. Widgets scale their text to fit. Or set the size here:'),
      gridSize,
      INTERACTION[draft.widget.type] === 'tap'
        ? field('Protect against accidental presses', selectInput([['none', 'No, one tap does it'], ['hold', 'Hold for a moment'], ['double', 'Tap twice']], draft.confirm, (v) => { draft.confirm = v; }))
        : null);
  };

  const renderLook = () => {
    if (draft.widget) return renderWidgetLook();
    previewHost = h('div', { class: 'preview-row' });
    updatePreview();
    const iconInput = textInput(draft.icon, (v) => { draft.icon = v; updatePreview(); }, { placeholder: 'Emoji or short text' });
    const picker = h('div', { class: 'emoji-grid' }, EMOJIS.map((e) => h('button', { type: 'button', class: 'emoji', onclick: () => { draft.icon = e; iconInput.value = e; updatePreview(); } }, e)));
    const stateSelect = selectInput([
      ['auto', 'Follow the first action (recommended)'], ['none', 'Never change color'], ['toggle', "Flip each time it's pressed"], ['key', 'Follow something specific…'],
    ], draft.state.source, (v) => { draft.state.source = v; renderContent(); });
    const stateHelp = { auto: 'Actions like mic mute, OBS record or scene switch report their real state, so the button color always matches.', none: 'The button always shows its normal color.', toggle: 'For actions that cannot report state. The button remembers on/off itself (resets when the app restarts).', key: 'Pick any state to follow, e.g. "OBS is streaming".' }[draft.state.source];
    const gridSize = h('div', { class: 'row gap' },
      field('Width', textInput(draft.w, (v) => { draft.w = Math.max(1, Math.min(page.cols, Number(v) || 1)); }, { type: 'number', min: 1, max: page.cols })),
      field('Height', textInput(draft.h, (v) => { draft.h = Math.max(1, Math.min(page.rows, Number(v) || 1)); }, { type: 'number', min: 1, max: page.rows })));
    return h('div', { class: 'stack' },
      previewHost,
      h('div', { class: 'row gap' },
        field('Label', textInput(draft.label, (v) => { draft.label = v; updatePreview(); }, { placeholder: 'Button text' })),
        field('Label when active', textInput(draft.labelOn, (v) => { draft.labelOn = v; updatePreview(); }, { placeholder: 'optional, e.g. Muted' }))),
      field('Icon', h('div', { class: 'stack tight' }, iconInput, picker)),
      h('div', { class: 'row gap top' }, colorField('Color', 'color', false), colorField('Color when active', 'colorOn', true)),
      h('div', { class: 'row gap top' },
        pictureField('Picture (PNG, JPEG, GIF, WebP)', 'image'),
        pictureField('Picture when active', 'imageOn', 'Leave empty to keep the normal picture.')),
      draft.image || draft.imageOn ? field('How the picture fits', selectInput([['cover', 'Fill the button (crops the edges)'], ['contain', 'Show the whole picture']], draft.imageFit, (v) => { draft.imageFit = v; updatePreview(); })) : null,
      h('div', { class: 'row gap top' }, effectField('Animation when active', 'animOn'), effectField('Animation when not active', 'anim')),
      draft.anim !== 'none' || draft.animOn !== 'none' ? field('Animation speed', selectInput(Effects.SPEEDS, draft.animSpeed, (v) => { draft.animSpeed = v; updatePreview(); })) : null,
      h('p', { class: 'muted small' }, 'Drag the corner handle on the grid to resize too. Or set the size here:'),
      gridSize,
      field('Color follows', stateSelect, { help: stateHelp }),
      draft.state.source === 'key' ? field('State to follow', stateKeyField({ value: draft.state.key, onChange: (v) => { draft.state.key = v; } })) : null,
      field('Protect against accidental presses', selectInput([['none', 'No, one press runs it'], ['hold', 'Hold for a moment'], ['double', 'Tap twice']], draft.confirm, (v) => { draft.confirm = v; }),
        { help: 'Good for things like stopping a stream or quitting SteamVR.' }));
  };

  function renderContent() {
    clear(content);
    content.append(tab === 'actions' ? (draft.widget ? renderWidgetTab() : renderActions()) : tab === 'triggers' ? renderTriggers() : renderLook());
  }

  // -- footer actions --
  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };

  async function save() {
    showError('');
    const cleaned = clone(draft);
    cleaned.triggers = cleaned.triggers.filter((t) => !(t.type === 'hotkey' && !t.accelerator) && !((t.type === 'processStart' || t.type === 'processStop') && !t.process));
    let rect = { x: cleaned.x, y: cleaned.y, w: cleaned.w, h: cleaned.h };
    if (!Grid.fits(page, rect, cleaned.id)) {
      const spot = Grid.findFreeSpot(page, cleaned.w, cleaned.h, cleaned.id);
      if (!spot) { showError(`There is no room for a ${cleaned.w}×${cleaned.h} button on this page. Make it smaller or add rows/columns.`); return; }
      rect = { ...rect, ...spot };
      cleaned.x = spot.x;
      cleaned.y = spot.y;
    }
    const ok = await saveConfig((cfg) => {
      const pg = cfg.pages.find((p) => p.id === page.id);
      const idx = pg.buttons.findIndex((b) => b.id === cleaned.id);
      if (idx >= 0) pg.buttons[idx] = cleaned; else pg.buttons.push(cleaned);
    });
    if (ok) modal.close();
  }

  async function remove() {
    if (!await confirmDialog({ title: 'Delete this button?', message: `"${draft.label || 'Button'}" and its actions will be removed.`, confirmLabel: 'Delete', danger: true })) return;
    if (await saveConfig((cfg) => { const pg = cfg.pages.find((p) => p.id === page.id); pg.buttons = pg.buttons.filter((b) => b.id !== draft.id); })) modal.close();
  }

  async function duplicate() {
    const spot = Grid.findFreeSpot(page, draft.w, draft.h);
    if (!spot) { showError('No free space on this page for a copy.'); return; }
    const copy = { ...clone(draft), id: uid('b'), x: spot.x, y: spot.y, label: draft.label ? `${draft.label} copy` : '' };
    if (await saveConfig((cfg) => cfg.pages.find((p) => p.id === page.id).buttons.push(copy))) { toast('Duplicated'); modal.close(); }
  }

  async function test() {
    showError('');
    if (!draft.steps.length) { showError('Add an action first.'); return; }
    try {
      await net.request('test', { steps: draft.steps });
      toast('Test ran.', 'info');
    } catch (err) { showError(`Test failed: ${err.message}`); }
  }

  const footer = [
    isNew ? null : h('button', { class: 'btn-danger', onclick: remove }, 'Delete'),
    isNew ? null : h('button', { class: 'btn-secondary', onclick: duplicate }, 'Duplicate'),
    h('span', { class: 'spacer' }),
    draft.widget && !(state.catalog.widgets || []).some((w) => w.id === draft.widget.type && w.hasFinishSteps) ? null
      : h('button', { class: 'btn-secondary', onclick: test, title: 'Runs the actions right now, without saving' }, '▶ Test'),
    h('button', { class: 'btn-secondary', onclick: () => modal.close() }, 'Cancel'),
    h('button', { class: 'btn-primary', onclick: save }, isNew ? 'Add button' : 'Save'),
  ];

  const modal = openModal({ title: isNew ? 'New button' : 'Edit button', wide: true, body: [tabsEl, content, errorEl], footer });
  renderTabs();
  renderContent();
}
