// VR Macro Pad media helper.
// Reads and controls the Windows media session (the same source the volume flyout shows),
// so it works with Spotify, browsers and most players without any login.
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
//
// Windows Runtime async operations are awaited through reflection: the compiler would
// otherwise need the Windows SDK's umbrella metadata file, which most PCs do not have.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Media;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace VrmdMedia
{
    static class Program
    {
        static readonly Type Ext = Type.GetType("System.WindowsRuntimeSystemExtensions, System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089");
        static readonly MethodInfo AsTaskOp = Ext.GetMethods().First(m => m.Name == "AsTask" && m.IsGenericMethod && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.Name.StartsWith("IAsyncOperation`1"));

        static R Await<R>(object op)
        {
            var task = (Task<R>)AsTaskOp.MakeGenericMethod(typeof(R)).Invoke(null, new object[] { op });
            if (!task.Wait(6000)) throw new Exception("The media API did not answer in time");
            return task.Result;
        }

        static GlobalSystemMediaTransportControlsSessionManager manager;
        static string thumbKey = "";
        static string thumbData = "";

        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        static readonly string[] Browsers = { "brave", "chrome", "msedge", "firefox", "opera", "vivaldi", "iexplore", "arc.exe", "zen" };

        static bool IsBrowser(string id)
        {
            string l = id.ToLowerInvariant();
            foreach (var b in Browsers) if (l.Contains(b)) return true;
            return false;
        }

        // app: "auto" (a playing music app first, then a playing browser tab, then whatever is paused),
        // "any" (whatever Windows considers current) or part of an app id such as "spotify".
        static GlobalSystemMediaTransportControlsSession Pick(string app)
        {
            var sessions = manager.GetSessions().ToList();
            if (sessions.Count == 0) return null;
            if (app == "auto")
            {
                var current = manager.GetCurrentSession();
                GlobalSystemMediaTransportControlsSession best = null;
                int bestScore = -1;
                // Windows' current session goes first so it wins ties.
                var order = new List<GlobalSystemMediaTransportControlsSession>();
                if (current != null) order.Add(current);
                foreach (var s in sessions) if (current == null || s.SourceAppUserModelId != current.SourceAppUserModelId) order.Add(s);
                foreach (var s in order)
                {
                    // playing music app > paused music app > playing browser tab > paused browser tab
                    int score = (IsBrowser(s.SourceAppUserModelId) ? 0 : 2) + (s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? 1 : 0);
                    if (score > bestScore) { best = s; bestScore = score; }
                }
                return best;
            }
            if (string.IsNullOrEmpty(app) || app == "any") return manager.GetCurrentSession() ?? sessions[0];
            string needle = app.ToLowerInvariant();
            foreach (var s in sessions) if (s.SourceAppUserModelId.ToLowerInvariant().Contains(needle)) return s;
            return null;
        }

        static string ReadThumb(GlobalSystemMediaTransportControlsSessionMediaProperties props, string key)
        {
            if (thumbKey == key) return thumbData;
            string data = "";
            try
            {
                if (props.Thumbnail != null)
                {
                    var stream = Await<IRandomAccessStreamWithContentType>(props.Thumbnail.OpenReadAsync());
                    if (stream.Size > 0 && stream.Size < 4000000)
                    {
                        using (var reader = new DataReader(stream.GetInputStreamAt(0)))
                        {
                            uint n = Await<uint>(reader.LoadAsync((uint)stream.Size));
                            var bytes = new byte[n];
                            reader.ReadBytes(bytes);
                            string mime = string.IsNullOrEmpty(stream.ContentType) ? "image/jpeg" : stream.ContentType;
                            data = "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
                        }
                    }
                }
            }
            catch (Exception) { data = ""; }
            thumbKey = key;
            thumbData = data;
            return data;
        }

        static object Get(Dictionary<string, object> r)
        {
            var ids = manager.GetSessions().Select(s => s.SourceAppUserModelId).ToList();
            var res = new Dictionary<string, object>();
            res["sessions"] = ids;
            var s0 = Pick(S(r, "app"));
            if (s0 == null) { res["available"] = false; return res; }
            var props = Await<GlobalSystemMediaTransportControlsSessionMediaProperties>(s0.TryGetMediaPropertiesAsync());
            var info = s0.GetPlaybackInfo();
            var tl = s0.GetTimelineProperties();
            string key = s0.SourceAppUserModelId + "|" + props.Title + "|" + props.Artist + "|" + props.AlbumTitle;
            res["available"] = true;
            res["appId"] = s0.SourceAppUserModelId;
            res["title"] = props.Title ?? "";
            res["artist"] = props.Artist ?? "";
            res["album"] = props.AlbumTitle ?? "";
            res["status"] = info.PlaybackStatus.ToString();
            res["positionMs"] = (long)tl.Position.TotalMilliseconds;
            res["startMs"] = (long)tl.StartTime.TotalMilliseconds;
            res["endMs"] = (long)tl.EndTime.TotalMilliseconds;
            res["updatedAt"] = tl.LastUpdatedTime.ToUnixTimeMilliseconds();
            res["canSeek"] = info.Controls.IsPlaybackPositionEnabled;
            // null = the player does not say (then the widget hides its shuffle / repeat buttons)
            res["shuffle"] = info.IsShuffleActive.HasValue ? (object)info.IsShuffleActive.Value : null;
            res["repeat"] = info.AutoRepeatMode.HasValue ? info.AutoRepeatMode.Value.ToString() : "";
            res["canShuffle"] = info.Controls.IsShuffleEnabled;
            res["canRepeat"] = info.Controls.IsRepeatEnabled;
            res["thumbKey"] = key;
            // The picture is only sent when the caller does not already have this track's picture.
            res["thumb"] = S(r, "knownThumbKey") != key ? ReadThumb(props, key) : "";
            return res;
        }

        // Every player Windows knows about, with what it is doing, for the "Player" picker.
        static object List()
        {
            var list = new List<object>();
            foreach (var s in manager.GetSessions())
            {
                var d = new Dictionary<string, object>();
                d["id"] = s.SourceAppUserModelId;
                d["status"] = s.GetPlaybackInfo().PlaybackStatus.ToString();
                string title = "", artist = "";
                try
                {
                    var props = Await<GlobalSystemMediaTransportControlsSessionMediaProperties>(s.TryGetMediaPropertiesAsync());
                    title = props.Title ?? ""; artist = props.Artist ?? "";
                }
                catch (Exception) { }
                d["title"] = title;
                d["artist"] = artist;
                list.Add(d);
            }
            return list;
        }

        static object Control(Dictionary<string, object> r)
        {
            var s0 = Pick(S(r, "app"));
            if (s0 == null) throw new Exception("No media player is running");
            string cmd = S(r, "cmd");
            bool ok;
            switch (cmd)
            {
                case "play": ok = Await<bool>(s0.TryPlayAsync()); break;
                case "pause": ok = Await<bool>(s0.TryPauseAsync()); break;
                case "toggle": ok = Await<bool>(s0.TryTogglePlayPauseAsync()); break;
                case "stop": ok = Await<bool>(s0.TryStopAsync()); break;
                case "next": ok = Await<bool>(s0.TrySkipNextAsync()); break;
                case "previous": ok = Await<bool>(s0.TrySkipPreviousAsync()); break;
                case "shuffle":
                {
                    string mode = S(r, "mode");
                    bool cur = s0.GetPlaybackInfo().IsShuffleActive ?? false;
                    bool want = mode == "on" ? true : mode == "off" ? false : !cur;
                    ok = Await<bool>(s0.TryChangeShuffleActiveAsync(want));
                    break;
                }
                case "repeat":
                {
                    string mode = S(r, "mode");
                    var cur = s0.GetPlaybackInfo().AutoRepeatMode ?? MediaPlaybackAutoRepeatMode.None;
                    MediaPlaybackAutoRepeatMode want;
                    if (mode == "none") want = MediaPlaybackAutoRepeatMode.None;
                    else if (mode == "list") want = MediaPlaybackAutoRepeatMode.List;
                    else if (mode == "track") want = MediaPlaybackAutoRepeatMode.Track;
                    else want = cur == MediaPlaybackAutoRepeatMode.None ? MediaPlaybackAutoRepeatMode.List : cur == MediaPlaybackAutoRepeatMode.List ? MediaPlaybackAutoRepeatMode.Track : MediaPlaybackAutoRepeatMode.None;
                    ok = Await<bool>(s0.TryChangeAutoRepeatModeAsync(want));
                    break;
                }
                case "seekby":
                {
                    // relative jump: work out where the song is right now, add the delta, stay inside the song
                    var tl = s0.GetTimelineProperties();
                    var pi = s0.GetPlaybackInfo();
                    double pos = tl.Position.TotalMilliseconds;
                    if (pi.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                        pos += Math.Max(0, (DateTimeOffset.Now - tl.LastUpdatedTime).TotalMilliseconds);
                    pos += Convert.ToDouble(r["deltaMs"]);
                    pos = Math.Max(tl.StartTime.TotalMilliseconds, Math.Min(pos, tl.EndTime.TotalMilliseconds - 500));
                    ok = Await<bool>(s0.TryChangePlaybackPositionAsync((long)(pos * 10000)));
                    break;
                }
                case "seek": ok = Await<bool>(s0.TryChangePlaybackPositionAsync(Convert.ToInt64(r["positionMs"]) * 10000)); break;
                default: throw new Exception("Unknown media command: " + cmd);
            }
            if (!ok) throw new Exception("The player did not accept \"" + cmd + "\"");
            return true;
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
            manager = Await<GlobalSystemMediaTransportControlsSessionManager>(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
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
                        case "get": res["result"] = Get(req); break;
                        case "list": res["result"] = List(); break;
                        case "control": res["result"] = Control(req); break;
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
            return 0;
        }
    }
}
