// SteamVR: battery/tracking for headset, controllers, trackers and base stations, start/quit/restart, and
// a short list of live picture settings (supersampling, motion smoothing, brightness, bounds, performance
// graph, recenter, dim the view). This is about SteamVR the *application*; the VR overlay that shows this
// deck inside a headset is a separate, always-on part of the app itself, not a plugin.
const { SteamvrRuntime } = require('./runtime');

module.exports = {
  id: 'steamvr',
  name: 'SteamVR',
  version: '1.0.0',
  description: 'Battery, start/quit/restart, supersampling, brightness, dim the view, bounds, recenter.',
  icon: '🥽',
  actions: require('./actions'),
  widgets: require('./widgets'),
  stateKeys: [
    { key: 'vr.connected', label: 'SteamVR is running', group: 'SteamVR' },
    { key: 'vr.dimmed', label: 'The view is dimmed', group: 'SteamVR' },
    { key: 'vr.motionSmoothing', label: 'SteamVR motion smoothing is on', group: 'SteamVR' },
    { key: 'vr.perfGraph', label: 'SteamVR performance graph is showing', group: 'SteamVR' },
    { key: 'vr.boundsForced', label: 'Play-area bounds are kept visible', group: 'SteamVR' },
    { key: 'vr.lowBattery', label: 'A headset / controller / tracker battery is low', group: 'SteamVR' },
    { key: 'vr.charging', label: 'A headset / controller / tracker is charging', group: 'SteamVR' },
    { key: 'vr.hmdWorn', label: 'The headset is on your head', group: 'SteamVR' },
    { key: 'vr.trackingLost', label: 'A device lost tracking', group: 'SteamVR' },
    { key: 'vr.dropped', label: 'A device you used before is off or dropped out', group: 'SteamVR' },
    { key: 'vr.device', label: 'This device is connected…', group: 'SteamVR', arg: 'vr.devices' },
  ],
  settingsFields: [
    { key: 'lowBatteryPercent', label: 'Low-battery warning (%)', type: 'number', min: 1, max: 90, default: 15 },
  ],
  optionLists: {
    'vr.devices': (ctx) => ctx.plugins.get('steamvr').options(),
  },
  matchState(key) {
    if (key.startsWith('vr.')) return { vr: true };
    return null;
  },
  createRuntime(ctx) {
    return new SteamvrRuntime(ctx);
  },
};
