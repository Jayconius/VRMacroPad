# VR Macro Pad: the full guide

[← Back to the README](../README.md)

Colored push-button macros and live mini screens for Windows. Use it on the desktop, or float it in VR as a native
**SteamVR overlay** (see [VR-OVERLAY.md](VR-OVERLAY.md)). The window also still works with OVR Toolkit, XSOverlay or Desktop+.

## Run it

Use the **exe**: `VR-Macro-Pad-Setup-x.y.z.exe` installs it (Start menu + desktop shortcut, uninstaller), or
`VR-Macro-Pad-x.y.z-portable.exe` runs as a single file from anywhere with nothing to install. Both are built with
`npm run dist` and land in `dist/`. They are not code-signed, so Windows SmartScreen may say "unknown publisher" the first
time (More info → Run anyway). The first launch builds its small Windows helper programs (a few seconds); after that it starts
straight away. Your layout and logins live in `%APPDATA%\VR Macro Pad`, the same place for the exe and the .bat.

From the source (needs [Node.js](https://nodejs.org)): double-click **Start VR Macro Pad.bat**; it installs what it needs the first time.

It is a normal borderless window with its own taskbar button; the tray icon is there for quick actions.
**Updating:** quit the old copy first (✕ or the tray menu), then start the new one.

Only one copy runs at a time: starting it again brings the running window to the front (even if it was minimized
or hidden in the tray) and the new launch quits by itself. If the running copy is stuck and doesn't answer within a
few seconds, you get a plain "VR Macro Pad is already running" message instead.

## Using it

* **Press a button** to run it. Its color follows the real state where it can (mic muted,
  recording, emote-only on...).
* **Editing is locked by default.** Hold the 🔒 button for about a second to unlock. Then:
  * drag a button to move it, drag its bottom-right corner to resize it (snaps to the grid);
  * click a button to edit it, click a dashed **+** cell to add one there, or use **＋ Add button**;
  * **＋ Page** adds pages; click the active page tab to change its size or delete it.
* Editing locks again after a few minutes idle. It can be limited to a hotkey / the tray menu
  (Settings → Editing lock), so it cannot be unlocked from inside VR by accident.
* Buttons can be protected against accidental presses: *hold to confirm* or *tap twice*.

### The window

Settings → Window: borderless (default) or a normal frame, show in the taskbar (default), what the close
button does (quit, or hide to the tray so hotkeys and triggers keep working), always on top. Drag the top bar to
move a borderless window and its edges to resize it. Clicking the window does **not** take focus from your
game, so keystroke macros still reach it; it only takes focus while an edit dialog with text fields is open.

### Buttons only (see-through)

The eye button in the top bar (also: the tray menu, or **Ctrl+Alt+Shift+V**, changeable in Settings → Window) hides everything
except the page tabs and the buttons, and makes the rest of the window fully transparent, so the buttons float over your desktop or
game. It works while editing is locked. The faint **⋯** at the top right (or the hotkey) brings the full window back; unlocking
editing does too. The window is rebuilt when you switch (a blink), and a see-through window is resized by dragging its thin
invisible edges, not the usual window border. Whether a VR overlay app keeps the transparency depends on that app.

### Buttons: look, pictures and effects

Click a button (editing unlocked) and open the **Look** tab: label and icon, color (and a color when active), and:

* **Pictures**: pick a PNG, JPEG, GIF or WebP (up to 8 MB), one for the normal state and one for the active state. GIFs animate.
  Choose *fill the button* or *show the whole picture*. Pictures are stored in `%APPDATA%\VR Macro Pad\images` under a hash name and only
  served to the app itself. Pictures no button uses any more are removed after a day. SVG is not accepted (it can carry scripts).
* **Animations**, separately for *active* and *not active*, with a speed: **pulse** (fade), **breathe** (gentle grow), **flash** (blink, for
  warnings), **glow** (a swelling halo), **ripple** (rings spreading out), **heartbeat**, **shake** (a jolt now and then), **bounce**,
  **hazard stripes** (moving warning stripes, unmissable) and **color cycle**. A good use is *flash* or *hazard* on "mic is live"
  and *heartbeat* on "recording". Settings → General → *Play button animations* switches them all off.

### Pinning it in VR

The best way is the native overlay: Settings → **VR overlay**, then start SteamVR (see [VR-OVERLAY.md](VR-OVERLAY.md)). To use a
window capture instead: leave the window open and not minimized, and in OVR Toolkit / XSOverlay / Desktop+ add a window capture of
**VR Macro Pad**. With **Start with no window** (Settings → Window, or the tray menu) the desktop window stays hidden and only the
overlay shows.

## Mini screens ("widgets")

Add them from **＋ Add button**: most are under *Mini screens & tools*, the SteamVR battery is with the other SteamVR
items and the two Twitch ones with the other Twitch items. They are buttons that show live information:

| Widget | What it does |
|---|---|
| Clock | Time and date, optionally in another time zone |
| Countdown timer | Tap start / pause, hold to reset; beeps, and can run actions when it finishes (e.g. a chat message). Survives restarts |
| Stopwatch | Tap start / stop, hold to reset |
| Coin flip | Heads or tails; optionally posts the result to Twitch chat |
| Dice roller | d4-d100 or custom, several dice, a modifier, advantage / disadvantage on a d20; optionally posts to chat |
| SteamVR battery | Headset, controllers, trackers (and base stations) as a list with bars, or as illustrated pictures that switch to a red low-battery version. Shows charging, "tracking lost", and devices that are off or dropped out (with their last level). Nicknames and pictures per serial |
| Now playing | Album cover, title, artist, progress bar, play / pause / skip / click-to-seek. Spotify and most players |
| Twitch ad timer | Countdown to your next ad break, snooze counter, tap to snooze |
| Twitch stream status | Live badge, viewer count, uptime |

## Actions

| Area | Actions |
|---|---|
| Audio | mic mute, output mute, switch default output / microphone, cycle outputs, master volume, per-app volume (finds the app on whichever output device it is routed to) |
| Keyboard & system | press keys / shortcuts, type text, Alt+Tab & friends, media keys, launch program, open link, show message, wait |
| Media | play / pause / next / previous for any player (pick the app: Automatic, Spotify, YouTube Music, a browser...) |
| Spotify | play / pause / skip, shuffle, repeat, skip forward / back, Spotify's own volume (all through Windows, no login), and **Like** (needs a one-time Spotify connection, see below) |
| YouTube Music (Pear Desktop) | play / pause / skip, like / dislike, shuffle, repeat (or jump to a mode), volume, skip forward / back |
| SteamVR | start, quit, restart, **supersampling**, **motion smoothing**, **headset brightness** (driver colour gain), **dim the view** (any headset), **play-area bounds** (show / look), **performance graph**, **recenter** (seated). Everything except start / quit needs SteamVR running |
| Voicemeeter | mute / solo / mono / send to A1-B3 / EQ on strips, buses and the recorder, **gain** (set, raise, lower, fade), **macro buttons** 0-79, engine commands (restart, presets, save / load), **choose audio devices**, per-app volume (Potato), any **script** command |
| OBS | switch scene, record, stream, save replay (clip), replay buffer, mute a source, any raw request |
| VRChat (OSC) | mic mute (color follows your real state), chatbox message (also with `{song}` `{artist}` `{time}` `{date}`), clear chatbox, typing bubble, avatar parameter and **parameter steps** (outfit up / down / around), change avatar, **game controls** (jump, run, move, turn, use / grab / drop, Quick Menu, panic), **walk / turn for a moment**, **any OSC message** to VRChat or another app |
| Twitch | chat message, announcement, chat modes (emote-only, followers, subs, slow, unique), shield mode, snooze / run ads, clear chat, stream marker, clip, raid, shoutout, title / category |
| Web & smart home | HTTP request / webhook, Home Assistant service call |

**Triggers** (press a button without touching it): global hotkey (F13-F24 work well), app starts / closes, a state
changes (OBS recording, Twitch ad coming up, SteamVR: low battery / charging / headset put on / tracking lost / a device
dropped out, ...), time of day. A page can also appear when an app starts.
Every button is a list of steps with optional delays.

## Setting up the integrations

Every integration is a plugin: open **Settings → Plugins** and expand its card. Cards that need a one-time setup have an **Instructions** button with numbered steps.

* **OBS**: Tools → WebSocket Server Settings → enable. Enter the port/password in Settings → Plugins.
* **VRChat**: Action Menu → Options → OSC → Enabled. The VRChat mic action needs VRChat's mic mode set to *Toggle*.
* **Spotify like**: everything in the Spotify group except *Like* needs nothing. Windows has no like button, so Like uses the Spotify
  Web API: at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) create an app, add the Redirect URI shown in
  Settings → Plugins → Spotify (`http://127.0.0.1:17422/callback`), paste its Client ID there and press **Connect Spotify**.
  Spotify's rules (since Feb 2026): an app in development mode only works while its owner has Premium, for up to 5 people added
  under *User Management*. So this cannot be shipped to everyone the way Twitch is: each person uses their own Client ID.
  The app never sees your password, needs no client secret, and only asks for: current song, read and change Liked Songs.
* **Spotify / media**: nothing to set up. It reads Windows' media session, so it works with the Spotify desktop app
  (and browsers, VLC...), needs no login and no Premium. It shows what is playing *on this PC*.
* **YouTube Music (Pear Desktop)**: it already shows up in the *Now playing* widget through Windows (Player: `youtube music`).
  For more (album name, like / shuffle / repeat buttons, volume), use Pear's API: in Pear enable **Plugins → API Server**
  (set its hostname to `127.0.0.1` so only this PC can reach it), then Settings → Plugins → YouTube Music →
  **Connect Pear**, and click **Allow** in the Pear window once. Set the widget's Player to `pear`.
  Pear's volume takes the slider position but reports loudness on a curve; the app converts, so "raise by 10" moves the slider by 10.
* **Voicemeeter**: install it (Standard, Banana or Potato) and run it. The app finds VB-Audio's Remote API by itself (`VoicemeeterRemote64.dll`,
  installed with Voicemeeter) and only connects while a button needs it. Numbers in the forms start at 1 like Voicemeeter's labels. For
  anything not in the forms, use *Custom command* with Voicemeeter's own scripting language, e.g. `Strip[0].Mute=1; Bus[0].Gain=-6;`.
