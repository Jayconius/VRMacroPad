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
      if (p.type === 'bool') ctx.plugin('vrchat').remember(p.name, value);
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
    // VRChat announces the avatar you are wearing, so the button can light up on the current one.
    state: (p) => (p.avatarId ? `vrc.avatar=${String(p.avatarId).trim()}` : null),
    defaults: { label: 'Avatar', icon: '🎭', color: '#6b46c1', colorOn: '#2f855a' },
    async run(p, ctx) {
      if (!/^avtr_[0-9a-f-]{36}$/i.test(p.avatarId || '')) throw new Error('That does not look like an avatar ID (avtr_ followed by a UUID)');
      await ctx.osc.send('/avatar/change', [p.avatarId]);
    },
  },
];

// ---- game controls (VRChat's OSC input controller) ----
const CONTROLS = [
  ['Jump', 'Jump'], ['Run', 'Run (hold)'], ['MoveForward', 'Move forward'], ['MoveBackward', 'Move backward'], ['MoveLeft', 'Move left'], ['MoveRight', 'Move right'],
  ['LookLeft', 'Turn left'], ['LookRight', 'Turn right'], ['ComfortLeft', 'Comfort turn left (VR)'], ['ComfortRight', 'Comfort turn right (VR)'],
  ['UseLeft', 'Use, left hand (VR)'], ['UseRight', 'Use, right hand (VR)'], ['GrabLeft', 'Grab, left hand (VR)'], ['GrabRight', 'Grab, right hand (VR)'],
  ['DropLeft', 'Drop, left hand (VR)'], ['DropRight', 'Drop, right hand (VR)'],
  ['QuickMenuToggleLeft', 'Quick Menu, left'], ['QuickMenuToggleRight', 'Quick Menu, right'], ['PanicButton', 'Panic button (hide everyone\'s avatars)'],
];
const AXES = [
  ['Vertical', 'Walk forward (+) / backward (-)'], ['Horizontal', 'Walk right (+) / left (-)'], ['LookHorizontal', 'Turn right (+) / left (-)'],
  ['UseAxisRight', 'Use, right hand (0 to 1)'], ['GrabAxisRight', 'Grab, right hand (0 to 1)'],
  ['MoveHoldFB', 'Move a held object away (+) / toward you (-)'], ['SpinHoldCwCcw', 'Spin a held object clockwise (+)'], ['SpinHoldUD', 'Tilt a held object up / down'], ['SpinHoldLR', 'Tilt a held object left / right'],
];
const TAP_MS = 110;
const MAX_HOLD_MS = 30000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const iv = (value) => [{ type: 'i', value }];
const fv = (value) => [{ type: 'f', value }];

// The chatbox text with {time}, {date}, {song}, {artist} filled in.
function fillTemplate(text, ctx, now = new Date()) {
  const np = ctx.nowPlaying ? ctx.nowPlaying() : null;
  const two = (n) => String(n).padStart(2, '0');
  const map = {
    time: `${two(now.getHours())}:${two(now.getMinutes())}`,
    date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    song: np ? np.title || '' : '',
    artist: np ? np.artist || '' : '',
  };
  return { text: String(text).replace(/\{(time|date|song|artist)\}/g, (m, k) => map[k]), playing: Boolean(np && np.title) };
}

