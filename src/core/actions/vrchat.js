// VRChat control over OSC. VRChat must have OSC enabled (Action Menu -> Options -> OSC).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const actions = [
  {
    id: 'vrc.mic',
    category: 'VRChat',
    label: 'Mic mute (in VRChat)',
    description: 'Toggles your VRChat mic. Needs VRChat set to "Toggle" mic mode. Button color follows your real mute state.',
    icon: '🎙️',
    needs: 'vrc',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: [['toggle', 'Toggle'], ['mute', 'Mute'], ['unmute', 'Unmute']], default: 'toggle', help: 'Mute / Unmute need VRChat to have reported your mic state over OSC.' }],
    state: () => 'vrc.MuteSelf',
    defaults: { label: 'VRC mic', icon: '🎙️', color: '#2f855a', colorOn: '#c53030', labelOn: 'Muted' },
    async run(p, ctx) {
      const muted = ctx.hub.get('vrc.MuteSelf');
      if (p.mode !== 'toggle') {
        if (muted === undefined) throw new Error('VRChat has not reported your mic state yet. Is OSC enabled in VRChat?');
        if (muted === (p.mode === 'mute')) return; // already in the requested state
      }
      // Buttons must be pulsed 1 then reset to 0, or VRChat ignores repeats.
      await ctx.osc.send('/input/Voice', [{ type: 'i', value: 0 }]);
      await sleep(40);
      await ctx.osc.send('/input/Voice', [{ type: 'i', value: 1 }]);
      await sleep(120);
      await ctx.osc.send('/input/Voice', [{ type: 'i', value: 0 }]);
    },
  },
  {
    id: 'vrc.chatbox',
    category: 'VRChat',
    label: 'Send chatbox message',
    description: 'Shows a message in your VRChat chatbox.',
    icon: '💬',
    needs: 'vrc',
    params: [
      { key: 'text', label: 'Message', type: 'text', required: true, help: 'VRChat shows at most 144 characters.' },
      { key: 'immediate', label: 'Send immediately (skip the keyboard)', type: 'boolean', default: true },
      { key: 'sound', label: 'Play the notification sound', type: 'boolean', default: false },
    ],
    defaults: { label: 'Chat', icon: '💬', color: '#2b6cb0' },
    async run(p, ctx) {
      if (!p.text) throw new Error('No message to send');
      await ctx.osc.send('/chatbox/input', [String(p.text).slice(0, 144), p.immediate !== false, Boolean(p.sound)]);
    },
  },
  {
    id: 'vrc.param',
    category: 'VRChat',
    label: 'Avatar parameter',
    description: 'Set or toggle an avatar parameter (outfit toggles, effects, ...).',
    icon: '🧍',
    needs: 'vrc',
    params: [
      { key: 'name', label: 'Parameter name', type: 'text', required: true, placeholder: 'Outfit_Hat' },
      { key: 'type', label: 'Type', type: 'select', options: [['bool', 'On/off (bool)'], ['int', 'Whole number (int)'], ['float', 'Decimal (float)']], default: 'bool' },
      { key: 'mode', label: 'Action', type: 'select', options: [['toggle', 'Toggle (on/off only)'], ['set', 'Set to value']], default: 'toggle' },
      { key: 'value', label: 'Value', type: 'number', default: 1, showIf: { key: 'mode', in: ['set'] } },
    ],
    state: (p) => (p.name ? `vrc.param=${p.name}` : null),
    defaults: { label: 'Toggle', icon: '🧍', color: '#4a5568', colorOn: '#6b46c1' },
    async run(p, ctx) {
      if (!p.name) throw new Error('Enter the parameter name');
      let value;
      if (p.mode === 'toggle') {
        if (p.type !== 'bool') throw new Error('Toggle only works with on/off parameters');
        const known = ctx.hub.get('vrc.param') || {};
        value = !known[p.name];
      } else if (p.type === 'bool') value = Number(p.value) !== 0;
      else value = Number(p.value);
      const arg = p.type === 'bool' ? value : { type: p.type === 'int' ? 'i' : 'f', value };
      await ctx.osc.send(`/avatar/parameters/${p.name}`, [arg]);
      // VRChat only reports changes it makes itself; remember what we sent so the next toggle flips it.
      if (p.type === 'bool') ctx.vrc.remember(p.name, value);
    },
  },
  {
    id: 'vrc.avatar',
    category: 'VRChat',
    label: 'Change avatar',
    description: 'Switch to an avatar by its ID (avtr_...).',
    icon: '🎭',
    needs: 'vrc',
    params: [{ key: 'avatarId', label: 'Avatar ID', type: 'text', required: true, placeholder: 'avtr_xxxxxxxx-xxxx-...' }],
    defaults: { label: 'Avatar', icon: '🎭', color: '#6b46c1' },
    async run(p, ctx) {
      if (!/^avtr_[0-9a-f-]{36}$/i.test(p.avatarId || '')) throw new Error('That does not look like an avatar ID (avtr_ followed by a UUID)');
      await ctx.osc.send('/avatar/change', [p.avatarId]);
    },
  },
];

module.exports = actions;
