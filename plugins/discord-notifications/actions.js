module.exports = [
  {
    id: 'dnotify.clear',
    category: 'Discord notifications',
    label: 'Clear Discord notifications',
    description: 'Forgets the recent Discord notifications, so the widgets and any button following "Unread Discord notification" reset.',
    icon: '🔕',
    needs: 'dnotify',
    params: [],
    state: () => 'dnotify.unread',
    defaults: { label: 'Clear', icon: '🔕', color: '#4a5568', colorOn: '#d69e2e' },
    async run(params, ctx) {
      ctx.plugin('discord-notifications').clear();
    },
  },
];
