using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace CitadelEws
{
    internal sealed class ServiceConfig
    {
        public string PythonPath;
        public string AgentPath;
        public string ConfigPath;
        public string StopFile;
        public string LifecycleStopFile;
    }

    public sealed class CitadelNodeService : ServiceBase
    {
        public const string ServiceId = "CitadelEWSNode";
        private const int RestartExitCode = 75;
        private const int StopExitCode = 76;

        private readonly ServiceConfig config;
        private readonly object sync = new object();
        private Thread supervisor;
        private Process child;
        private volatile bool stopping;

        internal CitadelNodeService(ServiceConfig config)
        {
            this.config = config;
            ServiceName = ServiceId;
            CanStop = true;
            CanShutdown = true;
            // The Python agent already has its own JSONL audit log. Disabling
            // ServiceBase AutoLog avoids requiring a privileged EventLog source
            // to be created for a service that runs as LocalService.
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            DeleteLifecycleStopFile();
            stopping = false;
            supervisor = new Thread(Supervise);
            supervisor.IsBackground = true;
            supervisor.Name = "CITADEL Agent Supervisor";
            supervisor.Start();
        }

        protected override void OnStop()
        {
            StopChild(true, 45000);
        }

        protected override void OnShutdown()
        {
            // Windows shutdown has a shorter system-wide deadline. The
            // lifecycle marker is transient and will be cleared on next start.
            StopChild(false, 10000);
        }

        private static string Quote(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0)
            {
                throw new ArgumentException("Invalid service path argument.");
            }
            return "\"" + value + "\"";
        }

        private ProcessStartInfo BuildChildStartInfo()
        {
            var start = new ProcessStartInfo();
            start.FileName = config.PythonPath;
            start.Arguments = Quote(config.AgentPath) + " run --config " + Quote(config.ConfigPath);
            start.WorkingDirectory = Path.GetDirectoryName(config.AgentPath);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] = "1";
            start.EnvironmentVariables["CITADEL_SERVICE_STOP_FILE"] = config.LifecycleStopFile;
            return start;
        }

        private Process StartChild()
        {
            return Process.Start(BuildChildStartInfo());
        }

        private void DeleteLifecycleStopFile()
        {
            try
            {
                if (File.Exists(config.LifecycleStopFile))
                {
                    File.Delete(config.LifecycleStopFile);
                }
            }
            catch
            {
                throw new InvalidOperationException("Unable to clear transient lifecycle stop marker.");
            }
        }

        private void Supervise()
        {
            try
            {
                while (!stopping)
                {
                    if (File.Exists(config.StopFile))
                    {
                        Thread.Sleep(1000);
                        continue;
                    }

                    Process current;
                    lock (sync)
                    {
                        if (stopping)
                        {
                            return;
                        }
                        current = StartChild();
                        child = current;
                    }

                    current.WaitForExit();
                    int code = current.ExitCode;
                    lock (sync)
                    {
                        if (Object.ReferenceEquals(child, current))
                        {
                            child = null;
                        }
                    }
                    current.Dispose();

                    if (stopping)
                    {
                        return;
                    }

                    if (code == RestartExitCode)
                    {
                        Thread.Sleep(1000);
                        continue;
                    }

                    if (code == StopExitCode)
                    {
                        // A signed stop request intentionally leaves the SCM host
                        // alive and dormant until the service is restarted.
                        while (!stopping)
                        {
                            Thread.Sleep(1000);
                        }
                        return;
                    }

                    if (File.Exists(config.StopFile))
                    {
                        // A signed uninstall/STOP marker persists across reboot.
                        // Only an explicit administrator repair clears it.
                        continue;
                    }

                    // Unexpected child exit is a service failure. SCM recovery
                    // policy will restart the whole Core Service.
                    Environment.Exit(code == 0 ? 1 : code);
                    return;
                }
            }
            catch
            {
                if (!stopping)
                {
                    Environment.Exit(1);
                }
            }
        }

        private void StopChild(bool requestAdditionalTime, int gracefulWaitMs)
        {
            Process current;
            lock (sync)
            {
                stopping = true;
                current = child;
            }

            bool markerWritten = false;
            try
            {
                if (current != null && !current.HasExited)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(config.LifecycleStopFile));
                    File.WriteAllText(
                        config.LifecycleStopFile,
                        "windows lifecycle stop " + DateTime.UtcNow.ToString("o") + Environment.NewLine
                    );
                    markerWritten = true;

                    if (requestAdditionalTime)
                    {
                        RequestAdditionalTime(60000);
                    }

                    if (!current.WaitForExit(gracefulWaitMs))
                    {
                        current.Kill();
                        current.WaitForExit(5000);
                    }
                }

                if (supervisor != null && supervisor.IsAlive && Thread.CurrentThread != supervisor)
                {
                    supervisor.Join(5000);
                }
            }
            finally
            {
                if (markerWritten)
                {
                    try
                    {
                        File.Delete(config.LifecycleStopFile);
                    }
                    catch
                    {
                        // This file is transient. OnStart always attempts to
                        // remove a stale copy before launching the agent.
                    }
                }
            }
        }

        internal static ServiceConfig ParseArgs(string[] args)
        {
            var result = new ServiceConfig();
            for (int i = 0; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length)
                {
                    throw new ArgumentException("Service arguments must be key/value pairs.");
                }
                string key = args[i];
                string value = Path.GetFullPath(args[i + 1]);
                if (key == "--python") result.PythonPath = value;
                else if (key == "--agent") result.AgentPath = value;
                else if (key == "--config") result.ConfigPath = value;
                else if (key == "--stop-file") result.StopFile = value;
                else if (key == "--lifecycle-stop-file") result.LifecycleStopFile = value;
                else throw new ArgumentException("Unknown service argument: " + key);
            }

            if (String.IsNullOrWhiteSpace(result.PythonPath) ||
                String.IsNullOrWhiteSpace(result.AgentPath) ||
                String.IsNullOrWhiteSpace(result.ConfigPath) ||
                String.IsNullOrWhiteSpace(result.StopFile) ||
                String.IsNullOrWhiteSpace(result.LifecycleStopFile))
            {
                throw new ArgumentException("Missing required CITADEL service arguments.");
            }

            return result;
        }

        private static void RunSelfTest()
        {
            string root = Path.Combine(Path.GetTempPath(), "CitadelNodeServiceSelfTest");
            var config = ParseArgs(new string[] {
                "--python", Path.Combine(root, "python.exe"),
                "--agent", Path.Combine(root, "citadel_node_v2.py"),
                "--config", Path.Combine(root, "config.json"),
                "--stop-file", Path.Combine(root, "STOP"),
                "--lifecycle-stop-file", Path.Combine(root, "SERVICE_STOP")
            });
            var service = new CitadelNodeService(config);
            Directory.CreateDirectory(root);
            File.WriteAllText(config.LifecycleStopFile, "stale transient marker");
            service.DeleteLifecycleStopFile();
            ProcessStartInfo start = service.BuildChildStartInfo();
            if (File.Exists(config.LifecycleStopFile) ||
                service.AutoLog ||
                start.UseShellExecute ||
                !start.CreateNoWindow ||
                start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] != "1" ||
                start.EnvironmentVariables["CITADEL_SERVICE_STOP_FILE"] != config.LifecycleStopFile ||
                start.FileName != config.PythonPath ||
                start.Arguments.IndexOf(" run --config ", StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("CITADEL service child contract self-test failed.");
            }
            Console.WriteLine("CITADEL Windows Service Host SELF TEST: PASS");
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                RunSelfTest();
                return 0;
            }

            ServiceConfig config = ParseArgs(args);
            ServiceBase.Run(new CitadelNodeService(config));
            return 0;
        }
    }
}
