// YouTube Music through Pear Desktop's "API Server" plugin. Connect it in Settings → Connections
// (Pear asks you to click Allow once).
const { REPEAT_ORDER } = require('./client');

const REPEAT_LABEL = { NONE: 'Off', ALL: 'Repeat all', ONE: 'Repeat one' };

const actions = [
  {
    id: 'pear.playback',
    category: 'YouTube Music (Pear)',
    label: 'Play / pause / skip',
    description: 'Play, pause, next or previous track in Pear Desktop.',
    icon: '⏯️',
    needs: 'pear',
    params: [{ key: 'cmd', label: 'Action', type: 'select', default: 'toggle', options: [['toggle', 'Play / Pause'], ['play', 'Play'], ['pause', 'Pause'], ['next', 'Next track'], ['previous', 'Previous track']] }],
    state: (p) => (['toggle', 'play', 'pause'].includes(p.cmd) ? 'pear.playing' : null),
    defaults: { label: 'YT Music', icon: '⏯️', color: '#7a1f2b', colorOn: '#2f855a' },
    async run(p, ctx) {
      await ctx.mediaControl('pear', p.cmd);
    },
  },
  {
    id: 'pear.like',
    category: 'YouTube Music (Pear)',
    label: 'Like / dislike the song',
    description: 'Thumbs up or down on the current song (pressing again removes it). The button lights up while liked.',
    icon: '👍',
    needs: 'pear',
    params: [{ key: 'which', label: 'Which', type: 'select', default: 'like', options: [['like', 'Like 👍'], ['dislike', 'Dislike 👎']] }],
    state: (p) => (p.which === 'dislike' ? 'pear.disliked' : 'pear.liked'),
    defaults: { label: 'Like', icon: '👍', color: '#4a5568', colorOn: '#2f855a', labelOn: 'Liked' },
    async run(p, ctx) {
      await ctx.mediaControl('pear', p.which === 'dislike' ? 'dislike' : 'like');
    },
  },
  {
    id: 'pear.shuffle',
    category: 'YouTube Music (Pear)',
    label: 'Shuffle',
    description: 'Turns shuffle on or off. The button lights up while it is on.',
    icon: '🔀',
    needs: 'pear',
    params: [],
    state: () => 'pear.shuffle',
    defaults: { label: 'Shuffle', icon: '🔀', color: '#4a5568', colorOn: '#6b46c1', labelOn: 'Shuffle on' },
    async run(p, ctx) {
      await ctx.mediaControl('pear', 'shuffle');
    },
  },
  {
    id: 'pear.repeat',
    category: 'YouTube Music (Pear)',
    label: 'Repeat',
    description: 'Cycle repeat (off → all → one), or jump to a specific mode.',
    icon: '🔁',
    needs: 'pear',
    params: [{ key: 'mode', label: 'Mode', type: 'select', default: 'cycle', options: [['cycle', 'Next mode each press'], ...REPEAT_ORDER.map((m) => [m, REPEAT_LABEL[m]])] }],
    state: () => 'pear.repeat',
    defaults: { label: 'Repeat', icon: '🔁', color: '#4a5568', colorOn: '#6b46c1' },
    async run(p, ctx) {
      if (p.mode && p.mode !== 'cycle') await ctx.plugin('pear').call((c) => c.setRepeat(p.mode));
      else await ctx.mediaControl('pear', 'repeat');
    },
  },
  {
    id: 'pear.volume',
    category: 'YouTube Music (Pear)',
    label: 'Volume (Pear only)',
    description: "Change Pear's own volume, or mute it, without touching the rest of your audio.",
    icon: '🔊',
    needs: 'pear',
    params: [
      { key: 'mode', label: 'Action', type: 'select', default: 'up', options: [['up', 'Raise by'], ['down', 'Lower by'], ['set', 'Set to'], ['mute', 'Mute / unmute']] },
      { key: 'amount', label: 'Amount (%)', type: 'number', min: 0, max: 100, default: 10, showIf: { key: 'mode', in: ['up', 'down', 'set'] } },
    ],
    state: (p) => (p.mode === 'mute' ? 'pear.muted' : null),
    defaults: { label: 'YT vol', icon: '🔊', color: '#7a1f2b' },
    async run(p, ctx) {
      if (p.mode === 'mute') { await ctx.mediaControl('pear', 'mute'); return; }
      const amount = Number(p.amount);
      if (!Number.isFinite(amount)) throw new Error('Amount must be a number');
      // Steps are in slider percent (what you see in Pear), not the curved loudness Pear reports.
      await ctx.plugin('pear').call((c) => c.setVolume(p.mode === 'set' ? amount : c.sliderVolume() + (p.mode === 'down' ? -amount : amount)));
    },
  },
  {
    id: 'pear.seek',
    category: 'YouTube Music (Pear)',
    label: 'Skip forward / back',
    description: 'Jump a few seconds forward or back in the current song.',
    icon: '⏩',
    needs: 'pear',
    params: [
      { key: 'direction', label: 'Direction', type: 'select', default: 'forward', options: [['forward', 'Forward'], ['back', 'Back']] },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 1, max: 600, default: 10 },
    ],
    defaults: { label: '+10s', icon: '⏩', color: '#7a1f2b' },
    async run(p, ctx) {
      const s = Math.max(1, Math.min(600, Number(p.seconds) || 10));
      await ctx.plugin('pear').call((c) => c.seekBy(p.direction === 'back' ? -s : s));
    },
  },
];

module.exports = actions;
