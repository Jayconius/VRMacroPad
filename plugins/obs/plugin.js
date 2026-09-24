// OBS Studio, over obs-websocket v5 (built into OBS 28+).
const { ObsRuntime } = require('./runtime');

module.exports = {
  id: 'obs',
  name: 'OBS Studio',
  version: '1.0.0',
  description: 'Switch scenes, record, stream, mute sources.',
  icon: '🎬',
  instructions: () => 'In OBS: Tools → WebSocket Server Settings → enable it, then enter the same port and password here.',
  // Settings → Plugins shows a generic "Save and test connection" button for any plugin that declares
  // this — it saves, then calls the named optionList and reports how many results came back.
  testOptionKind: 'obs.scenes',
  actions: require('./actions'),
  stateKeys: [
    { key: 'obs.recording', label: 'OBS is recording', group: 'OBS' },
    { key: 'obs.streaming', label: 'OBS is streaming', group: 'OBS' },
    { key: 'obs.replay', label: 'OBS replay buffer is on', group: 'OBS' },
    { key: 'obs.scene', label: 'OBS scene is…', group: 'OBS', arg: 'obs.scenes' },
    { key: 'obs.inputMuted', label: 'OBS source is muted…', group: 'OBS', arg: 'obs.inputs' },
  ],
  settingsFields: [
    { key: 'host', label: 'Address', type: 'text', default: '127.0.0.1' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 4455 },
    { key: 'password', label: 'Password', type: 'password', default: '', help: 'Stored in plain text in your config. Leave empty if OBS has no password.' },
  ],
  optionLists: {
    'obs.scenes': (ctx) => ctx.plugins.get('obs').options('obs.scenes'),
    'obs.inputs': (ctx) => ctx.plugins.get('obs').options('obs.inputs'),
  },
  matchState(key) {
    if (key.startsWith('obs.')) return { obs: true };
    return null;
  },
  createRuntime(ctx) {
    return new ObsRuntime(ctx);
  },
};
