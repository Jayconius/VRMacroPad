// Discord Notifications: shows who last messaged you on Discord (DMs, channel messages, @everyone, mentions and
// server events) and lets buttons react to it. It reads the notifications Windows shows for the Discord app, so
// there is no Discord login, bot or key. Only Discord's notifications are kept; everything else is dropped.
const { DiscordNotifyRuntime } = require('./runtime');

module.exports = {
  id: 'discord-notifications',
  name: 'Discord Notifications',
  version: '1.0.0',
  description: 'Show who last messaged you on Discord and light buttons up when a message, mention or event arrives.',
  icon: '🔔',

  instructions: () => 'Reads the notifications Windows shows for the Discord app, so Discord must have desktop notifications turned on and Windows Do Not Disturb / Focus Assist must be off. Windows asks once to allow notification access. Only Discord\'s notifications are kept; every other app\'s notifications are discarded the moment they arrive, and nothing is stored or logged. Discord only sends a notification for messages it would normally alert you about (DMs, @mentions, and channels set to notify), so a muted channel never shows here.',

  settingsFields: [
    { key: 'ignoreDms', label: 'Ignore direct messages (DMs)', type: 'boolean', default: false },
    { key: 'ignoreChannel', label: 'Ignore other channel messages', type: 'boolean', default: false, help: 'Channel messages that are not an @everyone or a mention of you.' },
    { key: 'ignoreEveryone', label: 'Ignore @everyone and @here', type: 'boolean', default: false },
    { key: 'ignoreMentions', label: 'Ignore @you (mentions of you)', type: 'boolean', default: false, help: 'Needs your Discord name below, because Discord does not say who you are.' },
    { key: 'ignoreEvents', label: 'Ignore server events', type: 'boolean', default: false, help: 'The "Your event is starting in…" reminders.' },
    { key: 'myName', label: 'Your Discord name', type: 'text', placeholder: 'the name people @ you by', help: 'Used to recognise when a message mentions you (@name). Leave empty if you do not use the mention filter or the mention state.' },
    { key: 'showText', label: 'Show the message text', type: 'boolean', default: true, help: 'Turn off to show only who it is from, for example while streaming.' },
    { key: 'clearAfterMin', label: 'Forget them after (minutes)', type: 'number', min: 0, max: 1440, default: 30, help: '0 keeps them until you tap the widget.' },
  ],

  actions: require('./actions'),
  widgets: require('./widgets'),

  stateKeys: [
    { key: 'dnotify.unread', label: 'There is an unread Discord notification', group: 'Discord notifications' },
    { key: 'dnotify.from', label: 'Latest Discord notification is from…', group: 'Discord notifications', arg: 'text' },
    { key: 'dnotify.type', label: 'Latest Discord notification is a… (dm, channel, everyone, mention or event)', group: 'Discord notifications', arg: 'text' },
  ],

  matchState(key) {
    if (key === 'dnotify.unread' || key === 'dnotify.from' || key === 'dnotify.type') return { dnotify: true };
    return null;
  },

  createRuntime(ctx) {
    return new DiscordNotifyRuntime(ctx);
  },
};