actions.push(
  {
    id: 'vrc.input',
    category: 'VRChat',
    label: 'Press a game control',
    description: 'Jump, run, walk, turn, use / grab / drop, open the Quick Menu, or hit the panic button, as if you pressed it on your controller. Needs OSC enabled in VRChat.',
    icon: '🕹️',
    needs: 'vrc',
    params: [
      { key: 'control', label: 'Control', type: 'select', options: CONTROLS, default: 'Jump' },
      { key: 'how', label: 'How', type: 'select', options: [['tap', 'Tap'], ['hold', 'Hold for a time'], ['down', 'Press and keep held'], ['up', 'Let go']], default: 'tap' },
      { key: 'ms', label: 'Hold time (ms)', type: 'number', min: 50, max: MAX_HOLD_MS, default: 1000, showIf: { key: 'how', in: ['hold'] } },
    ],
    defaults: { label: 'Jump', icon: '🕹️', color: '#2b6cb0' },
    async run(p, ctx) {
      if (!CONTROLS.some(([v]) => v === p.control)) throw new Error('Pick a control');
      const address = `/input/${p.control}`;
      // VRChat ignores a button that is not let go first (0), then pressed (1), then released again (0).
      if (p.how === 'up') { await ctx.osc.send(address, iv(0)); return; }
      await ctx.osc.send(address, iv(0));
      await wait(30);
      await ctx.osc.send(address, iv(1));
      if (p.how === 'down') return;
      await wait(p.how === 'hold' ? Math.min(MAX_HOLD_MS, Math.max(50, Number(p.ms) || 1000)) : TAP_MS);
      await ctx.osc.send(address, iv(0));
    },
  },
  {
    id: 'vrc.axis',
    category: 'VRChat',
    label: 'Move or turn for a moment',
    description: 'Walks, strafes or turns (or works a held object) for a set time, then stops. A time of 0 leaves it on until you send another one.',
    icon: '🚶',
    needs: 'vrc',
    params: [
      { key: 'axis', label: 'Movement', type: 'select', options: AXES, default: 'Vertical' },
      { key: 'value', label: 'Strength (-1 to 1)', type: 'number', min: -1, max: 1, default: 1 },
      { key: 'ms', label: 'For how long (ms, 0 = keep on)', type: 'number', min: 0, max: MAX_HOLD_MS, default: 500 },
    ],
    defaults: { label: 'Walk', icon: '🚶', color: '#2b6cb0' },
    async run(p, ctx) {
      if (!AXES.some(([v]) => v === p.axis)) throw new Error('Pick a movement');
      const address = `/input/${p.axis}`;
      const value = Math.max(-1, Math.min(1, Number(p.value)));
      if (!Number.isFinite(value)) throw new Error('Strength is a number from -1 to 1');
      await ctx.osc.send(address, fv(value));
      const ms = Math.min(MAX_HOLD_MS, Math.max(0, Number(p.ms) || 0));
      if (!ms) return;
      await wait(ms);
      await ctx.osc.send(address, fv(0));
    },
  },
  {
    id: 'vrc.chatboxLive',
    category: 'VRChat',
    label: 'Chatbox with the time or the song playing',
    description: 'A chatbox message with {time}, {date}, {song} and {artist} filled in, for example "Listening to {song} - {artist}". Uses whatever your PC is playing.',
    icon: '🎵',
    needs: () => ({ vrc: true, media: ['any'] }),
    params: [
      { key: 'text', label: 'Message', type: 'text', required: true, default: 'Listening to {song} - {artist}', help: '{time} {date} {song} {artist}. VRChat shows at most 144 characters.' },
      { key: 'onlyPlaying', label: 'Do nothing when no song is playing', type: 'boolean', default: true },
      { key: 'sound', label: 'Play the notification sound', type: 'boolean', default: false },
    ],
    defaults: { label: 'Now playing', icon: '🎵', color: '#2b6cb0' },
    async run(p, ctx) {
      if (!p.text) throw new Error('No message to send');
      const { text, playing } = fillTemplate(p.text, ctx);
      if (/\{song\}|\{artist\}/.test(p.text) && p.onlyPlaying !== false && !playing) throw new Error('Nothing is playing right now');
      const out = text.trim().slice(0, 144);
      if (!out) throw new Error('The message came out empty');
      await ctx.osc.send('/chatbox/input', [out, true, Boolean(p.sound)]);
    },
  },
  {
    id: 'vrc.chatboxClear',
    category: 'VRChat',
    label: 'Clear the chatbox',
    description: 'Removes your message from the chatbox.',
    icon: '🧹',
    needs: 'vrc',
    params: [],
    defaults: { label: 'Clear chat', icon: '🧹', color: '#4a5568' },
    async run(p, ctx) {
      await ctx.osc.send('/chatbox/input', ['', true, false]);
    },
  },
  {
    id: 'vrc.typing',
    category: 'VRChat',
    label: 'Chatbox typing bubble',
    description: 'Shows or hides the "typing..." bubble over your head.',
    icon: '⌨️',
    needs: 'vrc',
    params: [{ key: 'on', label: 'Show the bubble', type: 'boolean', default: true }],
    defaults: { label: 'Typing', icon: '⌨️', color: '#4a5568' },
    async run(p, ctx) {
      await ctx.osc.send('/chatbox/typing', [p.on !== false]);
    },
  },
  {
    id: 'vrc.paramStep',
    category: 'VRChat',
    label: 'Avatar parameter: step up / down / cycle',
    description: 'Nudges an avatar slider (0 to 1) or steps a whole-number parameter (outfit number, mode) up, down or around.',
    icon: '🎚️',
    needs: (p) => ({ vrc: true, vrcParams: p.name ? [p.name] : [] }),
    params: [
      { key: 'name', label: 'Parameter name', type: 'text', required: true, placeholder: 'Outfit' },
      { key: 'type', label: 'Type', type: 'select', options: [['float', 'Slider (decimal)'], ['int', 'Whole number']], default: 'int' },
      { key: 'mode', label: 'Action', type: 'select', options: [['up', 'Up'], ['down', 'Down']], default: 'up' },
      { key: 'step', label: 'Step', type: 'number', min: 0.001, max: 255, default: 1 },
      { key: 'min', label: 'Lowest value', type: 'number', default: 0 },
      { key: 'max', label: 'Highest value', type: 'number', default: 3 },
      { key: 'wrap', label: 'Go around at the ends', type: 'boolean', default: true },
    ],
    defaults: { label: 'Next', icon: '🎚️', color: '#6b46c1' },
    async run(p, ctx) {
      if (!p.name) throw new Error('Enter the parameter name');
      const int = p.type !== 'float';
      const min = Number(p.min) || 0;
      const max = Number.isFinite(Number(p.max)) ? Number(p.max) : (int ? 3 : 1);
      if (max < min) throw new Error('The highest value must not be below the lowest');
      const known = (ctx.hub.get('vrc.param') || {})[p.name];
      const cur = Number.isFinite(Number(known)) ? Number(known) : min;
      let next = cur + (p.mode === 'down' ? -1 : 1) * (Number(p.step) || 1);
      if (next > max) next = p.wrap === false ? max : min;
      else if (next < min) next = p.wrap === false ? min : max;
      next = int ? Math.round(next) : Math.round(next * 1000) / 1000;
      await ctx.osc.send(`/avatar/parameters/${p.name}`, [{ type: int ? 'i' : 'f', value: next }]);
      ctx.plugin('vrchat').remember(p.name, next);
    },
  },
  {
    id: 'osc.custom',
    category: 'VRChat',
    label: 'Send any OSC message',
    description: 'Sends one OSC message to VRChat or to any other app that listens for OSC (face tracking, lighting, ...).',
    icon: '📡',
    params: [
      { key: 'address', label: 'Address', type: 'text', required: true, placeholder: '/avatar/parameters/MyToggle' },
      { key: 'type', label: 'Value type', type: 'select', options: [['bool', 'On / off'], ['int', 'Whole number'], ['float', 'Decimal number'], ['string', 'Text']], default: 'bool' },
      { key: 'value', label: 'Value', type: 'text', default: '1', help: 'For on / off: 1 / true is on, 0 / false is off.' },
      { key: 'host', label: 'Send to (empty = the VRChat address in Settings)', type: 'text', placeholder: '127.0.0.1' },
      { key: 'port', label: 'Port (empty = the VRChat port in Settings)', type: 'number', min: 1, max: 65535 },
    ],
    defaults: { label: 'OSC', icon: '📡', color: '#4a5568' },
    async run(p, ctx) {
      const address = String(p.address || '').trim();
      if (!address.startsWith('/') || /\s/.test(address)) throw new Error('The address starts with / and has no spaces');
      let arg;
      const raw = String(p.value === undefined ? '' : p.value).trim();
      if (p.type === 'bool') arg = !/^(0|false|off|no|)$/i.test(raw);
      else if (p.type === 'string') arg = raw;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error('The value is not a number');
        arg = { type: p.type === 'int' ? 'i' : 'f', value: n };
      }
      const port = Number(p.port);
      if ((p.host && String(p.host).trim()) || port) {
        if (!(port >= 1 && port <= 65535)) throw new Error('Enter the port to send to');
        await ctx.oscTo(String(p.host || '127.0.0.1').trim(), Math.round(port), address, [arg]);
      } else {
        await ctx.osc.send(address, [arg]);
      }
    },
  },
);

module.exports = actions;
module.exports.fillTemplate = fillTemplate;
