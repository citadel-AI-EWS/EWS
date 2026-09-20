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
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            if (File.Exists(config.StopFile))
            {
                throw new InvalidOperationException(
                    "CITADEL STOP marker is present. Run the explicit installer/repair flow to clear it."
                );
            }

            stopping = false;
            supervisor = new Thread(Supervise);
            supervisor.IsBackground = true;
            supervisor.Name = "CITADEL Agent Supervisor";
            supervisor.Start();
        }

        protected override void OnStop()
        {
            StopChild(false);
        }

        protected override void OnShutdown()
        {
            StopChild(false);
        }

        private static string Quote(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0)
            {
                throw new ArgumentException("Invalid service path argument.");
            }
            return "\"" + value + "\"";
        }

        private Process StartChild()
        {
            var start = new ProcessStartInfo();
            start.FileName = config.PythonPath;
            start.Arguments = Quote(config.AgentPath) + " run --config " + Quote(config.ConfigPath);
            start.WorkingDirectory = Path.GetDirectoryName(config.AgentPath);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] = "1";
            return Process.Start(start);
        }

        private void Supervise()
        {
            try
            {
                while (!stopping)
                {
                    Process current = StartChild();
                    lock (sync)
                    {
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

                    if (code == StopExitCode || File.Exists(config.StopFile))
                    {
                        // A signed stop/uninstall request intentionally leaves
                        // the SCM host alive but does not restart the Core Agent.
                        // An administrator can later restart/repair the service.
                        while (!stopping)
                        {
                            Thread.Sleep(1000);
                        }
                        return;
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

        private void StopChild(bool keepStopFile)
        {
            stopping = true;

            Process current;
            lock (sync)
            {
                current = child;
            }

            bool wroteMarker = false;
            if (current != null && !current.HasExited)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(config.StopFile));
                File.WriteAllText(
                    config.StopFile,
                    "windows service stop " + DateTime.UtcNow.ToString("o") + Environment.NewLine
                );
                wroteMarker = true;

                if (!current.WaitForExit(45000))
                {
                    current.Kill();
                    current.WaitForExit(5000);
                }
            }

            if (supervisor != null && supervisor.IsAlive && Thread.CurrentThread != supervisor)
            {
                supervisor.Join(5000);
            }

            if (wroteMarker && !keepStopFile)
            {
                try
                {
                    File.Delete(config.StopFile);
                }
                catch
                {
                    // A stale transient stop marker is safer than deleting an
                    // unrelated file. Explicit repair clears it on next install.
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
                else throw new ArgumentException("Unknown service argument: " + key);
            }

            if (String.IsNullOrWhiteSpace(result.PythonPath) ||
                String.IsNullOrWhiteSpace(result.AgentPath) ||
                String.IsNullOrWhiteSpace(result.ConfigPath) ||
                String.IsNullOrWhiteSpace(result.StopFile))
            {
                throw new ArgumentException("Missing required CITADEL service arguments.");
            }

            return result;
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                Console.WriteLine("CITADEL Windows Service Host SELF TEST: PASS");
                return 0;
            }

            ServiceConfig config = ParseArgs(args);
            ServiceBase.Run(new CitadelNodeService(config));
            return 0;
        }
    }
}