* **SteamVR battery**: nothing to set up. The app links to SteamVR only while a battery widget or trigger needs it, and
  only if SteamVR is already running (it never starts it). What shows up depends on what your headset's driver reports.
  Devices seen before are remembered, so a tracker that is switched off still appears (greyed, with its last level).
  For the picture version of the widget, set its *Layout* to *Pictures*.
* **Twitch**: Settings → Plugins → Twitch → **Connect Twitch**. Twitch shows a short code; open the link, enter it
  and approve with your own account. Nothing else to set up: the app ships with its own registered Twitch application
  (its public Client ID is in `src/core/app-config.js`), and there is no client secret. Your login is stored encrypted
  with your Windows account. *Check permissions* confirms Twitch granted everything. Sign-in lasts as long as you use
  it (Twitch expires it after 30 idle days). To use your own Twitch app instead, open *Advanced* and paste its Client ID
  (register it at [dev.twitch.tv/console](https://dev.twitch.tv/console): Client Type **Public**, OAuth Redirect URL
  **`http://localhost`**, which is required by the form but never used).
* **Kick**: Settings → Plugins → Kick → **Connect Kick**, then log in and approve on kick.com. It uses Kick's official API only.
  Buttons: chat message, title and category, ad break, timeout. Mini screens: stream status and ad breaks. (No ban / unban on purpose.)
* **YouTube**: chat messages, go live / end stream, ad breaks, title / description / category, public / unlisted / private, and live-status and
  channel-number mini screens, through YouTube's official API. Google has to verify an app before everyone can log in with one click, and that
  is still pending, so for now open the YouTube card, press **Instructions** and make your own free Google app (about five minutes), paste its
  Client ID and Secret, then press **Connect YouTube**. Nothing that targets one viewer (bans, timeouts) is included.
* **Streamer.bot**: in Streamer.bot open Servers/Clients → WebSocket Server and start it (the defaults are fine). The plugin lists your actions by
  name, with their group next to them; pick one for a button. Only enter a password if you turned on *Authentication* there.
* **Discord**: create a webhook (channel settings → Integrations → Webhooks) and paste its URL into the Discord card. Then buttons can post
  messages, cards and screenshots, share a new Steam screenshot or your last VRChat photo, and press your Discord mute / deafen / push-to-talk shortcuts.
  **Discord Notifications** adds mini screens showing who last messaged you (with filters) and buttons that light up on a new message.
* **Voicemod**: Voicemod's Control API needs a client key that you ask Voicemod for (the card's **Instructions** button has the link). Paste
  it, press **Save and test connection**, then use Change voice, Random voice, the on / off switches (voice changer, mute, hear-myself,
  background) and Play a sound. Each voice or sound button has one **List** dropdown that starts on the complete list (voices: all /
  Voicemod's / Community; sounds: all, then your soundboards, then Voicemod's), and a picker you can scroll or type in. Voicemod only reports
  a new sound (or soundboard) after it has been played once in Voicemod; press ⟳ afterwards.
