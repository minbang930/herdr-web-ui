param(
  [Parameter(Mandatory = $true)]
  [string]$Shell,
  [string]$Marker = '',
  [string]$CommandBase64 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
  [Console]::Error.WriteLine("herdr-web-ui: failed to start a standard Windows process: $($_.Exception.Message)")
  exit 126
}

function Test-HerdrWebElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (($Marker -eq '') -eq ($CommandBase64 -eq '')) {
  throw 'Specify exactly one of -Marker or -CommandBase64'
}

if ($Marker -ne '') {
  if ($Marker -notmatch '^[A-Fa-f0-9]{32}$') {
    throw 'Invalid readiness marker'
  }

  $bootstrapLines = @(
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
    'if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
    "  [Console]::Error.WriteLine('herdr-web-ui: requested a standard shell but the child token is still elevated')",
    '  exit 125',
    '}',
    "Write-Output '__HERDR_WEB_STANDARD_READY_$Marker'"
  )
  $bootstrap = $bootstrapLines -join [Environment]::NewLine
  $childArgs = @('-NoLogo', '-NoExit', '-Command', $bootstrap)
}
else {
  if ($CommandBase64 -notmatch '^[A-Za-z0-9+/=]+$') {
    throw 'Invalid encoded command'
  }

  $command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($CommandBase64))
  $guard = @'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine('herdr-web-ui: standard-token maintenance child is still elevated')
  exit 125
}
'@
  $guarded = $guard + [Environment]::NewLine + $command
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($guarded))
  $childArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
}

# A bridge that already runs without elevation needs no token surgery.
if (-not (Test-HerdrWebElevated)) {
  & $Shell @childArgs
  exit $LASTEXITCODE
}

