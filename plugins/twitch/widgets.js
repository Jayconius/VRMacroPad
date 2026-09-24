// Ad-timer and stream-status widgets, moved unchanged from the old src/core/widgets.js.
module.exports = [
{
    id: 'twitch.ads',
    category: 'Twitch',
    label: 'Twitch ad timer',
    description: 'Counts down to your next ad break. Tap to snooze it.',
    icon: '📺',
    size: { w: 2, h: 2 },
    params: [{ key: 'tapAction', label: 'Tap does', type: 'select', default: 'snooze', options: [['snooze', 'Snooze the next ad'], ['none', 'Nothing (display only)']] }],
    defaults: { color: '#3a1f6b' },
    needs: () => ({ twitch: true, twitchAds: true }),
    initState: () => ({}),
    data: (ctx) => { const t = ctx.plugin('twitch'); return t ? t.adsData() : { connected: false, status: 'off' }; },
    async command(ctx, button, st, cmd) {
      if (cmd !== 'tap' || button.widget.params.tapAction === 'none') return;
      const t = ctx.plugin('twitch');
      if (!t) throw new Error('Twitch is not available (not loaded, or disabled in Settings → Plugins)');
      await t.call((c) => c.snoozeAd());
      t.refresh();
    },
  },
{
    id: 'twitch.stream',
    category: 'Twitch',
    label: 'Twitch stream status',
    description: 'Shows whether you are live, your viewer count and how long you have been streaming.',
    icon: '🔴',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { color: '#3a1f6b' },
    needs: () => ({ twitch: true, twitchStream: true }),
    initState: () => ({}),
    data: (ctx) => { const t = ctx.plugin('twitch'); return t ? t.streamData() : { connected: false, status: 'off' }; },
    command: async () => {},
  }
];
