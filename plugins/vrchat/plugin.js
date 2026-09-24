// VRChat, over its own OSC support (Action Menu -> Options -> OSC -> Enabled). Also handles the generic
// "send any OSC message" action, since it needs the same host/port settings as everything else here.
const { VrchatRuntime } = require('./runtime');

module.exports = {
  id: 'vrchat',
  name: 'VRChat',
  version: '1.0.0',
  description: 'Mic mute, game controls, chatbox, avatar parameters, over OSC.',
  icon: '👾',
  instructions: () => 'In VRChat: Action Menu → Options → OSC → Enabled. The default ports rarely need changing.',
  // OSC is a shared core transport (settings.osc), not this plugin's own settings — the generic "send any
  // OSC message" action needs the same host/port whether or not a button ever touches VRChat itself. These
  // just tell Settings → Plugins which core fields belong in this card; see docs/PLUGIN-GUIDE.md.
  coreFields: [
    { path: 'osc.sendPort', label: 'Send to port', type: 'number', min: 1, max: 65535, default: 9000 },
    { path: 'osc.listenPort', label: 'Listen on port', type: 'number', min: 1, max: 65535, default: 9001 },
    { path: 'osc.listen', label: 'Listen for VRChat state (needed for the mic-mute color)', type: 'boolean', default: true },
  ],
  actions: require('./actions'),
  stateKeys: [
    { key: 'vrc.MuteSelf', label: 'VRChat mic is muted', group: 'VRChat' },
    { key: 'vrc.avatar', label: 'You are wearing avatar…', group: 'VRChat', arg: 'text' },
    { key: 'vrc.param', label: 'VRChat avatar parameter is on…', group: 'VRChat', arg: 'text' },
    { key: 'vrc.VRMode', label: 'You are playing VRChat in VR', group: 'VRChat' },
    { key: 'vrc.AFK', label: 'You are AFK in VRChat', group: 'VRChat' },
    { key: 'vrc.Seated', label: 'You are seated in VRChat', group: 'VRChat' },
    { key: 'vrc.Earmuffs', label: 'VRChat earmuffs are on', group: 'VRChat' },
    { key: 'vrc.InStation', label: 'You are in a VRChat station (chair)', group: 'VRChat' },
  ],
  matchState(key) {
    if (key.startsWith('vrc.')) {
      if (key.startsWith('vrc.param=')) return { vrc: true, vrcParams: [key.slice('vrc.param='.length)] };
      return { vrc: true };
    }
    return null;
  },
  createRuntime(ctx) {
    return new VrchatRuntime(ctx);
  },
};
