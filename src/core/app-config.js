// Values baked into the app for everyone who runs it.
module.exports = {
  // Shown on Settings → About.
  author: 'Jayconius',
  website: 'https://jayconius.com',
  // The VR Macro Pad page on GitHub (shown on Settings → About). Leave empty to show "not published yet".
  githubUrl: 'https://github.com/Jayconius/VRMacroPad',

  // The Client ID of the Twitch application registered for this app (dev.twitch.tv/console,
  // Client Type "Public", OAuth Redirect URL http://localhost).
  //
  // With this filled in, users just press "Connect Twitch" and approve it with their own account.
  // A Client ID is public by design (this app type has no client secret), so it is safe to ship.
  // Leave it empty to make users register their own Twitch app and paste in its Client ID.
  twitchClientId: 'pplyu5avu2h1r6mjxs2mz4lvvgazxp',

  // Spotify "Like" needs a Client ID from a Spotify developer app (developer.spotify.com/dashboard, Redirect URI
  // http://127.0.0.1:17422/callback). Leave empty and each user pastes their own in Settings. Note that Spotify
  // (since Feb 2026) only lets a development-mode app work for 5 users, and only while its owner has Premium.
  spotifyClientId: '',
};
