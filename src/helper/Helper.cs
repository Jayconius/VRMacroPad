// VR Macro Pad Windows helper.
// Reads one JSON request per line on stdin, writes one JSON response per line on stdout.
// Compiled with the .NET Framework csc.exe that ships with Windows (C# 5), so no SDK is needed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace VrmdHelper
{
    // ---------- Win32: input + windows ----------
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion U; }

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int idx);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr h, int idx, IntPtr v);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr h, int idx);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr h, int idx, int v);

        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_NOACTIVATE = 0x08000000L;
        public const long WS_EX_APPWINDOW = 0x00040000L;
        public const long WS_EX_TOOLWINDOW = 0x00000080L;

        public static long GetExStyle(IntPtr h)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(h, GWL_EXSTYLE).ToInt64() : GetWindowLong32(h, GWL_EXSTYLE);
        }

        public static void SetExStyle(IntPtr h, long v)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_EXSTYLE, new IntPtr(v));
            else SetWindowLong32(h, GWL_EXSTYLE, (int)v);
        }
    }

    static class Keyboard
    {
        const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4, KEYEVENTF_SCANCODE = 8;

        static readonly HashSet<int> Extended = new HashSet<int> {
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, // nav cluster, printscreen, ins, del
            0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 // win keys, apps, numpad divide, numlock, right ctrl/alt
        };

        static void Send(Native.INPUT[] inputs)
        {
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != inputs.Length) throw new Exception("SendInput was blocked (Windows refused the input; try running the app as administrator if the target window is elevated)");
        }

        static Native.INPUT Key(int vk, bool up, bool scan)
        {
            var i = new Native.INPUT();
            i.type = 1;
            ushort sc = (ushort)Native.MapVirtualKey((uint)vk, 0);
            uint flags = 0;
            if (up) flags |= KEYEVENTF_KEYUP;
            if (Extended.Contains(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            if (scan) { flags |= KEYEVENTF_SCANCODE; i.U.ki.wVk = 0; }
            else i.U.ki.wVk = (ushort)vk;
            i.U.ki.wScan = sc;
            i.U.ki.dwFlags = flags;
            return i;
        }

        // Press every key in order, hold, release in reverse order.
        public static void Combo(List<int> vks, int holdMs, bool scan)
        {
            var down = new Native.INPUT[vks.Count];
            for (int n = 0; n < vks.Count; n++) down[n] = Key(vks[n], false, scan);
            Send(down);
            if (holdMs > 0) System.Threading.Thread.Sleep(holdMs);
            var up = new Native.INPUT[vks.Count];
            for (int n = 0; n < vks.Count; n++) up[n] = Key(vks[vks.Count - 1 - n], true, scan);
            Send(up);
        }

        public static void Text(string text, int perKeyDelayMs)
        {
            foreach (char c in text)
            {
                var d = new Native.INPUT(); d.type = 1; d.U.ki.wScan = c; d.U.ki.dwFlags = KEYEVENTF_UNICODE;
                var u = new Native.INPUT(); u.type = 1; u.U.ki.wScan = c; u.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                Send(new[] { d, u });
                if (perKeyDelayMs > 0) System.Threading.Thread.Sleep(perKeyDelayMs);
            }
        }
    }

    // ---------- Core Audio COM ----------
    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore props);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
        [PreserveSig] int GetChannelVolumeLevel(uint ch, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
        [PreserveSig] int VolumeStepUp(ref Guid ctx);
        [PreserveSig] int VolumeStepDown(ref Guid ctx);
        [PreserveSig] int QueryHardwareSupport(out uint mask);
        [PreserveSig] int GetVolumeRange(out float min, out float max, out float inc);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr groupId, uint flags, out IntPtr ctl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr groupId, uint flags, out IntPtr vol);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        [PreserveSig] int RegisterSessionNotification(IntPtr n);
        [PreserveSig] int UnregisterSessionNotification(IntPtr n);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr n);
        [PreserveSig] int UnregisterDuckNotification(IntPtr n);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        // IAudioSessionControl part
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
        [PreserveSig] int GetGroupingParam(out Guid param);
        [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid ctx);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
        // IAudioSessionControl2 part
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // Undocumented but long-stable interface used by every default-device switcher.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string dev, out IntPtr fmt);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string dev, [MarshalAs(UnmanagedType.Bool)] bool def, out IntPtr fmt);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string dev);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string dev, IntPtr endpointFmt, IntPtr mixFmt);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string dev, [MarshalAs(UnmanagedType.Bool)] bool def, out long defPeriod, out long minPeriod);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string dev, ref long period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string dev, out IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string dev, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string dev, [MarshalAs(UnmanagedType.Bool)] bool fx, ref PropertyKey key, out PropVariant v);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string dev, [MarshalAs(UnmanagedType.Bool)] bool fx, ref PropertyKey key, ref PropVariant v);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string dev, int role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string dev, [MarshalAs(UnmanagedType.Bool)] bool visible);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyConfigClient { }

    static class Audio
    {
        const int CLSCTX_ALL = 23;
        const int DEVICE_STATE_ACTIVE = 1;
        static Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static Guid NoContext = Guid.Empty;
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

        static void Check(int hr, string what)
        {
            if (hr != 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
        }

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        }

        static int Flow(string flow)
        {
            if (flow == "render") return 0;
            if (flow == "capture") return 1;
            throw new Exception("flow must be render or capture");
        }

        // id null/empty means the current default device.
        static IMMDevice Device(string flow, string id)
        {
            IMMDevice dev;
            if (string.IsNullOrEmpty(id)) Check(Enumerator().GetDefaultAudioEndpoint(Flow(flow), 0, out dev), "No default " + flow + " device");
            else Check(Enumerator().GetDevice(id, out dev), "Audio device not found");
            return dev;
        }

        static string DeviceId(IMMDevice d) { string id; Check(d.GetId(out id), "GetId"); return id; }

        static string FriendlyName(IMMDevice d)
        {
            IPropertyStore store;
            if (d.OpenPropertyStore(0, out store) != 0) return "(unknown)";
            var key = new PropertyKey { fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid = 14 };
            PropVariant pv;
            if (store.GetValue(ref key, out pv) != 0) return "(unknown)";
            string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.p) : "(unknown)";
            PropVariantClear(ref pv);
            return name;
        }

        static IAudioEndpointVolume Endpoint(IMMDevice d)
        {
            object o;
            Check(d.Activate(ref IID_EndpointVolume, CLSCTX_ALL, IntPtr.Zero, out o), "Activate volume");
            return (IAudioEndpointVolume)o;
        }

        static Dictionary<string, object> Describe(IMMDevice d)
        {
            var ep = Endpoint(d);
            bool muted; float vol;
            ep.GetMute(out muted);
            ep.GetMasterVolumeLevelScalar(out vol);
            var r = new Dictionary<string, object>();
            r["id"] = DeviceId(d);
            r["name"] = FriendlyName(d);
            r["muted"] = muted;
            r["volume"] = Math.Round(vol * 100);
            return r;
        }

        public static object Devices(string flow)
        {
            IMMDeviceCollection col;
            Check(Enumerator().EnumAudioEndpoints(Flow(flow), DEVICE_STATE_ACTIVE, out col), "EnumAudioEndpoints");
            int count; col.GetCount(out count);
            string defId = null;
            try { defId = DeviceId(Device(flow, null)); } catch (Exception) { }
            var list = new List<object>();
            for (int i = 0; i < count; i++)
            {
                IMMDevice d; col.Item(i, out d);
                var item = new Dictionary<string, object>();
                string id = DeviceId(d);
                item["id"] = id;
                item["name"] = FriendlyName(d);
                item["isDefault"] = id == defId;
                list.Add(item);
            }
            return list;
        }

        // Everything the state poller needs in one round trip.
        public static object Snapshot()
        {
            var r = new Dictionary<string, object>();
            foreach (string flow in new[] { "render", "capture" })
            {
                try { r[flow] = Describe(Device(flow, null)); } catch (Exception) { r[flow] = null; }
            }
            return r;
        }

        public static object SetMute(string flow, string id, object muted)
        {
            var ep = Endpoint(Device(flow, id));
            bool now;
            ep.GetMute(out now);
            bool target = muted == null ? !now : Convert.ToBoolean(muted);
            Check(ep.SetMute(target, ref NoContext), "SetMute");
            return target;
        }

        // volume: absolute 0-100, or delta: relative change in percentage points.
        public static object SetVolume(string flow, string id, object volume, object delta)
        {
            var ep = Endpoint(Device(flow, id));
            float cur; ep.GetMasterVolumeLevelScalar(out cur);
            double target = volume != null ? Convert.ToDouble(volume) : Math.Round(cur * 100) + Convert.ToDouble(delta);
            target = Math.Max(0, Math.Min(100, target));
            Check(ep.SetMasterVolumeLevelScalar((float)(target / 100.0), ref NoContext), "SetVolume");
            return target;
        }

        public static object SetDefault(string flow, string id)
        {
            Device(flow, id); // validates the id exists
            var policy = (IPolicyConfig)(new PolicyConfigClient());
            for (int role = 0; role < 3; role++) Check(policy.SetDefaultEndpoint(id, role), "SetDefaultEndpoint");
            return true;
        }

        // Audio sessions (one per app that has played sound) on EVERY active output device, not only the
        // default one: an app can be routed to any device (headset, speakers, a virtual mixer...).
        static List<KeyValuePair<string, object>> SessionsRaw()
        {
            var list = new List<KeyValuePair<string, object>>();
            IMMDeviceCollection devices;
            Check(Enumerator().EnumAudioEndpoints(0, DEVICE_STATE_ACTIVE, out devices), "EnumAudioEndpoints");
            int deviceCount; devices.GetCount(out deviceCount);
            for (int d = 0; d < deviceCount; d++)
            {
                try
                {
                    IMMDevice dev; devices.Item(d, out dev);
                    object o;
                    if (dev.Activate(ref IID_SessionManager2, CLSCTX_ALL, IntPtr.Zero, out o) != 0) continue;
                    var mgr = (IAudioSessionManager2)o;
                    IAudioSessionEnumerator en;
                    if (mgr.GetSessionEnumerator(out en) != 0) continue;
                    int count; en.GetCount(out count);
                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl2 ctl;
                        if (en.GetSession(i, out ctl) != 0) continue;
                        uint pid; ctl.GetProcessId(out pid);
                        if (pid == 0) continue; // system sounds
                        string name;
                        try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { continue; }
                        list.Add(new KeyValuePair<string, object>(name, ctl));
                    }
                }
                catch (Exception) { /* a virtual device that will not talk to us: skip it */ }
            }
            return list;
        }

        public static object Sessions()
        {
            var list = new List<object>();
            var seen = new HashSet<string>();
            foreach (var kv in SessionsRaw())
            {
                if (!seen.Add(kv.Key.ToLowerInvariant())) continue;
                var vol = (ISimpleAudioVolume)kv.Value;
                float v; bool m;
                vol.GetMasterVolume(out v); vol.GetMute(out m);
                var item = new Dictionary<string, object>();
                item["name"] = kv.Key;
                item["volume"] = Math.Round(v * 100);
                item["muted"] = m;
                list.Add(item);
            }
            return list;
        }

        // Matches every audio session belonging to a process name (chrome has many).
        public static object SetSession(string process, object volume, object delta, object muted, bool toggleMute)
        {
            string want = process.ToLowerInvariant();
            if (want.EndsWith(".exe")) want = want.Substring(0, want.Length - 4);
            int hits = 0;
            object last = null;
            foreach (var kv in SessionsRaw())
            {
                if (kv.Key.ToLowerInvariant() != want) continue;
                var vol = (ISimpleAudioVolume)kv.Value;
                hits++;
                if (volume != null || delta != null)
                {
                    float cur; vol.GetMasterVolume(out cur);
                    double target = volume != null ? Convert.ToDouble(volume) : Math.Round(cur * 100) + Convert.ToDouble(delta);
                    target = Math.Max(0, Math.Min(100, target));
                    Check(vol.SetMasterVolume((float)(target / 100.0), ref NoContext), "SetMasterVolume");
                    last = target;
                }
                if (toggleMute || muted != null)
                {
                    bool now; vol.GetMute(out now);
                    bool t = toggleMute ? !now : Convert.ToBoolean(muted);
                    Check(vol.SetMute(t, ref NoContext), "SetMute");
                    last = t;
                }
            }
            if (hits == 0) throw new Exception("No audio session for \"" + process + "\" (the app must be running and have made sound)");
            return last;
        }
    }

    // ---------- request dispatch ----------
    static class Program
    {
        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }
        static object O(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) ? v : null;
        }
        static int I(Dictionary<string, object> r, string k, int def)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : def;
        }

        static object Dispatch(Dictionary<string, object> r)
        {
            string op = S(r, "op");
            switch (op)
            {
                case "ping": return "pong";
                case "keys.combo":
                    {
                        var vks = new List<int>();
                        foreach (object v in (object[])r["vks"]) vks.Add(Convert.ToInt32(v));
                        Keyboard.Combo(vks, I(r, "holdMs", 30), Convert.ToBoolean(O(r, "scan") ?? false));
                        return true;
                    }
                case "keys.text": Keyboard.Text(S(r, "text") ?? "", I(r, "delayMs", 0)); return true;
                case "audio.devices": return Audio.Devices(S(r, "flow"));
                case "audio.snapshot": return Audio.Snapshot();
                case "audio.setMute": return Audio.SetMute(S(r, "flow"), S(r, "device"), O(r, "muted"));
                case "audio.setVolume": return Audio.SetVolume(S(r, "flow"), S(r, "device"), O(r, "volume"), O(r, "delta"));
                case "audio.setDefault": return Audio.SetDefault(S(r, "flow"), S(r, "device"));
                case "audio.sessions": return Audio.Sessions();
                case "audio.setSession":
                    return Audio.SetSession(S(r, "process"), O(r, "volume"), O(r, "delta"), O(r, "muted"), Convert.ToBoolean(O(r, "toggleMute") ?? false));
                case "proc.list":
                    {
                        var names = new HashSet<string>();
                        foreach (var p in Process.GetProcesses()) { names.Add(p.ProcessName.ToLowerInvariant() + ".exe"); p.Dispose(); }
                        return new List<string>(names);
                    }
                case "window.noActivate":
                    {
                        var h = new IntPtr(Convert.ToInt64(S(r, "hwnd")));
                        long style = Native.GetExStyle(h);
                        bool on = Convert.ToBoolean(r["on"]);
                        Native.SetExStyle(h, on ? (style | Native.WS_EX_NOACTIVATE) : (style & ~Native.WS_EX_NOACTIVATE));
                        return (Native.GetExStyle(h) & Native.WS_EX_NOACTIVATE) != 0;
                    }
                case "window.style":
                    {
                        // A window that does not activate on click gets no taskbar button unless it is
                        // also marked as an "app window", so the two flags are managed together.
                        var h = new IntPtr(Convert.ToInt64(S(r, "hwnd")));
                        long style = Native.GetExStyle(h);
                        if (r.ContainsKey("noActivate"))
                            style = Convert.ToBoolean(r["noActivate"]) ? (style | Native.WS_EX_NOACTIVATE) : (style & ~Native.WS_EX_NOACTIVATE);
                        if (r.ContainsKey("appWindow"))
                        {
                            bool app = Convert.ToBoolean(r["appWindow"]);
                            style = app ? ((style | Native.WS_EX_APPWINDOW) & ~Native.WS_EX_TOOLWINDOW) : (style & ~Native.WS_EX_APPWINDOW);
                        }
                        Native.SetExStyle(h, style);
                        long now = Native.GetExStyle(h);
                        var res = new Dictionary<string, object>();
                        res["noActivate"] = (now & Native.WS_EX_NOACTIVATE) != 0;
                        res["appWindow"] = (now & Native.WS_EX_APPWINDOW) != 0;
                        res["toolWindow"] = (now & Native.WS_EX_TOOLWINDOW) != 0;
                        return res;
                    }
                case "window.isNoActivate":
                    return (Native.GetExStyle(new IntPtr(Convert.ToInt64(S(r, "hwnd")))) & Native.WS_EX_NOACTIVATE) != 0;
                case "window.foreground":
                    {
                        var h = Native.GetForegroundWindow();
                        var sb = new StringBuilder(256);
                        Native.GetWindowText(h, sb, 256);
                        uint pid; Native.GetWindowThreadProcessId(h, out pid);
                        var res = new Dictionary<string, object>();
                        res["hwnd"] = h.ToInt64().ToString();
                        res["title"] = sb.ToString();
                        res["pid"] = pid;
                        return res;
                    }
                default: throw new Exception("Unknown op: " + op);
            }
        }

        [STAThread]
        static int Main()
        {
            var enc = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), enc);
            var output = new StreamWriter(Console.OpenStandardOutput(), enc);
            output.AutoFlush = true;
            var ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                object id = null;
                var res = new Dictionary<string, object>();
                try
                {
                    var req = (Dictionary<string, object>)ser.DeserializeObject(line);
                    id = O(req, "id");
                    res["id"] = id;
                    res["ok"] = true;
                    res["result"] = Dispatch(req);
                }
                catch (Exception e)
                {
                    res["id"] = id;
                    res["ok"] = false;
                    res["error"] = (e.InnerException != null ? e.InnerException.Message : e.Message);
                    res.Remove("result");
                }
                output.WriteLine(ser.Serialize(res));
            }
            return 0;
        }
    }
}
