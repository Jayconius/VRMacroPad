// Voicemeeter (Standard, Banana, Potato), through VB-Audio's official Remote API. Installed and running is
// all it needs; the plugin finds the DLL by itself.
const { VoicemeeterRuntime } = require('./runtime');

module.exports = {
  id: 'voicemeeter',
  name: 'Voicemeeter',
  version: '1.0.0',
  description: 'Mute / solo / route strips and buses, gain, macro buttons, devices, per-app volume, scripts.',
  icon: '🎚️',
  actions: require('./actions'),
  stateKeys: [
    { key: 'vm.connected', label: 'Voicemeeter is running', group: 'Voicemeeter' },
    { key: 'vm.param', label: 'Voicemeeter switch is on… (like Strip[0].Mute)', group: 'Voicemeeter', arg: 'text' },
    { key: 'vm.macro', label: 'Voicemeeter macro button is on… (number)', group: 'Voicemeeter', arg: 'text' },
  ],
  optionLists: {
    'vm.devices': (ctx) => ctx.plugins.get('voicemeeter').options(),
  },
  matchState(key) {
    if (!key.startsWith('vm.')) return null;
    if (key.startsWith('vm.param=')) return { vm: true, vmParams: [key.slice('vm.param='.length)] };
    if (key.startsWith('vm.macro=')) return { vm: true, vmMacros: [Number(key.slice('vm.macro='.length))] };
    return { vm: true };
  },
  createRuntime(ctx) {
    return new VoicemeeterRuntime(ctx);
  },
};
