using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace CitadelEws
{
    internal sealed class PortablePaths
    {
        public string AppRoot;
        public string DataRoot;
        public string PythonPath;
        public string AgentPath;
        public string ConfigPath;
        public string StopFile;
        public string LifecycleStopFile;
        public string HoldFile;
        public string ReadyFile;

        public static PortablePaths Discover()
        {
            var appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var dataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CitadelEWS",
                "state"
            );
            return new PortablePaths {
                AppRoot = appRoot,
                DataRoot = dataRoot,
                PythonPath = Path.Combine(appRoot, "runtime", "python.exe"),
                AgentPath = Path.Combine(appRoot, "citadel_node_v2.py"),
                ConfigPath = Path.Combine(dataRoot, "config.json"),
                StopFile = Path.Combine(dataRoot, "STOP"),
                LifecycleStopFile = Path.Combine(dataRoot, "SERVICE_STOP"),
                HoldFile = Path.Combine(dataRoot, "SERVICE_HOLD"),
                ReadyFile = Path.Combine(dataRoot, "SERVICE_READY")
            };
        }

        public void Validate()
        {
            if (!File.Exists(PythonPath)) throw new FileNotFoundException("Bundled Python runtime is missing.", PythonPath);
            if (!File.Exists(AgentPath)) throw new FileNotFoundException("CITADEL agent entrypoint is missing.", AgentPath);
            if (!File.Exists(ConfigPath)) throw new FileNotFoundException("CITADEL agent config is missing.", ConfigPath);
            Directory.CreateDirectory(DataRoot);
        }
    }

    public sealed class CitadelPortableService : ServiceBase
    {
        public const string ServiceId = "CitadelEWSNode";
        private const int RestartExitCode = 75;
        private const int StopExitCode = 76;

        private readonly PortablePaths paths;
        private readonly object sync = new object();
        private Thread supervisor;
        private Process child;
        private volatile bool stopping;

        internal CitadelPortableService(PortablePaths paths)
        {
            this.paths = paths;
            ServiceName = ServiceId;
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            paths.Validate();
            DeleteLifecycleStopFile();
            stopping = false;
            supervisor = new Thread(Supervise) {
                IsBackground = true,
                Name = "CITADEL Portable Agent Supervisor"
            };
            supervisor.Start();
        }

        protected override void OnStop()
        {
            StopChild(true, 45000);
        }

        protected override void OnShutdown()
        {
            StopChild(false, 10000);
        }

        private static string Quote(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0)
                throw new ArgumentException("Invalid service path argument.");
            return "\"" + value + "\"";
        }

        internal ProcessStartInfo BuildChildStartInfo()
        {
            var start = new ProcessStartInfo {
                FileName = paths.PythonPath,
                Arguments = Quote(paths.AgentPath) + " run --config " + Quote(paths.ConfigPath),
                WorkingDirectory = paths.AppRoot,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.EnvironmentVariables["PYTHONHOME"] = Path.Combine(paths.AppRoot, "runtime");
            start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] = "1";
            start.EnvironmentVariables["CITADEL_SERVICE_STOP_FILE"] = paths.LifecycleStopFile;
            start.EnvironmentVariables["CITADEL_SERVICE_HOLD_FILE"] = paths.HoldFile;
            start.EnvironmentVariables["CITADEL_SERVICE_READY_FILE"] = paths.ReadyFile;
            return start;
        }

        private void DeleteLifecycleStopFile()
        {
            if (File.Exists(paths.LifecycleStopFile))
                File.Delete(paths.LifecycleStopFile);
        }

        private void Supervise()
        {
            try
            {
                while (!stopping)
                {
                    if (File.Exists(paths.StopFile))
                    {
                        Thread.Sleep(1000);
                        continue;
                    }

                    Process current;
                    lock (sync)
                    {
                        if (stopping) return;
                        current = Process.Start(BuildChildStartInfo());
                        child = current;
                    }

                    current.WaitForExit();
                    int code = current.ExitCode;
                    lock (sync)
                    {
                        if (Object.ReferenceEquals(child, current)) child = null;
                    }
                    current.Dispose();

                    if (stopping) return;
                    if (code == RestartExitCode)
                    {
                        Thread.Sleep(1000);
                        continue;
                    }
                    if (code == StopExitCode)
                    {
                        while (!stopping) Thread.Sleep(1000);
                        return;
                    }
                    if (File.Exists(paths.StopFile)) continue;

                    Environment.Exit(code == 0 ? 1 : code);
                    return;
                }
            }
            catch
            {
                if (!stopping) Environment.Exit(1);
            }
        }

        private void StopChild(bool requestAdditionalTime, int gracefulWaitMs)
        {
            bool markerWritten = false;
            try
            {
                lock (sync)
                {
                    stopping = true;
                    var current = child;
                    if (current != null && !current.HasExited)
                    {
                        Directory.CreateDirectory(paths.DataRoot);
                        File.WriteAllText(
                            paths.LifecycleStopFile,
                            "windows lifecycle stop " + DateTime.UtcNow.ToString("o") + Environment.NewLine
                        );
                        markerWritten = true;
                        if (requestAdditionalTime) RequestAdditionalTime(60000);

                        if (!current.WaitForExit(gracefulWaitMs))
                        {
                            current.Kill();
                            current.WaitForExit(5000);
                        }
                    }
                }
                if (supervisor != null && supervisor.IsAlive && Thread.CurrentThread != supervisor)
                    supervisor.Join(5000);
            }
            finally
            {
                if (markerWritten)
                {
                    try { File.Delete(paths.LifecycleStopFile); } catch { }
                }
            }
        }

        private static int SelfTest()
        {
            var root = Path.Combine(Path.GetTempPath(), "CitadelPortableServiceSelfTest-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(root);
                var runtime = Path.Combine(root, "runtime");
                var data = Path.Combine(root, "state");
                Directory.CreateDirectory(runtime);
                Directory.CreateDirectory(data);
                var paths = new PortablePaths {
                    AppRoot = root,
                    DataRoot = data,
                    PythonPath = Path.Combine(runtime, "python.exe"),
                    AgentPath = Path.Combine(root, "citadel_node_v2.py"),
                    ConfigPath = Path.Combine(data, "config.json"),
                    StopFile = Path.Combine(data, "STOP"),
                    LifecycleStopFile = Path.Combine(data, "SERVICE_STOP"),
                    HoldFile = Path.Combine(data, "SERVICE_HOLD"),
                    ReadyFile = Path.Combine(data, "SERVICE_READY")
                };
                File.WriteAllText(paths.PythonPath, "");
                File.WriteAllText(paths.AgentPath, "");
                File.WriteAllText(paths.ConfigPath, "{}");
                paths.Validate();

                var service = new CitadelPortableService(paths);
                var start = service.BuildChildStartInfo();
                if (start.UseShellExecute ||
                    !start.CreateNoWindow ||
                    start.FileName != paths.PythonPath ||
                    start.Arguments.IndexOf(" run --config ", StringComparison.Ordinal) < 0 ||
                    start.EnvironmentVariables["PYTHONHOME"] != runtime ||
                    start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] != "1")
                    throw new InvalidOperationException("Portable service child contract failed.");

                Console.WriteLine("CITADEL portable Windows service SELF TEST: PASS");
                return 0;
            }
            finally
            {
                try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
            }
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if (args.Length != 0) throw new ArgumentException("The portable service does not accept runtime arguments.");
            var paths = PortablePaths.Discover();
            ServiceBase.Run(new CitadelPortableService(paths));
            return 0;
        }
    }
}
