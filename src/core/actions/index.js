// The action catalog. Each entry is self-describing (params drive the UI form),
// so adding a new action means adding one object to one of these files.
const groups = [require('./audio'), require('./system'), require('./media'), require('./obs'), require('./vrchat'), require('./twitch'), require('./pear'), require('./spotify')];
const { widgetCatalog } = require('../widgets');

const defs = new Map();
for (const group of groups) {
  for (const def of group) {
    if (defs.has(def.id)) throw new Error(`Duplicate action id ${def.id}`);
    defs.set(def.id, def);
  }
}

// State keys the UI can offer for "state source" and "state changes" triggers.
const STATE_KEYS = [
  { key: 'audio.in.muted', label: 'Default microphone is muted', group: 'Audio' },
  { key: 'audio.out.muted', label: 'Default output is muted', group: 'Audio' },
  { key: 'audio.out.default', label: 'Default output device is…', group: 'Audio', arg: 'audio.render' },
  { key: 'audio.in.default', label: 'Default microphone is…', group: 'Audio', arg: 'audio.capture' },
  { key: 'obs.recording', label: 'OBS is recording', group: 'OBS' },
  { key: 'obs.streaming', label: 'OBS is streaming', group: 'OBS' },
  { key: 'obs.replay', label: 'OBS replay buffer is on', group: 'OBS' },
  { key: 'obs.scene', label: 'OBS scene is…', group: 'OBS', arg: 'obs.scenes' },
  { key: 'obs.inputMuted', label: 'OBS source is muted…', group: 'OBS', arg: 'obs.inputs' },
  { key: 'vrc.MuteSelf', label: 'VRChat mic is muted', group: 'VRChat' },
  { key: 'vrc.param', label: 'VRChat avatar parameter is on…', group: 'VRChat', arg: 'text' },
  { key: 'proc', label: 'App is running…', group: 'System', arg: 'processes' },
  { key: 'media.playing', label: 'Music / video is playing', group: 'Media' },
  { key: 'vr.connected', label: 'SteamVR is running', group: 'SteamVR' },
  { key: 'vr.lowBattery', label: 'A headset / controller / tracker battery is low', group: 'SteamVR' },
  { key: 'vr.charging', label: 'A headset / controller / tracker is charging', group: 'SteamVR' },
  { key: 'vr.hmdWorn', label: 'The headset is on your head', group: 'SteamVR' },
  { key: 'vr.trackingLost', label: 'A device lost tracking', group: 'SteamVR' },
  { key: 'vr.dropped', label: 'A device you used before is off or dropped out', group: 'SteamVR' },
  { key: 'vr.device', label: 'This device is connected…', group: 'SteamVR', arg: 'vr.devices' },
  { key: 'spotify.playing', label: 'Spotify is playing', group: 'Spotify' },
  { key: 'spotify.liked', label: 'The Spotify song playing is liked', group: 'Spotify' },
  { key: 'spotify.shuffle', label: 'Spotify shuffle is on', group: 'Spotify' },
  { key: 'spotify.repeat', label: 'Spotify repeat is on', group: 'Spotify' },
  { key: 'pear.connected', label: 'Pear (YouTube Music) is connected', group: 'YouTube Music' },
  { key: 'pear.playing', label: 'YouTube Music is playing', group: 'YouTube Music' },
  { key: 'pear.liked', label: 'Current YouTube Music song is liked', group: 'YouTube Music' },
  { key: 'pear.shuffle', label: 'YouTube Music shuffle is on', group: 'YouTube Music' },
  { key: 'pear.repeat', label: 'YouTube Music repeat is on', group: 'YouTube Music' },
  { key: 'twitch.connected', label: 'Twitch is connected', group: 'Twitch' },
  { key: 'twitch.live', label: 'You are live on Twitch', group: 'Twitch' },
  { key: 'twitch.adSoon', label: 'An ad break is coming up soon', group: 'Twitch' },
  { key: 'twitch.emoteOnly', label: 'Emote-only mode is on', group: 'Twitch' },
  { key: 'twitch.followersOnly', label: 'Followers-only mode is on', group: 'Twitch' },
  { key: 'twitch.subsOnly', label: 'Subscribers-only mode is on', group: 'Twitch' },
  { key: 'twitch.slowMode', label: 'Slow mode is on', group: 'Twitch' },
  { key: 'twitch.uniqueChat', label: 'Unique chat is on', group: 'Twitch' },
  { key: 'twitch.shield', label: 'Shield mode is on', group: 'Twitch' },
];

// What the browser needs to build forms (functions and run() stay on the server).
function catalogForUi() {
  return {
    actions: [...defs.values()].map((d) => ({
      id: d.id,
      category: d.category,
      label: d.label,
      description: d.description,
      icon: d.icon,
      params: d.params,
      defaults: d.defaults,
      hasState: Boolean(d.state),
    })),
    widgets: widgetCatalog(),
    stateKeys: STATE_KEYS,
  };
}

// The state key a button follows when its source is "auto": from its first stateful step.
function autoStateKey(button) {
  for (const step of button.steps) {
    const def = defs.get(step.action);
    if (def && def.state) {
      const key = def.state(step.params || {});
      if (key) return key;
    }
  }
  return null;
}

module.exports = { defs, STATE_KEYS, catalogForUi, autoStateKey };
