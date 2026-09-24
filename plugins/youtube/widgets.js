const ago = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const compact = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M` : n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n));

const problem = (rt) => {
  if (!rt) return { subtitle: 'YouTube is switched off', status: 'warn' };
  const s = rt.snapshot();
  if (!s.connected) return { subtitle: 'YouTube is not connected (Settings → Plugins → YouTube)', status: 'warn' };
  return null;
};

const HEALTH = { good: 'Good', ok: 'OK', bad: 'Bad', noData: 'No video' };

module.exports = [
  {
    id: 'youtube.stream',
    category: 'YouTube',
    label: 'YouTube stream status',
    description: 'Shows whether you are live, your viewer count, likes, how long you have been streaming and how healthy the stream is.',
    icon: '🔴',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { label: 'YouTube', color: '#7f1d1d' },
    interaction: 'none',
    needs: () => ({ youtube: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('youtube');
      const bad = problem(rt);
      if (bad) return bad;
      const s = rt.snapshot();
      if (s.error && !s.broadcast) return { subtitle: s.error, status: 'error' };
      const b = s.broadcast;
      if (!b) return { value: 'Offline', subtitle: 'No live or upcoming broadcast set up', status: 'warn' };
      if (!b.live) return { value: 'Offline', subtitle: b.title ? `Next: ${b.title}` : 'A broadcast is set up', status: 'warn' };
      const items = [];
      if (b.startedAt) items.push({ label: 'Live for', value: ago(ctx.now() - b.startedAt) });
      items.push({ label: 'Likes', value: String(s.likes) });
      if (s.health && s.health.health) items.push({ label: 'Health', value: HEALTH[s.health.health] || s.health.health });
      return {
        value: `${s.viewers} watching`,
        subtitle: b.title,
        status: s.health && (s.health.health === 'bad' || s.health.health === 'noData') ? 'warn' : 'ok',
        items,
      };
    },
    async command() { /* display only */ },
  },
  {
    id: 'youtube.channel',
    category: 'YouTube',
    label: 'YouTube channel numbers',
    description: 'Shows your subscriber count, total views and number of videos.',
    icon: '👥',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { label: 'YouTube', color: '#7f1d1d' },
    interaction: 'none',
    needs: () => ({ youtube: true, youtubeStats: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('youtube');
      const bad = problem(rt);
      if (bad) return bad;
      const st = rt.snapshot().stats;
      if (!st) return { subtitle: 'Loading…' };
      if (st.error) return { subtitle: st.error, status: 'error' };
      return {
        value: st.subscribers === null ? 'Subs hidden' : `${compact(st.subscribers)} subscribers`,
        subtitle: `${compact(st.views)} views · ${st.videos} videos`,
        status: 'ok',
      };
    },
    async command() { /* display only */ },
  },
];
