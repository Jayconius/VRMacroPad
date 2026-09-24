// Kick, through Kick's OFFICIAL public API. Sign in with your own Kick developer app (Client ID + Secret).
// Kick's API offers a lot less than Twitch's, so this plugin has fewer buttons: see `description`.
const { KickRuntime } = require('./runtime');

module.exports = {
  id: 'kick',
  name: 'Kick',
  version: '1.0.0',
  description: 'Chat, title and category, ad breaks and timeouts, live status and viewers, through Kick\'s official API.',
  icon: '🟢',

  instructions: (st = {}) => (st.hasBuiltIn
    ? 'Press Connect, then log in and approve access on kick.com. You stay in control: Kick lists exactly what you are allowing, and you can revoke it any time in your Kick settings. Kick\'s official API does not offer announcements, snoozing ads, chat modes (emote-only, slow mode and so on), shield mode, clear chat, clips, markers, raids or shoutouts, so they are not here.'
    : [
      'Kick lets apps sign in only with an app you create yourself:',
      '1) On kick.com turn on 2FA (Account settings → Security), then open Account settings → Developer → Create App.',
      '2) Name it with one word (no spaces), give it any description, and as the Redirect URL enter exactly the address shown below.',
      '3) Tick these permissions: Read user information, Read channel information, Update channel information, Write to Chat feed, Execute moderation actions for moderators, Read ads related information, and Read/add ads. Leave webhooks off.',
      '4) Copy the app\'s Client ID and Client Secret into the boxes below (the secret is saved in your settings file on this PC, not encrypted, and left out of exported layouts), then press Connect and approve on Kick.',
      'What Kick\'s official API does not offer, so it is not here: announcements, snoozing ads, chat modes (emote-only, slow mode and so on), shield mode, clear chat, clips, markers, raids and shoutouts.',
    ].join('\n')),

  settingsFields: [
    { key: 'clientId', label: 'Client ID (from your Kick app)', type: 'text', builtInAware: true, help: 'Only needed if you made your own Kick app (Kick → Account settings → Developer). If this build comes with its own Kick app built in, leave both empty.' },
    { key: 'clientSecret', label: 'Client Secret (from your Kick app)', type: 'password', builtInAware: true },
  ],

  connections: [{ id: 'main', label: 'Kick account', flow: 'redirect' }],
  clientMethods: ['connect', 'disconnect'],
  externalDomains: ['id.kick.com'],

  actions: require('./actions'),
  widgets: require('./widgets'),

  stateKeys: [
    { key: 'kick.connected', label: 'Kick is connected', group: 'Kick' },
    { key: 'kick.live', label: 'You are live on Kick', group: 'Kick' },
  ],

  matchState(key) {
    return key.startsWith('kick.') ? { kick: true } : null;
  },

  createRuntime(ctx) {
    return new KickRuntime(ctx);
  },
};