* **TeamSpeak 3**: Tools → Options → Addons → ClientQuery → Settings, copy the API key into the TeamSpeak 3 card, connect to a server, and
  press **Save and test connection**. Buttons mute your microphone or speakers or set you away, and light up to follow TeamSpeak.
  TeamSpeak 5 / 6 cannot be controlled by other apps.
* **Mix It Up**: Services → Developer API → Connect, then **Save and test connection** on the Mix It Up card. Buttons run a command (picked
  from your list), send a chat message, clear chat, or turn a command on or off.
* **Updates**: Settings → General → *Check for updates* (off by default). When on, the app asks GitHub for the latest release number, and a box offers
  a link, **Download** and **Skip**. Portable copies save the new exe next to the old one; installed copies can install it and restart.

## Security

The app runs a small web server on `127.0.0.1` only (that's how the window and browser tabs talk to it).
Because any website can try to reach localhost, every connection needs a secret token *and* the right
`Host` and `Origin` headers. The token is stored in `%APPDATA%\VR Macro Pad\auth.json`. Config edits, linking or
unlinking Twitch, and testing actions are refused by the server itself while editing is locked. Twitch tokens live in
`secrets.json`, separate from your layout (so exporting a layout never leaks them), encrypted with Windows. OBS and
Home Assistant passwords are stored in plain text in your config; layout export leaves them out.

## Limits and honesty

* **No SteamVR controller bindings.** The overlay uses the laser and trigger; a hotkey and the tray menu can show / hide it.
* The overlay, dashboard entry, editor and their settings have been used on a real headset. **Not tried on real hardware:** the SteamVR
  battery screen, Voicemeeter (tested against a built-in test double and VB-Audio's documentation), headset brightness (needs driver
  support; "Dim the view" does not), and the SteamVR keyboard in the VR editor. (Twitch has been exercised against a real account.)
  If something does not match, the
  *Info → Status* and *Activity* tabs show the exact error.
* Keystrokes cannot be sent into windows running as administrator (or protected by some anti-cheat) unless this app
  is also run as administrator.
* Windows only.

## Where things are

* Config, backups, token, secrets: `%APPDATA%\VR Macro Pad\` (the last 20 layouts are backed up automatically).
* Code: `src/core` (engine, plugin loader and runtime, widgets, server, updater), `plugins` (one folder per integration: OBS, Twitch, Kick, YouTube, Discord, VRChat, Voicemeeter...), `src/ui` (the web UI), `src/main` (Electron
  shell), `src/helper` (small C# programs for audio/keys, media sessions, SteamVR, the SteamVR overlay and Voicemeeter, compiled on first run with
  the compiler that ships with Windows). `vendor/openvr` is Valve's official OpenVR SDK (BSD licence, see its LICENSE). `src/ui/assets/devices` (the device pictures) come from the author's other app, OhFudgeMyBatteryChat (MIT, see the
  README there).

## For developers

```
npm test              # 370 tests: logic, protocols against fake OBS / VRChat / Twitch / Pear / Voicemeeter, server security, real Windows helpers
npm run test:overlay  # renders the overlay page off-screen and drives it with fake laser events (~100 checks)
npm run dist            # builds the installer and the portable exe into dist/ (needs internet the first time)
npm run test:clean    # launches the real app to check the buttons-only view is really see-through
npm run smoke         # launches the real desktop app once and checks it
npm run test:single   # launches real copies to check the "only one copy at a time" behavior
npm run dev       # UI + core as a plain web server (no Electron) at http://127.0.0.1:17420/?token=dev-token-dev-token-dev-token-dev-token
```

**Adding an action or a mini screen** = writing a plugin (a folder with a few small files). See
[BUILD-A-PLUGIN.md](BUILD-A-PLUGIN.md) for the tutorial and [PLUGIN-GUIDE.md](PLUGIN-GUIDE.md) for the reference. The built-in ones in `plugins/` are the best examples.
