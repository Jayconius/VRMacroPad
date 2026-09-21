<div align="center">

<img src="docs/images/banner.png" alt="VR Macro Pad" width="100%">

# VR Macro Pad

**Colored push-button macros and live mini screens for Windows.**
Use it on your desktop, or float it in VR as a real **SteamVR overlay**.

[![Download](https://img.shields.io/github/v/release/Jayconius/VRMacroPad?style=for-the-badge&label=Download&color=2f855a)](https://github.com/Jayconius/VRMacroPad/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-4c8dff?style=for-the-badge)](LICENSE)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=for-the-badge&logo=windows&logoColor=white)](#-download)

[![Downloads](https://img.shields.io/github/downloads/Jayconius/VRMacroPad/total?style=flat-square&label=downloads&color=6b46c1)](https://github.com/Jayconius/VRMacroPad/releases)
[![Stars](https://img.shields.io/github/stars/Jayconius/VRMacroPad?style=flat-square&color=b7791f)](https://github.com/Jayconius/VRMacroPad/stargazers)
[![Electron](https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![Made for VR](https://img.shields.io/badge/made%20for-VR-c53030?style=flat-square)](#-use-it-in-vr)

</div>

---

<p align="center"><img src="docs/images/vr-overlay.png" alt="VR Macro Pad 2.0 as a SteamVR overlay: a deck floating in front of you, a copy on the wrist, and the editor in the SteamVR dashboard" width="100%"></p>

## ✨ What is it?

A grid of big, colored buttons that run macros, plus **mini screens** that show live information (SteamVR battery, the song playing, your Twitch ad timer, a clock, dice...). Press a button and it mutes your mic, switches your OBS scene, sends a Twitch chat message, changes your Voicemeeter volume, jumps in VRChat, and much more.

**New in 2.0: it is a native SteamVR overlay.** Grab it, move it, resize it, snap it to your wrist, or leave it in the room, all from inside VR, and edit everything without taking the headset off. No VR? It works just as well on a desktop window (and you can hide that window if you only use VR).

<p align="center"><img src="docs/images/deck.png" alt="The VR Macro Pad window with buttons, clock, timer, dice, coin and a SteamVR battery screen" width="90%"></p>

## 🆕 What's new in 2.0

* 🥽 **Native SteamVR overlay**: in front of you, in the room, or on your wrist; grab, resize, pin, "only when I look at it"; works with any headset that runs through SteamVR. [Read more](docs/VR-OVERLAY.md)
* 🧭 **An entry in the SteamVR dashboard** with controls (reset position / size, dim the view, turn off) and a **full editor inside VR** (with SteamVR's keyboard).
* ✨ **Button effects**: pulse, breathe, flash, glow, ripple, heartbeat, shake, bounce, hazard stripes and color cycle, for the normal and the active state.
* 🖼️ **Your own pictures and GIFs** on buttons, a different one for each state.
* 🎚️ **Voicemeeter**: mute / solo / route strips and buses, gain and fades, macro buttons, devices, per-app volume, any script.
* 🛠️ **SteamVR functions**: supersampling, motion smoothing, headset brightness, **dim the view** (any headset), play-area bounds, performance graph, recenter.
* 👾 **More VRChat**: game controls, walk and turn, chatbox with the song or the time, avatar parameter steps, any OSC message, AFK / seated / VR-mode triggers.
* 🫥 **Start with no window** (settings or tray) for VR-only users.
* 🐛 Fixed: audio buttons (mic mute, volume, device switch) showed a "Helper timed out" error after 8 seconds even though they worked; the SteamVR battery could not connect when no VR game was running.

## 📥 Download

| | |
|---|---|
| 💿 **[Installer](https://github.com/Jayconius/VRMacroPad/releases/latest)** | Start menu + desktop shortcut, uninstaller. `VR-Macro-Pad-Setup-x.y.z.exe` |
| 🎒 **[Portable](https://github.com/Jayconius/VRMacroPad/releases/latest)** | One file, nothing to install, run it from anywhere. `VR-Macro-Pad-x.y.z-portable.exe` |

> [!NOTE]
> The exes are not code-signed yet, so Windows SmartScreen may say *"unknown publisher"*. Click **More info → Run anyway**.
> The first start takes a few seconds while it builds its small Windows helper programs.

## 🚀 Quick start

1. **Start it.** You get a starter layout with a mic button, volume, media and a few tools.
2. **Press a button** to run it. Buttons light up to match reality (mic muted, recording, emote-only on...).
3. **Hold the 🔒 button for a second** to unlock editing. Then drag buttons to move them, drag a corner to resize, click one to edit it, or press **＋ Add button**.
4. It locks itself again a few minutes later, so a stray click in VR can never rearrange your deck.

## 🎛️ What can a button do?

| | |
|---|---|
| 🎙️ **Audio** | mic mute, output mute, switch devices, volume, per-app volume |
| ⌨️ **Keyboard & system** | shortcuts, type text, media keys, launch programs, open links |
| 🥽 **SteamVR** | start / quit / restart, battery on a mini screen, supersampling, motion smoothing, brightness, dim the view, play-area bounds, performance graph, recenter |
| 🎚️ **Voicemeeter** | mute / solo / route, gain and fades, macro buttons, recorder, audio devices, per-app volume, any script |
| 🎬 **OBS** | switch scene, record, stream, save replay, mute a source |
| 👾 **VRChat** | mic mute, chatbox (with song / time), avatar parameters and steps, game controls, walk / turn, any OSC message (over OSC) |
| 💜 **Twitch** | chat messages, emote-only, followers-only, shield mode, ads, clip, raid, title... |
| 🎵 **Spotify** | play / skip, shuffle, repeat, seek, volume, and Like |
| ▶️ **YouTube Music** | through [Pear Desktop](https://github.com/pear-devs/pear-desktop): like, shuffle, repeat, volume |
| 🏠 **Web & smart home** | webhooks, Home Assistant |

Every button is a list of steps with optional delays. Give it a **picture or GIF** (a different one when active), and an **animation** for its states (pulse, flash, glow, ripple, hazard stripes...) so a live mic or a running stream cannot be missed. It can also fire **on its own**: a hotkey, an app starting or closing, a state changing (recording started, low battery, ad coming up...), or a time of day.

## 📺 Mini screens

Buttons that show live information instead of just running steps:

| | |
|---|---|
| 🕒 **Clock**, ⏳ **Timer**, ⏱️ **Stopwatch** | timers survive restarts and can run actions when they finish |
| 🪙 **Coin flip**, 🎲 **Dice** | d4 to d100, advantage / disadvantage, and they can post the result to Twitch chat |
| 🔋 **SteamVR battery** | headset, controllers, trackers and base stations, as a list or as **pictures** |
| 🎶 **Now playing** | album cover, title, progress, controls. Spotify and most players |
| 📺 **Twitch ad timer / stream status** | countdown to your next ad, live badge, viewers, uptime |

## 🫥 Buttons only (see-through)

One click on the 👁 button (or **Ctrl+Alt+Shift+V**) makes everything **except your pages and buttons fully transparent**, so they float over your game or desktop.

<p align="center"><img src="docs/images/buttons-only.png" alt="Only the buttons and page tabs are visible, floating over a background" width="90%"></p>

## 🥽 Use it in VR

1. Settings → **VR overlay** → *Show the deck in SteamVR*, then start SteamVR. (The app never starts SteamVR itself.)
2. Point a controller at the deck and pull the trigger. Hold the trigger on the dotted handle to **grab** it; carry it to your other wrist and let go to **snap** it there.
3. Open the SteamVR menu: **VR Macro Pad** is in the bar at the bottom, with **Controls** and a full **Editor**.

It works next to XSOverlay and OVR Toolkit and with any SteamVR headset (Quest over Link / Air Link / Virtual Desktop, Index, Vive, Steam Frame streaming...). The full guide is [docs/VR-OVERLAY.md](docs/VR-OVERLAY.md).

Prefer a window capture? The desktop window still works with **OVR Toolkit / XSOverlay / Desktop+**, and clicking it does **not** steal focus from your game.

<details>
<summary><b>🔌 Setting up OBS, VRChat, Twitch, Spotify Like, Pear...</b></summary>

<br>

| | How |
|---|---|
| **OBS** | Tools → WebSocket Server Settings → enable. Enter the port and password in Settings → Connections. |
| **VRChat** | Action Menu → Options → OSC → Enabled. |
| **Twitch** | Settings → Connections → **Connect Twitch**, then approve on twitch.tv. Nothing else to set up. |
| **Spotify** | Play, skip, shuffle, repeat, seek and volume need **no setup and no login**. *Like* needs a one-time connection with your own Spotify developer app (see the [guide](docs/GUIDE.md#setting-up-the-integrations)). |
| **YouTube Music** | In Pear: Plugins → API Server → enable. Then Settings → Connections → **Connect Pear**. |
| **SteamVR** | Nothing. It only looks at SteamVR when something needs it, and never starts it. |
| **Voicemeeter** | Install [Voicemeeter](https://voicemeeter.com) (Standard, Banana or Potato) and start it. Nothing to configure. |

</details>

## 🔒 Privacy and safety

- Everything stays on your PC. The app runs a small web server on `127.0.0.1` only, protected by a secret token.
- Twitch and Spotify logins are stored **encrypted with your Windows account**, never in your layout file, so sharing a layout never leaks them.
- Editing (and linking accounts) is locked by default and can be limited to a hotkey or the tray menu.

## ⚠️ Honest limits

- **Windows only.**
- Tried on real hardware: the overlay, the dashboard entry and editor. **Not tried on real hardware yet:** the SteamVR battery screen, Voicemeeter (built against VB-Audio's official documentation and a built-in test double), headset brightness (depends on the headset's driver; "Dim the view" works everywhere), and the SteamVR keyboard in the VR editor. Reports welcome!
- Spotify **Like** talks to Spotify's Web API, which (since Feb 2026) only lets a development-mode app work while its owner has Premium, for up to 5 people. So each person uses their own Client ID.
- Keystrokes can't be sent into programs running as administrator unless VR Macro Pad runs as administrator too.
- The overlay needs SteamVR. There are no controller bindings yet (grab and click use the laser and trigger).
- OVR Advanced Settings cannot be controlled from other apps, so its features are done directly where SteamVR allows (supersampling, brightness, bounds...). VRChat's web API (friends, status) is not used.

## 🛠️ Build it yourself

```bash
git clone https://github.com/Jayconius/VRMacroPad.git
cd VRMacroPad
npm install
npm start          # run it
npm test           # 217 tests
npm run dist       # build the installer and portable exe into dist/
```

Needs [Node.js](https://nodejs.org). The full guide (every setting, how to add an action or a mini screen) is in **[docs/GUIDE.md](docs/GUIDE.md)**.

## 🙏 Credits

- [OpenVR SDK](https://github.com/ValveSoftware/openvr) by Valve (BSD-3), used for the overlay and to read SteamVR batteries and settings.
- [Voicemeeter](https://voicemeeter.com) and its Remote API by VB-Audio (the API is used through the DLL that comes with Voicemeeter; nothing of theirs is bundled).
- The device pictures come from the author's other app, [OhFudgeMyBatteryChat](https://github.com/Jayconius/OhFudgeMyBatteryChat) (MIT).
- Built with [Electron](https://www.electronjs.org) and [ws](https://github.com/websockets/ws).

VR Macro Pad is an independent project. It is **not affiliated with** [Macro Deck](https://macro-deck.app) (a different app by SuchByte), Valve, Meta, Twitch, Spotify, OBS, VRChat or VB-Audio. Those names belong to their owners.

## 💬 Contact

Made by **Jayconius** · [jayconius.com](https://jayconius.com)
Found a bug or want a feature? [Open an issue](https://github.com/Jayconius/VRMacroPad/issues).

## 📄 License

[MIT](LICENSE) © 2026 Jayconius
