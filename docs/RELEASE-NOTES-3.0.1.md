# VR Macro Pad 3.0.1

**Three new plugins (Voicemod, TeamSpeak 3 and Mix It Up) and better pick lists across the whole editor.**

## Downloads

| File | What it is |
|---|---|
| `VR-Macro-Pad-Setup-3.0.1.exe` | Installer: Start menu and desktop shortcut, uninstaller |
| `VR-Macro-Pad-3.0.1-portable.exe` | One file, nothing to install, run it from anywhere |

* Windows 10 / 11, 64-bit. The exes are **not code-signed**, so SmartScreen may say *"unknown publisher"*: click **More info → Run anyway**.
* **Updating from 3.0.0:** your layout and settings carry over (they live in `%APPDATA%\VR Macro Pad`). Close the old copy completely first, including its tray icon. If you turned on *Check for updates* in 3.0.0, the app offers this version by itself.

---

## 🎭 New: Voicemod

Control Voicemod from a button, through Voicemod's own Control API (on your PC only).

* **Change voice.** One **List** dropdown that starts on the complete list: *All voices*, *Voicemod voices* (the ones that come with it) or *Community voices* (the ones you added from its Community tab), each with how many it holds. Under it, a picker you can scroll or type in. The button lights up while that voice is in use.
* **Random voice**, from all voices, only Voicemod's, or only your Community ones.
* **Voice changer, mute, hear-myself and background effects**: on, off or switch each press, with buttons that follow Voicemod's real state (also when you change it in Voicemod itself).
* **Play a sound** and **Stop all sounds.** The List has *All sounds*, then **your own soundboards** (found by themselves, marked "yours"), then Voicemod's soundboards, each with how many sounds it holds.
* **Setup:** Voicemod's Control API needs a **client key** that you ask Voicemod for. The Voicemod card's **Instructions** button has the link and the steps.

Worth knowing (these are Voicemod's rules, not the app's):

* A sound, or a soundboard, that you have just added only shows up after it has been **played once in Voicemod**. Play it, then press ⟳ next to the list.
* Voicemod never tells other apps which **voices** are on a soundboard (only which sounds), so voices have no soundboard lists.

## 🗣️ New: TeamSpeak 3

* Buttons to **mute your microphone**, **mute your speakers** (deafen) and **set yourself away** (with a message), each on, off or switch each press.
* Buttons **follow your real TeamSpeak state**, even when you change it in TeamSpeak, and there is a "you are talking" state for triggers.
* **Setup:** copy the API key from TeamSpeak's *Tools → Options → Addons → ClientQuery → Settings* into the TeamSpeak 3 card, connect to a server and press **Save and test connection**. It reconnects by itself when TeamSpeak starts later.
* TeamSpeak 5 and 6 have no way for other apps to control them, so only TeamSpeak 3 is supported.

## 🎛️ New: Mix It Up

* **Run a Mix It Up command** (picked by name from your list, with optional arguments, platform and special identifiers), **send a chat message**, **clear chat**, and **turn a command on or off**.
* **Setup:** in Mix It Up, *Services → Developer API → Connect*, then **Save and test connection** on the Mix It Up card.

## 🔎 Better pick lists everywhere

Every "type or pick" box in the editor (Voicemod voices and sounds, OBS scenes, Streamer.bot and Mix It Up actions, and more) now uses a list drawn by the app itself:

* It **scrolls**, and it **opens showing everything**, with your current choice highlighted, instead of only what matched the text already in the box.
* **Typing narrows it**, and several words match in any order ("demon radio" finds "Radio Demon").
* Arrow keys, Enter and Escape work, and it can be clicked open again after a choice.
* A list can depend on another box on the same button (like Voicemod's Sound list following its List), and reloads when that box changes.

For plugin authors: settings can be grouped into a folded section with a one-line summary, a tick-list setting gets a filter box when it is long, and an option list can receive the values of other fields. See the [Plugin reference](https://github.com/Jayconius/VRMacroPad/blob/main/docs/PLUGIN-GUIDE.md).

## ⚠️ Known limits

* **Voicemod** was tested against a real Voicemod. **Mix It Up** and **TeamSpeak 3** were built from their official documentation and tested against stand-ins, not yet against the real apps. Reports welcome.
* YouTube's one-click sign-in is still waiting for Google's verification. The YouTube plugin works today with your own Google app (the card's Instructions button).

370 automated tests (368 pass, 2 skipped by design).

Found a bug or want a feature? [Open an issue](https://github.com/Jayconius/VRMacroPad/issues).

**Full changes since 3.0.0:** https://github.com/Jayconius/VRMacroPad/compare/v3.0.0...v3.0.1
