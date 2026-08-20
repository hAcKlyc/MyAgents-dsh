$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$payloadPathName = "MYAGENTS_WINDOWS_JOB_PAYLOAD_PATH"
$payloadDigestName = "MYAGENTS_WINDOWS_JOB_PAYLOAD_SHA256"
$payloadPath = [Environment]::GetEnvironmentVariable($payloadPathName, "Process")
$expectedPayloadDigest = [Environment]::GetEnvironmentVariable($payloadDigestName, "Process")
[Environment]::SetEnvironmentVariable($payloadPathName, $null, "Process")
[Environment]::SetEnvironmentVariable($payloadDigestName, $null, "Process")
if ([string]::IsNullOrWhiteSpace($payloadPath) -or $expectedPayloadDigest -notmatch '^[a-f0-9]{64}$'
  -or -not [IO.Path]::IsPathFullyQualified($payloadPath)) {
  throw "Windows Job Object payload authority is missing"
}
$payloadInfo = Get-Item -LiteralPath $payloadPath -Force
if (-not $payloadInfo.PSIsContainer -and $payloadInfo.Length -le 2097152
  -and (($payloadInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
  $payloadBytes = [IO.File]::ReadAllBytes($payloadPath)
} else {
  throw "Windows Job Object payload file is invalid"
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actualPayloadDigest = ([BitConverter]::ToString($sha256.ComputeHash($payloadBytes))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
if ($actualPayloadDigest -ne $expectedPayloadDigest) {
  throw "Windows Job Object payload digest changed"
}
Remove-Item -LiteralPath $payloadPath -Force
$payload = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
if ($null -eq $payload.argv -or $payload.argv.Count -lt 1 -or [string]::IsNullOrWhiteSpace($payload.cwd)
  -or [string]::IsNullOrWhiteSpace($payload.gracefulControlPath)
  -or [string]::IsNullOrWhiteSpace($payload.forceControlPath)
  -or [string]::IsNullOrWhiteSpace($payload.attestationPath)) {
  throw "Windows Job Object payload is invalid"
}
$payloadDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($payloadPath))
foreach ($authorityPath in @(
  [string]$payload.gracefulControlPath,
  [string]$payload.forceControlPath,
  [string]$payload.attestationPath
)) {
  if (-not [IO.Path]::IsPathFullyQualified($authorityPath)
    -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($authorityPath)) -ne $payloadDirectory) {
    throw "Windows Job Object control authority escapes its private directory"
  }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MyAgentsWindowsJobHost {
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint CTRL_BREAK_EVENT = 1;
  private const uint WAIT_OBJECT_0 = 0;
  private const uint WAIT_TIMEOUT = 258;
  private const int JobObjectExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job, int infoClass, IntPtr information, uint length, IntPtr returnLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(int standardHandle);

  private static void Check(bool value, string operation) {
    if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  private static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes += 1; continue; }
      if (character == '"') {
        result.Append('\\', slashes * 2 + 1).Append('"');
        slashes = 0;
        continue;
      }
      result.Append('\\', slashes).Append(character);
      slashes = 0;
    }
    result.Append('\\', slashes * 2).Append('"');
    return result.ToString();
  }

  private static void WaitForJobEmpty(IntPtr job) {
    int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      while (true) {
        Check(QueryInformationJobObject(job, 1, memory, (uint)size, IntPtr.Zero),
          "QueryInformationJobObject(BasicAccountingInformation)");
        var accounting = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
          memory, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (accounting.ActiveProcesses == 0) return;
        Thread.Sleep(10);
      }
    } finally {
      Marshal.FreeHGlobal(memory);
    }
  }

  public static int Run(
    string[] argv,
    string cwd,
    string gracefulControlPath,
    string forceControlPath,
    string attestationPath
  ) {
    if (argv == null || argv.Length == 0) throw new ArgumentException("argv is empty");
    IntPtr job = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool gracefulSent = false;
    bool forceSent = false;
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero, "CreateJobObject");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr memory = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, memory, false);
        Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, memory, (uint)size),
          "SetInformationJobObject(KILL_ON_JOB_CLOSE)");
      } finally {
        Marshal.FreeHGlobal(memory);
      }
      var startup = new STARTUPINFO();
      startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      startup.dwFlags = (int)STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);
      var command = new StringBuilder(String.Join(" ", Array.ConvertAll(argv, Quote)));
      if (command.Length > 30000) throw new InvalidDataException("child command exceeds the CreateProcess bound");
      Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
        IntPtr.Zero, cwd, ref startup, out process), "CreateProcessW(suspended)");
      Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
      if (ResumeThread(process.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      while (true) {
        uint wait = WaitForSingleObject(process.hProcess, 50);
        if (wait == WAIT_OBJECT_0) break;
        if (wait != WAIT_TIMEOUT) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
        if (!forceSent && File.Exists(forceControlPath)
          && File.ReadAllText(forceControlPath, Encoding.UTF8).Trim() == "TerminateJobObject") {
          forceSent = true;
          Check(TerminateJobObject(job, 1), "TerminateJobObject");
          continue;
        }
        if (!gracefulSent && File.Exists(gracefulControlPath)
          && File.ReadAllText(gracefulControlPath, Encoding.UTF8).Trim() == "CTRL_BREAK_EVENT") {
          gracefulSent = true;
          Check(GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process.dwProcessId), "GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)");
        }
      }
      uint exitCode;
      Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
      Check(TerminateJobObject(job, exitCode == 0 ? 1u : exitCode), "TerminateJobObject(descendants)");
      WaitForJobEmpty(job);
      File.WriteAllText(
        attestationPath,
        "JOB_EMPTY:" + unchecked((int)exitCode).ToString(),
        new UTF8Encoding(false)
      );
      return unchecked((int)exitCode);
    } catch (Exception failure) {
      Exception cleanupFailure = null;
      if (job != IntPtr.Zero) {
        try {
          Check(TerminateJobObject(job, 1), "TerminateJobObject(failure-cleanup)");
          WaitForJobEmpty(job);
        } catch (Exception error) {
          cleanupFailure = error;
        }
      }
      if (cleanupFailure != null) throw new AggregateException(failure, cleanupFailure);
      throw;
    } finally {
      try { if (File.Exists(gracefulControlPath)) File.Delete(gracefulControlPath); } catch { }
      try { if (File.Exists(forceControlPath)) File.Delete(forceControlPath); } catch { }
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@

$argv = @($payload.argv | ForEach-Object { [string]$_ })
$exitCode = [MyAgentsWindowsJobHost]::Run(
  $argv,
  [string]$payload.cwd,
  [string]$payload.gracefulControlPath,
  [string]$payload.forceControlPath,
  [string]$payload.attestationPath
)
exit $exitCode
