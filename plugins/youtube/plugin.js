// YouTube, through YouTube's OFFICIAL Data API. You connect with your own Google Cloud sign-in details (a Client ID and a Client
// Secret; the "Instructions" button walks through making them), or, if the author gave you an access key, with the author's
// private sign-in helper. It mirrors the Twitch plugin where YouTube's API allows it: see `description` and the notes in actions.js.
const { YouTubeRuntime } = require('./runtime');

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const CLOUD = 'https://console.cloud.google.com';

module.exports = {
  id: 'youtube',
  name: 'YouTube',
  version: '1.0.0',
  description: 'Live chat, go live / end stream, ad breaks, title, description and category, visibility, live status and channel numbers, through YouTube\'s official API.',
  icon: '▶️',

  instructions: (st = {}) => (st.usingBuiltIn
    ? 'Signed in with the built-in YouTube login, using your access key. Clear the key under Advanced to go back to your own Client ID and Secret.'
    : [
      'To connect YouTube you need your own free Google sign-in details: a Client ID and a Client Secret. Press "Instructions" for a step-by-step guide with the links, paste both below, then press Connect and approve on Google.',
      'YouTube\'s API does not offer chat modes (slow mode, subscribers-only and so on), raids, shoutouts, clips or markers, so they are not here. Nothing that targets one viewer (bans, timeouts) is included on purpose.',
    ].join('\n')),

  guide: {
    button: 'Instructions',
    title: 'Connect YouTube: get your Client ID and Secret',
    intro: 'Google needs every app that talks to YouTube to have its own sign-in details. Making them is free, needs no payment card, and takes about ten minutes. You only do it once. Use the Google account that owns your YouTube channel.',
    steps: [
      {
        title: 'Create a Google Cloud project',
        text: 'Open the link, name the project "VR Macro Pad" and press Create. (Ignore the note about how many projects you have left.) Wait a few seconds until Google says it is ready.',
        links: [{ label: 'Open "New project"', url: `${CLOUD}/projectcreate` }],
      },
      {
        title: 'Turn on the YouTube Data API',
        text: 'Make sure "VR Macro Pad" is picked at the top of the page, then press Enable.',
        links: [{ label: 'Open YouTube Data API v3', url: `${CLOUD}/apis/library/youtube.googleapis.com` }],
      },
      {
        title: 'Set up the sign-in screen',
        text: 'Press "Get started" and fill in:\n• App name: VR Macro Pad\n• User support email: your email (people who sign in can see it, so use a spare address if you prefer)\n• Audience: External\n• Contact information: your email\nTick the agreement box and press Create.',
        links: [{ label: 'Open the sign-in screen setup', url: `${CLOUD}/auth/overview` }],
      },
      {
        title: 'Add the YouTube permission',
        text: 'Press "Add or remove scopes", scroll down to "Manually add scopes", paste the permission below, then press "Add to table", "Update" and "Save".',
        links: [{ label: 'Open Data Access', url: `${CLOUD}/auth/scopes` }],
        copy: { label: 'Copy the permission', text: SCOPE },
      },
      {
        title: 'Add yourself as a test user',
        text: 'Under "Test users" press "Add users", type the Google email that owns your YouTube channel, and Save. Until the app is published, only people on this list can connect, and Google signs them out every 7 days (just press Connect again).',
        links: [{ label: 'Open Audience', url: `${CLOUD}/auth/audience` }],
      },
      {
        title: 'Create the Client ID and Secret',
        text: 'Press "Create client", choose the application type "Desktop app", name it anything and press Create. Google then shows a Client ID and a Client secret. Copy both (or press "Download JSON" and keep that file private).',
        links: [{ label: 'Open Clients', url: `${CLOUD}/auth/clients` }],
      },
      {
        title: 'Paste them here and connect',
        text: 'Close this window, paste the Client ID and the Client Secret into the two boxes on the YouTube card, and press "Connect YouTube account". On Google\'s page choose your account. If it says "Google hasn\'t verified this app", press Advanced, then "Go to VR Macro Pad (unsafe)", then Allow. That warning is normal for an app you made yourself.',
      },
    ],
    outro: 'Your Client Secret is saved in the settings file on this PC (in plain text, like the OBS password), is left out when you export a layout, and only ever goes to Google. Do not share it or post it anywhere.',
  },

  settingsFields: [
    { key: 'clientId', label: 'Client ID (from your Google app)', type: 'text', help: 'From step 6 of the Instructions: it ends in .apps.googleusercontent.com.' },
    { key: 'clientSecret', label: 'Client Secret (from your Google app)', type: 'password', help: 'From step 6 of the Instructions. Saved in your settings file on this PC (not encrypted) and left out of exported layouts.' },
    { key: 'accessKey', label: 'Access key', type: 'password', advanced: true, help: 'Only if you were given one. It switches on the built-in YouTube login, so you can leave the Client ID and Secret empty. Saved in your settings file on this PC (not encrypted) and left out of exported layouts.' },
  ],
  advancedLabel: 'Advanced: I have an access key',

  connections: [{ id: 'main', label: 'YouTube account', flow: 'redirect' }],
  clientMethods: ['connect', 'disconnect'],
  externalDomains: ['accounts.google.com', 'console.cloud.google.com'],

  actions: require('./actions'),
  widgets: require('./widgets'),

  stateKeys: [
    { key: 'youtube.connected', label: 'YouTube is connected', group: 'YouTube' },
    { key: 'youtube.live', label: 'You are live on YouTube', group: 'YouTube' },
  ],

  matchState(key) {
    return key.startsWith('youtube.') ? { youtube: true } : null;
  },

  createRuntime(ctx) {
    return new YouTubeRuntime(ctx);
  },
};
