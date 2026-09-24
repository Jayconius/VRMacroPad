// YouTube Music through Pear Desktop's "API Server" plugin (album, like/dislike, shuffle, repeat, volume).
const { PearRuntime } = require('./runtime');

module.exports = {
  id: 'pear',
  name: 'YouTube Music (Pear)',
  version: '1.0.0',
  description: 'Album, like / dislike, shuffle, repeat and volume for YouTube Music, via Pear Desktop.',
  icon: '▶️',
  instructions: () => 'In Pear: Plugins → API Server → enable it (set the hostname to 127.0.0.1 so only this PC can reach it). Then press Connect and click Allow in the Pear window. Adds the album, like, shuffle, repeat and volume.',
  // Shown next to the dot in place of the generic word for that status, while connections[].flow is 'approve'.
  statusHints: {
    'awaiting-approval': 'A prompt is showing in Pear. Click Allow.',
    denied: 'Press Connect again and click Allow.',
    'not-running': "Can't reach Pear. Is it running with the API Server plugin on?",
    'needs-auth': 'Press Connect below.',
  },
  actions: require('./actions'),
  stateKeys: [
    { key: 'pear.connected', label: 'Pear (YouTube Music) is connected', group: 'YouTube Music' },
    { key: 'pear.playing', label: 'YouTube Music is playing', group: 'YouTube Music' },
    { key: 'pear.liked', label: 'Current YouTube Music song is liked', group: 'YouTube Music' },
    { key: 'pear.shuffle', label: 'YouTube Music shuffle is on', group: 'YouTube Music' },
    { key: 'pear.repeat', label: 'YouTube Music repeat is on', group: 'YouTube Music' },
  ],
  settingsFields: [
    { key: 'host', label: 'Address', type: 'text', default: '127.0.0.1' },
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 26538 },
  ],
  connections: [{ id: 'main', label: 'Pear', flow: 'approve' }],
  clientMethods: ['connect', 'disconnect'],
  // "I am the definitive media source for the app id 'pear'" — ctx.mediaControl/media route to this
  // plugin's runtime (control(cmd,arg), view(), thumbFor(url)) instead of the generic Windows media session.
  mediaBridge: { app: 'pear' },
  matchState(key) {
    if (key.startsWith('pear.')) return { pear: true };
    return null;
  },
  createRuntime(ctx) {
    return new PearRuntime(ctx);
  },
};
