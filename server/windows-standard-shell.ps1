param(
  [Parameter(Mandatory = $true)]
  [string]$Shell,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{32}$')]
  [string]$Marker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
  [Console]::Error.WriteLine("herdr-web-ui: failed to start a standard Windows shell: $($_.Exception.Message)")
  exit 126
}

function Test-HerdrWebElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$bootstrap = @"
`$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
`$principal = [Security.Principal.WindowsPrincipal]::new(`$identity)
if (`$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine('herdr-web-ui: requested a standard shell but the child token is still elevated')
  exit 125
}
Write-Output '__HERDR_WEB_STANDARD_READY_$Marker'
"@

$childArgs = @('-NoLogo', '-NoProfile', '-NoExit', '-Command', $bootstrap)

# If herdr itself is already standard, keep the exact same lifecycle shape: a child owns the
# interactive console, this bootstrap waits, and the elevated/outer shell never reappears.
if (-not (Test-HerdrWebElevated)) {
  & $Shell @childArgs
  exit $LASTEXITCODE
}

if (-not ('HerdrWebUi.StandardProcess' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace HerdrWebUi
{
    public static class StandardProcess
    {
        private const uint TOKEN_QUERY = 0x0008;
        private const uint TOKEN_DUPLICATE = 0x0002;
        private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
        private const uint MAXIMUM_ALLOWED = 0x02000000;
        private const int TokenLinkedToken = 19;
        private const int SecurityImpersonation = 2;
        private const int TokenPrimary = 1;
        private const uint INFINITE = 0xffffffff;

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_LINKED_TOKEN
        {
            public IntPtr LinkedToken;
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
        private static extern bool CloseHandle(IntPtr handle);

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

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr token,
            int tokenInformationClass,
            out TOKEN_LINKED_TOKEN tokenInformation,
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

        private static string Quote(string value)
        {
            if (value.Length == 0)
                return "\"\"";
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

        public static int Run(string file, string[] args, string cwd)
        {
            IntPtr currentToken = IntPtr.Zero;
            IntPtr linkedToken = IntPtr.Zero;
            IntPtr primaryToken = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();

            try
            {
                if (!OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                    out currentToken))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");

                TOKEN_LINKED_TOKEN linked;
                int returned;
                if (!GetTokenInformation(
                    currentToken,
                    TokenLinkedToken,
                    out linked,
                    Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)),
                    out returned))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "The elevated process has no linked standard token");

                linkedToken = linked.LinkedToken;
                if (!DuplicateTokenEx(
                    linkedToken,
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

                // With creationFlags=0, CreateProcessAsUser inherits the parent's console.
                // That keeps the child inside herdr's existing ConPTY instead of opening a window.
                if (!CreateProcessAsUserW(
                    primaryToken,
                    file,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    0,
                    IntPtr.Zero,
                    cwd,
                    ref startup,
                    out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUserW failed");

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
                if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
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
