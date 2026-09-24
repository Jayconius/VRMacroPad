// Twitch: chat, chat modes, shield mode, ads, clips, raids, and the ad-timer / stream-status mini screens.
// Sign-in is a device-code flow: no client secret, no redirect server. See client.js for the full flow, and
// docs/PLUGIN-GUIDE.md if you want the same pattern for your own plugin.
const { TwitchRuntime } = require('./runtime');

module.exports = {
  id: 'twitch',
  name: 'Twitch',
  version: '1.0.0',
  description: 'Chat, chat modes, shield mode, ads, clips, raids, and the ad-timer widget.',
  icon: '💜',
  instructions: (st) => (st.hasBuiltIn
    ? 'Press Connect, then approve access on twitch.tv with the short code shown. You stay in control: Twitch lists exactly what you are allowing, and you can revoke it any time in your Twitch settings.'
    : 'Create a free app at dev.twitch.tv/console: Client Type "Public", OAuth Redirect URL http://localhost. Paste its Client ID here. You approve access once on twitch.tv with a short code; no secret is needed.'),
  actions: require('./actions'),
  widgets: require('./widgets'),
  stateKeys: [
    { key: 'twitch.connected', label: 'Twitch is connected', group: 'Twitch' },
    { key: 'twitch.live', label: 'You are live on Twitch', group: 'Twitch' },
    { key: 'twitch.adSoon', label: 'An ad break is coming up soon', group: 'Twitch' },
    { key: 'twitch.adRunning', label: 'An ad break is playing now', group: 'Twitch' },
    { key: 'twitch.emoteOnly', label: 'Emote-only mode is on', group: 'Twitch' },
    { key: 'twitch.followersOnly', label: 'Followers-only mode is on', group: 'Twitch' },
    { key: 'twitch.subsOnly', label: 'Subscribers-only mode is on', group: 'Twitch' },
    { key: 'twitch.slowMode', label: 'Slow mode is on', group: 'Twitch' },
    { key: 'twitch.uniqueChat', label: 'Unique chat is on', group: 'Twitch' },
    { key: 'twitch.shield', label: 'Shield mode is on', group: 'Twitch' },
  ],
  settingsFields: [
    // builtInAware: the generic Settings UI tucks this inside a collapsed "Advanced" details and adjusts
    // its placeholder while status().hasBuiltIn is true, instead of always showing it top-level.
    { key: 'clientId', label: 'Client ID', type: 'text', builtInAware: true, placeholder: 'from the Twitch developer console', help: 'Only needed if you registered your own application at dev.twitch.tv/console (Client Type "Public", OAuth Redirect URL http://localhost).' },
    { key: 'adWarnMinutes', label: 'Warn about an upcoming ad this many minutes ahead', type: 'number', min: 1, max: 60, default: 5 },
  ],
  connections: [{ id: 'main', label: 'Twitch account', flow: 'device' }],
  clientMethods: ['connect', 'disconnect', 'check'],
  externalDomains: ['www.twitch.tv', 'twitch.tv'],
  matchState(key) {
    if (!key.startsWith('twitch.')) return null;
    const patch = { twitch: true };
    if (key === 'twitch.adSoon' || key === 'twitch.ads' || key === 'twitch.adRunning') patch.twitchAds = true;
    else if (key === 'twitch.live' || key === 'twitch.stream') patch.twitchStream = true;
    else if (key !== 'twitch.connected') patch.twitchModes = true;
    return patch;
  },
  createRuntime(ctx) {
    return new TwitchRuntime(ctx);
  },
};
