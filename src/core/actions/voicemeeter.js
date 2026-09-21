// Voicemeeter (Standard, Banana, Potato): mute / solo / route strips and buses, gain and fades, macro buttons, the recorder,
// engine commands, choosing devices, and any command in Voicemeeter's own scripting language.
// Everything goes through VB-Audio's Remote API (needs Voicemeeter installed and running). Numbers shown here start at 1 like
// Voicemeeter's own labels; the API counts from 0.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const MODES = [['toggle', 'Toggle'], ['on', 'On'], ['off', 'Off']];
const STRIP_OPTIONS = [
  ['Mute', 'Mute'], ['Solo', 'Solo'], ['Mono', 'Mono'], ['MC', 'Mute center'],
  ['A1', 'Send to A1'], ['A2', 'Send to A2'], ['A3', 'Send to A3'], ['A4', 'Send to A4'], ['A5', 'Send to A5'],
  ['B1', 'Send to B1'], ['B2', 'Send to B2'], ['B3', 'Send to B3'], ['EQ.on', 'EQ on'],
];
const BUS_OPTIONS = [['Mute', 'Mute'], ['Mono', 'Mono'], ['EQ.on', 'EQ on'], ['Sel', 'SEL (monitor select)']];
const RECORDER_OPTIONS = [['play', 'Play'], ['stop', 'Stop'], ['pause', 'Pause'], ['record', 'Record'], ['replay', 'Play from the start'], ['ff', 'Fast forward'], ['rew', 'Rewind']];
const MOMENTARY = new Set(['play', 'stop', 'replay', 'ff', 'rew']);
const TARGETS = [['strip', 'Input strip'], ['bus', 'Output bus']];

const index = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 8) throw new Error('The strip or bus number is 1 to 8');
  return n - 1;
};

// The Voicemeeter parameter a toggle button controls, e.g. "Strip[0].Mute".
function toggleName(p) {
  if (p.target === 'recorder') {
    if (!RECORDER_OPTIONS.some(([v]) => v === p.recorderOption)) throw new Error('Pick a recorder button');
    return `recorder.${p.recorderOption}`;
  }
  const bus = p.target === 'bus';
  const opt = bus ? p.busOption : p.stripOption;
  if (!(bus ? BUS_OPTIONS : STRIP_OPTIONS).some(([v]) => v === opt)) throw new Error('Pick what to switch');
  return `${bus ? 'Bus' : 'Strip'}[${index(p.index)}].${opt}`;
}

const nameOrNull = (fn) => { try { return fn(); } catch { return null; } };

