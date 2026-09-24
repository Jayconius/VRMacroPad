// Play/pause/skip for whatever is playing (Spotify, browsers, most players), through the
// Windows media session. More precise than the global media keys because it can target one app.
const actions = [
  {
    id: 'media.control',
    category: 'Media',
    label: 'Media player control',
    description: 'Play, pause, skip or go back in Spotify (or any player) without touching the keyboard.',
    icon: '⏯️',
    needs: (p) => (String(p.app) === 'pear' ? { pear: true } : { media: [String(p.app || 'auto')] }),
    params: [
      { key: 'cmd', label: 'Action', type: 'select', default: 'toggle', options: [['toggle', 'Play / Pause'], ['play', 'Play'], ['pause', 'Pause'], ['next', 'Next track'], ['previous', 'Previous track'], ['stop', 'Stop']] },
      { key: 'app', label: 'Player', type: 'select', optionsFrom: 'media.players', unknownSuffix: 'not running right now', default: 'auto', help: 'Which app to control. Automatic prefers a playing music app over a browser tab. The list shows what Windows sees right now.' },
    ],
    state: (p) => (p.cmd === 'toggle' || p.cmd === 'play' || p.cmd === 'pause' ? 'media.playing' : null),
    defaults: { label: 'Play / Pause', icon: '⏯️', color: '#6b46c1', colorOn: '#2f855a' },
    async run(p, ctx) {
      await ctx.mediaControl(String(p.app || 'auto'), p.cmd);
    },
  },
];

module.exports = actions;
