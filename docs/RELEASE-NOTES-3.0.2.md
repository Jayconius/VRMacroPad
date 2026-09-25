# VR Macro Pad 3.0.2

**Live hardware stats: two new plugins, Libre Hardware Monitor and HWiNFO.** Show your CPU and GPU temperature, usage, memory, drives and network speed as mini screens with live graphs, and let buttons light up when something runs hot.

## Downloads

| File | What it is |
|---|---|
| `VR-Macro-Pad-Setup-3.0.2.exe` | Installer: Start menu and desktop shortcut, uninstaller |
| `VR-Macro-Pad-3.0.2-portable.exe` | One file, nothing to install, run it from anywhere |

* Windows 10 / 11, 64-bit. The exes are **not code-signed**, so SmartScreen may say *"unknown publisher"*: click **More info → Run anyway**.
* **Updating from 3.0.1:** your layout and settings carry over (they live in `%APPDATA%\VR Macro Pad`). Close the old copy completely first, including its tray icon. If you turned on *Check for updates*, the app offers this version by itself.

---

## 📊 New: Libre Hardware Monitor and 🖥️ HWiNFO

<p align="center"><img src="https://raw.githubusercontent.com/Jayconius/VRMacroPad/main/docs/images/hardware.png" alt="Live hardware widgets" width="70%"></p>

Two plugins with the **same widgets and buttons**, so pick the program you already use (or want to use). Both only **read**: nothing on your PC is changed.

### Mini screens

* **Hardware stat with graph.** One live number and a little graph of the last minute or so, turning **amber, then red** when it gets high. Choose from CPU temperature, CPU usage, CPU speed and power, GPU temperature, hot spot, usage, memory used, power, speed and fan, memory used (% or GB), the hottest drive, download and upload speed, or **any sensor at all** from a list. Optionally show the lowest and highest since it started, and set your own amber and red levels.
* **Hardware overview.** A live list of the readings you pick (CPU, GPU, memory...), amber or red when any is high.
* **Hottest parts.** The hottest temperatures on your PC right now, hottest first.
* **Network speed.** Download and upload of the connection actually in use, with a graph.
* **Drives.** Each drive's temperature and how full it is.

### Buttons that follow your hardware

A button can light up (or a trigger can fire) on **the CPU is hot**, **the GPU is hot**, **a drive is hot**, **any of them is hot**, **the CPU is nearly maxed out**, **the GPU is nearly maxed out** and **memory is nearly full**. The levels are in each plugin's **Advanced** section. Also new: an action that **pops up a stat** ("GPU temperature: 62°C") and one that clears the graphs. Temperatures can be shown in **°C or °F**.

### Setup

* **Libre Hardware Monitor** (free, no time limit): run it as administrator so it can read every sensor, open *Options → Remote Web Server → Run*, then press **Save and test connection** on its card. An optional user name and password is supported.
* **HWiNFO**: in HWiNFO's *Settings* (General / User Interface tab) tick **Shared Memory Support** and press OK. **Then restart HWiNFO**: close it completely (also from the tray icon) and start it again, with its Sensors window running. HWiNFO only starts sharing after a restart. The free version of HWiNFO **switches Shared Memory Support off after 12 hours**: tick it again and restart it (HWiNFO Pro has no limit). If you would rather not do that, use Libre Hardware Monitor.
* Both cards have an **Instructions** button with the same steps.

Which reading counts as "the CPU temperature" is picked automatically (the package temperature; with two GPUs, the one that is busiest). If it picks something you do not like, choose *Any sensor* and pick the one you want by name.

## 🧩 For plugin authors

The generic widget can now draw a small graph: return `spark` (a list of recent numbers, oldest first) and optionally `sparkMin` / `sparkMax` from `data()`. See the [Plugin reference](https://github.com/Jayconius/VRMacroPad/blob/main/docs/PLUGIN-GUIDE.md). The two hardware plugins share their code as identical copies (each plugin still stands alone), and a test keeps the copies in step.

## ⚠️ Known limits

* HWiNFO must be **restarted once** after Shared Memory Support is ticked, and the free version stops sharing after 12 hours (see above).
* Some sensors are not reported by every PC or by both programs (for example a GPU fan on a laptop). A widget then says the reading is not reported instead of showing a wrong number.
* **Mix It Up** and **TeamSpeak 3** (from 3.0.1) were built from their official documentation and tested against stand-ins, not yet against the real apps. Reports welcome.
* YouTube's one-click sign-in is still waiting for Google's verification. The YouTube plugin works today with your own Google app (the card's Instructions button).

388 automated tests (386 pass, 2 skipped by design).

Found a bug or want a feature? [Open an issue](https://github.com/Jayconius/VRMacroPad/issues).

**Full changes since 3.0.1:** https://github.com/Jayconius/VRMacroPad/compare/v3.0.1...v3.0.2
