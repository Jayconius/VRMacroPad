// Discord webhook plugin: a button that posts a message to a Discord channel.
// The "manual API setup" style — you paste a webhook URL once, there is no login flow.
// Walkthrough: docs/BUILD-A-PLUGIN.md
const { DiscordRuntime } = require('./runtime');

module.exports = {
  id: 'mydiscord',
  name: 'My Discord Webhook',
  version: '1.0.0',
  description: 'Post a message to a Discord channel with one button.',
  icon: '💬',

  instructions: () => 'In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, then paste it below.',

  settingsFields: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'password', placeholder: 'https://discord.com/api/webhooks/…', help: 'Anyone with this URL can post to the channel, so it is kept out of exported layouts.' },
    { key: 'username', label: 'Post as', type: 'text', default: 'VR Macro Pad', help: 'The name shown next to the message.' },
  ],

  testOptionKind: 'mydiscord.test',
  optionLists: {
    // "Save and test connection" calls this; it sends nothing, it just checks the URL is reachable.
    'mydiscord.test': (ctx) => ctx.plugins.get('mydiscord').check(),
  },

  actions: require('./actions'),

  stateKeys: [
    { key: 'mydiscord.lastOk', label: 'The last Discord message was delivered', group: 'My Discord' },
  ],

  createRuntime(ctx) {
    return new DiscordRuntime(ctx);
  },
};
