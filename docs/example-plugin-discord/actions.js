module.exports = [
  {
    id: 'mydiscord.send',
    category: 'My Discord',
    label: 'Send a message',
    description: 'Posts a message to your Discord channel through the webhook set up in Settings → Plugins.',
    icon: '💬',
    params: [
      { key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: 'Going live now! 🔴', help: 'Up to 2000 characters. Discord formatting works (**bold**, links...).' },
    ],
    // The button lights up while the last message was delivered; the runtime sets this key.
    state: () => 'mydiscord.lastOk',
    defaults: { label: 'Announce', icon: '💬', color: '#4a5568', colorOn: '#5865f2' },
    async run(params, ctx) {
      if (!String(params.message || '').trim()) throw new Error('Type a message first.');
      await ctx.plugin('mydiscord').send(params.message);
      ctx.toast('Sent to Discord', 'info');
    },
  },
];
