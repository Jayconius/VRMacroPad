// YouTube: live chat, going live and ending the stream, ad breaks, title / description / category, and who can watch.
// Connect your account in Settings → Plugins → YouTube first. Nothing here targets a particular viewer (no bans,
// timeouts or deleting one person's message): those are too fiddly for a button. YouTube's API also has no chat modes
// (slow mode, subscribers-only...), raids, shoutouts, clips or markers, so there are no buttons for those.
const { CATEGORIES } = require('./client');

const actions = [
  {
    id: 'youtube.chat',
    category: 'YouTube',
    label: 'Send chat message',
    description: 'Says something in the live chat of your current stream (hi, welcome, socials...).',
    icon: '💬',
    needs: 'youtube',
    params: [{ key: 'message', label: 'Message', type: 'textarea', required: true, help: 'Up to 200 characters (YouTube\'s limit). Chain several steps with a delay for a sequence of messages.' }],
    defaults: { label: 'Say hi', icon: '👋', color: '#b91c1c' },
    async run(p, ctx) {
      if (!String(p.message || '').trim()) throw new Error('Type a message first');
      await ctx.plugin('youtube').call((c) => c.sendChat(p.message));
    },
  },
  {
    id: 'youtube.goLive',
    category: 'YouTube',
    label: 'Go live',
    description: 'Starts your broadcast (the same as pressing "Go live" in YouTube Studio). Your streaming software must already be sending video.',
    icon: '🔴',
    needs: 'youtube',
    params: [],
    state: () => 'youtube.live',
    defaults: { label: 'Go live', icon: '🔴', color: '#4a5568', colorOn: '#b91c1c', labelOn: 'LIVE', confirm: 'hold' },
    async run(p, ctx) {
      const rt = ctx.plugin('youtube');
      const b = await rt.call((c) => c.transition('live'));
      rt.refresh();
      ctx.toast(`Going live: ${b.title || 'your broadcast'}`, 'info');
    },
  },
  {
    id: 'youtube.endStream',
    category: 'YouTube',
    label: 'End stream',
    description: 'Ends your live broadcast.',
    icon: '⏹️',
    needs: 'youtube',
    params: [],
    state: () => 'youtube.live', // lit while you are live, which is when you would press it
    defaults: { label: 'End stream', icon: '⏹️', color: '#4a5568', colorOn: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      const rt = ctx.plugin('youtube');
      await rt.call((c) => c.transition('complete'));
      rt.refresh();
      ctx.toast('Stream ended.', 'info');
    },
  },
  {
    id: 'youtube.adBreak',
    category: 'YouTube',
    label: 'Run an ad break',
    description: 'Starts an ad break now (you must be live, and your channel must be monetized).',
    icon: '📺',
    needs: 'youtube',
    params: [{ key: 'length', label: 'Length', type: 'select', default: '30', options: [['15', '15 seconds'], ['30', '30 seconds'], ['60', '1 minute'], ['90', '1.5 minutes'], ['120', '2 minutes'], ['180', '3 minutes']] }],
    defaults: { label: 'Run ad', icon: '📺', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      await ctx.plugin('youtube').call((c) => c.adBreak(Number(p.length)));
      ctx.toast('Ad break started.', 'info');
    },
  },
  {
    id: 'youtube.details',
    category: 'YouTube',
    label: 'Change title / description / category',
    description: 'Updates the title, description and/or category of your live (or next upcoming) stream. Leave a box empty to leave that part alone.',
    icon: '✏️',
    needs: 'youtube',
    params: [
      { key: 'title', label: 'Title (optional)', type: 'text', help: 'Up to 100 characters.' },
      { key: 'description', label: 'Description (optional)', type: 'textarea', help: 'Replaces the whole description.' },
      { key: 'category', label: 'Category', type: 'select', default: '', options: [['', '(leave as it is)'], ...CATEGORIES] },
    ],
    defaults: { label: 'Set title', icon: '✏️', color: '#b91c1c' },
    async run(p, ctx) {
      await ctx.plugin('youtube').call((c) => c.updateDetails({ title: p.title, description: p.description, categoryId: p.category }));
      ctx.plugin('youtube').refresh();
      ctx.toast('Stream updated.', 'info');
    },
  },
  {
    id: 'youtube.privacy',
    category: 'YouTube',
    label: 'Who can watch (public / unlisted / private)',
    description: 'Changes the visibility of your live (or next upcoming) stream.',
    icon: '👁️',
    needs: 'youtube',
    params: [{ key: 'privacy', label: 'Visibility', type: 'select', default: 'public', options: [['public', 'Public'], ['unlisted', 'Unlisted (only people with the link)'], ['private', 'Private (only you)']] }],
    defaults: { label: 'Public', icon: '👁️', color: '#b91c1c', confirm: 'hold' },
    async run(p, ctx) {
      await ctx.plugin('youtube').call((c) => c.setPrivacy(p.privacy));
      ctx.plugin('youtube').refresh();
      ctx.toast(`Stream is now ${p.privacy}.`, 'info');
    },
  },
];

module.exports = actions;
