// VR Macro Pad overlay helper.
// Puts the app's picture into SteamVR as an overlay, and reports laser clicks and scrolls back.
// It only connects when SteamVR is already running (it never starts SteamVR itself).
//
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout ({id, ok, result|error}).
// Unsolicited lines with an "ev" field (mouse, scroll, visible, quit, log) are events.
// The picture arrives on a named pipe as frames: 'VRMF', width u32, height u32, reserved u32, then BGRA pixels.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Valve.VR;

namespace VrmdOverlay
{
    static class Program
    {
        static readonly object Gate = new object();      // all SteamVR state
        static readonly object OutGate = new object();   // stdout lines
        static readonly JavaScriptSerializer Ser = new JavaScriptSerializer();
        static StreamWriter output;

        // The keys can be changed from the environment so tests can run next to the real overlay without clashing with it.
        static readonly string OverlayKey = Environment.GetEnvironmentVariable("VRMD_OVERLAY_KEY") ?? "com.jayconius.vrmacropad.overlay";
        static readonly string DashboardKey = Environment.GetEnvironmentVariable("VRMD_DASHBOARD_KEY") ?? "com.jayconius.vrmacropad.dashboard";
        static readonly string DimmerKey = Environment.GetEnvironmentVariable("VRMD_DIMMER_KEY") ?? "com.jayconius.vrmacropad.dimmer";

        static bool inited = false;
        static string lastError = "";
        static ulong handle = 0;

        // What we were asked for, remembered so it can be re-applied after SteamVR restarts.
        static float widthMeters = 0.7f;
        static float alpha = 1f;
        static float curvature = 0f;
        static bool wantVisible = true;
        static bool glanceOn = false;     // only show while you look at it
        static bool glanceOk = true;      // the latest verdict
        static bool haveFrame = false;
        static bool havePlacement = false;
        static bool shown = false;
        static string placeMode = "device";   // "device" or "absolute"
        static string placeRole = "hmd";      // hmd | left | right | tracker
        static string placeSerial = "";
        static float[] placeMatrix = Identity();
        static int frameW = 0, frameH = 0;
        static uint lastMouseDevice = 0;

        // The entry in SteamVR's dashboard (the bar at the bottom of the VR menu): a second overlay with its own picture.
        static ulong dashHandle = 0, dashThumb = 0;
        static int dashW = 0, dashH = 0;
        static string thumbFile = "";
        static bool dashOpen = false;

        // "Dim the view": a big black sheet just in front of the eyes, drawn under the deck and other overlays. It works on any
        // headset because it does not depend on the headset's driver.
        static ulong dimHandle = 0;
        static float dimLevel = 0f;
        static readonly HashSet<int> dashEventsSeen = new HashSet<int>();

        // How pictures reach SteamVR. The GPU path hands over a texture (no flicker); the raw path copies pixels each time.
        static bool wantGpu = true;
        static bool gpuBroken = false;
        static int gpuFails = 0;
        static long uploads = 0;
        static double uploadMsTotal = 0;
        static double uploadMsMax = 0;
        static string uploadPath = "";
        static bool gpuChecked = false;      // the first GPU picture was read back and really arrived
        static int gpuCheckAt = 0;           // when to read it back (Environment.TickCount), 0 = not armed
        static int gpuSentSample = 0;        // how much of the picture we sent was not zero

        // Grabbing: while set, the panel is held at a fixed offset from the controller that grabbed it.
        static bool grabbing = false;
        static uint grabDevice = 0;
        static float[] grabOffset = Identity();
        static float snapRadius = 0.35f;  // how close (m) the panel must be to a wrist to snap onto it
        static string snapNow = "";       // which wrist the carried panel is near right now ("", "left", "right")

        // ---- 3x4 matrices (row-major, same layout as HmdMatrix34_t) ----
        static float[] Identity()
        {
            return new float[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 };
        }

        public static float[] Multiply(float[] a, float[] b)
        {
            var o = new float[12];
            for (int i = 0; i < 3; i++)
            {
                for (int j = 0; j < 3; j++) o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
                o[i * 4 + 3] = a[i * 4] * b[3] + a[i * 4 + 1] * b[7] + a[i * 4 + 2] * b[11] + a[i * 4 + 3];
            }
            return o;
        }

        public static float[] Invert(float[] m)
        {
            var o = new float[12];
            for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) o[i * 4 + j] = m[j * 4 + i];
            for (int i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * m[3] + o[i * 4 + 1] * m[7] + o[i * 4 + 2] * m[11]);
            return o;
        }

        static float[] ToArr(HmdMatrix34_t m)
        {
            return new float[] { m.m0, m.m1, m.m2, m.m3, m.m4, m.m5, m.m6, m.m7, m.m8, m.m9, m.m10, m.m11 };
        }

        static HmdMatrix34_t ToMat(float[] a)
        {
            var m = new HmdMatrix34_t();
            m.m0 = a[0]; m.m1 = a[1]; m.m2 = a[2]; m.m3 = a[3];
            m.m4 = a[4]; m.m5 = a[5]; m.m6 = a[6]; m.m7 = a[7];
            m.m8 = a[8]; m.m9 = a[9]; m.m10 = a[10]; m.m11 = a[11];
            return m;
        }

        static float[] Arr12(object o)
        {
            var list = o as IList;
            if (list == null || list.Count != 12) return null;
            var a = new float[12];
            for (int i = 0; i < 12; i++) a[i] = (float)Convert.ToDouble(list[i]);
            return a;
        }

        static List<object> ArrOut(float[] a)
        {
            var l = new List<object>();
            foreach (var v in a) l.Add((double)v);
            return l;
        }

        // ---- output ----
        static void Emit(Dictionary<string, object> line)
        {
            lock (OutGate) { output.WriteLine(Ser.Serialize(line)); }
        }

        static void Log(string text)
        {
            var d = new Dictionary<string, object>();
            d["ev"] = "log";
            d["text"] = text;
            Emit(d);
        }

        static bool Ok(string what, EVROverlayError e)
        {
            if (e == EVROverlayError.None) return true;
            Log(what + " failed: " + e);
            return false;
        }

        // ---- connecting ----
        static bool SteamVrRunning()
        {
            try { return Process.GetProcessesByName("vrserver").Length > 0; } catch (Exception) { return false; }
        }

