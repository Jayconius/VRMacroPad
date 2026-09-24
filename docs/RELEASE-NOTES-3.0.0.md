# VR Macro Pad 3.0.0: plugins

**Everything is a plugin now, there are five new plugins (Discord, Discord Notifications, Kick, Streamer.bot and YouTube), any grid size up to 100 × 100, an optional update checker, and a lot of polish.** This is the biggest update since 1.0.

> [!IMPORTANT]
> **YouTube sign-in is not available yet.** The one-click *Log in with Google* is waiting for Google to verify the app, and that is out of my hands. **The YouTube plugin still works today**: open **Settings → Plugins → YouTube**, press **Instructions**, and follow the numbered steps to make your own free Google app (about five minutes, no cost), then paste its Client ID and Secret and press **Connect YouTube**. When Google's verification comes through, signing in becomes a single button, with no update needed on your side beyond the normal one.

## Downloads

| File | What it is |
|---|---|
| `VR-Macro-Pad-Setup-3.0.0.exe` | Installer: Start menu and desktop shortcut, uninstaller |
| `VR-Macro-Pad-3.0.0-portable.exe` | One file, nothing to install, run it from anywhere |

* Windows 10 / 11, 64-bit. Both are the same app.
* The exes are **not code-signed**, so Windows SmartScreen may say *"unknown publisher"*: click **More info → Run anyway**.
* The first start takes a few seconds while the app builds its small Windows helper programs.
* **Upgrading from 2.0:** your layout and settings carry over (they live in `%APPDATA%\VR Macro Pad`, and the app keeps automatic backups of your last 20 layouts). Close the old copy completely first, including its tray icon.

---

## 🧩 Everything is a plugin

The biggest change is under the hood, and it opens the app up. OBS, Twitch, VRChat, Spotify, Pear (YouTube Music), Voicemeeter, SteamVR and the starter pack (audio, keyboard, media, system, webhooks and the built-in mini screens) have all moved out of the app's core into **plugins**, exactly like the ones you can write yourself.

