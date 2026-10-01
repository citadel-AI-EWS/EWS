using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

[DataContract]
internal sealed class InstallState
{
    [DataMember(Name = "release_root")]
    public string ReleaseRoot { get; set; }
}

internal static class CitadelSshLauncher
{
    private const int InvalidStateExit = 72;
    private const int MissingRuntimeExit = 73;

    private static string Full(string value)
    {
        return Path.GetFullPath(value ?? string.Empty).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static bool IsStrictDescendant(string child, string parent)
    {
        string childFull = Full(child) + Path.DirectorySeparatorChar;
        string parentFull = Full(parent) + Path.DirectorySeparatorChar;
        return childFull.StartsWith(parentFull, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(Full(child), Full(parent), StringComparison.OrdinalIgnoreCase);
    }

    private static InstallState ReadInstallState(string path)
    {
        using (FileStream stream = File.OpenRead(path))
        {
            var serializer = new DataContractJsonSerializer(typeof(InstallState));
            return serializer.ReadObject(stream) as InstallState;
        }
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0)
        {
            throw new InvalidOperationException("unsafe_path");
        }
        return """ + value + """;
    }

    public static int Main()
    {
        try
        {
            string installRoot = Full(AppDomain.CurrentDomain.BaseDirectory);
            string releasesRoot = Path.Combine(installRoot, "releases");
            string statePath = Path.Combine(installRoot, "install-state.json");
            if (!File.Exists(statePath))
            {
                Console.Error.WriteLine("CITADEL SSH launcher: install state missing.");
                return InvalidStateExit;
            }

            InstallState state = ReadInstallState(statePath);
            if (state == null || string.IsNullOrWhiteSpace(state.ReleaseRoot))
            {
                Console.Error.WriteLine("CITADEL SSH launcher: release root missing.");
                return InvalidStateExit;
            }

            string releaseRoot = Full(state.ReleaseRoot);
            if (!IsStrictDescendant(releaseRoot, releasesRoot) || !Directory.Exists(releaseRoot))
            {
                Console.Error.WriteLine("CITADEL SSH launcher: release root rejected.");
                return InvalidStateExit;
            }

            string python = Path.Combine(releaseRoot, ".venv", "Scripts", "python.exe");
            string console = Path.Combine(releaseRoot, "ssh_restricted_console.py");
            string config = Path.Combine(releaseRoot, "config.json");
            if (!File.Exists(python) || !File.Exists(console) || !File.Exists(config))
            {
                Console.Error.WriteLine("CITADEL SSH launcher: active runtime incomplete.");
                return MissingRuntimeExit;
            }

            var start = new ProcessStartInfo
            {
                FileName = python,
                Arguments = Quote(console) + " --config " + Quote(config),
                WorkingDirectory = releaseRoot,
                UseShellExecute = false,
                CreateNoWindow = false
            };
            using (Process child = Process.Start(start))
            {
                if (child == null)
                {
                    Console.Error.WriteLine("CITADEL SSH launcher: child start failed.");
                    return MissingRuntimeExit;
                }
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("CITADEL SSH launcher failed: " + error.GetType().Name);
            return InvalidStateExit;
        }
    }
}