        static bool TryInit()
        {
            if (inited) return true;
            if (!OpenVR.IsRuntimeInstalled()) { lastError = "SteamVR is not installed"; return false; }
            if (!SteamVrRunning()) { lastError = "SteamVR is not running"; return false; }
            var err = EVRInitError.None;
            var sys = OpenVR.Init(ref err, EVRApplicationType.VRApplication_Overlay);
            if (err != EVRInitError.None || sys == null || OpenVR.Overlay == null)
            {
                lastError = err == EVRInitError.None ? "SteamVR has no overlay support" : OpenVR.GetStringForHmdError(err);
                return false;
            }
            inited = true;
            gpuChecked = false;
            gpuCheckAt = 0;
            lastError = "";
            try { int adapter = 0; sys.GetDXGIOutputInfo(ref adapter); D3D.UseAdapter(adapter); } catch (Exception) { D3D.UseAdapter(-1); }
            handle = 0;
            dashHandle = 0;
            dashThumb = 0;
            shown = false;
            return true;
        }

        static void Disconnect()
        {
            if (!inited) return;
            grabbing = false;
            try { if (handle != 0) OpenVR.Overlay.DestroyOverlay(handle); } catch (Exception) { }
            try { if (dashHandle != 0) OpenVR.Overlay.DestroyOverlay(dashHandle); } catch (Exception) { }
            try { if (dimHandle != 0) OpenVR.Overlay.DestroyOverlay(dimHandle); } catch (Exception) { }
            dimHandle = 0;
            handle = 0;
            dashHandle = 0;
            dashThumb = 0;
            shown = false;
            inited = false;
            try { OpenVR.Shutdown(); } catch (Exception) { }
        }

        static bool EnsureOverlay()
        {
            if (handle != 0) return true;
            var ov = OpenVR.Overlay;
            ulong h = 0;
            if (!Ok("CreateOverlay", ov.CreateOverlay(OverlayKey, "VR Macro Pad", ref h))) return false;
            handle = h;
            Ok("input method", ov.SetOverlayInputMethod(h, VROverlayInputMethod.Mouse));
            Ok("interactive", ov.SetOverlayFlag(h, VROverlayFlags.MakeOverlaysInteractiveIfVisible, true));
            Ok("premultiplied", ov.SetOverlayFlag(h, VROverlayFlags.IsPremultiplied, true));      // Chromium's pictures are premultiplied
            Ok("no backside", ov.SetOverlayFlag(h, VROverlayFlags.NoBackside, true));
            Ok("click stabilization", ov.SetOverlayFlag(h, VROverlayFlags.EnableClickStabilization, true));
            Ok("discrete scroll", ov.SetOverlayFlag(h, VROverlayFlags.SendVRDiscreteScrollEvents, true));
            Ok("color", ov.SetOverlayColor(h, 1f, 1f, 1f));
            Ok("sort order", ov.SetOverlaySortOrder(h, 10));   // above the dimmer
            ApplyProps();
            ApplyPlacement();
            if (frameW > 0) SetMouseScale();
            EnsureDashboard();
            EnsureDimmer();
            return true;
        }

        static void EnsureDimmer()
        {
            if (dimHandle != 0) return;
            var ov = OpenVR.Overlay;
            ulong h = 0;
            if (!Ok("CreateOverlay (dimmer)", ov.CreateOverlay(DimmerKey, "VR Macro Pad dimmer", ref h))) return;
            dimHandle = h;
            var white = new byte[] { 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255 };   // 2x2
            var pin = GCHandle.Alloc(white, GCHandleType.Pinned);
            try { Ok("dimmer picture", ov.SetOverlayRaw(h, pin.AddrOfPinnedObject(), 2, 2, 4)); } finally { pin.Free(); }
            Ok("dimmer input", ov.SetOverlayInputMethod(h, VROverlayInputMethod.None));   // the laser goes straight through
            Ok("dimmer color", ov.SetOverlayColor(h, 0f, 0f, 0f));
            Ok("dimmer width", ov.SetOverlayWidthInMeters(h, 8f));
            Ok("dimmer sort", ov.SetOverlaySortOrder(h, 0));
            var m = ToMat(new float[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.5f });
            Ok("dimmer place", ov.SetOverlayTransformTrackedDeviceRelative(h, OpenVR.k_unTrackedDeviceIndex_Hmd, ref m));
            ApplyDim();
        }

        static void ApplyDim()
        {
            if (dimHandle == 0) return;
            var ov = OpenVR.Overlay;
            if (dimLevel <= 0.001f) { ov.HideOverlay(dimHandle); return; }
            Ok("dimmer alpha", ov.SetOverlayAlpha(dimHandle, dimLevel));
            Ok("dimmer show", ov.ShowOverlay(dimHandle));
        }

        // The dashboard entry. SteamVR lists it in the bar at the bottom of the VR menu and shows its picture when it is opened.
        static void EnsureDashboard()
        {
            if (dashHandle != 0) return;
            var ov = OpenVR.Overlay;
            ulong main = 0, thumb = 0;
            if (!Ok("CreateDashboardOverlay", ov.CreateDashboardOverlay(DashboardKey, "VR Macro Pad", ref main, ref thumb))) return;
            dashHandle = main;
            dashThumb = thumb;
            Ok("dashboard input", ov.SetOverlayInputMethod(main, VROverlayInputMethod.Mouse));
            Ok("dashboard premultiplied", ov.SetOverlayFlag(main, VROverlayFlags.IsPremultiplied, true));
            Ok("dashboard scroll", ov.SetOverlayFlag(main, VROverlayFlags.SendVRDiscreteScrollEvents, true));
            Ok("dashboard width", ov.SetOverlayWidthInMeters(main, 1.8f));
            if (thumbFile.Length > 0) Ok("dashboard icon", ov.SetOverlayFromFile(thumb, thumbFile));
            if (dashW > 0)
            {
                var s = new HmdVector2_t();
                s.v0 = dashW;
                s.v1 = dashH;
                Ok("dashboard mouse scale", ov.SetOverlayMouseScale(main, ref s));
            }
        }