const actions = [
  {
    id: 'vm.toggle',
    category: 'Voicemeeter',
    label: 'Switch on / off (mute, solo, routing...)',
    description: 'Mute, solo, mono, send to A1-B3, EQ on a strip or bus, or a recorder button. The button follows the real state.',
    icon: '🎚️',
    needs: (p) => ({ vm: true, vmParams: [nameOrNull(() => toggleName(p))].filter(Boolean) }),
    params: [
      { key: 'target', label: 'What', type: 'select', options: [...TARGETS, ['recorder', 'Recorder (cassette)']], default: 'strip' },
      { key: 'index', label: 'Number (1 = the first one)', type: 'number', min: 1, max: 8, default: 1, showIf: { key: 'target', in: ['strip', 'bus'] } },
      { key: 'stripOption', label: 'Switch', type: 'select', options: STRIP_OPTIONS, default: 'Mute', showIf: { key: 'target', in: ['strip'] } },
      { key: 'busOption', label: 'Switch', type: 'select', options: BUS_OPTIONS, default: 'Mute', showIf: { key: 'target', in: ['bus'] } },
      { key: 'recorderOption', label: 'Button', type: 'select', options: RECORDER_OPTIONS, default: 'play', showIf: { key: 'target', in: ['recorder'] } },
      { key: 'mode', label: 'Mode', type: 'select', options: MODES, default: 'toggle', showIf: { key: 'target', in: ['strip', 'bus', 'recorder'] } },
    ],
    state: (p) => { const n = nameOrNull(() => toggleName(p)); return n ? `vm.param=${n}` : null; },
    defaults: { label: 'VM', icon: '🎚️', color: '#2f855a', colorOn: '#c53030', labelOn: 'On' },
    async run(p, ctx) {
      const name = toggleName(p);
      const opt = p.target === 'recorder' ? p.recorderOption : '';
      let value;
      if (MOMENTARY.has(opt)) value = 1; // these are presses, not switches
      else if (p.mode === 'on') value = 1;
      else if (p.mode === 'off') value = 0;
      else value = Number(await ctx.vm('get', { name })) ? 0 : 1;
      await ctx.vm('set', { name, value });
    },
  },
  {
    id: 'vm.gain',
    category: 'Voicemeeter',
    label: 'Volume (gain) of a strip or bus',
    description: 'Set the gain in dB (-60 to +12), raise or lower it, fade to a level over time, or reset it to 0 dB.',
    icon: '🔊',
    needs: 'vm',
    params: [
      { key: 'target', label: 'What', type: 'select', options: TARGETS, default: 'strip' },
      { key: 'index', label: 'Number (1 = the first one)', type: 'number', min: 1, max: 8, default: 1 },
      { key: 'mode', label: 'Action', type: 'select', options: [['up', 'Raise by'], ['down', 'Lower by'], ['set', 'Set to'], ['fade', 'Fade to'], ['reset', 'Back to 0 dB']], default: 'up' },
      { key: 'db', label: 'Amount (dB)', type: 'number', min: -60, max: 12, default: 3, showIf: { key: 'mode', in: ['up', 'down', 'set', 'fade'] } },
      { key: 'ms', label: 'Fade time (ms)', type: 'number', min: 0, max: 120000, default: 1000, showIf: { key: 'mode', in: ['fade'] } },
    ],
    defaults: { label: 'Vol', icon: '🔊', color: '#2b6cb0' },
    async run(p, ctx) {
      const base = `${p.target === 'bus' ? 'Bus' : 'Strip'}[${index(p.index)}]`;
      const db = Number(p.db);
      if (p.mode === 'reset') await ctx.vm('set', { name: `${base}.Gain`, value: 0 });
      else if (p.mode === 'set') await ctx.vm('set', { name: `${base}.Gain`, value: clamp(db, -60, 12) });
      else if (p.mode === 'fade') await ctx.vm('script', { text: `${base}.FadeTo=(${clamp(db, -60, 12)},${clamp(Math.round(Number(p.ms) || 0), 0, 120000)});` });
      else {
        const step = clamp(Math.abs(db) || 3, 0, 72);
        await ctx.vm('script', { text: `${base}.Gain ${p.mode === 'down' ? '-=' : '+='}${step};` });
      }
    },
  },
  {
    id: 'vm.macro',
    category: 'Voicemeeter',
    label: 'Macro button',
    description: 'Presses a Voicemeeter Macro Button (0 to 79). Create the button in Voicemeeter first; its number is shown in the Macro Buttons window.',
    icon: '🎛️',
    needs: (p) => ({ vm: true, vmMacros: Number.isInteger(Number(p.button)) ? [Number(p.button)] : [] }),
    params: [
      { key: 'button', label: 'Button number (0-79)', type: 'number', min: 0, max: 79, default: 0 },
      { key: 'mode', label: 'Mode', type: 'select', options: MODES, default: 'toggle' },
    ],
    state: (p) => (Number.isInteger(Number(p.button)) ? `vm.macro=${Number(p.button)}` : null),
    defaults: { label: 'Macro', icon: '🎛️', color: '#4a5568', colorOn: '#2f855a', labelOn: 'On' },
    async run(p, ctx) {
      const b = Math.round(Number(p.button));
      if (!Number.isInteger(b) || b < 0 || b > 79) throw new Error('The button number is 0 to 79');
      let on = p.mode === 'on';
      if (p.mode === 'toggle') on = !(await ctx.vm('macro', { button: b }));
      await ctx.vm('script', { text: `Command.Button[${b}].State=${on ? 1 : 0};` });
    },
  },
  {
    id: 'vm.command',
    category: 'Voicemeeter',
    label: 'Voicemeeter command',
    description: 'Restart the audio engine, show the window, lock it, eject the cassette, recall a preset, or save / load a configuration file.',
    icon: '🛠️',
    needs: 'vm',
    params: [
      { key: 'command', label: 'Command', type: 'select', default: 'Restart', options: [['Restart', 'Restart the audio engine'], ['Show', 'Show the Voicemeeter window'], ['Eject', 'Eject the cassette'], ['LockOn', 'Lock the window'], ['LockOff', 'Unlock the window'], ['Preset', 'Recall a preset (scene)'], ['Save', 'Save the configuration to a file'], ['Load', 'Load a configuration file']] },
      { key: 'preset', label: 'Preset number (1 = the first)', type: 'number', min: 1, max: 32, default: 1, showIf: { key: 'command', in: ['Preset'] } },
      { key: 'file', label: 'File (.xml)', type: 'text', placeholder: 'C:\\Users\\me\\Documents\\stream.xml', showIf: { key: 'command', in: ['Save', 'Load'] } },
    ],
    defaults: { label: 'VM', icon: '🛠️', color: '#4a5568' },
    async run(p, ctx) {
      switch (p.command) {
        case 'Restart': case 'Show': case 'Eject': return ctx.vm('set', { name: `Command.${p.command}`, value: 1 });
        case 'LockOn': return ctx.vm('set', { name: 'Command.Lock', value: 1 });
        case 'LockOff': return ctx.vm('set', { name: 'Command.Lock', value: 0 });
        case 'Preset': return ctx.vm('set', { name: `Command.Preset[${clamp(Math.round(Number(p.preset) || 1), 1, 32) - 1}].Recall`, value: 1 });
        case 'Save': case 'Load': {
          if (!/\.xml$/i.test(p.file || '')) throw new Error('Choose a file that ends in .xml');
          return ctx.vm('setString', { name: `Command.${p.command}`, value: p.file });
        }
        default: throw new Error('Pick a command');
      }
    },
  },
  {
    id: 'vm.reset',
    category: 'Voicemeeter',
    label: 'Reset Voicemeeter (all settings)',
    description: 'Puts every Voicemeeter setting back to its default. Hold the button to confirm.',
    icon: '♻️',
    needs: 'vm',
    params: [],
    defaults: { label: 'VM reset', icon: '♻️', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      await ctx.vm('set', { name: 'Command.Reset', value: 1 });
    },
  },
  {
    id: 'vm.start',
    category: 'Voicemeeter',
    label: 'Start Voicemeeter',
    description: 'Starts Voicemeeter (Standard, Banana or Potato) if it is not running.',
    icon: '▶️',
    needs: 'vm',
    params: [{ key: 'edition', label: 'Edition', type: 'select', options: [['1', 'Voicemeeter'], ['2', 'Voicemeeter Banana'], ['3', 'Voicemeeter Potato']], default: '2' }],
    state: () => 'vm.connected',
    defaults: { label: 'Voicemeeter', icon: '▶️', color: '#4a5568', colorOn: '#2f855a', labelOn: 'Running' },
    async run(p, ctx) {
      const e = Math.round(Number(p.edition));
      if (![1, 2, 3].includes(e)) throw new Error('Pick an edition');
      await ctx.vm('run', { type: e + 3 }); // 4-6 are the 64-bit programs
    },
  },
  {
    id: 'vm.device',
    category: 'Voicemeeter',
    label: 'Choose the audio device of a strip or bus',
    description: 'Points a hardware input strip or a hardware output bus (A1-A5) at a device, for example A1 at your headset. Leave the device empty to unselect it.',
    icon: '🎧',
    needs: 'vm',
    params: [
      { key: 'target', label: 'What', type: 'select', options: [['bus', 'Hardware output (A1, A2...)'], ['strip', 'Hardware input strip']], default: 'bus' },
      { key: 'index', label: 'Number (1 = A1 / the first strip)', type: 'number', min: 1, max: 5, default: 1 },
      { key: 'driver', label: 'Driver', type: 'select', options: [['wdm', 'WDM (usual choice)'], ['mme', 'MME'], ['ks', 'KS'], ['asio', 'ASIO']], default: 'wdm' },
      { key: 'device', label: 'Device', type: 'select', optionsFrom: 'vm.devices', allowCustom: true, default: '', emptyLabel: 'None (unselect)', help: 'Pick from the list, or type the device name exactly as Voicemeeter shows it.' },
    ],
    defaults: { label: 'Output', icon: '🎧', color: '#6b46c1' },
    async run(p, ctx) {
      const base = `${p.target === 'strip' ? 'Strip' : 'Bus'}[${index(p.index)}].device`;
      if (!['wdm', 'mme', 'ks', 'asio'].includes(p.driver)) throw new Error('Pick a driver');
      await ctx.vm('setString', { name: `${base}.${p.driver}`, value: p.device || '' });
    },
  },
  {
    id: 'vm.appVolume',
    category: 'Voicemeeter',
    label: 'Volume or mute of one app (Potato)',
    description: 'Changes one app\'s volume or mute inside a virtual input strip. Voicemeeter Potato only; the app must be playing.',
    icon: '🎮',
    needs: 'vm',
    params: [
      { key: 'index', label: 'Strip number (1 = the first)', type: 'number', min: 1, max: 8, default: 6 },
      { key: 'app', label: 'App name (the start of it is enough)', type: 'text', required: true, placeholder: 'Spotify' },
      { key: 'what', label: 'What', type: 'select', options: [['gain', 'Volume'], ['mute', 'Mute'], ['unmute', 'Unmute']], default: 'gain' },
      { key: 'volume', label: 'Volume (percent)', type: 'number', min: 0, max: 100, default: 50, showIf: { key: 'what', in: ['gain'] } },
    ],
    defaults: { label: 'App', icon: '🎮', color: '#2b6cb0' },
    async run(p, ctx) {
      const app = String(p.app || '').trim();
      if (!app || /["();]/.test(app)) throw new Error('Enter the app name without quotes or brackets');
      const strip = `Strip[${index(p.index)}]`;
      if (p.what === 'gain') await ctx.vm('script', { text: `${strip}.AppGain=("${app}",${clamp(Number(p.volume), 0, 100) / 100});` });
      else await ctx.vm('script', { text: `${strip}.AppMute=("${app}",${p.what === 'mute' ? 1 : 0});` });
    },
  },
  {
    id: 'vm.script',
    category: 'Voicemeeter',
    label: 'Custom command (Voicemeeter scripting)',
    description: 'Sends any command in Voicemeeter\'s own language, one or several separated by ; or new lines. Example: Strip[0].Mute=1; Bus[1].Gain=-10;',
    icon: '📜',
    needs: 'vm',
    params: [{ key: 'text', label: 'Commands', type: 'textarea', required: true, placeholder: 'Strip[0].Mute=1;\nBus[0].Gain=-6;' }],
    defaults: { label: 'Script', icon: '📜', color: '#4a5568' },
    async run(p, ctx) {
      if (!String(p.text || '').trim()) throw new Error('Type the commands to send');
      await ctx.vm('script', { text: String(p.text).slice(0, 4000) });
    },
  },
];

module.exports = actions;
