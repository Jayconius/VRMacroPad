// Buttons for Kick, using only Kick's official API. Things Kick's API does not offer (announcements, snoozing ads,
// chat modes like emote-only or slow mode, shield mode, clear chat, clips, markers, raids, shoutouts) are not here
// on purpose: see the plugin's description in Settings.
module.exports = [
  {
    id: 'kick.chat',
    category: 'Kick',
    label: 'Send chat message',
    description: 'Posts a message in your Kick chat, as you or as your Kick app\'s bot.',
    icon: '💬',
    needs: 'kick',
    params: [
      { key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: 'Thanks for watching!', help: 'Up to 500 characters.' },
      { key: 'as', label: 'Send as', type: 'select', default: 'user', options: [['user', 'You'], ['bot', 'The bot of your Kick app']] },
    ],
    defaults: { label: 'Kick chat', icon: '💬', color: '#1a8f3c' },
    async run(p, ctx) {
      const rt = ctx.plugin('kick');
      await rt.call((c) => c.sendChat(p.message, { as: p.as === 'bot' ? 'bot' : 'user' }));
      ctx.toast('Sent to Kick chat', 'info');
    },
  },
  {
    id: 'kick.channel',
    category: 'Kick',
    label: 'Change title / category',
    description: 'Changes your stream title, category or tags. Leave a box empty to leave that part alone.',
    icon: '📝',
    needs: 'kick',
    params: [
      { key: 'title', label: 'Title', type: 'text', placeholder: 'Playing VRChat with friends' },
      { key: 'category', label: 'Category', type: 'text', placeholder: 'Just Chatting', help: 'The category name, as on Kick. The closest match is used.' },
      { key: 'tags', label: 'Tags', type: 'text', placeholder: 'vr, chill, english', help: 'Separated by commas, up to 10. This replaces your current tags.' },
    ],
    defaults: { label: 'Set stream info', icon: '📝', color: '#1a8f3c' },
    async run(p, ctx) {
      const rt = ctx.plugin('kick');
      const tags = String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      const done = [];
      await rt.call(async (c) => {
        let category = null;
        if (String(p.category || '').trim()) category = await c.findCategory(p.category);
        await c.updateChannel({ title: p.title, categoryId: category && category.id, tags });
        if (String(p.title || '').trim()) done.push('title');
        if (category) done.push(`category ${category.name}`);
        if (tags.length) done.push('tags');
      });
      rt.refresh();
      ctx.toast(`Kick updated: ${done.join(', ')}`, 'info');
    },
  },
  {
    id: 'kick.adRun',
    category: 'Kick',
    label: 'Run an ad break',
    description: 'Starts an ad break now. Kick limits how many you can run; the "Kick ad breaks" mini screen shows how many are left.',
    icon: '📺',
    needs: () => ({ kick: true, kickAds: true }),
    params: [{ key: 'length', label: 'Length', type: 'select', default: '60', options: [['30', '30 seconds'], ['60', '1 minute'], ['90', '1.5 minutes'], ['120', '2 minutes'], ['180', '3 minutes'], ['300', '5 minutes']] }],
    defaults: { label: 'Run ad', icon: '📺', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      const rt = ctx.plugin('kick');
      const r = await rt.call((c) => c.adBreak(Number(p.length)));
      rt.pollAds();
      ctx.toast(r && r.remaining_ad_breaks !== undefined ? `Ad break started. ${r.remaining_ad_breaks} left.` : 'Ad break started', 'info');
    },
  },
  {
    id: 'kick.timeout',
    category: 'Kick',
    label: 'Time out a viewer',
    description: 'Stops someone chatting for a while.',
    icon: '⏳',
    needs: 'kick',
    params: [
      { key: 'username', label: 'Channel name', type: 'text', required: true, placeholder: 'their Kick channel name', help: 'The viewer must have a Kick channel.' },
      { key: 'minutes', label: 'Minutes', type: 'number', min: 1, max: 10080, default: 10 },
      { key: 'reason', label: 'Reason (optional)', type: 'text' },
    ],
    defaults: { label: 'Timeout', icon: '⏳', color: '#b7791f', confirm: 'hold' },
    async run(p, ctx) {
      const t = await ctx.plugin('kick').call((c) => c.ban(p.username, { minutes: Number(p.minutes) || 10, reason: p.reason }));
      ctx.toast(`Timed out ${t.slug || p.username} for ${Number(p.minutes) || 10} min`, 'info');
    },
  },
];
