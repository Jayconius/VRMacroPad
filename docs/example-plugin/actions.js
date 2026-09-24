// One action: announce the current reading as a toast (stand-in for "post it to chat", "flash a light",
// whatever your own plugin would actually do with the data).
module.exports = [
  {
    id: 'weather.announce',
    category: 'Weather (example)',
    label: 'Announce the weather',
    description: 'Shows the current temperature and condition as a toast.',
    icon: '⛅',
    needs: 'weather', // matches what sync(needs) in runtime.js checks for
    params: [],
    defaults: { label: 'Weather', icon: '⛅', color: '#2b5a7a' },
    async run(params, ctx) {
      const snap = ctx.plugin('weather').snapshot();
      if (!snap.available) throw new Error(snap.error || 'Weather is not available yet');
      ctx.toast(`${snap.tempC}°C, ${snap.condition}`, 'info');
    },
  },
];
