// VR Macro Pad SteamVR helper.
// Connects to SteamVR as a *background* app (it never starts SteamVR itself) and reports
// tracked devices with their battery state. Uses Valve's official OpenVR SDK (vendor/openvr).
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Valve.VR;

namespace VrmdVr
{
    static class Program
    {
        static readonly object Gate = new object();
        static bool inited = false;
        static string lastError = "";

        static bool TryInit()
        {
            if (inited) return true;
            if (!OpenVR.IsRuntimeInstalled()) { lastError = "SteamVR is not installed"; return false; }
            var err = EVRInitError.None;
            var sys = OpenVR.Init(ref err, EVRApplicationType.VRApplication_Background);
            if (err != EVRInitError.None || sys == null)
            {
                lastError = err == EVRInitError.Init_NoServerForBackgroundApp ? "SteamVR is not running" : OpenVR.GetStringForHmdError(err);
                return false;
            }
            inited = true;
            lastError = "";
            return true;
        }

        static void Disconnect()
        {
            if (!inited) return;
            inited = false;
            try { OpenVR.Shutdown(); } catch (Exception) { }
        }

        // SteamVR waits for its clients when it shuts down, so quit requests must be answered promptly.
        static void PumpEvents()
        {
            var ev = new VREvent_t();
            uint size = (uint)Marshal.SizeOf(typeof(VREvent_t));
            while (OpenVR.System.PollNextEvent(ref ev, size))
            {
                var type = (EVREventType)ev.eventType;
                if (type == EVREventType.VREvent_Quit || type == EVREventType.VREvent_ProcessQuit || type == EVREventType.VREvent_DriverRequestedQuit)
                {
                    OpenVR.System.AcknowledgeQuit_Exiting();
                    Disconnect();
                    return;
                }
            }
        }

        static string Str(uint index, ETrackedDeviceProperty prop)
        {
            var sb = new StringBuilder(256);
            var err = ETrackedPropertyError.TrackedProp_Success;
            OpenVR.System.GetStringTrackedDeviceProperty(index, prop, sb, (uint)sb.Capacity, ref err);
            return err == ETrackedPropertyError.TrackedProp_Success ? sb.ToString() : "";
        }

        static string ClassName(ETrackedDeviceClass c)
        {
            switch (c)
            {
                case ETrackedDeviceClass.HMD: return "hmd";
                case ETrackedDeviceClass.Controller: return "controller";
                case ETrackedDeviceClass.GenericTracker: return "tracker";
                case ETrackedDeviceClass.TrackingReference: return "basestation";
                default: return "other";
            }
        }

        static object Snapshot()
        {
            var res = new Dictionary<string, object>();
            var devices = new List<object>();
            res["devices"] = devices;
            lock (Gate)
            {
                if (!TryInit()) { res["connected"] = false; res["error"] = lastError; return res; }
                try
                {
                    var sys = OpenVR.System;
                    // One call covers every device: eTrackingResult per pose is how OpenVR says a device
                    // lost tracking (out of range, recalibrating) without fully disconnecting.
                    var poses = new TrackedDevicePose_t[OpenVR.k_unMaxTrackedDeviceCount];
                    bool havePoses = false;
                    try { sys.GetDeviceToAbsoluteTrackingPose(ETrackingUniverseOrigin.TrackingUniverseStanding, 0, poses); havePoses = true; } catch (Exception) { }
                    for (uint i = 0; i < OpenVR.k_unMaxTrackedDeviceCount; i++)
                    {
                        var cls = sys.GetTrackedDeviceClass(i);
                        if (cls == ETrackedDeviceClass.Invalid) continue;
                        if (!sys.IsTrackedDeviceConnected(i)) continue;
                        // Read the level directly and treat "the driver has none" as no battery. Gating on
                        // Prop_DeviceProvidesBatteryStatus_Bool hid devices that do report a level.
                        double battery = -1;
                        bool charging = false;
                        var e2 = ETrackedPropertyError.TrackedProp_Success;
                        float pct = sys.GetFloatTrackedDeviceProperty(i, ETrackedDeviceProperty.Prop_DeviceBatteryPercentage_Float, ref e2);
                        if (e2 == ETrackedPropertyError.TrackedProp_Success) battery = Math.Round(pct * 100);
                        bool provides = battery >= 0;
                        if (provides)
                        {
                            var e3 = ETrackedPropertyError.TrackedProp_Success;
                            charging = sys.GetBoolTrackedDeviceProperty(i, ETrackedDeviceProperty.Prop_DeviceIsCharging_Bool, ref e3) && e3 == ETrackedPropertyError.TrackedProp_Success;
                        }
                        object trackingOk = null;
                        if (havePoses && (cls == ETrackedDeviceClass.HMD || cls == ETrackedDeviceClass.Controller || cls == ETrackedDeviceClass.GenericTracker))
                            trackingOk = poses[i].eTrackingResult == ETrackingResult.Running_OK;
                        object worn = null;
                        if (cls == ETrackedDeviceClass.HMD)
                            worn = sys.GetTrackedDeviceActivityLevel(i) == EDeviceActivityLevel.k_EDeviceActivityLevel_UserInteraction;
                        var role = sys.GetControllerRoleForTrackedDeviceIndex(i);
                        var d = new Dictionary<string, object>();
                        d["index"] = i;
                        d["class"] = ClassName(cls);
                        d["role"] = role == ETrackedControllerRole.LeftHand ? "left" : role == ETrackedControllerRole.RightHand ? "right" : "";
                        d["model"] = Str(i, ETrackedDeviceProperty.Prop_ModelNumber_String);
                        d["serial"] = Str(i, ETrackedDeviceProperty.Prop_SerialNumber_String);
                        d["type"] = Str(i, ETrackedDeviceProperty.Prop_ControllerType_String);
                        d["manufacturer"] = Str(i, ETrackedDeviceProperty.Prop_ManufacturerName_String);
                        d["trackingOk"] = trackingOk;
                        d["worn"] = worn;
                        d["hasBattery"] = provides;
                        d["battery"] = battery;
                        d["charging"] = charging;
                        devices.Add(d);
                    }
                    res["connected"] = true;
                    res["error"] = "";
                }
                catch (Exception e)
                {
                    // SteamVR went away mid-read: drop the connection and report it.
                    Disconnect();
                    res["connected"] = false;
                    res["error"] = "Lost connection to SteamVR (" + e.Message + ")";
                }
            }
            return res;
        }

        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
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

            var pump = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(250);
                    lock (Gate)
                    {
                        if (!inited) continue;
                        try { PumpEvents(); } catch (Exception) { Disconnect(); }
                    }
                }
            });
            pump.IsBackground = true;
            pump.Start();

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                var res = new Dictionary<string, object>();
                object id = null;
                try
                {
                    var req = (Dictionary<string, object>)ser.DeserializeObject(line);
                    req.TryGetValue("id", out id);
                    res["id"] = id;
                    res["ok"] = true;
                    switch (S(req, "op"))
                    {
                        case "ping": res["result"] = "pong"; break;
                        case "snapshot": res["result"] = Snapshot(); break;
                        default: throw new Exception("Unknown op: " + S(req, "op"));
                    }
                }
                catch (Exception e)
                {
                    res["id"] = id;
                    res["ok"] = false;
                    res["error"] = e.InnerException != null ? e.InnerException.Message : e.Message;
                    res.Remove("result");
                }
                output.WriteLine(ser.Serialize(res));
            }
            lock (Gate) { Disconnect(); }
            return 0;
        }
    }
}