        static void ApplyProps()
        {
            if (handle == 0) return;
            var ov = OpenVR.Overlay;
            Ok("width", ov.SetOverlayWidthInMeters(handle, widthMeters));
            Ok("alpha", ov.SetOverlayAlpha(handle, alpha));
            Ok("curvature", ov.SetOverlayCurvature(handle, curvature));
            ApplyVisibility();
        }

        static void SetMouseScale()
        {
            if (handle != 0 && frameW > 0)
            {
                var s = new HmdVector2_t();
                s.v0 = frameW;
                s.v1 = frameH;
                Ok("mouse scale", OpenVR.Overlay.SetOverlayMouseScale(handle, ref s));
            }
            if (dashHandle != 0 && dashW > 0)
            {
                var s = new HmdVector2_t();
                s.v0 = dashW;
                s.v1 = dashH;
                Ok("dashboard mouse scale", OpenVR.Overlay.SetOverlayMouseScale(dashHandle, ref s));
            }
        }

        // Only show the panel once it has a picture and a place, so it never flashes at the origin.
        static void ApplyVisibility()
        {
            if (handle == 0) return;
            bool want = wantVisible && haveFrame && havePlacement && (!glanceOn || glanceOk);
            if (want == shown) return;
            var ov = OpenVR.Overlay;
            if (want) Ok("show", ov.ShowOverlay(handle)); else Ok("hide", ov.HideOverlay(handle));
            shown = want;
        }

        // ---- devices ----
        static uint ResolveDevice(string role, string serial)
        {
            var sys = OpenVR.System;
            if (role == "hmd") return OpenVR.k_unTrackedDeviceIndex_Hmd;
            if (role == "left") return sys.GetTrackedDeviceIndexForControllerRole(ETrackedControllerRole.LeftHand);
            if (role == "right") return sys.GetTrackedDeviceIndexForControllerRole(ETrackedControllerRole.RightHand);
            if (role == "tracker" && serial.Length > 0)
            {
                for (uint i = 0; i < OpenVR.k_unMaxTrackedDeviceCount; i++)
                {
                    if (sys.GetTrackedDeviceClass(i) != ETrackedDeviceClass.GenericTracker) continue;
                    if (StrProp(i, ETrackedDeviceProperty.Prop_SerialNumber_String) == serial) return i;
                }
            }
            return OpenVR.k_unTrackedDeviceIndexInvalid;
        }

        static string StrProp(uint index, ETrackedDeviceProperty prop)
        {
            var sb = new StringBuilder(256);
            var err = ETrackedPropertyError.TrackedProp_Success;
            OpenVR.System.GetStringTrackedDeviceProperty(index, prop, sb, (uint)sb.Capacity, ref err);
            return err == ETrackedPropertyError.TrackedProp_Success ? sb.ToString() : "";
        }

        static TrackedDevicePose_t[] ReadPoses()
        {
            var poses = new TrackedDevicePose_t[OpenVR.k_unMaxTrackedDeviceCount];
            OpenVR.System.GetDeviceToAbsoluteTrackingPose(ETrackingUniverseOrigin.TrackingUniverseStanding, 0f, poses);
            return poses;
        }

        static void ApplyPlacement()
        {
            if (handle == 0) return;
            var ov = OpenVR.Overlay;
            var m = ToMat(placeMatrix);
            if (placeMode == "absolute")
            {
                Ok("place (room)", ov.SetOverlayTransformAbsolute(handle, ETrackingUniverseOrigin.TrackingUniverseStanding, ref m));
                havePlacement = true;
            }
            else
            {
                uint dev = ResolveDevice(placeRole, placeSerial);
                if (dev == OpenVR.k_unTrackedDeviceIndexInvalid) { havePlacement = false; ApplyVisibility(); return; } // controller not there (yet): stay hidden
                Ok("place (device)", ov.SetOverlayTransformTrackedDeviceRelative(handle, dev, ref m));
                havePlacement = true;
            }
            ApplyVisibility();
        }

        // ---- grabbing ----
        static float[] OverlayWorldNow(TrackedDevicePose_t[] poses)
        {
            if (placeMode == "absolute") return placeMatrix;
            uint dev = ResolveDevice(placeRole, placeSerial);
            if (dev == OpenVR.k_unTrackedDeviceIndexInvalid || !poses[dev].bPoseIsValid) return null;
            return Multiply(ToArr(poses[dev].mDeviceToAbsoluteTracking), placeMatrix);
        }

        // ---- snapping to a wrist ----
        public static bool SnapNear(float[] panel, float[] controller, float radius)
        {
            float dx = panel[3] - controller[3], dy = panel[7] - controller[7], dz = panel[11] - controller[11];
            return (float)Math.Sqrt(dx * dx + dy * dy + dz * dz) < radius;
        }

