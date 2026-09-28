using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace CitadelEws
{
    internal sealed class PortablePaths
    {
        public const string LauncherVersion = "1.0.0";

        public string AppRoot;
        public string DataRoot;
        public string PythonPath;
        public string AgentPath;
        public string ConfigPath;
        public string StopFile;
        public string LifecycleStopFile;
        public string HoldFile;
        public string ReadyFile;
        public string ReleasesRoot;
        public string ReleaseId;
        public string PreviousReleaseId;
        public string PreviousDescriptorSha256;
        public bool PreviousRollbackable;
        public bool Versioned;
        public bool PreviousFallbackUsed;
        public string LegacyRoot;
        public string CitadelRoot;

        public static PortablePaths Discover()
        {
            var legacyRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var citadelRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CitadelEWS"
            );
            return DiscoverForRoots(legacyRoot, citadelRoot);
        }

        internal static PortablePaths DiscoverForRoots(string legacyRoot, string citadelRoot)
        {
            var dataRoot = Path.Combine(citadelRoot, "state");
            var statePath = Path.Combine(dataRoot, "release-state.json");

            FileAttributes stateAttributes;
            if (!TryGetExistingAttributes(statePath, out stateAttributes))
                return CreateLegacy(legacyRoot, citadelRoot, dataRoot);

            if ((stateAttributes & FileAttributes.Directory) != 0)
                throw new InvalidDataException("release-state.json is not a regular file.");
            if ((stateAttributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("release-state.json must not be a reparse point.");

            var programDataRoot = Directory.GetParent(citadelRoot);
            if (programDataRoot == null ||
                HasReparsePoint(programDataRoot.FullName) ||
                HasReparsePoint(citadelRoot) ||
                HasReparsePoint(dataRoot))
                throw new InvalidDataException("Version-selection metadata ancestry contains a reparse point.");

            var json = File.ReadAllText(statePath);
            if (ReadRequiredJsonInt(json, "schema") != 1)
                throw new InvalidDataException("Unsupported CITADEL release-state schema.");
            var minLauncher = ReadRequiredJsonString(json, "min_launcher_version");
            Version requiredVersion;
            Version actualVersion;
            if (!Version.TryParse(minLauncher, out requiredVersion) ||
                !Version.TryParse(LauncherVersion, out actualVersion))
                throw new InvalidDataException("Invalid launcher version metadata.");
            if (requiredVersion > actualVersion)
                throw new InvalidOperationException("Installed launcher is too old for the committed release state.");

            var releasesRoot = Path.Combine(citadelRoot, "releases");
            var current = ReadRequiredJsonString(json, "current");
            var currentDescriptor = ReadRequiredJsonString(json, "current_descriptor_sha256");
            var previous = ReadOptionalJsonString(json, "previous");
            var previousDescriptor = ReadOptionalJsonString(json, "previous_descriptor_sha256");
            var previousRollbackable = ReadRequiredJsonBool(json, "previous_rollbackable");

            PortablePaths paths;
            if (TryCreateVersioned(
                releasesRoot, dataRoot, current, currentDescriptor,
                previous, previousDescriptor, previousRollbackable, false, out paths))
            {
                paths.LegacyRoot = legacyRoot;
                paths.CitadelRoot = citadelRoot;
                return paths;
            }

            if (previousRollbackable &&
                !String.IsNullOrWhiteSpace(previous) &&
                !String.IsNullOrWhiteSpace(previousDescriptor) &&
                TryCreateVersioned(
                    releasesRoot, dataRoot, previous, previousDescriptor,
                    null, null, false, true, out paths))
            {
                paths.LegacyRoot = legacyRoot;
                paths.CitadelRoot = citadelRoot;
                return paths;
            }

            throw new InvalidDataException("Committed CITADEL release state has no startable verified release.");
        }

        private static PortablePaths CreateLegacy(string appRoot, string citadelRoot, string dataRoot)
        {
            return CreateForAppRoot(appRoot, citadelRoot, dataRoot, null, null, null, false, false);
        }

        private static PortablePaths CreateForAppRoot(
            string appRoot,
            string citadelRoot,
            string dataRoot,
            string releasesRoot,
            string releaseId,
            string previousReleaseId,
            bool previousRollbackable,
            bool previousFallbackUsed)
        {
            return new PortablePaths {
                AppRoot = appRoot,
                DataRoot = dataRoot,
                PythonPath = Path.Combine(appRoot, "runtime", "python.exe"),
                AgentPath = Path.Combine(appRoot, "citadel_node_v2.py"),
                ConfigPath = Path.Combine(dataRoot, "config.json"),
                StopFile = Path.Combine(dataRoot, "STOP"),
                LifecycleStopFile = Path.Combine(dataRoot, "SERVICE_STOP"),
                HoldFile = Path.Combine(dataRoot, "SERVICE_HOLD"),
                ReadyFile = Path.Combine(dataRoot, "SERVICE_READY"),
                ReleasesRoot = releasesRoot,
                ReleaseId = releaseId,
                PreviousReleaseId = previousReleaseId,
                PreviousRollbackable = previousRollbackable,
                Versioned = !String.IsNullOrWhiteSpace(releaseId),
                PreviousFallbackUsed = previousFallbackUsed,
                LegacyRoot = appRoot,
                CitadelRoot = citadelRoot
            };
        }

        private static bool TryCreateVersioned(
            string releasesRoot,
            string dataRoot,
            string releaseId,
            string descriptorSha256,
            string previousReleaseId,
            string previousDescriptorSha256,
            bool previousRollbackable,
            bool previousFallbackUsed,
            out PortablePaths paths)
        {
            paths = null;
            if (!IsSafeReleaseId(releaseId) || !IsSha256(descriptorSha256))
                return false;

            var releasesFull = Path.GetFullPath(releasesRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var candidate = Path.GetFullPath(Path.Combine(releasesRoot, releaseId)).TrimEnd(Path.DirectorySeparatorChar);
            if (!(candidate + Path.DirectorySeparatorChar).StartsWith(releasesFull, StringComparison.OrdinalIgnoreCase))
                return false;
            if (!Directory.Exists(releasesRoot) || HasReparsePoint(releasesRoot))
                return false;
            if (!Directory.Exists(candidate) || HasReparsePoint(candidate))
                return false;

            var runtimeRoot = Path.Combine(candidate, "runtime");
            var okPath = Path.Combine(candidate, "RELEASE.OK");
            var pythonPath = Path.Combine(runtimeRoot, "python.exe");
            var agentPath = Path.Combine(candidate, "citadel_node_v2.py");
            if (!Directory.Exists(runtimeRoot) ||
                !File.Exists(okPath) ||
                !File.Exists(pythonPath) ||
                !File.Exists(agentPath))
                return false;
            if (HasReparsePoint(runtimeRoot) ||
                HasReparsePoint(okPath) ||
                HasReparsePoint(pythonPath) ||
                HasReparsePoint(agentPath))
                return false;

            try
            {
                var okJson = File.ReadAllText(okPath);
                if (!String.Equals(ReadRequiredJsonString(okJson, "release_id"), releaseId, StringComparison.Ordinal))
                    return false;
                if (!String.Equals(ReadRequiredJsonString(okJson, "descriptor_sha256"), descriptorSha256, StringComparison.OrdinalIgnoreCase))
                    return false;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (InvalidDataException)
            {
                return false;
            }

            var citadelRoot = Directory.GetParent(releasesRoot).FullName;
            paths = CreateForAppRoot(
                candidate,
                citadelRoot,
                dataRoot,
                releasesRoot,
                releaseId,
                previousReleaseId,
                previousRollbackable,
                previousFallbackUsed
            );
            paths.PreviousDescriptorSha256 = previousDescriptorSha256;
            return true;
        }

        internal bool TrySwitchToPreviousRelease()
        {
            if (!Versioned || PreviousFallbackUsed || !PreviousRollbackable ||
                String.IsNullOrWhiteSpace(PreviousReleaseId) ||
                String.IsNullOrWhiteSpace(PreviousDescriptorSha256))
                return false;

            PortablePaths previous;
            if (!TryCreateVersioned(
                ReleasesRoot,
                DataRoot,
                PreviousReleaseId,
                PreviousDescriptorSha256,
                null,
                null,
                false,
                true,
                out previous))
                return false;

            AppRoot = previous.AppRoot;
            PythonPath = previous.PythonPath;
            AgentPath = previous.AgentPath;
            ReleaseId = previous.ReleaseId;
            PreviousReleaseId = null;
            PreviousDescriptorSha256 = null;
            PreviousRollbackable = false;
            PreviousFallbackUsed = true;
            return true;
        }

        internal void RefreshCommittedRelease()
        {
            if (String.IsNullOrWhiteSpace(LegacyRoot) || String.IsNullOrWhiteSpace(CitadelRoot))
                return;
            var fresh = DiscoverForRoots(LegacyRoot, CitadelRoot);
            AppRoot = fresh.AppRoot;
            DataRoot = fresh.DataRoot;
            PythonPath = fresh.PythonPath;
            AgentPath = fresh.AgentPath;
            ConfigPath = fresh.ConfigPath;
            StopFile = fresh.StopFile;
            LifecycleStopFile = fresh.LifecycleStopFile;
            HoldFile = fresh.HoldFile;
            ReadyFile = fresh.ReadyFile;
            ReleasesRoot = fresh.ReleasesRoot;
            ReleaseId = fresh.ReleaseId;
            PreviousReleaseId = fresh.PreviousReleaseId;
            PreviousDescriptorSha256 = fresh.PreviousDescriptorSha256;
            PreviousRollbackable = fresh.PreviousRollbackable;
            Versioned = fresh.Versioned;
            PreviousFallbackUsed = fresh.PreviousFallbackUsed;
        }

        private static bool TryGetExistingAttributes(string path, out FileAttributes attributes)
        {
            try
            {
                attributes = File.GetAttributes(path);
                return true;
            }
            catch (FileNotFoundException)
            {
                attributes = 0;
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                attributes = 0;
                return false;
            }
        }

        private static bool HasReparsePoint(string path)
        {
            try
            {
                return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
            }
            catch
            {
                return true;
            }
        }

        private static int ReadRequiredJsonInt(string json, string key)
        {
            var token = "\"" + key + "\"";
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0) throw new InvalidDataException("Missing release-state field: " + key);
            index = json.IndexOf(':', index + token.Length);
            if (index < 0) throw new InvalidDataException("Invalid JSON field: " + key);
            index++;
            while (index < json.Length && Char.IsWhiteSpace(json[index])) index++;
            var start = index;
            if (index < json.Length && json[index] == '-') index++;
            while (index < json.Length && Char.IsDigit(json[index])) index++;
            if (index == start || (index == start + 1 && json[start] == '-'))
                throw new InvalidDataException("Invalid JSON integer field: " + key);
            var numberEnd = index;
            while (index < json.Length && Char.IsWhiteSpace(json[index])) index++;
            if (index >= json.Length || (json[index] != ',' && json[index] != '}'))
                throw new InvalidDataException("Invalid JSON integer token boundary: " + key);
            int value;
            if (!Int32.TryParse(json.Substring(start, numberEnd - start), out value))
                throw new InvalidDataException("Invalid JSON integer field: " + key);
            return value;
        }

        private static bool IsSafeReleaseId(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length > 160)
                return false;
            if (!Char.IsLetterOrDigit(value[0]) || !Char.IsLetterOrDigit(value[value.Length - 1]))
                return false;
            for (var i = 0; i < value.Length; i++)
            {
                var ch = value[i];
                if (!(Char.IsLetterOrDigit(ch) || ch == '.' || ch == '_' || ch == '-'))
                    return false;
            }
            return value.IndexOf("..", StringComparison.Ordinal) < 0;
        }

        private static bool IsSha256(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length != 64)
                return false;
            for (var i = 0; i < value.Length; i++)
            {
                var ch = value[i];
                if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')))
                    return false;
            }
            return true;
        }

        private static string ReadRequiredJsonString(string json, string key)
        {
            var value = ReadOptionalJsonString(json, key);
            if (String.IsNullOrWhiteSpace(value))
                throw new InvalidDataException("Missing release-state field: " + key);
            return value;
        }

        private static string ReadOptionalJsonString(string json, string key)
        {
            var token = """ + key + """;
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0) return null;
            index = json.IndexOf(':', index + token.Length);
            if (index < 0) throw new InvalidDataException("Invalid JSON field: " + key);
            index++;
            while (index < json.Length && Char.IsWhiteSpace(json[index])) index++;
            if (index >= json.Length) throw new InvalidDataException("Invalid JSON field: " + key);
            if (json.Substring(index).StartsWith("null", StringComparison.Ordinal)) return null;
            if (json[index] != '"') throw new InvalidDataException("Invalid JSON string field: " + key);
            index++;
            var end = json.IndexOf('"', index);
            if (end < 0) throw new InvalidDataException("Unterminated JSON string field: " + key);
            var value = json.Substring(index, end - index);
            if (value.IndexOf('\\') >= 0)
                throw new InvalidDataException("Escaped release-state values are not accepted.");
            return value;
        }

        private static bool ReadRequiredJsonBool(string json, string key)
        {
            var token = """ + key + """;
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0) throw new InvalidDataException("Missing release-state field: " + key);
            index = json.IndexOf(':', index + token.Length);
            if (index < 0) throw new InvalidDataException("Invalid JSON field: " + key);
            index++;
            while (index < json.Length && Char.IsWhiteSpace(json[index])) index++;
            if (json.Substring(index).StartsWith("true", StringComparison.Ordinal)) return true;
            if (json.Substring(index).StartsWith("false", StringComparison.Ordinal)) return false;
            throw new InvalidDataException("Invalid JSON boolean field: " + key);
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
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectExtendedLimitInformationClass = 9;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private readonly PortablePaths paths;
        private readonly bool taskMode;
        private readonly object sync = new object();
        private Thread supervisor;
        private Process child;
        private IntPtr taskJob = IntPtr.Zero;
        private volatile bool stopping;

        internal CitadelPortableService(PortablePaths paths, bool taskMode = false)
        {
            this.paths = paths;
            this.taskMode = taskMode;
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
            // Both supervisors use the agent's managed exit-code protocol (75/76).
            start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] = "1";
            start.EnvironmentVariables.Remove("CITADEL_TASK_MANAGED");
            if (taskMode)
                start.EnvironmentVariables["CITADEL_TASK_MANAGED"] = "1";
            start.EnvironmentVariables["CITADEL_SERVICE_STOP_FILE"] = paths.LifecycleStopFile;
            start.EnvironmentVariables["CITADEL_SERVICE_HOLD_FILE"] = paths.HoldFile;
            start.EnvironmentVariables["CITADEL_SERVICE_READY_FILE"] = paths.ReadyFile;
            if (paths.Versioned && !String.IsNullOrWhiteSpace(paths.ReleaseId))
                start.EnvironmentVariables["CITADEL_RELEASE_ID"] = paths.ReleaseId;
            else
                start.EnvironmentVariables.Remove("CITADEL_RELEASE_ID");
            return start;
        }

        private void DeleteLifecycleStopFile()
        {
            if (File.Exists(paths.LifecycleStopFile))
                File.Delete(paths.LifecycleStopFile);
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create CITADEL task-host Job Object.");

            var information = new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var size = (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, ref information, size))
            {
                var error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "Unable to configure CITADEL task-host Job Object.");
            }
            return job;
        }

        internal int RunTaskHost()
        {
            paths.Validate();
            DeleteLifecycleStopFile();
            stopping = false;
            taskJob = CreateKillOnCloseJob();
            if (!AssignProcessToJobObject(taskJob, Process.GetCurrentProcess().Handle))
            {
                var error = Marshal.GetLastWin32Error();
                CloseHandle(taskJob);
                taskJob = IntPtr.Zero;
                throw new Win32Exception(error, "Unable to attach CITADEL task host to its Job Object.");
            }

            // Keep the final Job Object handle open for the entire task-host
            // lifetime. The host is itself in the job, so every Process.Start
            // child inherits membership before user code can run. Process
            // teardown closes the handle and KILL_ON_JOB_CLOSE removes any
            // surviving child without a post-creation assignment race.
            Supervise();
            return 0;
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
                    try
                    {
                        lock (sync)
                        {
                            if (stopping) return;
                            current = Process.Start(BuildChildStartInfo());
                            if (current == null)
                                throw new InvalidOperationException("Unable to start CITADEL agent child.");
                            child = current;
                        }
                    }
                    catch
                    {
                        // Versioned mode gets exactly one start-time fallback to
                        // the committed previous release. A child that actually
                        // starts is never rolled back because of later exit codes.
                        if (paths.TrySwitchToPreviousRelease())
                        {
                            Thread.Sleep(250);
                            continue;
                        }
                        throw;
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
                        // Exit 75 is the bounded handoff used by signed update.
                        // Re-resolve committed state so a future atomic pointer
                        // flip takes effect without restarting the stable host.
                        paths.RefreshCommittedRelease();
                        Thread.Sleep(1000);
                        continue;
                    }
                    if (code == StopExitCode)
                    {
                        while (!stopping) Thread.Sleep(1000);
                        return;
                    }
                    if (File.Exists(paths.StopFile)) continue;

                    if (taskMode)
                    {
                        // The Task Scheduler fallback keeps one stable host alive and
                        // restarts only the bounded agent child after an unexpected exit.
                        Thread.Sleep(5000);
                        continue;
                    }

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

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (var file in Directory.GetFiles(source))
                File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
            foreach (var directory in Directory.GetDirectories(source))
                CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
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
                    start.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] != "1" ||
                    start.EnvironmentVariables["CITADEL_TASK_MANAGED"] != null)
                    throw new InvalidOperationException("Portable service child contract failed.");

                var taskHost = new CitadelPortableService(paths, true);
                var taskStart = taskHost.BuildChildStartInfo();
                if (taskStart.EnvironmentVariables["CITADEL_TASK_MANAGED"] != "1" ||
                    taskStart.EnvironmentVariables["CITADEL_SERVICE_MANAGED"] != "1")
                    throw new InvalidOperationException("Portable fallback task child contract failed.");

                var citadelRoot = Path.Combine(root, "programdata", "CitadelEWS");
                var versionedState = Path.Combine(citadelRoot, "state");
                var releases = Path.Combine(citadelRoot, "releases");
                var currentId = "0.3.22-abcdef012345";
                var previousId = "0.3.21-deadbeef0000";
                var currentHash = new string('a', 64);
                var previousHash = new string('b', 64);
                Directory.CreateDirectory(versionedState);
                File.WriteAllText(Path.Combine(versionedState, "config.json"), "{}");

                Action<string, string> makeRelease = (releaseId, descriptorHash) => {
                    var releaseRoot = Path.Combine(releases, releaseId);
                    Directory.CreateDirectory(Path.Combine(releaseRoot, "runtime"));
                    File.WriteAllText(Path.Combine(releaseRoot, "runtime", "python.exe"), "");
                    File.WriteAllText(Path.Combine(releaseRoot, "citadel_node_v2.py"), "");
                    File.WriteAllText(
                        Path.Combine(releaseRoot, "RELEASE.OK"),
                        "{\"release_id\":\"" + releaseId +
                        "\",\"descriptor_sha256\":\"" + descriptorHash + "\"}"
                    );
                };
                makeRelease(currentId, currentHash);
                makeRelease(previousId, previousHash);
                File.WriteAllText(
                    Path.Combine(versionedState, "release-state.json"),
                    "{" +
                    "\"schema\":1," +
                    "\"generation\":1," +
                    "\"current\":\"" + currentId + "\"," +
                    "\"previous\":\"" + previousId + "\"," +
                    "\"previous_rollbackable\":true," +
                    "\"current_descriptor_sha256\":\"" + currentHash + "\"," +
                    "\"previous_descriptor_sha256\":\"" + previousHash + "\"," +
                    "\"state_schema\":1," +
                    "\"min_launcher_version\":\"1.0.0\"," +
                    "\"transaction_id\":\"txn-selftest\"," +
                    "\"committed_at\":\"2026-09-28T00:00:00Z\"" +
                    "}"
                );

                var legacyForRefreshRoot = Path.Combine(root, "legacy-refresh");
                Directory.CreateDirectory(Path.Combine(legacyForRefreshRoot, "runtime"));
                File.WriteAllText(Path.Combine(legacyForRefreshRoot, "runtime", "python.exe"), "");
                File.WriteAllText(Path.Combine(legacyForRefreshRoot, "citadel_node_v2.py"), "");
                var refreshCitadelRoot = Path.Combine(root, "refresh-programdata", "CitadelEWS");
                var refreshState = Path.Combine(refreshCitadelRoot, "state");
                Directory.CreateDirectory(refreshState);
                File.WriteAllText(Path.Combine(refreshState, "config.json"), "{}");
                var refreshPaths = PortablePaths.DiscoverForRoots(legacyForRefreshRoot, refreshCitadelRoot);
                if (refreshPaths.Versioned)
                    throw new InvalidOperationException("Legacy launcher unexpectedly started in versioned mode.");

                var versionedPaths = PortablePaths.DiscoverForRoots(
                    Path.Combine(root, "legacy"),
                    citadelRoot
                );
                if (!versionedPaths.Versioned ||
                    versionedPaths.ReleaseId != currentId ||
                    versionedPaths.AppRoot != Path.Combine(releases, currentId))
                    throw new InvalidOperationException("Versioned launcher did not select committed current release.");

                // Simulate a long-lived legacy host receiving exit 75 after the
                // versioned pointer appears. It must re-read the committed state.
                Directory.CreateDirectory(Path.Combine(refreshCitadelRoot, "releases"));
                CopyDirectory(Path.Combine(releases, currentId), Path.Combine(refreshCitadelRoot, "releases", currentId));
                CopyDirectory(Path.Combine(releases, previousId), Path.Combine(refreshCitadelRoot, "releases", previousId));
                File.WriteAllText(
                    Path.Combine(refreshState, "release-state.json"),
                    File.ReadAllText(Path.Combine(versionedState, "release-state.json"))
                );
                refreshPaths.RefreshCommittedRelease();
                if (!refreshPaths.Versioned || refreshPaths.ReleaseId != currentId)
                    throw new InvalidOperationException("Launcher did not refresh committed release after managed restart.");

                File.Delete(Path.Combine(releases, currentId, "runtime", "python.exe"));
                var fallbackPaths = PortablePaths.DiscoverForRoots(
                    Path.Combine(root, "legacy"),
                    citadelRoot
                );
                if (!fallbackPaths.Versioned ||
                    !fallbackPaths.PreviousFallbackUsed ||
                    fallbackPaths.ReleaseId != previousId)
                    throw new InvalidOperationException("Versioned launcher did not fall back to committed previous release.");

                File.WriteAllText(
                    Path.Combine(versionedState, "release-state.json"),
                    "{\"current\":\"..\\\\evil\",\"previous_rollbackable\":false," +
                    "\"current_descriptor_sha256\":\"" + currentHash +
                    "\",\"min_launcher_version\":\"1.0.0\"}"
                );
                bool unsafeStateRejected = false;
                try
                {
                    PortablePaths.DiscoverForRoots(Path.Combine(root, "legacy"), citadelRoot);
                }
                catch (InvalidDataException)
                {
                    unsafeStateRejected = true;
                }
                if (!unsafeStateRejected)
                    throw new InvalidOperationException("Unsafe versioned release state was not rejected.");

                Console.WriteLine("CITADEL portable Windows service/task-host SELF TEST: PASS");
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
            var paths = PortablePaths.Discover();
            if (args.Length == 1 && args[0] == "--task-host")
                return new CitadelPortableService(paths, true).RunTaskHost();
            if (args.Length != 0)
                throw new ArgumentException("The portable host accepts only --self-test or --task-host.");
            ServiceBase.Run(new CitadelPortableService(paths));
            return 0;
        }
    }
}
