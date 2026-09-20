// Spotify, through the Windows media session (the same thing the volume flyout shows): no login,
// no Premium, and it never touches your account. It controls the Spotify desktop app on THIS PC.
// Only "Like" needs more (Windows has no like): it uses the Spotify Web API after a one-time connection.
const REPEAT_LABEL = { none: 'Off', list: 'Repeat all', track: 'Repeat one' };
const NEEDS = { media: ['spotify'] };

const actions = [
  {
    id: 'spotify.playback',
    category: 'Spotify',
    label: 'Play / pause / skip',
    description: 'Play, pause, next or previous track in the Spotify app.',
    icon: '⏯️',
    needs: () => NEEDS,
    params: [{ key: 'cmd', label: 'Action', type: 'select', default: 'toggle', options: [['toggle', 'Play / Pause'], ['play', 'Play'], ['pause', 'Pause'], ['next', 'Next track'], ['previous', 'Previous track']] }],
    state: (p) => (['toggle', 'play', 'pause'].includes(p.cmd) ? 'spotify.playing' : null),
    defaults: { label: 'Spotify', icon: '⏯️', color: '#1a6b3a', colorOn: '#1db954' },
    async run(p, ctx) {
      await ctx.mediaControl('spotify', p.cmd || 'toggle');
    },
  },
  {
    id: 'spotify.like',
    category: 'Spotify',
    label: 'Like the song',
    description: 'Saves the current song to your Liked Songs (pressing again removes it). The button lights up while it is liked. Needs a one-time Spotify connection in Settings, unlike the rest of this list.',
    icon: '💚',
    needs: () => ({ media: ['spotify'], spotify: true }),
    params: [{ key: 'mode', label: 'Action', type: 'select', default: 'toggle', options: [['toggle', 'Like / unlike'], ['like', 'Like only'], ['unlike', 'Remove the like']] }],
    state: () => 'spotify.liked',
    defaults: { label: 'Like', icon: '💚', color: '#4a5568', colorOn: '#1db954', labelOn: 'Liked' },
    async run(p, ctx) {
      await ctx.spotifyLike(p.mode === 'like' || p.mode === 'unlike' ? p.mode : 'toggle');
    },
  },
  {
    id: 'spotify.shuffle',
    category: 'Spotify',
    label: 'Shuffle',
    description: 'Turns Spotify shuffle on or off. The button lights up while it is on.',
    icon: '🔀',
    needs: () => NEEDS,
    params: [{ key: 'mode', label: 'Action', type: 'select', default: 'toggle', options: [['toggle', 'Flip it'], ['on', 'Turn on'], ['off', 'Turn off']] }],
    state: () => 'spotify.shuffle',
    defaults: { label: 'Shuffle', icon: '🔀', color: '#4a5568', colorOn: '#1db954', labelOn: 'Shuffle on' },
    async run(p, ctx) {
      await ctx.mediaControl('spotify', 'shuffle', p.mode === 'on' || p.mode === 'off' ? p.mode : '');
    },
  },
  {
    id: 'spotify.repeat',
    category: 'Spotify',
    label: 'Repeat',
    description: 'Cycle repeat (off → all → one), or jump to a specific mode. The button lights up while repeat is on.',
    icon: '🔁',
    needs: () => NEEDS,
    params: [{ key: 'mode', label: 'Mode', type: 'select', default: 'cycle', options: [['cycle', 'Next mode each press'], ...Object.entries(REPEAT_LABEL)] }],
    state: () => 'spotify.repeat',
    defaults: { label: 'Repeat', icon: '🔁', color: '#4a5568', colorOn: '#1db954' },
    async run(p, ctx) {
      await ctx.mediaControl('spotify', 'repeat', p.mode && p.mode !== 'cycle' ? p.mode : '');
    },
  },
  {
    id: 'spotify.seek',
    category: 'Spotify',
    label: 'Skip forward / back',
    description: 'Jump a few seconds forward or back in the current song.',
    icon: '⏩',
    needs: () => NEEDS,
    params: [
      { key: 'direction', label: 'Direction', type: 'select', default: 'forward', options: [['forward', 'Forward'], ['back', 'Back']] },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 1, max: 600, default: 10 },
    ],
    defaults: { label: '+10s', icon: '⏩', color: '#1a6b3a' },
    async run(p, ctx) {
      const s = Math.max(1, Math.min(600, Number(p.seconds) || 10));
      await ctx.mediaControl('spotify', 'seekby', (p.direction === 'back' ? -s : s) * 1000);
    },
  },
  {
    id: 'spotify.volume',
    category: 'Spotify',
    label: 'Volume (Spotify only)',
    description: "Change the Spotify app's own volume, or mute it, without touching the rest of your audio.",
    icon: '🔊',
    needs: 'audio',
    params: [
      { key: 'mode', label: 'Action', type: 'select', default: 'up', options: [['up', 'Raise by'], ['down', 'Lower by'], ['set', 'Set to'], ['toggleMute', 'Mute / unmute']] },
      { key: 'amount', label: 'Amount (%)', type: 'number', min: 0, max: 100, default: 10, showIf: { key: 'mode', in: ['up', 'down', 'set'] } },
    ],
    defaults: { label: 'Vol', icon: '🔊', color: '#1a6b3a' },
    async run(p, ctx) {
      const amount = Number(p.amount);
      const args = { process: 'spotify' };
      if (p.mode === 'toggleMute') args.toggleMute = true;
      else {
        if (!Number.isFinite(amount)) throw new Error('Amount must be a number');
        if (p.mode === 'set') args.volume = amount;
        else args.delta = p.mode === 'down' ? -amount : amount;
      }
      await ctx.helper.call('audio.setSession', args);
    },
  },
];

module.exports = actions;