        // The wrist (of the hand that is NOT holding the panel) the panel is close to, or "".
        static string NearestWrist(TrackedDevicePose_t[] poses, float[] world, out string controllerType)
        {
            controllerType = "";
            var sys = OpenVR.System;
            var holder = sys.GetControllerRoleForTrackedDeviceIndex(grabDevice);
            string[] roles = holder == ETrackedControllerRole.LeftHand ? new string[] { "right" } : holder == ETrackedControllerRole.RightHand ? new string[] { "left" } : new string[] { "left", "right" };
            string best = "";
            float bestDist = snapRadius;
            foreach (var role in roles)
            {
                uint dev = ResolveDevice(role, "");
                if (dev == OpenVR.k_unTrackedDeviceIndexInvalid || dev >= poses.Length || !poses[dev].bPoseIsValid) continue;
                var c = ToArr(poses[dev].mDeviceToAbsoluteTracking);
                float dx = world[3] - c[3], dy = world[7] - c[7], dz = world[11] - c[11];
                float d = (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
                if (d < bestDist) { bestDist = d; best = role; controllerType = StrProp(dev, ETrackedDeviceProperty.Prop_ControllerType_String); }
            }
            return best;
        }

        static void EmitSnap(string role)
        {
            var d = new Dictionary<string, object>();
            d["ev"] = "snap";
            d["role"] = role;
            Emit(d);
        }

        static object GrabStart(uint device)
        {
            if (!inited || handle == 0) throw new Exception("The overlay is not connected");
            var poses = ReadPoses();
            if (device >= poses.Length || !poses[device].bPoseIsValid) throw new Exception("That controller has no position right now");
            var world = OverlayWorldNow(poses);
            if (world == null) throw new Exception("The device the panel follows is not tracked right now");
            grabDevice = device;
            grabOffset = Multiply(Invert(ToArr(poses[device].mDeviceToAbsoluteTracking)), world);
            snapNow = "";
            grabbing = true;
            return true;
        }

        static void GrabTick()
        {
            var poses = ReadPoses();
            if (grabDevice >= poses.Length || !poses[grabDevice].bPoseIsValid) return;
            var world = Multiply(ToArr(poses[grabDevice].mDeviceToAbsoluteTracking), grabOffset);
            var m = ToMat(world);
            OpenVR.Overlay.SetOverlayTransformAbsolute(handle, ETrackingUniverseOrigin.TrackingUniverseStanding, ref m);
            string type;
            string near = NearestWrist(poses, world, out type);
            if (near != snapNow) { snapNow = near; EmitSnap(near); }   // tells the app to light up the wrist button
        }

        static object GrabStop()
        {
            var res = new Dictionary<string, object>();
            if (!grabbing) { res["grabbed"] = false; return res; }
            grabbing = false;
            var poses = ReadPoses();
            var world = poses[grabDevice].bPoseIsValid ? Multiply(ToArr(poses[grabDevice].mDeviceToAbsoluteTracking), grabOffset) : OverlayWorldNow(poses);
            res["grabbed"] = true;
            if (world == null) { ApplyPlacement(); return res; }
            res["world"] = ArrOut(world);
            string snapType;
            res["snapRole"] = NearestWrist(poses, world, out snapType);
            res["snapType"] = snapType;
            if (snapNow != "") { snapNow = ""; EmitSnap(""); }
            if (placeMode == "absolute")
            {
                placeMatrix = world;
            }
            else
            {
                uint dev = ResolveDevice(placeRole, placeSerial);
                if (dev != OpenVR.k_unTrackedDeviceIndexInvalid && poses[dev].bPoseIsValid)
                {
                    placeMatrix = Multiply(Invert(ToArr(poses[dev].mDeviceToAbsoluteTracking)), world);
                    res["relative"] = ArrOut(placeMatrix);
                }
            }
            ApplyPlacement(); // back to following the device (or staying in the room) at the new spot
            return res;
        }

        // ---- looking at it ----
        // True while the panel faces the head and the head faces the panel. Easier to keep than to gain, so it
        // does not flicker at the edge: it appears within 50 degrees of straight on and stays until 60.
        public static bool GlanceVisible(float[] hmd, float[] panel, bool wasVisible)
        {
            float tx = hmd[3] - panel[3], ty = hmd[7] - panel[7], tz = hmd[11] - panel[11];   // panel -> head
            float dist = (float)Math.Sqrt(tx * tx + ty * ty + tz * tz);
            if (dist < 0.01f || dist > 1.5f) return false;
            tx /= dist; ty /= dist; tz /= dist;
            float facing = panel[2] * tx + panel[6] * ty + panel[10] * tz;          // the panel's front (+Z) toward the head
            float gaze = -(hmd[2] * -tx + hmd[6] * -ty + hmd[10] * -tz);            // the head's forward (-Z) toward the panel
            float faceMin = wasVisible ? 0.5f : 0.64f;                              // cos 60 / cos 50
            float gazeMin = wasVisible ? 0.7f : 0.82f;                              // cos 45 / cos 35
            return facing > faceMin && gaze > gazeMin;
        }

        static void GlanceTick()
        {
            if (!glanceOn || handle == 0 || grabbing) return;
            bool ok = false;
            try
            {
                var poses = ReadPoses();
                var world = OverlayWorldNow(poses);
                if (world != null && poses[0].bPoseIsValid) ok = GlanceVisible(ToArr(poses[0].mDeviceToAbsoluteTracking), world, glanceOk);
            }
            catch (Exception) { ok = false; }
            if (ok != glanceOk) { glanceOk = ok; ApplyVisibility(); }
        }

        // ---- the picture ----
        static bool ReadExact(Stream s, byte[] buf, int count)
        {
            int got = 0;
            while (got < count)
            {
                int n = s.Read(buf, got, count - got);
                if (n <= 0) return false;
                got += n;
            }
            return true;
        }

        // How many sampled bytes of a picture are not zero (an empty texture reads back as all zeros).
        static int NonZero(byte[] px, int count)
        {
            int n = 0;
            for (int i = 0; i < count; i += 61) if (px[i] != 0) n++;
            return n;
        }

        // Reads the first GPU picture back out of SteamVR. If it never arrived (empty), switch to the raw path for good
        // and ask the app to send the picture again, so a broken GPU path can never leave the deck invisible.
        static void GpuCheck()
        {
            gpuCheckAt = 0;
            if (handle == 0 || frameW <= 0 || frameH <= 0 || uploadPath != "gpu") return;
            int n = frameW * frameH * 4;
            var buf = new byte[n];
            var pin = GCHandle.Alloc(buf, GCHandleType.Pinned);
            try
            {
                uint rw = 0, rh = 0;
                var e = OpenVR.Overlay.GetOverlayImageData(handle, pin.AddrOfPinnedObject(), (uint)n, ref rw, ref rh);
                if (e != EVROverlayError.None) { Log("could not check the GPU picture (" + e + "); keeping it"); gpuChecked = true; return; }
                if (NonZero(buf, n) == 0)
                {
                    gpuBroken = true;
                    Log("the GPU picture arrived empty: using raw pixels instead");
                    var d = new Dictionary<string, object>();
                    d["ev"] = "repaint";
                    Emit(d);
                }
                else { gpuChecked = true; Log("the GPU picture arrived (checked)"); }
            }
            finally { pin.Free(); }
        }

        // BGRA (what Chromium paints) to RGBA (what SteamVR wants).
        public static void SwapRedBlue(byte[] bgra, byte[] rgba, int count)
        {
            for (int i = 0; i < count; i += 4)
            {
                rgba[i] = bgra[i + 2];
                rgba[i + 1] = bgra[i + 1];
                rgba[i + 2] = bgra[i];
                rgba[i + 3] = bgra[i + 3];
            }
        }

        static string pipeName = "";
        static Thread pipeThread;
        static volatile bool pipeWanted = false;

        static void StartPipe(string name)
        {
            if (pipeThread != null && pipeName == name) return;
            pipeName = name;
            pipeWanted = true;
            if (pipeThread != null) return;
            pipeThread = new Thread(PipeLoop);
            pipeThread.IsBackground = true;
            pipeThread.Start();
        }

        static void PipeLoop()
        {
            var head = new byte[16];
            byte[] bgra = new byte[0];
            byte[] rgba = new byte[0];
            var sw = new Stopwatch();
            while (true)
            {
                if (!pipeWanted) { Thread.Sleep(200); continue; }
                try
                {
                    using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.In))
                    {
                        pipe.Connect(1500);
                        Log("picture pipe connected");
                        while (pipeWanted)
                        {
                            if (!ReadExact(pipe, head, 16)) break;
                            if (head[0] != (byte)'V' || head[1] != (byte)'R' || head[2] != (byte)'M' || head[3] != (byte)'F') { Log("bad picture header"); break; }
                            int w = BitConverter.ToInt32(head, 4);
                            int h = BitConverter.ToInt32(head, 8);
                            int size = w * h * 4;
                            if (w <= 0 || h <= 0 || w > 8192 || h > 8192) { Log("bad picture size"); break; }
                            if (bgra.Length != size) { bgra = new byte[size]; rgba = new byte[size]; }
                            if (!ReadExact(pipe, bgra, size)) break;
                            bool dash = BitConverter.ToInt32(head, 12) == 1;

                            // GPU texture: made outside the lock, handed to SteamVR inside it.
                            IntPtr tex = IntPtr.Zero;
                            if (wantGpu && !gpuBroken)
                            {
                                try { tex = D3D.MakeTexture(bgra, w, h); } catch (Exception e) { Log("GPU texture failed: " + e.Message); gpuBroken = true; }
                            }
                            bool gpuTried = tex != IntPtr.Zero;
                            bool needRaw = !gpuTried;
                            if (needRaw) SwapRedBlue(bgra, rgba, size);
                            var pin = needRaw ? GCHandle.Alloc(rgba, GCHandleType.Pinned) : default(GCHandle);
                            try
                            {
                                lock (Gate)
                                {
                                    if (inited && EnsureOverlay())
                                    {
                                        ulong target = dash ? dashHandle : handle;
                                        if (target != 0)
                                        {
                                            if (dash)
                                            {
                                                if (w != dashW || h != dashH) { dashW = w; dashH = h; SetMouseScale(); }
                                            }
                                            else if (w != frameW || h != frameH) { frameW = w; frameH = h; SetMouseScale(); }
                                            sw.Reset();
                                            sw.Start();
                                            bool sent = false;
                                            if (gpuTried)
                                            {
                                                var t = new Texture_t();
                                                t.handle = tex;
                                                t.eType = ETextureType.DirectX;
                                                t.eColorSpace = EColorSpace.Auto;
                                                var err = OpenVR.Overlay.SetOverlayTexture(target, ref t);
                                                if (err == EVROverlayError.None)
                                                {
                                                    // Without this the picture sits in this program's graphics queue and SteamVR gets an empty texture.
                                                    if (Environment.GetEnvironmentVariable("VRMD_TEST_NOFLUSH") == null) D3D.Flush();
                                                    sent = true;
                                                    gpuFails = 0;
                                                    if (uploadPath != "gpu") { uploadPath = "gpu"; Log("pictures go to SteamVR as GPU textures"); }
                                                    if (!dash && !gpuChecked && gpuCheckAt == 0)
                                                    {
                                                        gpuSentSample = NonZero(bgra, size);
                                                        if (gpuSentSample > 0) gpuCheckAt = Environment.TickCount + 700;
                                                    }
                                                }
                                                else
                                                {
                                                    Log("texture upload failed: " + err);
                                                    if (++gpuFails >= 3) { gpuBroken = true; Log("switching to the compatible picture path"); }
                                                    // this frame still goes out the old way
                                                    SwapRedBlue(bgra, rgba, size);
                                                    needRaw = true;
                                                    pin = GCHandle.Alloc(rgba, GCHandleType.Pinned);
                                                }
                                            }
                                            if (!sent && needRaw)
                                            {
                                                sent = Ok("picture", OpenVR.Overlay.SetOverlayRaw(target, pin.AddrOfPinnedObject(), (uint)w, (uint)h, 4));
                                                if (sent && uploadPath != "raw") { uploadPath = "raw"; Log("pictures go to SteamVR as raw pixels"); }
                                            }
                                            sw.Stop();
                                            if (sent)
                                            {
                                                double ms = sw.Elapsed.TotalMilliseconds;
                                                uploads++;
                                                uploadMsTotal += ms;
                                                if (ms > uploadMsMax) uploadMsMax = ms;
                                                if (!dash && !haveFrame) { haveFrame = true; ApplyVisibility(); }
                                            }
                                        }
                                    }
                                    else if (dash) { dashW = w; dashH = h; }
                                    else { frameW = w; frameH = h; }
                                }
                            }
                            finally
                            {
                                if (pin.IsAllocated) pin.Free();
                                if (tex != IntPtr.Zero) D3D.Release(tex);
                            }
                        }
                    }
                }
                catch (TimeoutException) { }
                catch (Exception) { }
                Thread.Sleep(300);
            }
        }

        // ---- events ----
        static void PumpOnce()
        {
            if (!inited) return;
            var ev = new VREvent_t();
            uint size = (uint)Marshal.SizeOf(typeof(VREvent_t));
            var sys = OpenVR.System;
            while (sys.PollNextEvent(ref ev, size))
            {
                var type = (EVREventType)ev.eventType;
                if (type == EVREventType.VREvent_Quit || type == EVREventType.VREvent_ProcessQuit || type == EVREventType.VREvent_DriverRequestedQuit)
                {
                    try { sys.AcknowledgeQuit_Exiting(); } catch (Exception) { }
                    Disconnect();
                    var q = new Dictionary<string, object>();
                    q["ev"] = "quit";
                    Emit(q);
                    return;
                }
            }
            if (dashHandle != 0)
            {
                bool open = OpenVR.Overlay.IsDashboardVisible();
                if (open != dashOpen)
                {
                    dashOpen = open;
                    var dd = new Dictionary<string, object>();
                    dd["ev"] = "dashboard";
                    dd["open"] = open;
                    dd["panel"] = OpenVR.Overlay.IsOverlayVisible(dashHandle);
                    Emit(dd);
                }
            }
            if (handle != 0) PollOverlay(handle, "", ref ev, size);
            if (dashHandle != 0) PollOverlay(dashHandle, "dash", ref ev, size);
        }

        static void PollOverlay(ulong which, string target, ref VREvent_t ev, uint size)
        {
            var ov = OpenVR.Overlay;
            while (ov.PollNextOverlayEvent(which, ref ev, size))
            {
                var type = (EVREventType)ev.eventType;
                var d = new Dictionary<string, object>();
                if (target.Length > 0)
                {
                    d["target"] = target;
                    // what the dashboard page is being sent, once per kind, so a silent panel can be understood from the log
                    if (dashEventsSeen.Add((int)type)) Log("dashboard event: " + type);
                }
                if (type == EVREventType.VREvent_MouseMove || type == EVREventType.VREvent_MouseButtonDown || type == EVREventType.VREvent_MouseButtonUp)
                {
                    if (target.Length == 0) lastMouseDevice = ev.trackedDeviceIndex;
                    d["ev"] = "mouse";
                    d["type"] = type == EVREventType.VREvent_MouseMove ? "move" : type == EVREventType.VREvent_MouseButtonDown ? "down" : "up";
                    d["x"] = (double)ev.data.mouse.x;
                    d["y"] = (double)ev.data.mouse.y;
                    d["button"] = (int)ev.data.mouse.button;
                    d["device"] = (int)ev.trackedDeviceIndex;
                    Emit(d);
                }
                else if (type == EVREventType.VREvent_KeyboardCharInput || type == EVREventType.VREvent_KeyboardDone || type == EVREventType.VREvent_KeyboardClosed)
                {
                    // SteamVR's on-screen keyboard keeps the whole text; we hand it over each time it changes.
                    var sb = new StringBuilder(2048);
                    string text = "";
                    try { ov.GetKeyboardText(sb, (uint)sb.Capacity); text = sb.ToString(); } catch (Exception) { }
                    d["ev"] = "keyboard";
                    d["kind"] = type == EVREventType.VREvent_KeyboardCharInput ? "text" : type == EVREventType.VREvent_KeyboardDone ? "done" : "closed";
                    d["text"] = text;
                    Emit(d);
                }
                else if (type == EVREventType.VREvent_ScrollDiscrete || type == EVREventType.VREvent_ScrollSmooth)
                {
                    d["ev"] = "scroll";
                    d["dx"] = (double)ev.data.scroll.xdelta;
                    d["dy"] = (double)ev.data.scroll.ydelta;
                    d["device"] = (int)ev.trackedDeviceIndex;
                    Emit(d);
                }
                else if (type == EVREventType.VREvent_FocusLeave)
                {
                    d["ev"] = "mouse";
                    d["type"] = "leave";
                    d["device"] = (int)ev.trackedDeviceIndex;
                    Emit(d);
                }
                else if (type == EVREventType.VREvent_OverlayShown || type == EVREventType.VREvent_OverlayHidden)
                {
                    d["ev"] = "visible";
                    d["shown"] = type == EVREventType.VREvent_OverlayShown;
                    Emit(d);
                }
            }
        }

        static void PumpLoop()
        {
            while (true)
            {
                Thread.Sleep(8);
                lock (Gate)
                {
                    try
                    {
                        if (!inited) continue;
                        PumpOnce();
                        if (inited && gpuCheckAt != 0 && Environment.TickCount - gpuCheckAt >= 0) GpuCheck();
                        if (inited && grabbing) GrabTick();
                        if (inited && glanceOn) GlanceTick();
                        // A controller that appeared after we were asked to follow it.
                        if (inited && handle != 0 && !havePlacement && placeMode == "device") ApplyPlacement();
                    }
                    catch (Exception e)
                    {
                        Log("pump error: " + e.Message);
                        Disconnect();
                    }
                }
            }
        }

        // ---- requests ----
        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        static bool Has(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null;
        }

        static float F(Dictionary<string, object> r, string k)
        {
            return (float)Convert.ToDouble(r[k]);
        }

        static object Status()
        {
            var res = new Dictionary<string, object>();
            res["connected"] = inited;
            res["error"] = lastError;
            res["overlay"] = handle != 0;
            res["shown"] = shown;
            res["frame"] = frameW > 0 ? frameW + "x" + frameH : "";
            res["grabbing"] = grabbing;
            res["dashboard"] = dashHandle != 0;
            res["dim"] = Math.Round(dimLevel, 3);
            res["dimmer"] = dimHandle != 0;
            res["upload"] = uploadPath;
            res["uploads"] = uploads;
            res["uploadMs"] = uploads > 0 ? Math.Round(uploadMsTotal / uploads, 2) : 0.0;
            res["uploadMaxMs"] = Math.Round(uploadMsMax, 2);
            return res;
        }

        static void EnsureDashboardIfReady()
        {
            if (inited && handle != 0) EnsureDashboard();
        }

        static object Attach()
        {
            lock (Gate)
            {
                if (TryInit()) EnsureOverlay();
                return Status();
            }
        }

        static object Poses()
        {
            lock (Gate)
            {
                if (!inited) throw new Exception("SteamVR is not connected");
                var poses = ReadPoses();
                var sys = OpenVR.System;
                var list = new List<object>();
                for (uint i = 0; i < OpenVR.k_unMaxTrackedDeviceCount; i++)
                {
                    var cls = sys.GetTrackedDeviceClass(i);
                    if (cls == ETrackedDeviceClass.Invalid || !sys.IsTrackedDeviceConnected(i)) continue;
                    var d = new Dictionary<string, object>();
                    d["index"] = i;
                    d["class"] = cls.ToString();
                    var role = sys.GetControllerRoleForTrackedDeviceIndex(i);
                    d["role"] = role == ETrackedControllerRole.LeftHand ? "left" : role == ETrackedControllerRole.RightHand ? "right" : "";
                    d["serial"] = StrProp(i, ETrackedDeviceProperty.Prop_SerialNumber_String);
                    d["model"] = StrProp(i, ETrackedDeviceProperty.Prop_ModelNumber_String);
                    d["controllerType"] = StrProp(i, ETrackedDeviceProperty.Prop_ControllerType_String);
                    d["inputProfile"] = StrProp(i, ETrackedDeviceProperty.Prop_InputProfilePath_String);
                    d["valid"] = poses[i].bPoseIsValid;
                    if (poses[i].bPoseIsValid) d["matrix"] = ArrOut(ToArr(poses[i].mDeviceToAbsoluteTracking));
                    list.Add(d);
                }
                var res = new Dictionary<string, object>();
                res["devices"] = list;
                return res;
            }
        }

        static object Handle(Dictionary<string, object> r)
        {
            switch (S(r, "op"))
            {
                case "ping": return "pong";
                case "status": lock (Gate) { return Status(); }
                case "attach":
                    if (S(r, "icon") != null) thumbFile = S(r, "icon");
                    return Attach();
                case "detach": lock (Gate) { Disconnect(); return Status(); }
                case "frames":
                    StartPipe(S(r, "pipe"));
                    return true;
                case "props":
                    lock (Gate)
                    {
                        if (Has(r, "width")) widthMeters = Math.Max(0.05f, Math.Min(5f, F(r, "width")));
                        if (Has(r, "alpha")) alpha = Math.Max(0f, Math.Min(1f, F(r, "alpha")));
                        if (Has(r, "curvature")) curvature = Math.Max(0f, Math.Min(1f, F(r, "curvature")));
                        if (Has(r, "visible")) wantVisible = Convert.ToBoolean(r["visible"]);
                        if (Has(r, "glance")) { glanceOn = Convert.ToBoolean(r["glance"]); if (!glanceOn) glanceOk = true; }
                        ApplyProps();
                        return Status();
                    }
                case "place":
                    lock (Gate)
                    {
                        var m = Arr12(r.ContainsKey("matrix") ? r["matrix"] : null);
                        if (m == null) throw new Exception("place needs a 12-number matrix");
                        placeMode = S(r, "mode") == "absolute" ? "absolute" : "device";
                        placeRole = S(r, "role") ?? "hmd";
                        placeSerial = S(r, "serial") ?? "";
                        placeMatrix = m;
                        if (grabbing) return Status(); // the grab owns the position until it ends
                        havePlacement = false;
                        ApplyPlacement();
                        return Status();
                    }
                case "poses": return Poses();
                case "dim":
                    lock (Gate)
                    {
                        dimLevel = Math.Max(0f, Math.Min(0.9f, F(r, "level")));
                        ApplyDim();
                        return Status();
                    }
                case "upload":
                    lock (Gate)
                    {
                        wantGpu = S(r, "mode") != "raw";
                        if (wantGpu) { gpuBroken = false; gpuFails = 0; gpuChecked = false; gpuCheckAt = 0; }
                        uploads = 0; uploadMsTotal = 0; uploadMsMax = 0;
                        return Status();
                    }
                case "dashboard":
                    lock (Gate)
                    {
                        if (S(r, "icon") != null) thumbFile = S(r, "icon");
                        EnsureDashboardIfReady();
                        if (dashThumb != 0 && thumbFile.Length > 0) Ok("dashboard icon", OpenVR.Overlay.SetOverlayFromFile(dashThumb, thumbFile));
                        return Status();
                    }
                case "keyboard":
                    lock (Gate)
                    {
                        if (!inited || dashHandle == 0) throw new Exception("The dashboard is not connected");
                        int mode = Has(r, "password") && Convert.ToBoolean(r["password"]) ? 1 : 0;
                        int lines = Has(r, "multiline") && Convert.ToBoolean(r["multiline"]) ? 1 : 0;
                        uint max = Has(r, "max") ? Convert.ToUInt32(r["max"]) : 1024;
                        var ke = OpenVR.Overlay.ShowKeyboardForOverlay(dashHandle, mode, lines, 0, S(r, "desc") ?? "", max, S(r, "text") ?? "", 0);
                        if (ke != EVROverlayError.None) throw new Exception("SteamVR keyboard: " + ke);
                        return true;
                    }
                case "keyboard.hide":
                    lock (Gate) { if (inited) OpenVR.Overlay.HideKeyboard(); return true; }
                case "d3d":
                    {
                        // Lets the tests (and me) check that this PC can make textures without SteamVR.
                        var res = new Dictionary<string, object>();
                        if (Has(r, "adapter")) D3D.UseAdapter(Convert.ToInt32(r["adapter"]));
                        var tex = D3D.MakeTexture(new byte[4 * 4 * 4], 4, 4);
                        res["ok"] = tex != IntPtr.Zero;
                        res["adapter"] = D3D.AdapterName;
                        D3D.Release(tex);
                        return res;
                    }
                case "grab.start":
                    lock (Gate)
                    {
                        if (Has(r, "snapRadius")) snapRadius = Math.Max(0.05f, Math.Min(1f, F(r, "snapRadius")));
                        return GrabStart(Has(r, "device") ? Convert.ToUInt32(r["device"]) : lastMouseDevice);
                    }
                case "grab.stop":
                    lock (Gate) { return GrabStop(); }
                case "haptic":
                    lock (Gate)
                    {
                        if (inited && handle != 0) OpenVR.Overlay.TriggerLaserMouseHapticVibration(handle, 0.02f, 200f, 0.4f);
                        return true;
                    }
                case "math":
                    {
                        // Lets the tests check this matrix code against the JavaScript one.
                        var a = Arr12(r["a"]);
                        var b = Arr12(r["b"]);
                        var res = new Dictionary<string, object>();
                        res["multiply"] = ArrOut(Multiply(a, b));
                        res["invert"] = ArrOut(Invert(a));
                        return res;
                    }
                case "glance":
                    {
                        // Lets the tests check the looking-at-it rule without SteamVR.
                        return GlanceVisible(Arr12(r["hmd"]), Arr12(r["panel"]), Convert.ToBoolean(r["was"]));
                    }
                case "snap":
                    {
                        // Lets the tests check the near-a-wrist rule without SteamVR.
                        return SnapNear(Arr12(r["panel"]), Arr12(r["controller"]), F(r, "radius"));
                    }
                case "swap":
                    {
                        // Lets the tests check the picture conversion without SteamVR.
                        var src = Convert.FromBase64String(S(r, "bgra"));
                        var dst = new byte[src.Length];
                        SwapRedBlue(src, dst, src.Length);
                        return Convert.ToBase64String(dst);
                    }
                case "shutdown":
                    lock (Gate) { Disconnect(); }
                    pipeWanted = false;
                    return true;
                default: throw new Exception("Unknown op: " + S(r, "op"));
            }
        }

        [STAThread]
        static int Main()
        {
            var enc = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), enc);
            output = new StreamWriter(Console.OpenStandardOutput(), enc);
            output.AutoFlush = true;
            Ser.MaxJsonLength = int.MaxValue;

            var pump = new Thread(PumpLoop);
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
                lock (OutGate) { output.WriteLine(Ser.Serialize(res)); }
            }
            lock (Gate) { Disconnect(); }
            return 0;
        }
    }

    // Just enough Direct3D 11 to make a texture from pixels, with no extra libraries. SteamVR takes the texture and
    // keeps it as long as it needs it (we only drop our own reference), so a picture is never rewritten while it is shown.
    static class D3D
    {
        [StructLayout(LayoutKind.Sequential)]
        struct TexDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccess, MiscFlags; }
        [StructLayout(LayoutKind.Sequential)]
        struct SubData { public IntPtr Mem; public uint Pitch, SlicePitch; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct AdapterDesc { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description; public uint VendorId, DeviceId, SubSysId, Revision; public UIntPtr DedicatedVideo, DedicatedSystem, SharedSystem; public long Luid; }

        [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
        [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);

        delegate int CreateTex2DFn(IntPtr self, ref TexDesc d, ref SubData s, out IntPtr tex);
        delegate int EnumAdaptersFn(IntPtr self, uint index, out IntPtr adapter);
        delegate int GetDescFn(IntPtr self, out AdapterDesc desc);
        delegate uint ReleaseFn(IntPtr self);
        delegate void FlushFn(IntPtr self);

        static IntPtr device = IntPtr.Zero;
        static IntPtr context = IntPtr.Zero;
        static CreateTex2DFn createTex;
        public static string AdapterName = "";
        static int wantedAdapter = -1;

        static IntPtr Slot(IntPtr obj, int index)
        {
            return Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), index * IntPtr.Size);
        }

        public static uint Release(IntPtr obj)
        {
            if (obj == IntPtr.Zero) return 0;
            return ((ReleaseFn)Marshal.GetDelegateForFunctionPointer(Slot(obj, 2), typeof(ReleaseFn)))(obj);
        }

        // Which graphics card SteamVR renders on (a texture from another card would not work).
        public static void UseAdapter(int index)
        {
            if (index != wantedAdapter && device != IntPtr.Zero) { Release(context); Release(device); device = IntPtr.Zero; context = IntPtr.Zero; }
            wantedAdapter = index;
        }

        static void Init()
        {
            if (device != IntPtr.Zero) return;
            IntPtr adapter = IntPtr.Zero;
            IntPtr factory = IntPtr.Zero;
            if (wantedAdapter >= 0)
            {
                var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); // IDXGIFactory1
                if (CreateDXGIFactory1(ref iid, out factory) == 0)
                {
                    var enumFn = (EnumAdaptersFn)Marshal.GetDelegateForFunctionPointer(Slot(factory, 7), typeof(EnumAdaptersFn));
                    if (enumFn(factory, (uint)wantedAdapter, out adapter) != 0) adapter = IntPtr.Zero;
                }
            }
            if (adapter != IntPtr.Zero)
            {
                AdapterDesc desc;
                var getDesc = (GetDescFn)Marshal.GetDelegateForFunctionPointer(Slot(adapter, 8), typeof(GetDescFn));
                AdapterName = getDesc(adapter, out desc) == 0 ? desc.Description : "";
            }
            int level;
            // driver type 0 (unknown) is required when an adapter is given; 1 (hardware) otherwise. 0x20 = BGRA support.
            int hr = D3D11CreateDevice(adapter, adapter != IntPtr.Zero ? 0 : 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context);
            Release(adapter);
            Release(factory);
            if (hr != 0 || device == IntPtr.Zero) { device = IntPtr.Zero; throw new Exception("no Direct3D 11 device (0x" + hr.ToString("x") + ")"); }
            createTex = (CreateTex2DFn)Marshal.GetDelegateForFunctionPointer(Slot(device, 5), typeof(CreateTex2DFn));
        }

        // Pixels are BGRA, exactly what Chromium paints. Returns a texture the caller must Release.
        public static uint UsageMode = 1;   // 1 = immutable (default); 0 = default usage, for experiments

        // Sends the queued work to the graphics card now. A device that never presents a frame would otherwise let it sit.
        public static void Flush()
        {
            if (context == IntPtr.Zero) return;
            ((FlushFn)Marshal.GetDelegateForFunctionPointer(Slot(context, 111), typeof(FlushFn)))(context);
        }

        public static IntPtr MakeTexture(byte[] bgra, int w, int h)
        {
            Init();
            var pin = GCHandle.Alloc(bgra, GCHandleType.Pinned);
            try
            {
                var d = new TexDesc();
                d.Width = (uint)w; d.Height = (uint)h; d.MipLevels = 1; d.ArraySize = 1;
                d.Format = 87;            // DXGI_FORMAT_B8G8R8A8_UNORM
                d.SampleCount = 1; d.SampleQuality = 0;
                d.Usage = UsageMode;      // immutable by default: filled once, never changed
                d.BindFlags = 8;          // shader resource
                var sub = new SubData();
                sub.Mem = pin.AddrOfPinnedObject();
                sub.Pitch = (uint)(w * 4);
                IntPtr tex;
                int hr = createTex(device, ref d, ref sub, out tex);
                if (hr != 0 || tex == IntPtr.Zero) throw new Exception("CreateTexture2D failed (0x" + hr.ToString("x") + ")");
                return tex;
            }
            finally { pin.Free(); }
        }
    }
}
