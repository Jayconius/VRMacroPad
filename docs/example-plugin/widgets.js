// One widget: a small "now showing" screen for the current reading.
//
// You don't write any drawing code. Return plain data from data() and the app draws it:
//   value     the big text            subtitle  the smaller line under it
//   progress  0..1, draws a bar       status    'ok' | 'warn' | 'error' colors the value
//   items     [{ label, value }] rows title     used as the subtitle if there is none
module.exports = [
  {
    id: 'weather.now',
    label: 'Weather (example)',
    description: 'Shows the current temperature and condition. Tap to refresh.',
    icon: '⛅',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { color: '#2b5a7a' },
    interaction: 'tap',                 // 'none' (default) | 'tap' | 'tap-hold'
    needs: () => ({ weather: true }),   // a widget on the page is enough to start polling, same as a button
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('weather');  // null if the plugin is off; a widget's data() must never throw
      if (!rt) return { subtitle: 'Weather is switched off', status: 'warn' };
      const s = rt.snapshot();
      if (!s.available) return { subtitle: s.error || 'Loading…', status: 'error' };
      return { value: `${s.tempC}°C`, subtitle: s.condition, status: s.tempC >= 25 ? 'warn' : 'ok' };
    },
    async command(ctx, button, state, cmd) {
      if (cmd !== 'tap') return;
      const rt = ctx.plugin('weather');
      if (rt) await rt.poll();
    },
  },
];
