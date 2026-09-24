// The "starter pack": everything that is not tied to one outside app or service — Windows audio, keyboard
// and system control, generic media-player control (Spotify and most players, through Windows itself, no
// login), webhooks / Home Assistant, and the always-available mini screens (clock, timer, stopwatch, coin,
// dice, now playing). Bundled with the app; every other plugin can lean on it (e.g. ctx.plugins.get('starter')).
const { StarterRuntime } = require('./runtime');

const optionListOf = (kind) => (ctx) => ctx.plugins.get(ctx.id).options(kind);

module.exports = {
  id: 'starter',
  name: 'Starter pack',
  version: '1.0.0',
  description: 'Audio, keyboard & system, media control, webhooks, and the built-in mini screens.',
  icon: '🧰',
  actions: require('./actions'),
  widgets: require('./widgets'),
  stateKeys: [
    { key: 'audio.in.muted', label: 'Default microphone is muted', group: 'Audio' },
    { key: 'audio.out.muted', label: 'Default output is muted', group: 'Audio' },
    { key: 'audio.in.mutedBy', label: 'This microphone is muted…', group: 'Audio', arg: 'audio.capture' },
    { key: 'audio.out.mutedBy', label: 'This output device is muted…', group: 'Audio', arg: 'audio.render' },
    { key: 'audio.app.muted', label: 'This app is muted…', group: 'Audio', arg: 'audio.sessions' },
    { key: 'audio.out.default', label: 'Default output device is…', group: 'Audio', arg: 'audio.render' },
    { key: 'audio.in.default', label: 'Default microphone is…', group: 'Audio', arg: 'audio.capture' },
    { key: 'proc', label: 'App is running…', group: 'System', arg: 'processes' },
    { key: 'media.playing', label: 'Music / video is playing', group: 'Media' },
  ],
  optionLists: {
    'audio.render': optionListOf('audio.render'),
    'audio.capture': optionListOf('audio.capture'),
    'audio.sessions': optionListOf('audio.sessions'),
    processes: optionListOf('processes'),
    'media.players': optionListOf('media.players'),
  },
  matchState(key) {
    if (key.startsWith('audio.app.')) return { audio: true, audioApps: true };
    if (key.startsWith('audio.')) return { audio: true };
    if (key === 'proc' || key.startsWith('proc=')) return { process: true };
    if (key.startsWith('media.')) return { media: ['any'] };
    return null;
  },
  createRuntime(ctx) {
    return new StarterRuntime(ctx);
  },
};
