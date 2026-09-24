const ago = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const problem = (rt) => {
  if (!rt) return { subtitle: 'Kick is switched off', status: 'warn' };
  const s = rt.snapshot();
  if (!s.connected) return { subtitle: 'Kick is not connected (Settings → Plugins → Kick)', status: 'warn' };
  return null;
};

module.exports = [
  {
    id: 'kick.stream',
    category: 'Kick',
    label: 'Kick stream',
    description: 'Shows whether you are live on Kick, your viewer count, and your title and category.',
    icon: '🟢',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { label: 'Kick', color: '#0e5a24' },
    interaction: 'none',
    needs: () => ({ kick: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('kick');
      const bad = problem(rt);
      if (bad) return bad;
      const s = rt.snapshot();
      if (!s.channel) return { subtitle: s.error || 'Loading…', status: s.error ? 'error' : undefined };
      const c = s.channel;
      if (!c.live) return { value: 'Offline', subtitle: [c.title, c.category && c.category.name].filter(Boolean).join(' · '), status: 'warn' };
      return {
        value: `${c.viewers} watching`,
        subtitle: [c.title, c.category && c.category.name].filter(Boolean).join(' · '),
        status: 'ok',
        items: c.startedAt ? [{ label: 'Live for', value: ago(ctx.now() - c.startedAt) }] : undefined,
      };
    },
    async command() { /* display only */ },
  },
  {
    id: 'kick.ads',
    category: 'Kick',
    label: 'Kick ad breaks',
    description: 'Shows how many ad breaks Kick still lets you run.',
    icon: '📺',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { label: 'Kick ads', color: '#0e5a24' },
    interaction: 'none',
    needs: () => ({ kick: true, kickAds: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('kick');
      const bad = problem(rt);
      if (bad) return bad;
      const a = rt.snapshot().ads;
      if (!a) return { subtitle: 'Loading…' };
      if (a.error) return { subtitle: a.error, status: 'error' };
      if (a.blocked) return { value: 'Blocked', subtitle: 'Kick is not allowing ad breaks right now', status: 'warn' };
      if (!a.optedIn) return { value: 'Not enrolled', subtitle: 'Your channel is not enrolled in Kick ads', status: 'warn' };
      return { value: String(a.remaining), subtitle: a.remaining === 1 ? 'ad break left' : 'ad breaks left', status: a.remaining > 0 ? 'ok' : 'warn' };
    },
    async command() { /* display only */ },
  },
];