if (-not ('HerdrWebUi.StandardProcess' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace HerdrWebUi
{
    public static class StandardProcess
    {
        private const uint TOKEN_QUERY = 0x0008;
        private const uint TOKEN_DUPLICATE = 0x0002;
        private const uint MAXIMUM_ALLOWED = 0x02000000;
        private const int TokenElevationType = 18;
        private const int TokenLinkedToken = 19;
        private const int TokenElevation = 20;
        private const int TokenElevationTypeLimited = 3;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const int SecurityImpersonation = 2;
        private const int TokenPrimary = 1;
        private const uint INFINITE = 0xffffffff;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const int ERROR_PRIVILEGE_NOT_HELD = 1314;
        private const uint LOGON_WITH_PROFILE = 0x00000001;

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_LINKED_TOKEN
        {
            public IntPtr LinkedToken;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_ELEVATION
        {
            public int TokenIsElevated;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
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
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            bool inheritHandle,
            uint processId
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(
            IntPtr process,
            uint desiredAccess,
            out IntPtr token
        );

        [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
        private static extern bool GetTokenInformationLinked(
            IntPtr token,
            int tokenInformationClass,
            out TOKEN_LINKED_TOKEN tokenInformation,
            int tokenInformationLength,
            out int returnLength
        );

        [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
        private static extern bool GetTokenInformationElevation(
            IntPtr token,
            int tokenInformationClass,
            out TOKEN_ELEVATION tokenInformation,
            int tokenInformationLength,
            out int returnLength
        );

        [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
        private static extern bool GetTokenInformationElevationType(
            IntPtr token,
            int tokenInformationClass,
            out int tokenInformation,
            int tokenInformationLength,
            out int returnLength
        );

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(
            IntPtr existingToken,
            uint desiredAccess,
            IntPtr tokenAttributes,
            int impersonationLevel,
            int tokenType,
            out IntPtr newToken
        );

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUserW(
            IntPtr token,
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation
        );

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessWithTokenW(
            IntPtr token,
            uint logonFlags,
            string applicationName,
            StringBuilder commandLine,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation
        );

        // OpenSSH/WMI administrator processes often have no TokenLinkedToken. In that case,
        // borrow the same account's real UAC-limited desktop token from Explorer. Unlike
        // CreateRestrictedToken(LUA_TOKEN), this is the token Windows itself gave the user's
        // non-elevated desktop and is compatible with Codex's Windows process/exec stack.
        private static bool TryOpenDesktopStandardToken(out IntPtr token)
        {
            token = IntPtr.Zero;
            string currentSid;
            using (WindowsIdentity current = WindowsIdentity.GetCurrent())
            {
                currentSid = current.User == null ? null : current.User.Value;
            }
            if (String.IsNullOrEmpty(currentSid))
                return false;

            foreach (Process process in Process.GetProcessesByName("explorer"))
            {
                IntPtr processHandle = IntPtr.Zero;
                IntPtr processToken = IntPtr.Zero;
                try
                {
                    processHandle = OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        unchecked((uint)process.Id));
                    if (processHandle == IntPtr.Zero)
                        continue;

                    if (!OpenProcessToken(
                        processHandle,
                        TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                        out processToken))
                        continue;

                    string candidateSid;
                    using (WindowsIdentity candidate = new WindowsIdentity(processToken))
                    {
                        candidateSid = candidate.User == null ? null : candidate.User.Value;
                    }
                    if (!String.Equals(currentSid, candidateSid, StringComparison.OrdinalIgnoreCase))
                        continue;

                    TOKEN_ELEVATION elevation;
                    int returned;
                    if (!GetTokenInformationElevation(
                        processToken,
                        TokenElevation,
                        out elevation,
                        Marshal.SizeOf(typeof(TOKEN_ELEVATION)),
                        out returned) || elevation.TokenIsElevated != 0)
                        continue;

                    int elevationType;
                    if (!GetTokenInformationElevationType(
                        processToken,
                        TokenElevationType,
                        out elevationType,
                        sizeof(int),
                        out returned) || elevationType != TokenElevationTypeLimited)
                        continue;

                    token = processToken;
                    processToken = IntPtr.Zero;
                    return true;
                }
                catch
                {
                    // Another desktop/session may expose an Explorer process we cannot query.
                }
                finally
                {
                    if (processToken != IntPtr.Zero) CloseHandle(processToken);
                    if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
                    process.Dispose();
                }
            }
            return false;
        }

        private static string Quote(string value)
        {
            if (value.Length == 0)
                return new string('"', 2);
            if (value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '\"' }) < 0)
                return value;

            var result = new StringBuilder();
            result.Append('\"');
            int backslashes = 0;
            foreach (char ch in value)
            {
                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (ch == '\"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('\"');
                    backslashes = 0;
                    continue;
                }

                if (backslashes > 0)
                {
                    result.Append('\\', backslashes);
                    backslashes = 0;
                }
                result.Append(ch);
            }
            if (backslashes > 0)
                result.Append('\\', backslashes * 2);
            result.Append('\"');
            return result.ToString();
        }

        // Preserve HERDR_SOCKET_PATH / HERDR_PANE_ID / PATH and the rest of the pane environment.
        private static IntPtr BuildEnvironmentBlock()
        {
            var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables(EnvironmentVariableTarget.Process))
            {
                var key = entry.Key as string;
                var value = entry.Value as string;
                if (!String.IsNullOrEmpty(key) && value != null)
                    values[key] = value;
            }

            var block = new StringBuilder();
            foreach (var entry in values)
            {
                block.Append(entry.Key);
                block.Append('=');
                block.Append(entry.Value);
                block.Append('\0');
            }
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        public static int Run(string file, string[] args, string cwd)
        {
            IntPtr currentToken = IntPtr.Zero;
            IntPtr linkedToken = IntPtr.Zero;
            IntPtr desktopToken = IntPtr.Zero;
            IntPtr primaryToken = IntPtr.Zero;
            IntPtr childToken = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();

            try
            {
                if (!OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_DUPLICATE,
                    out currentToken))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");

                TOKEN_LINKED_TOKEN linked;
                int returned;
                IntPtr candidateToken;
                bool candidateIsSameSession;
                if (GetTokenInformationLinked(
                    currentToken,
                    TokenLinkedToken,
                    out linked,
                    Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)),
                    out returned) && linked.LinkedToken != IntPtr.Zero)
                {
                    linkedToken = linked.LinkedToken;
                    candidateToken = linkedToken;
                    candidateIsSameSession = true;
                }
                else if (TryOpenDesktopStandardToken(out desktopToken))
                {
                    candidateToken = desktopToken;
                    candidateIsSameSession = false;
                }
                else
                {
                    throw new InvalidOperationException(
                        "No real non-elevated UAC token is available for this Windows account. " +
                        "Sign in to the Windows desktop so Explorer is running, or use an Administrator session."
                    );
                }

                if (!DuplicateTokenEx(
                    candidateToken,
                    MAXIMUM_ALLOWED,
                    IntPtr.Zero,
                    SecurityImpersonation,
                    TokenPrimary,
                    out primaryToken))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed");

                var commandLine = new StringBuilder();
                commandLine.Append(Quote(file));
                foreach (string arg in args)
                {
                    commandLine.Append(' ');
                    commandLine.Append(Quote(arg));
                }

                var startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                environment = BuildEnvironmentBlock();

                // A linked token belongs to the caller's logon session, so normal inherited-handle
                // creation keeps Herdr's ConPTY. A desktop token may belong to another Terminal
                // Services session; CreateProcessWithTokenW deliberately creates in the caller's
                // session, avoiding cross-session handle inheritance while keeping the real UAC token.
                bool created;
                int error = 0;
                if (candidateIsSameSession)
                {
                    created = CreateProcessAsUserW(
                        primaryToken,
                        file,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        CREATE_UNICODE_ENVIRONMENT,
                        environment,
                        cwd,
                        ref startup,
                        out process);
                    error = created ? 0 : Marshal.GetLastWin32Error();

                    if (!created && error == ERROR_PRIVILEGE_NOT_HELD)
                    {
                        process = new PROCESS_INFORMATION();
                        commandLine = new StringBuilder(commandLine.ToString());
                        created = CreateProcessWithTokenW(
                            primaryToken,
                            LOGON_WITH_PROFILE,
                            file,
                            commandLine,
                            CREATE_UNICODE_ENVIRONMENT,
                            environment,
                            cwd,
                            ref startup,
                            out process);
                        error = created ? 0 : Marshal.GetLastWin32Error();
                    }
                }
                else
                {
                    created = CreateProcessWithTokenW(
                        primaryToken,
                        LOGON_WITH_PROFILE,
                        file,
                        commandLine,
                        CREATE_UNICODE_ENVIRONMENT,
                        environment,
                        cwd,
                        ref startup,
                        out process);
                    error = created ? 0 : Marshal.GetLastWin32Error();
                }

                if (!created)
                    throw new Win32Exception(error, "Could not create the standard-token child process");

                // Match Codex's own Windows daemon guard exactly: TokenElevation must report 0.
                if (!OpenProcessToken(process.hProcess, TOKEN_QUERY, out childToken))
                {
                    TerminateProcess(process.hProcess, 125);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not verify the child process token");
                }
                TOKEN_ELEVATION elevation;
                if (!GetTokenInformationElevation(
                    childToken,
                    TokenElevation,
                    out elevation,
                    Marshal.SizeOf(typeof(TOKEN_ELEVATION)),
                    out returned))
                {
                    TerminateProcess(process.hProcess, 125);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the child process elevation");
                }
                if (elevation.TokenIsElevated != 0)
                {
                    TerminateProcess(process.hProcess, 125);
                    throw new InvalidOperationException("The requested standard-token child is still elevated");
                }

                WaitForSingleObject(process.hProcess, INFINITE);
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
                return unchecked((int)exitCode);
            }
            finally
            {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (childToken != IntPtr.Zero) CloseHandle(childToken);
                if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
                if (desktopToken != IntPtr.Zero) CloseHandle(desktopToken);
                if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);
                if (currentToken != IntPtr.Zero) CloseHandle(currentToken);
            }
        }
    }
}
'@
}

$code = [HerdrWebUi.StandardProcess]::Run($Shell, $childArgs, (Get-Location).Path)
exit $code
