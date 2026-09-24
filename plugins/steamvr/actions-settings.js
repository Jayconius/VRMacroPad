// SteamVR functions: the things OVR Advanced Settings and SteamVR's own settings screen change, as buttons.
// They talk to SteamVR through the "vr" helper (Valve's OpenVR settings) and only work while SteamVR is running.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function readSettings(ctx) {
  const st = await ctx.plugin('steamvr').control('settings.state');
  if (!st.connected) throw new Error(st.error || 'SteamVR is not running');
  return st.values || {};
}

async function write(ctx, section, key, value) {
  return ctx.plugin('steamvr').control('settings.set', { section, key, value });
}

const TOGGLE = [['toggle', 'Toggle'], ['on', 'On'], ['off', 'Off']];
const resolve = (mode, current) => (mode === 'on' ? true : mode === 'off' ? false : !current);

const actions = [
  {
    id: 'steamvr.supersample',
    category: 'SteamVR',
    label: 'Supersampling (render resolution)',
    description: 'Sets SteamVR\'s render resolution multiplier: higher looks sharper but costs performance. Applies to games started after the change.',
    icon: '🔍',
    needs: 'vr',
    params: [
      { key: 'mode', label: 'Action', type: 'select', options: [['set', 'Set to'], ['up', 'Increase by'], ['down', 'Decrease by'], ['reset', 'Back to 100 %']], default: 'set' },
      { key: 'value', label: 'Value (percent)', type: 'number', min: 20, max: 500, default: 100, showIf: { key: 'mode', in: ['set'] } },
      { key: 'step', label: 'Step (percent)', type: 'number', min: 1, max: 100, default: 10, showIf: { key: 'mode', in: ['up', 'down'] } },
    ],
    defaults: { label: 'Res', icon: '🔍', color: '#2b6cb0' },
    async run(p, ctx) {
      const cur = await readSettings(ctx);
      const now = Number(cur['steamvr.supersampleScale']) || 1;
      let next;
      if (p.mode === 'reset') next = 1;
      else if (p.mode === 'up') next = now + (Number(p.step) || 10) / 100;
      else if (p.mode === 'down') next = now - (Number(p.step) || 10) / 100;
      else next = (Number(p.value) || 100) / 100;
      next = Math.round(clamp(next, 0.2, 5) * 100) / 100;
      await write(ctx, 'steamvr', 'supersampleManualOverride', true); // otherwise SteamVR picks its own value per game
      await write(ctx, 'steamvr', 'supersampleScale', next);
      ctx.toast(`Supersampling ${Math.round(next * 100)} %`, 'info');
    },
  },
  {
    id: 'steamvr.motionSmoothing',
    category: 'SteamVR',
    label: 'Motion smoothing',
    description: 'Turns SteamVR motion smoothing (frame synthesis) on or off.',
    icon: '🎞️',
    needs: 'vr',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: TOGGLE, default: 'toggle' }],
    state: () => 'vr.motionSmoothing',
    defaults: { label: 'Smoothing', icon: '🎞️', color: '#4a5568', colorOn: '#2f855a', labelOn: 'Smoothing on' },
    async run(p, ctx) {
      const cur = await readSettings(ctx);
      await write(ctx, 'steamvr', 'motionSmoothing', resolve(p.mode, cur['steamvr.motionSmoothing'] === true));
    },
  },
  {
    id: 'steamvr.brightness',
    category: 'SteamVR',
    label: 'Headset brightness',
    description: 'Dims the headset picture through SteamVR\'s display colour gain. Works with headsets whose driver supports it (Index, Vive...); if nothing changes on yours, use "Dim the view" instead.',
    icon: '🔆',
    needs: 'vr',
    params: [
      { key: 'mode', label: 'Action', type: 'select', options: [['set', 'Set to'], ['up', 'Brighter by'], ['down', 'Dimmer by'], ['reset', 'Full brightness']], default: 'set' },
      { key: 'value', label: 'Brightness (percent)', type: 'number', min: 5, max: 100, default: 70, showIf: { key: 'mode', in: ['set'] } },
      { key: 'step', label: 'Step (percent)', type: 'number', min: 1, max: 50, default: 10, showIf: { key: 'mode', in: ['up', 'down'] } },
    ],
    defaults: { label: 'Bright', icon: '🔆', color: '#b7791f' },
    async run(p, ctx) {
      const cur = await readSettings(ctx);
      const now = Number(cur['steamvr.hmdDisplayColorGainR']);
      const base = Number.isFinite(now) ? now : 1;
      let next;
      if (p.mode === 'reset') next = 1;
      else if (p.mode === 'up') next = base + (Number(p.step) || 10) / 100;
      else if (p.mode === 'down') next = base - (Number(p.step) || 10) / 100;
      else next = (Number(p.value) || 70) / 100;
      next = Math.round(clamp(next, 0.05, 1) * 100) / 100;
      for (const c of ['R', 'G', 'B']) await write(ctx, 'steamvr', `hmdDisplayColorGain${c}`, next);
      ctx.toast(`Brightness ${Math.round(next * 100)} %`, 'info');
    },
  },
  {
    id: 'steamvr.dim',
    category: 'SteamVR',
    label: 'Dim the view',
    description: 'Puts a dark sheet in front of your eyes, so everything in VR gets darker. Works on any headset (it does not need driver support), and the VR deck and dashboard stay bright. Needs SteamVR running.',
    icon: '🌙',
    params: [
      { key: 'mode', label: 'Action', type: 'select', options: [['set', 'Set to'], ['up', 'Darker by'], ['down', 'Lighter by'], ['toggle', 'Switch on / off'], ['off', 'Off (full brightness)']], default: 'set' },
      { key: 'value', label: 'Darkness (percent, 0-90)', type: 'number', min: 0, max: 90, default: 40, showIf: { key: 'mode', in: ['set', 'toggle'] } },
      { key: 'step', label: 'Step (percent)', type: 'number', min: 1, max: 50, default: 10, showIf: { key: 'mode', in: ['up', 'down'] } },
    ],
    state: () => 'vr.dimmed',
    defaults: { label: 'Dim', icon: '🌙', color: '#4a5568', colorOn: '#2b6cb0', labelOn: 'Dimmed' },
    async run(p, ctx) {
      let next = null;
      ctx.patchSettings((s) => {
        const now = Math.round(s.overlay.dim * 100);
        const set = clamp(Math.round(Number(p.value)), 0, 90);
        if (p.mode === 'off') next = 0;
        else if (p.mode === 'up') next = now + (Number(p.step) || 10);
        else if (p.mode === 'down') next = now - (Number(p.step) || 10);
        else if (p.mode === 'toggle') next = now > 0 ? 0 : (set || 40);
        else next = set;
        next = clamp(Math.round(next), 0, 90);
        s.overlay.dim = next / 100;
      });
      ctx.toast(next ? `Dimmed to ${next} %` : 'Full brightness', 'info');
    },
  },
  {
    id: 'steamvr.bounds',
    category: 'SteamVR',
    label: 'Show play-area bounds',
    description: 'Keeps the play-area (chaperone) walls visible so you can see where the edges are, or puts them back to normal.',
    icon: '🧱',
    needs: 'vr',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: TOGGLE, default: 'toggle' }],
    state: () => 'vr.boundsForced',
    defaults: { label: 'Bounds', icon: '🧱', color: '#4a5568', colorOn: '#b7791f', labelOn: 'Bounds on' },
    async run(p, ctx) {
      const st = await ctx.plugin('steamvr').control('settings.state');
      if (!st.connected) throw new Error(st.error || 'SteamVR is not running');
      await ctx.plugin('steamvr').control('bounds.force', { on: resolve(p.mode, st.boundsForced === true) });
    },
  },
  {
    id: 'steamvr.boundsStyle',
    category: 'SteamVR',
    label: 'Play-area bounds look',
    description: 'How strongly the play-area walls show up, and how close you must be before they fade in.',
    icon: '🧱',
    needs: 'vr',
    params: [
      { key: 'opacity', label: 'Opacity (percent, empty = leave)', type: 'number', min: 0, max: 100, default: 60 },
      { key: 'fade', label: 'Fade-in distance in meters (empty = leave)', type: 'number', min: 0.1, max: 3, default: 0.7 },
    ],
    defaults: { label: 'Walls', icon: '🧱', color: '#4a5568' },
    async run(p, ctx) {
      let touched = false;
      if (p.opacity !== undefined && p.opacity !== '' && p.opacity !== null) {
        await write(ctx, 'collisionBounds', 'CollisionBoundsColorGammaA', Math.round(clamp(Number(p.opacity), 0, 100) * 255 / 100));
        touched = true;
      }
      if (p.fade !== undefined && p.fade !== '' && p.fade !== null) {
        await write(ctx, 'collisionBounds', 'CollisionBoundsFadeDistance', clamp(Number(p.fade), 0.1, 3));
        touched = true;
      }
      if (!touched) throw new Error('Set an opacity or a distance');
    },
  },
  {
    id: 'steamvr.perfGraph',
    category: 'SteamVR',
    label: 'Performance graph',
    description: 'Shows or hides SteamVR\'s frame-timing graph in the headset.',
    icon: '📈',
    needs: 'vr',
    params: [{ key: 'mode', label: 'Mode', type: 'select', options: TOGGLE, default: 'toggle' }],
    state: () => 'vr.perfGraph',
    defaults: { label: 'Perf', icon: '📈', color: '#4a5568', colorOn: '#2b6cb0', labelOn: 'Graph on' },
    async run(p, ctx) {
      const cur = await readSettings(ctx);
      await write(ctx, 'steamvr', 'showPerfGraph', resolve(p.mode, cur['steamvr.showPerfGraph'] === true));
    },
  },
  {
    id: 'steamvr.recenter',
    category: 'SteamVR',
    label: 'Recenter (seated)',
    description: 'Resets the seated position to where you are sitting and looking now.',
    icon: '🎯',
    needs: 'vr',
    params: [],
    defaults: { label: 'Recenter', icon: '🎯', color: '#2f855a' },
    async run(p, ctx) {
      await ctx.plugin('steamvr').control('recenter');
    },
  },
];

module.exports = actions;
