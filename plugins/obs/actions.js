// OBS Studio control over obs-websocket v5.
const fs = require('fs');
const path = require('path');
const { expandShortcuts } = require('../../src/core/user-folders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
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
      await ctx.plugin('obs').client.request('SetCurrentProgramScene', { sceneName: p.scene });
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
      await ctx.plugin('obs').client.request(toggleRequest('Record', p.mode));
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
      await ctx.plugin('obs').client.request(toggleRequest('Stream', p.mode));
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
      await ctx.plugin('obs').client.request('SaveReplayBuffer');
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
      await ctx.plugin('obs').client.request(toggleRequest('ReplayBuffer', p.mode));
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
      if (p.mode === 'toggle') await ctx.plugin('obs').client.request('ToggleInputMute', { inputName: p.input });
      else await ctx.plugin('obs').client.request('SetInputMute', { inputName: p.input, inputMuted: p.mode === 'mute' });
    },
  },
  {
    id: 'obs.screenshot',
    category: 'OBS',
    label: 'Take a screenshot (OBS)',
    description: 'Saves a picture of what OBS is showing (the current scene, or one source) to a folder, using OBS itself. Chain it with a Discord "Send picture" step set to "The last OBS screenshot" to post it.',
    icon: '📸',
    needs: 'obs',
    params: [
      { key: 'what', label: 'Capture', type: 'select', default: 'program', options: [['program', 'The current scene (what viewers see)'], ['source', 'One source (a camera, a game capture...)']] },
      { key: 'source', label: 'Source', type: 'select', optionsFrom: 'obs.inputs', allowCustom: true, showIf: { key: 'what', in: ['source'] } },
      { key: 'folder', label: 'Save to folder', type: 'text', default: '{pictures}\\OBS Screenshots', help: '{pictures} is your Pictures folder, looked up on this PC. The folder is created if it is missing. OBS must be running on this PC.' },
      { key: 'format', label: 'Picture type', type: 'select', default: 'png', options: [['png', 'PNG (best quality)'], ['jpg', 'JPG (smaller files)']] },
      { key: 'quality', label: 'JPG quality (1-100)', type: 'number', min: 1, max: 100, default: 90, showIf: { key: 'format', in: ['jpg'] } },
    ],
    defaults: { label: 'OBS shot', icon: '📸', color: '#4a5568' },
    async run(p, ctx) {
      const obs = ctx.plugin('obs');
      let sourceName;
      if (p.what === 'source') {
        sourceName = String(p.source || '').trim();
        if (!sourceName) throw new Error('Pick a source first');
      } else {
        const cur = await obs.client.request('GetCurrentProgramScene');
        sourceName = cur && (cur.currentProgramSceneName || cur.sceneName);
        if (!sourceName) throw new Error('OBS did not say which scene is live');
      }
      const folder = path.normalize(expandShortcuts(p.folder || '{pictures}\\OBS Screenshots'));
      try { fs.mkdirSync(folder, { recursive: true }); } catch (err) { throw new Error(`Could not create the folder ${folder} (${err.code || err.message})`); }
      const format = p.format === 'jpg' ? 'jpg' : 'png';
      const now = new Date();
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      let imageFilePath = path.join(folder, `OBS_${stamp}.${format}`);
      for (let n = 2; fs.existsSync(imageFilePath); n++) imageFilePath = path.join(folder, `OBS_${stamp}_${n}.${format}`); // two in the same second
      const data = { sourceName, imageFormat: format, imageFilePath };
      if (format === 'jpg') data.imageCompressionQuality = Math.max(1, Math.min(100, Math.round(Number(p.quality) || 90)));
      await obs.client.request('SaveSourceScreenshot', data, 15000);
      // OBS writes the file itself, a moment after it answers.
      for (let i = 0; i < 25 && !fs.existsSync(imageFilePath); i++) await sleep(120);
      if (!fs.existsSync(imageFilePath)) throw new Error('OBS said it saved the screenshot, but the file is not there. Is OBS running on another PC?');
      obs.lastScreenshot = imageFilePath; // so a Discord button can send exactly this one
      ctx.toast(`Screenshot saved: ${path.basename(imageFilePath)}`, 'info');
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
      await ctx.plugin('obs').client.request(String(p.requestType), data);
    },
  },
];

module.exports = actions;
