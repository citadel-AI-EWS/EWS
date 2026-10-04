using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Security.Principal;
using System.Text;

internal static class CitadelSshConsole
{
    private static readonly string[] AllowedCommands = new[]
    {
        "help",
        "status",
        "hostname",
        "whoami",
        "uname -a",
        "python --version",
        "python3 --version",
        "uptime",
        "cpu",
        "memory",
        "disk",
        "network",
        "agent-status",
        "agent-logs",
        "lmstudio-status",
        "diagnostics",
        "ping-controller",
        "exit"
    };

    private static string ProgramDataRoot
    {
        get
        {
            string value = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return string.IsNullOrWhiteSpace(value) ? @"C:\ProgramData" : value;
        }
    }

    private static string SshStateRoot
    {
        get { return Path.Combine(ProgramDataRoot, "CitadelEWS", "ssh"); }
    }

    private static bool IsAllowed(string command)
    {
        return AllowedCommands.Contains(command, StringComparer.Ordinal);
    }

    private static bool ContainsShellSyntax(string command)
    {
        if (command == null) return false;
        return command.IndexOfAny(new[] { ';', '|', '&', '>', '<', '`', '$', '\r', '\n' }) >= 0;
    }

    private static string ReadWmiString(string query, string property)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher(query))
            using (ManagementObjectCollection objects = searcher.Get())
            {
                foreach (ManagementObject item in objects)
                {
                    object value = item[property];
                    if (value != null) return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
                }
            }
        }
        catch (ManagementException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return string.Empty;
    }

    private static string FormatBytes(long bytes)
    {
        double value = bytes;
        string[] suffixes = { "B", "KiB", "MiB", "GiB", "TiB" };
        foreach (string suffix in suffixes)
        {
            if (value < 1024.0 || suffix == "TiB") return value.ToString("0.0", CultureInfo.InvariantCulture) + " " + suffix;
            value /= 1024.0;
        }
        return value.ToString("0.0", CultureInfo.InvariantCulture) + " TiB";
    }

    private static string Help()
    {
        return "Allowed commands:" + Environment.NewLine + "  " + string.Join(Environment.NewLine + "  ", AllowedCommands);
    }

    private static string Hostname()
    {
        try { return Dns.GetHostName(); }
        catch (SocketException) { return Environment.MachineName; }
    }

    private static string Whoami()
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            return identity.Name;
        }
    }

    private static string Uname()
    {
        return "Windows " + Hostname() + " " + Environment.OSVersion.VersionString + " "
            + (Environment.Is64BitOperatingSystem ? "x86_64" : "x86");
    }

    private static string PythonVersion()
    {
        string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Python314", "python.exe");
        if (!File.Exists(executable)) return "Python unavailable";
        FileVersionInfo version = FileVersionInfo.GetVersionInfo(executable);
        return "Python " + version.FileMajorPart.ToString(CultureInfo.InvariantCulture) + "."
            + version.FileMinorPart.ToString(CultureInfo.InvariantCulture) + "."
            + version.FileBuildPart.ToString(CultureInfo.InvariantCulture);
    }

    private static string Uptime()
    {
        string raw = ReadWmiString("SELECT LastBootUpTime FROM Win32_OperatingSystem", "LastBootUpTime");
        if (string.IsNullOrWhiteSpace(raw)) return "uptime unavailable";
        try
        {
            DateTime boot = ManagementDateTimeConverter.ToDateTime(raw).ToUniversalTime();
            TimeSpan span = DateTime.UtcNow - boot;
            if (span < TimeSpan.Zero) span = TimeSpan.Zero;
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0}d {1:00}:{2:00}:{3:00}",
                (int)span.TotalDays,
                span.Hours,
                span.Minutes,
                span.Seconds
            );
        }
        catch (ArgumentOutOfRangeException)
        {
            return "uptime unavailable";
        }
    }

    private static string Cpu()
    {
        var values = new List<string>();
        try
        {
            using (var searcher = new ManagementObjectSearcher("SELECT Name,NumberOfLogicalProcessors,LoadPercentage FROM Win32_Processor"))
            using (ManagementObjectCollection objects = searcher.Get())
            {
                foreach (ManagementObject item in objects)
                {
                    string name = Convert.ToString(item["Name"], CultureInfo.InvariantCulture) ?? "CPU";
                    string logical = Convert.ToString(item["NumberOfLogicalProcessors"], CultureInfo.InvariantCulture) ?? "?";
                    string load = Convert.ToString(item["LoadPercentage"], CultureInfo.InvariantCulture) ?? "?";
                    values.Add(name.Trim() + " · logical=" + logical + " · load=" + load + "%");
                }
            }
        }
        catch (ManagementException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return values.Count == 0 ? "cpu unavailable" : string.Join(Environment.NewLine, values);
    }

    private static string Memory()
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher("SELECT TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem"))
            using (ManagementObjectCollection objects = searcher.Get())
            {
                foreach (ManagementObject item in objects)
                {
                    long totalKb = Convert.ToInt64(item["TotalVisibleMemorySize"], CultureInfo.InvariantCulture);
                    long freeKb = Convert.ToInt64(item["FreePhysicalMemory"], CultureInfo.InvariantCulture);
                    long usedKb = Math.Max(0, totalKb - freeKb);
                    double percent = totalKb > 0 ? (usedKb * 100.0 / totalKb) : 0;
                    return "total=" + FormatBytes(totalKb * 1024L)
                        + " · free=" + FormatBytes(freeKb * 1024L)
                        + " · used=" + percent.ToString("0.0", CultureInfo.InvariantCulture) + "%";
                }
            }
        }
        catch (ManagementException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        catch (FormatException)
        {
        }
        catch (InvalidCastException)
        {
        }
        return "memory unavailable";
    }

    private static string Disk()
    {
        try
        {
            string root = Path.GetPathRoot(Environment.SystemDirectory) ?? @"C:\";
            var drive = new DriveInfo(root);
            long used = drive.TotalSize - drive.AvailableFreeSpace;
            double percent = drive.TotalSize > 0 ? used * 100.0 / drive.TotalSize : 0;
            return root
                + " total=" + FormatBytes(drive.TotalSize)
                + " · free=" + FormatBytes(drive.AvailableFreeSpace)
                + " · used=" + percent.ToString("0.0", CultureInfo.InvariantCulture) + "%";
        }
        catch (IOException)
        {
            return "disk unavailable";
        }
        catch (UnauthorizedAccessException)
        {
            return "disk unavailable";
        }
    }

    private static string Network()
    {
        var lines = new List<string>();
        try
        {
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                var ipv4 = nic.GetIPProperties().UnicastAddresses
                    .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork)
                    .Select(address => address.Address.ToString())
                    .Take(8)
                    .ToArray();
                if (ipv4.Length == 0) continue;
                lines.Add(nic.Name + " · " + nic.OperationalStatus + " · " + string.Join(",", ipv4));
                if (lines.Count >= 24) break;
            }
        }
        catch (NetworkInformationException)
        {
        }
        return lines.Count == 0 ? "network inventory unavailable" : string.Join(Environment.NewLine, lines);
    }

    private static string AgentStatus()
    {
        try
        {
            using (var service = new ServiceController("CitadelEWSNode"))
            {
                ServiceControllerStatus status = service.Status;
                return "CitadelEWSNode: " + status;
            }
        }
        catch (InvalidOperationException)
        {
            return "CitadelEWSNode: not installed or inaccessible";
        }
    }

    private static string AgentLogs()
    {
        return "Agent logs are intentionally not exposed to the SSH OS user. Use the authenticated Hub Logs view.";
    }

    private static string LmStudioStatus()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:1234/v1/models");
            request.Method = "GET";
            request.Timeout = 1500;
            request.ReadWriteTimeout = 1500;
            request.Proxy = null;
            request.UserAgent = "CITADEL-Restricted-SSH";
            using (var response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream ?? Stream.Null, Encoding.UTF8, true, 4096, false))
            {
                char[] buffer = new char[12000];
                int read = reader.ReadBlock(buffer, 0, buffer.Length);
                return "HTTP " + (int)response.StatusCode + Environment.NewLine + new string(buffer, 0, read);
            }
        }
        catch (WebException)
        {
            return "LM Studio unavailable";
        }
    }

    private static Uri ReadControllerUri()
    {
        string path = Path.Combine(SshStateRoot, "controller-url.txt");
        if (!File.Exists(path)) return null;
        string raw;
        try { raw = File.ReadAllText(path, Encoding.UTF8).Trim(); }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }

        Uri uri;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out uri)) return null;
        if (uri.Scheme == Uri.UriSchemeHttps) return uri;
        if (uri.Scheme == Uri.UriSchemeHttp &&
            (string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)
             || uri.Host == "127.0.0.1"
             || uri.Host == "::1"))
        {
            return uri;
        }
        return null;
    }

    private static string PingController()
    {
        Uri uri = ReadControllerUri();
        if (uri == null) return "controller target unavailable";
        int port = uri.IsDefaultPort ? (uri.Scheme == Uri.UriSchemeHttps ? 443 : 80) : uri.Port;
        try
        {
            using (var client = new TcpClient())
            {
                IAsyncResult pending = client.BeginConnect(uri.Host, port, null, null);
                try
                {
                    if (!pending.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(2)))
                    {
                        return uri.Host + ":" + port + " unreachable: timeout";
                    }
                    client.EndConnect(pending);
                    return uri.Host + ":" + port + " reachable";
                }
                finally
                {
                    pending.AsyncWaitHandle.Close();
                }
            }
        }
        catch (SocketException)
        {
            return uri.Host + ":" + port + " unreachable";
        }
    }

    private static string Status()
    {
        return "host: " + Hostname() + Environment.NewLine
            + "os: " + Environment.OSVersion.VersionString + Environment.NewLine
            + "uptime: " + Uptime() + Environment.NewLine
            + "agent: " + AgentStatus();
    }

    private static string Diagnostics()
    {
        return Status() + Environment.NewLine + Environment.NewLine
            + "cpu:" + Environment.NewLine + Cpu() + Environment.NewLine + Environment.NewLine
            + "memory:" + Environment.NewLine + Memory() + Environment.NewLine + Environment.NewLine
            + "disk:" + Environment.NewLine + Disk() + Environment.NewLine + Environment.NewLine
            + "network:" + Environment.NewLine + Network() + Environment.NewLine + Environment.NewLine
            + "lmstudio:" + Environment.NewLine + LmStudioStatus();
    }

    private static Tuple<string, bool, int> Execute(string raw)
    {
        string command = (raw ?? string.Empty).Trim();
        if (command.Length == 0) return Tuple.Create(string.Empty, false, 0);
        if (ContainsShellSyntax(command))
        {
            return Tuple.Create("DENIED: shell syntax is not supported.", false, 2);
        }
        if (!IsAllowed(command))
        {
            return Tuple.Create("DENIED: command is not in the CITADEL SSH allow-list. Type 'help'.", false, 2);
        }

        switch (command)
        {
            case "help": return Tuple.Create(Help(), false, 0);
            case "status": return Tuple.Create(Status(), false, 0);
            case "hostname": return Tuple.Create(Hostname(), false, 0);
            case "whoami": return Tuple.Create(Whoami(), false, 0);
            case "uname -a": return Tuple.Create(Uname(), false, 0);
            case "python --version":
            case "python3 --version":
                string version = PythonVersion();
                return Tuple.Create(version, false, version == "Python unavailable" ? 127 : 0);
            case "uptime": return Tuple.Create(Uptime(), false, 0);
            case "cpu": return Tuple.Create(Cpu(), false, 0);
            case "memory": return Tuple.Create(Memory(), false, 0);
            case "disk": return Tuple.Create(Disk(), false, 0);
            case "network": return Tuple.Create(Network(), false, 0);
            case "agent-status": return Tuple.Create(AgentStatus(), false, 0);
            case "agent-logs": return Tuple.Create(AgentLogs(), false, 0);
            case "lmstudio-status": return Tuple.Create(LmStudioStatus(), false, 0);
            case "diagnostics": return Tuple.Create(Diagnostics(), false, 0);
            case "ping-controller": return Tuple.Create(PingController(), false, 0);
            case "exit": return Tuple.Create("Session closed.", true, 0);
            default: return Tuple.Create("DENIED.", false, 2);
        }
    }

    public static int Main()
    {
        string original = Environment.GetEnvironmentVariable("SSH_ORIGINAL_COMMAND");
        if (!string.IsNullOrWhiteSpace(original))
        {
            Tuple<string, bool, int> result = Execute(original);
            if (!string.IsNullOrEmpty(result.Item1)) Console.WriteLine(result.Item1);
            return result.Item3;
        }

        Console.WriteLine("CITADEL Restricted SSH Console");
        Console.WriteLine("No cmd.exe, PowerShell, arbitrary executables, forwarding, or file mutation. Type 'help'.");
        while (true)
        {
            Console.Write("citadel> ");
            string line = Console.ReadLine();
            if (line == null) return 0;
            Tuple<string, bool, int> result = Execute(line);
            if (!string.IsNullOrEmpty(result.Item1)) Console.WriteLine(result.Item1);
            if (result.Item2) return result.Item3;
        }
    }
}
