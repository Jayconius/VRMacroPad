// Windows audio: mute, volume, default-device switching, per-app volume.
const MODE_TOGGLE = [['toggle', 'Toggle'], ['mute', 'Mute'], ['unmute', 'Unmute']];
const FLOW = { output: 'render', input: 'capture' };

function muteArg(mode) {
  return mode === 'mute' ? true : mode === 'unmute' ? false : null;
}

const actions = [
  {
    id: 'audio.micMute',
    category: 'Audio',
    label: 'Microphone mute',
    description: 'Mute, unmute or toggle a microphone at the Windows level.',
    icon: '🎙️',
    needs: 'audio',
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: MODE_TOGGLE, default: 'toggle' },
      { key: 'device', label: 'Microphone', type: 'select', optionsFrom: 'audio.capture', default: '', emptyLabel: 'Default microphone' },
    ],
    state: (p) => (p.device ? null : 'audio.in.muted'),
    defaults: { label: 'Mic', icon: '🎙️', color: '#2f855a', colorOn: '#c53030', labelOn: 'Muted' },
    async run(p, ctx) {
      await ctx.helper.call('audio.setMute', { flow: 'capture', device: p.device || null, muted: muteArg(p.mode) });
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.outputMute',
    category: 'Audio',
    label: 'Speaker / headset mute',
    description: 'Mute, unmute or toggle the sound output.',
    icon: '🔇',
    needs: 'audio',
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: MODE_TOGGLE, default: 'toggle' },
      { key: 'device', label: 'Output device', type: 'select', optionsFrom: 'audio.render', default: '', emptyLabel: 'Default output' },
    ],
    state: (p) => (p.device ? null : 'audio.out.muted'),
    defaults: { label: 'Sound', icon: '🔊', color: '#2b6cb0', colorOn: '#c53030', labelOn: 'Muted' },
    async run(p, ctx) {
      await ctx.helper.call('audio.setMute', { flow: 'render', device: p.device || null, muted: muteArg(p.mode) });
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.setDefaultOutput',
    category: 'Audio',
    label: 'Switch default output device',
    description: 'Make one output device the Windows default (headset, speakers, ...).',
    icon: '🎧',
    needs: 'audio',
    params: [{ key: 'device', label: 'Output device', type: 'select', optionsFrom: 'audio.render', required: true }],
    state: (p) => (p.device ? `audio.out.default=${p.device}` : null),
    defaults: { label: 'Headset', icon: '🎧', color: '#4a5568', colorOn: '#2b6cb0' },
    async run(p, ctx) {
      if (!p.device) throw new Error('Pick an output device first');
      await ctx.helper.call('audio.setDefault', { flow: 'render', device: p.device });
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.setDefaultInput',
    category: 'Audio',
    label: 'Switch default microphone',
    description: 'Make one microphone the Windows default.',
    icon: '🎤',
    needs: 'audio',
    params: [{ key: 'device', label: 'Microphone', type: 'select', optionsFrom: 'audio.capture', required: true }],
    state: (p) => (p.device ? `audio.in.default=${p.device}` : null),
    defaults: { label: 'Mic device', icon: '🎤', color: '#4a5568', colorOn: '#2b6cb0' },
    async run(p, ctx) {
      if (!p.device) throw new Error('Pick a microphone first');
      await ctx.helper.call('audio.setDefault', { flow: 'capture', device: p.device });
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.cycleOutput',
    category: 'Audio',
    label: 'Cycle output devices',
    description: 'Each press switches to the next device in your list (e.g. headset -> speakers -> headset).',
    icon: '🔁',
    needs: 'audio',
    params: [{ key: 'devices', label: 'Devices to cycle through', type: 'multiselect', optionsFrom: 'audio.render', required: true }],
    defaults: { label: 'Next output', icon: '🔁', color: '#4a5568' },
    async run(p, ctx) {
      const list = Array.isArray(p.devices) ? p.devices : [];
      if (list.length < 2) throw new Error('Pick at least two devices to cycle through');
      const snap = await ctx.helper.call('audio.snapshot');
      const cur = snap.render && snap.render.id;
      const next = list[(list.indexOf(cur) + 1) % list.length];
      await ctx.helper.call('audio.setDefault', { flow: 'render', device: next });
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.volume',
    category: 'Audio',
    label: 'Master volume',
    description: 'Set, raise or lower the volume of an output or input device.',
    icon: '🔊',
    needs: 'audio',
    params: [
      { key: 'target', label: 'Device type', type: 'select', options: [['output', 'Output (speakers / headset)'], ['input', 'Input (microphone)']], default: 'output' },
      { key: 'mode', label: 'Action', type: 'select', options: [['up', 'Raise by'], ['down', 'Lower by'], ['set', 'Set to']], default: 'up' },
      { key: 'amount', label: 'Amount (%)', type: 'number', min: 0, max: 100, default: 5 },
    ],
    defaults: { label: 'Volume', icon: '🔊', color: '#4a5568' },
    async run(p, ctx) {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount)) throw new Error('Amount must be a number');
      const args = { flow: FLOW[p.target] || 'render', device: null };
      if (p.mode === 'set') args.volume = amount;
      else args.delta = p.mode === 'down' ? -amount : amount;
      await ctx.helper.call('audio.setVolume', args);
      ctx.refreshAudio();
    },
  },
  {
    id: 'audio.appVolume',
    category: 'Audio',
    label: 'Per-app volume',
    description: 'Change the volume of one app (game, Discord, music) without touching the rest.',
    icon: '🎚️',
    needs: 'audio',
    params: [
      { key: 'process', label: 'App', type: 'select', optionsFrom: 'audio.sessions', allowCustom: true, required: true, help: 'The app must be running and have played sound at least once.' },
      { key: 'mode', label: 'Action', type: 'select', options: [['up', 'Raise by'], ['down', 'Lower by'], ['set', 'Set to'], ['toggleMute', 'Toggle mute'], ['mute', 'Mute'], ['unmute', 'Unmute']], default: 'down' },
      { key: 'amount', label: 'Amount (%)', type: 'number', min: 0, max: 100, default: 10, showIf: { key: 'mode', in: ['up', 'down', 'set'] } },
    ],
    defaults: { label: 'App volume', icon: '🎚️', color: '#6b46c1' },
    async run(p, ctx) {
      if (!p.process) throw new Error('Pick an app first');
      const amount = Number(p.amount);
      const args = { process: p.process };
      if (p.mode === 'set') args.volume = amount;
      else if (p.mode === 'up') args.delta = amount;
      else if (p.mode === 'down') args.delta = -amount;
      else if (p.mode === 'toggleMute') args.toggleMute = true;
      else args.muted = p.mode === 'mute';
      await ctx.helper.call('audio.setSession', args);
    },
  },
];

module.exports = actions;
