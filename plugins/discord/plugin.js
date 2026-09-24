// Discord: post premade messages, cards and pictures to your channels through webhooks (a pasted URL per
// channel, so no login and no bot), share new screenshots automatically, and press your Discord shortcuts
// (mute, deafen, push to talk). Nothing here reads your Discord; it only sends.
const { DiscordRuntime } = require('./runtime');

module.exports = {
  id: 'discord',
  name: 'Discord',
  version: '1.0.0',
  description: 'Post "I\'m live" messages, cards and screenshots to Discord, and press your mute, deafen and push-to-talk shortcuts.',
  icon: '💬',

  instructions: () => 'To post: in Discord open a channel\'s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, and paste it below. Each channel you want to post to needs its own webhook. To mute, deafen or talk from the deck: in Discord open Settings → Keybinds, add the action, choose the same shortcut as here, and turn on "Global" so it works inside games. If a game runs as administrator, VR Macro Pad may need to as well for the shortcut to reach it.',

  settingsFields: [
    { key: 'webhookUrl', label: 'Webhook URL (main channel)', type: 'password', placeholder: 'https://discord.com/api/webhooks/…', help: 'Anyone with this URL can post to the channel, so it is kept out of exported layouts.' },
    { key: 'mainName', label: 'Main channel name', type: 'text', default: 'Main channel', help: 'The name shown in the Channel list on buttons.' },
    { key: 'name2', label: 'Channel 2 name', type: 'text', placeholder: 'e.g. Screenshots' },
    { key: 'url2', label: 'Channel 2 Webhook URL', type: 'password' },
    { key: 'name3', label: 'Channel 3 name', type: 'text' },
    { key: 'url3', label: 'Channel 3 Webhook URL', type: 'password' },
    { key: 'name4', label: 'Channel 4 name', type: 'text' },
    { key: 'url4', label: 'Channel 4 Webhook URL', type: 'password' },
    { key: 'username', label: 'Post as', type: 'text', default: 'VR Macro Pad', help: 'The name shown next to messages.' },
    { key: 'avatarUrl', label: 'Picture for posts (link, optional)', type: 'text', placeholder: 'https://…/me.png', help: 'A link to an image on the web.' },

    { key: 'muteKey', label: 'Mute shortcut', type: 'keys', default: 'ctrl+shift+m', help: 'Click, then press the shortcut you set for Toggle Mute in Discord.' },
    { key: 'deafenKey', label: 'Deafen shortcut', type: 'keys', default: 'ctrl+shift+d', help: 'The shortcut you set for Toggle Deafen in Discord.' },
    { key: 'talkKey', label: 'Push-to-talk / mic shortcut', type: 'keys', help: 'The shortcut you set for Push to Talk in Discord (Discord has none by default).' },

    { key: 'screenshotFolders', label: 'Screenshot folders to watch', type: 'textarea', default: '{steam}\\userdata\\*\\760\\remote\\*\\screenshots', help: 'For "Share new screenshots automatically". One folder per line. {steam} is looked up on this PC, so it works wherever Steam is. {pictures} is your Pictures folder, a * stands for any folder name, and sub-folders are included. The default covers Steam and SteamVR screenshots; add a line for any other game. VRChat photos are handled separately (their own button, or a switch on the auto-share button).' },
    { key: 'steamFolder', label: 'Steam folder (only if it is not found automatically)', type: 'text', placeholder: 'e.g. D:\\Games\\Steam', help: 'The folder Steam is installed in (the one that contains "userdata"). Leave empty to use the one Windows reports.' },
    { key: 'vrchatFolder', label: 'VRChat photo folder (only if it is not found automatically)', type: 'text', placeholder: 'e.g. D:\\Pictures\\VRChat', help: 'Leave empty to use the folder VRChat is set to save in (Pictures\\VRChat by default).' },
    { key: 'autoChannel', label: 'Default channel for automatic screenshots', type: 'select', optionsFrom: 'discord.channels', emptyLabel: 'Main channel', help: 'Used when the auto-share button does not pick a channel itself. Pick a private channel unless you mean it to be public.' },
    { key: 'autoCaption', label: 'Default caption for automatic screenshots', type: 'text', placeholder: 'e.g. New screenshot at {time}', help: 'Optional. {time} and {date} work here.' },
  ],

  testOptionKind: 'discord.test',
  optionLists: {
    // "Save and test connection": checks the main webhook; nothing is posted.
    'discord.test': (ctx) => ctx.plugins.get('discord').check(),
    // The Channel dropdown on buttons.
    'discord.channels': (ctx) => ctx.plugins.get('discord').channels(),
  },

  actions: require('./actions'),

  stateKeys: [
    { key: 'discord.lastOk', label: 'The last Discord post was delivered', group: 'Discord' },
    { key: 'discord.autoShare', label: 'Screenshots are being shared automatically', group: 'Discord' },
  ],

  createRuntime(ctx) {
    return new DiscordRuntime(ctx);
  },
};
