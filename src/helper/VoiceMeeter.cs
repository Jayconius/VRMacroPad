// VR Macro Pad Voicemeeter helper.
// Talks to Voicemeeter (Standard, Banana or Potato) through VB-Audio's official Remote API (VoicemeeterRemote64.dll, installed
// with Voicemeeter itself; nothing is bundled here). It never starts Voicemeeter unless the "run" request is made.
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout ({id, ok, result|error}).
// For tests, VRMD_VMR_FAKE=1 swaps the DLL for a small in-memory Voicemeeter, so the protocol can be checked without it.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace VrmdVmr
{
    // ---- what Voicemeeter offers, real or pretend ----
    interface IVmr
    {
        string Name { get; }
        int Login();
        int Logout();
        int IsDirty();
        int GetVmType(out int type);
        int GetVersion(out int version);
        int GetFloat(string name, out float value);
        int GetString(string name, out string value);
        int SetFloat(string name, float value);
        int SetString(string name, string value);
        int SetScript(string script);
        int MacroGet(int button, out float value);
        int Run(int type);
        List<string[]> Devices(bool output);   // { type, name, hardwareId }
    }

    class Real : IVmr
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnVoid();
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnInt(int a);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnOutInt(out int a);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGetF([MarshalAs(UnmanagedType.LPStr)] string name, out float v);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnSetF([MarshalAs(UnmanagedType.LPStr)] string name, float v);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGetSW([MarshalAs(UnmanagedType.LPStr)] string name, IntPtr wbuf);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnSetSW([MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string v);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnScriptW([MarshalAs(UnmanagedType.LPWStr)] string script);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnMacroGet(int button, out float v, int bitmode);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnDevDescW(int index, out int type, IntPtr wname, IntPtr whwid);

        IntPtr module;
        FnVoid login, logout, dirty, inCount, outCount;
        FnInt run;
        FnOutInt getType, getVersion;
        FnGetF getF;
        FnSetF setF;
        FnGetSW getSW;
        FnSetSW setSW;
        FnScriptW script;
        FnMacroGet macroGet;
        FnDevDescW inDesc, outDesc;

        public string Name { get { return "Voicemeeter Remote API"; } }

        T Bind<T>(string name) where T : class
        {
            var p = GetProcAddress(module, name);
            if (p == IntPtr.Zero) throw new Exception("VoicemeeterRemote is missing " + name + " (update Voicemeeter)");
            return (T)(object)Marshal.GetDelegateForFunctionPointer(p, typeof(T));
        }

        public Real(string dll)
        {
            module = LoadLibraryW(dll);
            if (module == IntPtr.Zero) throw new Exception("Could not load " + dll);
            login = Bind<FnVoid>("VBVMR_Login");
            logout = Bind<FnVoid>("VBVMR_Logout");
            dirty = Bind<FnVoid>("VBVMR_IsParametersDirty");
            run = Bind<FnInt>("VBVMR_RunVoicemeeter");
            getType = Bind<FnOutInt>("VBVMR_GetVoicemeeterType");
            getVersion = Bind<FnOutInt>("VBVMR_GetVoicemeeterVersion");
            getF = Bind<FnGetF>("VBVMR_GetParameterFloat");
            setF = Bind<FnSetF>("VBVMR_SetParameterFloat");
            getSW = Bind<FnGetSW>("VBVMR_GetParameterStringW");
            setSW = Bind<FnSetSW>("VBVMR_SetParameterStringW");
            script = Bind<FnScriptW>("VBVMR_SetParametersW");
            macroGet = Bind<FnMacroGet>("VBVMR_MacroButton_GetStatus");
            inCount = Bind<FnVoid>("VBVMR_Input_GetDeviceNumber");
            outCount = Bind<FnVoid>("VBVMR_Output_GetDeviceNumber");
            inDesc = Bind<FnDevDescW>("VBVMR_Input_GetDeviceDescW");
            outDesc = Bind<FnDevDescW>("VBVMR_Output_GetDeviceDescW");
        }

        public int Login() { return login(); }
        public int Logout() { return logout(); }
        public int IsDirty() { return dirty(); }
        public int GetVmType(out int type) { return getType(out type); }
        public int GetVersion(out int version) { return getVersion(out version); }
        public int GetFloat(string name, out float value) { return getF(name, out value); }
        public int SetFloat(string name, float value) { return setF(name, value); }
        public int SetString(string name, string value) { return setSW(name, value); }
        public int SetScript(string s) { return script(s); }
        public int MacroGet(int button, out float value) { return macroGet(button, out value, 0); }
        public int Run(int type) { return run(type); }

        public int GetString(string name, out string value)
        {
            var buf = Marshal.AllocHGlobal(1024);   // 512 wide characters
            try
            {
                for (int i = 0; i < 1024; i++) Marshal.WriteByte(buf, i, 0);
                int rc = getSW(name, buf);
                value = rc == 0 ? Marshal.PtrToStringUni(buf) : "";
                return rc;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        public List<string[]> Devices(bool output)
        {
            var list = new List<string[]>();
            int n = output ? outCount() : inCount();
            for (int i = 0; i < n; i++)
            {
                var name = Marshal.AllocHGlobal(1024);
                var hw = Marshal.AllocHGlobal(1024);
                try
                {
                    for (int k = 0; k < 1024; k++) { Marshal.WriteByte(name, k, 0); Marshal.WriteByte(hw, k, 0); }
                    int type;
                    int rc = (output ? outDesc : inDesc)(i, out type, name, hw);
                    if (rc != 0) continue;
                    list.Add(new string[] { type == 1 ? "mme" : type == 3 ? "wdm" : type == 4 ? "ks" : type == 5 ? "asio" : type.ToString(), Marshal.PtrToStringUni(name), Marshal.PtrToStringUni(hw) });
                }
                finally { Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(hw); }
            }
            return list;
        }
    }

    // A tiny Voicemeeter Banana in memory (tests only).
    class Fake : IVmr
    {
        public readonly Dictionary<string, float> F = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, string> S = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public readonly List<string> Commands = new List<string>();
        public bool Running = true;

        public Fake()
        {
            for (int i = 0; i < 5; i++) S["Strip[" + i + "].Label"] = i == 0 ? "Mic" : i == 3 ? "Game" : "Strip " + (i + 1);
            for (int i = 0; i < 5; i++) S["Bus[" + i + "].Label"] = i < 3 ? "A" + (i + 1) : "B" + (i - 2);
        }

        public string Name { get { return "fake Voicemeeter Banana"; } }
        public int Login() { return Running ? 0 : 1; }
        public int Logout() { return 0; }
        public int IsDirty() { return Running ? 0 : -1; }
        public int GetVmType(out int type) { type = 2; return Running ? 0 : -1; }
        public int GetVersion(out int version) { version = (2 << 24) | (1 << 16) | (1 << 8) | 8; return 0; }
        public int GetFloat(string name, out float value) { if (!F.TryGetValue(name, out value)) value = 0f; return 0; }
        public int GetString(string name, out string value) { if (!S.TryGetValue(name, out value)) value = ""; return 0; }
        public int SetFloat(string name, float value) { F[name] = value; return 0; }
        public int SetString(string name, string value) { S[name] = value; return 0; }
        public int MacroGet(int button, out float value) { if (!F.TryGetValue("Command.Button[" + button + "].State", out value)) value = 0f; return 0; }
        public int Run(int type) { Running = true; Commands.Add("run " + type); return 0; }

        public List<string[]> Devices(bool output)
        {
            var l = new List<string[]>();
            l.Add(new string[] { "wdm", output ? "Headphones (Fake Audio)" : "Microphone (Fake Audio)", "{0.0.0}" });
            l.Add(new string[] { "mme", output ? "Speakers (Fake Audio)" : "Line in (Fake Audio)", "{0.0.1}" });
            return l;
        }

        // "Strip[0].Mute=1; Strip[1].Gain +=3; Bus[0].FadeTo=(-10,500); Command.Restart=1;"
        public int SetScript(string script)
        {
            foreach (var raw in script.Split(new char[] { ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var part = raw.Trim();
                if (part.Length == 0) continue;
                var m = Regex.Match(part, @"^([^=+\-]+?)\s*(\+=|-=|=)\s*(.*)$");
                if (!m.Success) return -3;
                var name = m.Groups[1].Value.Trim();
                var op = m.Groups[2].Value;
                var val = m.Groups[3].Value.Trim();
                if (name.StartsWith("Command.", StringComparison.OrdinalIgnoreCase) && !name.Contains(".Button")) { Commands.Add(name + "=" + val); continue; }
                if (name.EndsWith(".FadeTo", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".FadeBy", StringComparison.OrdinalIgnoreCase))
                {
                    var t = Regex.Match(val, @"\(\s*(-?[\d.]+)\s*,");
                    if (!t.Success) return -3;
                    var g = name.Substring(0, name.LastIndexOf('.')) + ".Gain";
                    float cur; F.TryGetValue(g, out cur);
                    var d = float.Parse(t.Groups[1].Value, CultureInfo.InvariantCulture);
                    F[g] = name.EndsWith("FadeTo", StringComparison.OrdinalIgnoreCase) ? d : cur + d;
                    continue;
                }
                float num;
                if (!float.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out num))
                {
                    S[name] = val.Trim('"');
                    continue;
                }
                float old; F.TryGetValue(name, out old);
                if (op == "+=") F[name] = name.EndsWith(".Gain", StringComparison.OrdinalIgnoreCase) ? old + num : (old + num) % 2;
                else if (op == "-=") F[name] = old - num;
                else F[name] = num;
            }
            return 0;
        }
    }

    static class Program
    {
        static IVmr vmr;
        static bool loggedIn = false;
        static string loadError = "";
        static readonly JavaScriptSerializer Ser = new JavaScriptSerializer();

        static string FindDll()
        {
            var dirs = new List<string>();
            foreach (var view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                try
                {
                    using (var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    using (var k = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}"))
                    {
                        if (k == null) continue;
                        foreach (var name in new string[] { "UninstallString", "DisplayIcon" })
                        {
                            var v = Convert.ToString(k.GetValue(name));
                            if (string.IsNullOrEmpty(v)) continue;
                            v = v.Trim();
                            if (v.StartsWith("\"")) { var end = v.IndexOf('"', 1); if (end > 1) v = v.Substring(1, end - 1); }
                            else { var exe = v.IndexOf(".exe", StringComparison.OrdinalIgnoreCase); if (exe > 0) v = v.Substring(0, exe + 4); }
                            var dir = Path.GetDirectoryName(v);
                            if (!string.IsNullOrEmpty(dir)) dirs.Add(dir);
                        }
                    }
                }
                catch (Exception) { }
            }
            dirs.Add(@"C:\Program Files (x86)\VB\Voicemeeter");
            dirs.Add(@"C:\Program Files\VB\Voicemeeter");
            foreach (var d in dirs)
            {
                var p = Path.Combine(d, Environment.Is64BitProcess ? "VoicemeeterRemote64.dll" : "VoicemeeterRemote.dll");
                if (File.Exists(p)) return p;
            }
            return null;
        }

        static bool Load()
        {
            if (vmr != null) return true;
            if (Environment.GetEnvironmentVariable("VRMD_VMR_FAKE") != null) { vmr = new Fake(); return true; }
            var dll = FindDll();
            if (dll == null) { loadError = "Voicemeeter is not installed"; return false; }
            try { vmr = new Real(dll); }
            catch (Exception e) { loadError = e.Message; return false; }
            return true;
        }

        // Logs in once for the life of this program; Voicemeeter itself may start and stop underneath.
        static bool Connect(out string error)
        {
            error = "";
            if (!Load()) { error = loadError; return false; }
            if (!loggedIn)
            {
                int rc = vmr.Login();
                if (rc < 0) { error = "Voicemeeter refused the connection (" + rc + ")"; return false; }
                loggedIn = true;
            }
            return true;
        }

        static string TypeName(int t) { return t == 1 ? "Voicemeeter" : t == 2 ? "Voicemeeter Banana" : t == 3 ? "Voicemeeter Potato" : "unknown"; }

        static string VersionText(int v)
        {
            return ((v >> 24) & 0xFF) + "." + ((v >> 16) & 0xFF) + "." + ((v >> 8) & 0xFF) + "." + (v & 0xFF);
        }

        static bool IsText(string name)
        {
            return name.EndsWith(".Label", StringComparison.OrdinalIgnoreCase) || name.EndsWith("device.name", StringComparison.OrdinalIgnoreCase);
        }

        static Dictionary<string, object> Status()
        {
            var res = new Dictionary<string, object>();
            string err;
            res["installed"] = Load();
            res["error"] = loadError;
            res["connected"] = false;
            if (!Connect(out err)) { res["error"] = err; return res; }
            int t;
            bool up = vmr.IsDirty() >= 0 && vmr.GetVmType(out t) == 0;
            if (up)
            {
                vmr.GetVmType(out t);
                int v;
                vmr.GetVersion(out v);
                res["connected"] = true;
                res["type"] = t;
                res["typeName"] = TypeName(t);
                res["version"] = VersionText(v);
                res["strips"] = t == 1 ? 3 : t == 2 ? 5 : 8;
                res["buses"] = t == 1 ? 2 : t == 2 ? 5 : 8;
            }
            else res["error"] = "Voicemeeter is not running";
            return res;
        }

        // One request for everything the buttons follow: the connection, the asked-for parameters and macro buttons.
        static object Poll(Dictionary<string, object> r)
        {
            var res = Status();
            if (!(bool)res["connected"]) return res;
            var values = new Dictionary<string, object>();
            var list = r.ContainsKey("names") ? r["names"] as System.Collections.IList : null;
            if (list != null)
            {
                foreach (var o in list)
                {
                    var name = Convert.ToString(o);
                    if (name.Length == 0 || name.Length > 120) continue;
                    if (IsText(name)) { string s; values[name] = vmr.GetString(name, out s) == 0 ? s : null; }
                    else { float f; values[name] = vmr.GetFloat(name, out f) == 0 ? (object)Math.Round((double)f, 3) : null; }
                }
            }
            res["values"] = values;
            var macros = new Dictionary<string, object>();
            var ml = r.ContainsKey("macros") ? r["macros"] as System.Collections.IList : null;
            if (ml != null)
            {
                foreach (var o in ml)
                {
                    int b = Convert.ToInt32(o);
                    if (b < 0 || b > 79) continue;
                    float f;
                    macros[b.ToString()] = vmr.MacroGet(b, out f) == 0 ? (object)(f != 0f) : null;
                }
            }
            res["macros"] = macros;
            return res;
        }

        static void Need(int rc, string what)
        {
            if (rc == 0) return;
            if (rc == -1) throw new Exception("Voicemeeter is not running");
            if (rc == -2) throw new Exception("Voicemeeter refused (incompatible version)");
            if (rc == -3) throw new Exception("Voicemeeter does not know \"" + what + "\"");
            throw new Exception("Voicemeeter error " + rc + " on " + what);
        }

        static void Ready()
        {
            string err;
            if (!Connect(out err)) throw new Exception(err);
            if (vmr.IsDirty() < 0) throw new Exception("Voicemeeter is not running");
        }

        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        static object Handle(Dictionary<string, object> r)
        {
            switch (S(r, "op"))
            {
                case "ping": return "pong";
                case "status": return Status();
                case "poll": return Poll(r);
                case "set":
                    {
                        Ready();
                        var name = S(r, "name");
                        if (string.IsNullOrEmpty(name)) throw new Exception("No parameter name");
                        Need(vmr.SetFloat(name, (float)Convert.ToDouble(r["value"])), name);
                        return true;
                    }
                case "setString":
                    {
                        Ready();
                        var name = S(r, "name");
                        if (string.IsNullOrEmpty(name)) throw new Exception("No parameter name");
                        Need(vmr.SetString(name, S(r, "value") ?? ""), name);
                        return true;
                    }
                case "script":
                    {
                        Ready();
                        var text = S(r, "text");
                        if (string.IsNullOrWhiteSpace(text)) throw new Exception("Nothing to send");
                        Need(vmr.SetScript(text), "the command");
                        return true;
                    }
                case "get":
                    {
                        Ready();
                        var name = S(r, "name");
                        if (IsText(name)) { string s; Need(vmr.GetString(name, out s), name); return s; }
                        float f;
                        Need(vmr.GetFloat(name, out f), name);
                        return Math.Round((double)f, 3);
                    }
                case "macro":
                    {
                        Ready();
                        float f;
                        Need(vmr.MacroGet(Convert.ToInt32(r["button"]), out f), "macro button");
                        return f != 0f;
                    }
                case "devices":
                    {
                        Ready();
                        var res = new Dictionary<string, object>();
                        foreach (var kind in new string[] { "inputs", "outputs" })
                        {
                            var l = new List<object>();
                            foreach (var d in vmr.Devices(kind == "outputs"))
                            {
                                var e = new Dictionary<string, object>();
                                e["driver"] = d[0]; e["name"] = d[1]; e["id"] = d[2];
                                l.Add(e);
                            }
                            res[kind] = l;
                        }
                        return res;
                    }
                case "run":
                    {
                        string err;
                        if (!Connect(out err)) throw new Exception(err);
                        int type = Convert.ToInt32(r["type"]);   // 1 Standard, 2 Banana, 3 Potato (+3 for the 64-bit program)
                        Need(vmr.Run(type), "start");
                        return true;
                    }
                case "fake":
                    {
                        // tests only: look at, or change, the pretend Voicemeeter
                        var fake = vmr as Fake;
                        if (fake == null) throw new Exception("Not the test Voicemeeter");
                        if (r.ContainsKey("running")) fake.Running = Convert.ToBoolean(r["running"]);
                        var res = new Dictionary<string, object>();
                        res["commands"] = fake.Commands;
                        var f = new Dictionary<string, object>();
                        foreach (var kv in fake.F) f[kv.Key] = Math.Round((double)kv.Value, 3);
                        res["floats"] = f;
                        var s = new Dictionary<string, object>();
                        foreach (var kv in fake.S) s[kv.Key] = kv.Value;
                        res["strings"] = s;
                        return res;
                    }
                case "shutdown":
                    if (loggedIn) { try { vmr.Logout(); } catch (Exception) { } loggedIn = false; }
                    return true;
                default: throw new Exception("Unknown op: " + S(r, "op"));
            }
        }

        [STAThread]
        static int Main()
        {
            var enc = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), enc);
            var output = new StreamWriter(Console.OpenStandardOutput(), enc);
            output.AutoFlush = true;
            Ser.MaxJsonLength = int.MaxValue;

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                var res = new Dictionary<string, object>();
                object id = null;
                try
                {
                    var req = (Dictionary<string, object>)Ser.DeserializeObject(line);
                    req.TryGetValue("id", out id);
                    res["id"] = id;
                    res["ok"] = true;
                    res["result"] = Handle(req);
                }
                catch (Exception e)
                {
                    res["id"] = id;
                    res["ok"] = false;
                    res["error"] = e.InnerException != null ? e.InnerException.Message : e.Message;
                    res.Remove("result");
                }
                output.WriteLine(Ser.Serialize(res));
            }
            if (loggedIn) { try { vmr.Logout(); } catch (Exception) { } }
            return 0;
        }
    }
}