* **Settings → Plugins** lists every plugin as a card: its icon, name, a status dot, an **Enabled** switch, its own settings, and its Connect / Disconnect / sign-in buttons. Switch off what you don't use.
* **Write your own.** A plugin is a folder with a few small JavaScript files (`plugin.js`, plus optional `actions.js`, `runtime.js`, `widgets.js`). No build step, nothing to install: drop the folder into `%APPDATA%\VR Macro Pad\plugins`, restart, and it shows up with its own settings card, actions, mini screens and sign-in.
* **Two guides**: a step-by-step tutorial, **[Build your own plugin](https://github.com/Jayconius/VRMacroPad/blob/main/docs/BUILD-A-PLUGIN.md)** (a real Discord-webhook plugin, a cookbook of settings, logins, polling, mini screens and saving data, plus a FAQ, also as a [single web page](https://github.com/Jayconius/VRMacroPad/blob/main/docs/BUILD-A-PLUGIN.html)), and the full **[Plugin reference](https://github.com/Jayconius/VRMacroPad/blob/main/docs/PLUGIN-GUIDE.md)**. Working examples are in `docs/example-plugin`, `docs/example-plugin-discord` and `docs/example-plugin-login` (a complete sign-in flow against a fake service).
* **A plugin that breaks can't break the app.** If a plugin has a typo, a duplicate id or a bad manifest, it is skipped, and Settings → Plugins lists it at the top with the reason and its folder. Everything else keeps working. A plugin also has to declare what the page may ask of it: the web addresses it may open for sign-in, and which of its methods the page may call.
* **Plugins can ask for setup help** with an **Instructions** button: a dialog of numbered steps, buttons that open links in your browser, and Copy buttons for values you need to paste. Fields you rarely need can be tucked under an **Advanced** section.
* Settings, connection status and sign-in are all described in the plugin's manifest, so a plugin you write gets the same UI as a built-in one, with no special cases in the app.

## 🆕 New plugins

### 💬 Discord
* Post "I'm live" messages, **cards** (embeds) and **screenshots** to a channel through a webhook.
* Share your **last VRChat photo** (found through VRChat's own log) with one button, and **automatically share new Steam screenshots** (and, if you choose, new VRChat photos) with an on / off button. Auto-share always starts switched off.
* Press your **mute, deafen and push-to-talk** shortcuts, with an optional "open Discord first" step.
* Nothing is sent until you press a button (or switch auto-share on yourself).

### 🔔 Discord Notifications
* Two mini screens: **Last Discord notification** (who last messaged you) and **Recent Discord notifications** (a running list), plus a **Clear** button.
* **Filters** to ignore DMs, `@everyone`, `@you` or server events.
* Buttons can **light up** when a new message arrives, and it works with triggers.
* It reads Windows toast notifications locally, so it needs no Discord login, bot or token.

### 🟢 Kick
* Uses **Kick's official API** (OAuth with PKCE). Press **Connect Kick**, log in and approve on kick.com.
* **Buttons:** send a chat message, change the title and category, run an ad break, time out a viewer.
* **Mini screens:** live status with viewers and uptime, and the ad-break countdown.
* Ban and unban are intentionally not included: they are slow and easy to get wrong from inside VR.

### 🤖 Streamer.bot
* Run any of your **Streamer.bot actions** from a button: emote-only, slow mode, clear chat, scenes, anything you built.
* Talks to Streamer.bot's normal **WebSocket server** (the default settings work; no password needed unless you turned on Authentication).
* The action list shows the **action name first with its group next to it**, the way Streamer.bot organises them, so long lists are easy to scan.
* This is how you reach things Kick's public API doesn't offer.

### ▶️ YouTube
* **Buttons:** send a live-chat message, **go live** and **end stream**, run an **ad break**, change the **title, description and category**, and set **public / unlisted / private**.
* **Mini screens:** live status (live now, viewers, time live, likes, stream health) and channel numbers (subscribers, views, videos).
* Uses **YouTube's official API** with light polling, well inside the free daily quota.
* Deliberately no actions that target one viewer (bans, timeouts).
* **Sign-in status: see the note at the top.** For now you use your own free Google app via the **Instructions** button.

## 📐 Grids, editing and layout

* **Any grid size**, up to **100 columns × 100 rows** (and up to 1000 buttons per page), set from a page's settings. Small grids stay comfortable; huge ones are there if you want them.
* **"Fit the whole page on screen"** (on by default for each page): the grid scales to your window as you resize it, so a big grid never needs scrolling. Turn it off per page to get fixed-size buttons back.
* **Back button in the action picker.** After you open a group of actions and pick one (or back out), you return to where you were in the list instead of scrolling from the top again.
* **One connections icon** in the top bar (a dot and a count) opens a list of every plugin's status, replacing the row of per-plugin chips.
* The **Plugins** tab in Settings replaces the old *Connections* tab.

## 🔄 Optional update checker (off by default)

* **Settings → General → Check for updates.** Off until you turn it on. There is also a **Check now** button that works even when it's off.
* When on, the app asks GitHub once shortly after it starts, and again every few hours, whether there's a newer release. It sends nothing about you.
* If there is one, you get a box with the version, what's new, a **link to the release**, a **Download** button and a **Skip this version** button (Later just closes it).
* **Portable copies:** the new exe is saved in the **same folder** as the one you're running; the old one is left alone. Then **Show in folder**, or **Quit and open the new version**.
* **Installed copies:** the Setup is downloaded, then **Install and restart** closes the app, installs over the old copy quietly and reopens it. Your buttons and settings are kept.
* Safety: downloads come only from this project's own GitHub releases, over https, and are checked against the expected size and (when GitHub publishes one) the SHA-256 checksum before anything runs. The exes are unsigned, so there is no signature check.

## 🎙️ Audio, VR and other improvements

* **Mic and speaker buttons tied to a specific device** now follow that device's real Windows mute state, so they light up correctly even if you muted it somewhere else.
* Plugins can now expose **state keys** for triggers and button lighting, and **dropdown lists** they fill in themselves (for example your Streamer.bot actions).
* **Typed secrets are handled honestly:** logins and tokens are stored encrypted with your Windows account; a Client ID or Secret you type into a settings box is stored in your settings file in plain text and is left out when you export a layout. The interface says so.

## 🌐 Website and legal

* A small website at **[vrmacropad.jayconius.com](https://vrmacropad.jayconius.com)** with an overview, download links, a **privacy policy** and **terms**. The privacy policy includes Google's required *API Services User Data Policy / Limited Use* statement for the YouTube plugin.
* Kick's and YouTube's one-click sign-in goes through a small free relay on the same domain. It only swaps a sign-in code for a token (those services require a secret the app can't safely carry), and stores nothing.

## 📖 Documentation

* README rewritten for 3.0, with a new plugins overview picture and refreshed banner and VR graphics.
* New: **BUILD-A-PLUGIN** (tutorial, cookbook, FAQ, diagrams and screenshots), expanded **PLUGIN-GUIDE**, three worked example plugins, and an updated **GUIDE** with setup steps for every new plugin.

## 🛠️ Under the hood

* 336 automated tests (up from 217), including fake OBS, VRChat, Twitch, Kick, Streamer.bot, Discord and update servers, plugin safety checks, security tests for the local server, and real Windows helpers.
* The local server is still bound to `127.0.0.1` only, with host, origin and secret-token checks; the update actions that launch anything are limited to the desktop app.
* Repository hygiene: private tooling, deployment code for the sign-in relay, and local keys are excluded from the repository and from the exes.

---

## ⚠️ Known limits

* **YouTube one-click sign-in is not available yet** (waiting for Google's verification). Use your own Google app for now (Instructions button).
* Windows only. The exes are unsigned, so SmartScreen shows a warning the first time.
* **Not tried on real hardware yet:** the SteamVR battery screen, Voicemeeter, headset brightness (driver-dependent; *Dim the view* works everywhere) and the SteamVR keyboard in the VR editor. Reports welcome.
* The **install-and-restart** update path for installed copies has had less real-world testing than everything else. If it misbehaves, download the Setup from the release page and run it yourself.
* Spotify **Like** needs your own Spotify developer app (Spotify's rules since Feb 2026).
* Keystrokes can't be sent into programs running as administrator unless VR Macro Pad runs as administrator too.

Found a bug or want a feature? [Open an issue](https://github.com/Jayconius/VRMacroPad/issues).

**Full changes since 2.0.0:** https://github.com/Jayconius/VRMacroPad/compare/v2.0.0...v3.0.0
