// VR Macro Pad HWiNFO helper.
// Reads the numbers HWiNFO publishes through its official "Shared Memory Support" (a read-only block of memory called
// Global\HWiNFO_SENS_SM2, layout described in HWiNFO's own SDK). Nothing is written to HWiNFO and nothing is controlled.
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout ({id, ok, result|error}).
// For tests, VRMD_HWINFO_TEST=1 lets the "publish" request create a pretend HWiNFO block under another name, so the
// reader can be checked without HWiNFO.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;
using System.Web.Script.Serialization;

namespace VrmdHwinfo
{
    static class Program
    {
        const string RealMap = "Global\\HWiNFO_SENS_SM2";
        const uint SigLive = 0x53695748;   // 'HWiS'
        const uint SigDead = 0x44414544;   // 'DEAD': HWiNFO closed it (or Shared Memory Support timed out)
        const int MaxSensors = 4096;
        const int MaxReadings = 65536;

        static readonly JavaScriptSerializer Ser = new JavaScriptSerializer();
        static MemoryMappedFile published;   // test only

        static string S(Dictionary<string, object> r, string k)
        {
            object v; return r.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        static string Text(MemoryMappedViewAccessor v, long pos, int max)
        {
            var b = new byte[max];
            v.ReadArray(pos, b, 0, max);
            int n = Array.IndexOf(b, (byte)0);
            if (n < 0) n = max;
            // Newer HWiNFO writes UTF-8, but units such as the degree sign can come as Windows-1252: use UTF-8 when it is valid, else 1252.
            try { return new UTF8Encoding(false, true).GetString(b, 0, n); }
            catch (Exception) { return Encoding.GetEncoding(1252).GetString(b, 0, n); }
        }

        static object Read(string name)
        {
            MemoryMappedFile mm;
            try
            {
                mm = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read);
            }
            catch (FileNotFoundException)
            {
                throw new Exception("HWiNFO is not sharing its sensors. Start HWiNFO with Sensors, and tick Shared Memory Support in its Settings.");
            }
            catch (UnauthorizedAccessException)
            {
                throw new Exception("Windows does not let this app read HWiNFO's shared memory. Try running HWiNFO and this app both normally or both as administrator.");
            }
            using (mm)
            using (var v = mm.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read))
            {
                uint sig = v.ReadUInt32(0);
                if (sig == SigDead) throw new Exception("HWiNFO's Shared Memory Support is switched off (the free version turns it off after 12 hours: tick it again in HWiNFO's Settings).");
                if (sig != SigLive) throw new Exception("That is not HWiNFO's shared memory.");
                uint sensorOff = v.ReadUInt32(20), sensorSize = v.ReadUInt32(24), sensorCount = v.ReadUInt32(28);
                uint readOff = v.ReadUInt32(32), readSize = v.ReadUInt32(36), readCount = v.ReadUInt32(40);
                if (sensorSize < 264 || readSize < 316 || sensorCount > MaxSensors || readCount > MaxReadings) throw new Exception("HWiNFO's shared memory has a layout this app does not know.");
                var sensors = new List<object>();
                for (uint i = 0; i < sensorCount; i++)
                {
                    long p = sensorOff + (long)i * sensorSize;
                    var sname = Text(v, p + 136, 128);   // the name you gave it, else the original one
                    if (sname.Length == 0) sname = Text(v, p + 8, 128);
                    sensors.Add(new Dictionary<string, object> { { "name", sname } });
                }
                var readings = new List<object>();
                for (uint i = 0; i < readCount; i++)
                {
                    long p = readOff + (long)i * readSize;
                    var label = Text(v, p + 140, 128);
                    if (label.Length == 0) label = Text(v, p + 12, 128);
                    readings.Add(new Dictionary<string, object>
                    {
                        { "type", (int)v.ReadUInt32(p) },
                        { "sensor", (int)v.ReadUInt32(p + 4) },
                        { "label", label },
                        { "unit", Text(v, p + 268, 16) },
                        { "value", v.ReadDouble(p + 284) },
                        { "min", v.ReadDouble(p + 292) },
                        { "max", v.ReadDouble(p + 300) },
                        { "avg", v.ReadDouble(p + 308) },
                    });
                }
                return new Dictionary<string, object> { { "sensors", sensors }, { "readings", readings } };
            }
        }

        // Test only: a pretend HWiNFO with the same layout, so the reader above is tested against real bytes.
        static object Publish(string name, Dictionary<string, object> r)
        {
            if (Environment.GetEnvironmentVariable("VRMD_HWINFO_TEST") != "1") throw new Exception("publish is for tests only");
            var sens = (System.Collections.IList)r["sensors"];
            var reads = (System.Collections.IList)r["readings"];
            const int HeaderSize = 48, SensorSize = 264, ReadSize = 316;
            long total = HeaderSize + sens.Count * SensorSize + reads.Count * ReadSize;
            if (published != null) published.Dispose();
            published = MemoryMappedFile.CreateOrOpen(name, total);
            using (var v = published.CreateViewAccessor(0, total))
            {
                v.Write(0, r.ContainsKey("dead") ? SigDead : SigLive);
                v.Write(4, 2u); v.Write(8, 2u);
                v.Write(20, (uint)HeaderSize); v.Write(24, (uint)SensorSize); v.Write(28, (uint)sens.Count);
                v.Write(32, (uint)(HeaderSize + sens.Count * SensorSize)); v.Write(36, (uint)ReadSize); v.Write(40, (uint)reads.Count);
                Action<long, string, int> put = (pos, s, max) => { var b = Encoding.UTF8.GetBytes(s); v.WriteArray(pos, b, 0, Math.Min(b.Length, max - 1)); };
                for (int i = 0; i < sens.Count; i++)
                {
                    var d = (Dictionary<string, object>)sens[i];
                    long p = HeaderSize + (long)i * SensorSize;
                    put(p + 8, Convert.ToString(d["name"]), 128);
                }
                for (int i = 0; i < reads.Count; i++)
                {
                    var d = (Dictionary<string, object>)reads[i];
                    long p = HeaderSize + sens.Count * SensorSize + (long)i * ReadSize;
                    v.Write(p, Convert.ToUInt32(d["type"]));
                    v.Write(p + 4, Convert.ToUInt32(d["sensor"]));
                    put(p + 12, Convert.ToString(d["label"]), 128);
                    put(p + 268, Convert.ToString(d["unit"]), 16);
                    v.Write(p + 284, Convert.ToDouble(d["value"]));
                    v.Write(p + 292, Convert.ToDouble(d["min"]));
                    v.Write(p + 300, Convert.ToDouble(d["max"]));
                    v.Write(p + 308, Convert.ToDouble(d["avg"]));
                }
            }
            return true;
        }

        static object Handle(Dictionary<string, object> r)
        {
            switch (S(r, "op"))
            {
                case "ping": return "pong";
                case "read": return Read(S(r, "map") ?? RealMap);
                case "publish": return Publish(S(r, "map"), r);
                default: throw new Exception("unknown op " + S(r, "op"));
            }
        }

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
            return 0;
        }
    }
}
