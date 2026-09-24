// How one notification reads on a widget, whatever kind it is.
function describe(n) {
  if (n.type === 'event') return { value: n.body ? `Event: ${n.body}` : 'Event starting', subtitle: `starting in ${n.sender}`, status: 'ok' };
  const where = n.channel ? `${n.channel}: ` : '';
  const hot = n.type === 'everyone' || n.type === 'mention'; // stand out: someone pinged everyone, or you
  return { value: n.sender || n.app, subtitle: n.body ? `${where}${n.body}` : (n.channel || n.app), status: hot ? 'warn' : 'ok' };
}

const problem = (rt) => {
  if (!rt) return { subtitle: 'Discord Notifications is switched off', status: 'warn' };
  const s = rt.snapshot();
  return s.state === 'error' ? { subtitle: s.error || 'Not available', status: 'error' } : null;
};

module.exports = [
  {
    id: 'dnotify.last',
    category: 'Discord notifications',
    label: 'Last Discord notification',
    description: 'Shows who last messaged you on Discord and what they said: DMs, channel messages, @everyone, mentions and server events (any you switch off in Settings are left out). Tap to clear it.',
    icon: '🔔',
    size: { w: 2, h: 1 },
    params: [],
    defaults: { label: 'Discord', color: '#3b3f8f' },
    interaction: 'tap',
    needs: () => ({ dnotify: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('discord-notifications');
      const bad = problem(rt);
      if (bad) return bad;
      const s = rt.snapshot();
      if (!s.last) return { value: '', subtitle: s.state === 'connected' ? 'No new notifications' : 'Starting…' };
      return describe(s.last);
    },
    async command(ctx, button, state, cmd) {
      if (cmd !== 'tap') return;
      const rt = ctx.plugin('discord-notifications');
      if (rt) rt.clear();
    },
  },
  {
    id: 'dnotify.recent',
    category: 'Discord notifications',
    label: 'Recent Discord notifications',
    description: 'A short list of the last few Discord notifications, newest first. Best on a wider or taller button. Tap to clear.',
    icon: '📜',
    size: { w: 2, h: 2 },
    params: [],
    defaults: { label: 'Discord', color: '#3b3f8f' },
    interaction: 'tap',
    needs: () => ({ dnotify: true }),
    initState: () => ({}),
    data(ctx) {
      const rt = ctx.plugin('discord-notifications');
      const bad = problem(rt);
      if (bad) return bad;
      const s = rt.snapshot();
      if (!s.recent.length) return { value: '', subtitle: s.state === 'connected' ? 'No new notifications' : 'Starting…' };
      return {
        value: String(s.recent.length),
        subtitle: s.recent.length === 1 ? 'notification' : 'notifications',
        status: s.recent.some((n) => n.type === 'everyone' || n.type === 'mention') ? 'warn' : 'ok',
        items: s.recent.map((n) => (n.type === 'event'
          ? { label: `Event · ${n.sender}`, value: n.body }
          : { label: n.sender || n.app, value: n.body || n.channel })),
      };
    },
    async command(ctx, button, state, cmd) {
      if (cmd !== 'tap') return;
      const rt = ctx.plugin('discord-notifications');
      if (rt) rt.clear();
    },
  },
];
