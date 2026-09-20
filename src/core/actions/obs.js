// OBS Studio control over obs-websocket v5.
const MODE_TOGGLE = [['toggle', 'Toggle'], ['start', 'Start'], ['stop', 'Stop']];

function toggleRequest(base, mode) {
  return mode === 'start' ? `Start${base}` : mode === 'stop' ? `Stop${base}` : `Toggle${base}`;
}

const actions = [
  {
    id: 'obs.scene',
    category: 'OBS',
    label: 'Switch scene',
    description: 'Change the program scene in OBS.',
    icon: '🎬',
    needs: 'obs',
    params: [{ key: 'scene', label: 'Scene', type: 'select', optionsFrom: 'obs.scenes', allowCustom: true, required: true }],
    state: (p) => (p.scene ? `obs.scene=${p.scene}` : null),
    defaults: { label: 'Scene', icon: '🎬', color: '#4a5568', colorOn: '#2b6cb0' },
    async run(p, ctx) {
      if (!p.scene) throw new Error('Pick a scene first');
      await ctx.obs.request('SetCurrentProgramScene', { sceneName: p.scene });
    },
  },
  {
    id: 'obs.record',
    category: 'OBS',
    label: 'Recording',
    description: 'Start, stop or toggle recording.',
    icon: '⏺️',
    needs: 'obs',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: MODE_TOGGLE, default: 'toggle' }],
    state: () => 'obs.recording',
    defaults: { label: 'Record', icon: '⏺️', color: '#4a5568', colorOn: '#c53030', labelOn: 'Recording' },
    async run(p, ctx) {
      await ctx.obs.request(toggleRequest('Record', p.mode));
    },
  },
  {
    id: 'obs.stream',
    category: 'OBS',
    label: 'Streaming',
    description: 'Start, stop or toggle the live stream.',
    icon: '📡',
    needs: 'obs',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: MODE_TOGGLE, default: 'toggle' }],
    state: () => 'obs.streaming',
    defaults: { label: 'Stream', icon: '📡', color: '#4a5568', colorOn: '#c53030', labelOn: 'LIVE', confirm: 'hold' },
    async run(p, ctx) {
      await ctx.obs.request(toggleRequest('Stream', p.mode));
    },
  },
  {
    id: 'obs.replaySave',
    category: 'OBS',
    label: 'Save replay (clip)',
    description: 'Saves the last few seconds from the replay buffer. The buffer must be running in OBS.',
    icon: '📎',
    needs: 'obs',
    params: [],
    defaults: { label: 'Clip it', icon: '📎', color: '#6b46c1' },
    async run(p, ctx) {
      await ctx.obs.request('SaveReplayBuffer');
    },
  },
  {
    id: 'obs.replayBuffer',
    category: 'OBS',
    label: 'Replay buffer on/off',
    description: 'Start or stop the replay buffer.',
    icon: '🔁',
    needs: 'obs',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: MODE_TOGGLE, default: 'toggle' }],
    state: () => 'obs.replay',
    defaults: { label: 'Replay buffer', icon: '🔁', color: '#4a5568', colorOn: '#2f855a', labelOn: 'Buffer on' },
    async run(p, ctx) {
      await ctx.obs.request(toggleRequest('ReplayBuffer', p.mode));
    },
  },
  {
    id: 'obs.inputMute',
    category: 'OBS',
    label: 'Mute an OBS source',
    description: 'Mute or unmute an audio source (mic, desktop audio) inside OBS.',
    icon: '🔈',
    needs: 'obs',
    params: [
      { key: 'input', label: 'Source', type: 'select', optionsFrom: 'obs.inputs', allowCustom: true, required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: [['toggle', 'Toggle'], ['mute', 'Mute'], ['unmute', 'Unmute']], default: 'toggle' },
    ],
    state: (p) => (p.input ? `obs.inputMuted=${p.input}` : null),
    defaults: { label: 'OBS mic', icon: '🎙️', color: '#2f855a', colorOn: '#c53030', labelOn: 'Muted' },
    async run(p, ctx) {
      if (!p.input) throw new Error('Pick a source first');
      if (p.mode === 'toggle') await ctx.obs.request('ToggleInputMute', { inputName: p.input });
      else await ctx.obs.request('SetInputMute', { inputName: p.input, inputMuted: p.mode === 'mute' });
    },
  },
  {
    id: 'obs.custom',
    category: 'OBS',
    label: 'Custom OBS request (advanced)',
    description: 'Send any obs-websocket v5 request by name.',
    icon: '🧩',
    needs: 'obs',
    params: [
      { key: 'requestType', label: 'Request type', type: 'text', required: true, placeholder: 'SetCurrentSceneTransition' },
      { key: 'data', label: 'Request data (JSON)', type: 'textarea', placeholder: '{"transitionName": "Fade"}' },
    ],
    defaults: { label: 'OBS', icon: '🧩', color: '#4a5568' },
    async run(p, ctx) {
      let data = {};
      if (p.data && String(p.data).trim()) {
        try { data = JSON.parse(p.data); } catch { throw new Error('Request data is not valid JSON'); }
      }
      await ctx.obs.request(String(p.requestType), data);
    },
  },
];

module.exports = actions;
