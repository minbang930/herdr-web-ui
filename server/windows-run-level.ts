import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { HerdrPane, SessionCapabilities, SessionRunLevel, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";
import { isShellAgentKind, paneShell, shellCommandLine, startShellAgent, type PaneShell } from "./shell-agent.ts";
import { psQuote } from "./powershell.ts";

const STANDARD_READY_PREFIX = "__HERDR_WEB_STANDARD_READY_";
const STANDARD_START_TIMEOUT_MS = 12_000;
const AGENT_START_TIMEOUT_MS = 60_000;

const WINDOWS_AGENT_EXECUTABLES: Readonly<Record<string, string>> = {
  pi: "pi",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor-agent.cmd",
  devin: "devin",
  agy: "agy",
  cline: "cline",
  omp: "omp",
  mastracode: "mastracode",
  opencode: "opencode",
  copilot: "copilot",
  kimi: "kimi",
  kiro: "kiro-cli",
  droid: "droid",
  amp: "amp",
  grok: "grok",
  hermes: "hermes",
  kilo: "kilo",
  qodercli: "qodercli",
  qwen: "qwen",
  letta: "letta",
  maki: "maki",
  muse: "muse",
};

interface ProcessInfo {
  process_info?: {
    foreground_processes?: { argv?: string[] }[];
  };
}

let elevation: Promise<boolean> | null = null;

async function detectWindowsElevation(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const powershell = Bun.which("powershell.exe", { PATH: process.env["PATH"] ?? "" }) ?? "powershell.exe";
  const script = [
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "$principal=[Security.Principal.WindowsPrincipal]::new($identity)",
    "if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Write-Output '1'}else{Write-Output '0'}",
  ].join(";");
  const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 && stdout.trim() === "1";
}

export async function sessionCapabilities(): Promise<SessionCapabilities> {
  if (process.platform !== "win32") {
    return { default_run_level: null, run_levels: [], server_elevated: null };
  }
  elevation ??= detectWindowsElevation();
  const serverElevated = await elevation;
  return {
    default_run_level: "standard",
    run_levels: serverElevated ? ["standard", "admin"] : ["standard"],
    server_elevated: serverElevated,
  };
}

export function canonicalWindowsAgentExecutable(kind: string): string | null {
  return WINDOWS_AGENT_EXECUTABLES[kind] ?? null;
}

function appendRootExit(shell: PaneShell, command: string): string {
  if (shell === "powershell") return command + "; exit $LASTEXITCODE";
  if (shell === "cmd") return command + " & exit /b %ERRORLEVEL%";
  return command + "; exit $?";
}

export function windowsStandardBootstrapCommand(
  rootShell: PaneShell,
  helperHost: string,
  helperScript: string,
  childShell: string,
  marker: string,
): string {
  const command = shellCommandLine(rootShell, helperHost, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperScript,
    "-Shell",
    childShell,
    "-Marker",
    marker,
  ]);
  return appendRootExit(rootShell, command);
}

async function currentPaneShell(paneId: string): Promise<PaneShell> {
  const info = await herdrRpc<ProcessInfo>("pane.process_info", { pane_id: paneId }).catch(() => null);
  const argv0 = info?.process_info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe";
  return paneShell(argv0);
}

async function waitForMarker(paneId: string, marker: string, timeoutMs = STANDARD_START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const read = await paneRead({ paneId, source: "recent", format: "text", lines: 120, stripAnsi: true, timeoutMs: 1500 });
      if (read.text.includes(marker)) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(lastError instanceof Error
    ? `standard Windows shell did not become ready: ${lastError.message}`
    : "standard Windows shell did not become ready");
}

async function waitForMarkerResult(
  paneId: string,
  marker: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(marker + "(-?\\d+)");
  while (Date.now() < deadline) {
    const read = await paneRead({ paneId, source: "recent", format: "text", lines: 120, stripAnsi: true, timeoutMs: 1500 }).catch(() => null);
    const match = read?.text.match(pattern);
    if (match) return Number(match[1]);
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for the standard Windows command");
}

/**
 * Replaces a fresh Windows pane's inherited elevated shell with a child created from the
 * account's linked standard token. The outer shell exits as soon as the standard child exits,
 * so a user can never fall back into an elevated prompt by typing exit.
 */
export async function enterWindowsStandardShell(paneId: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows run levels are only available on Windows");
  const rootShell = await currentPaneShell(paneId);
  const helperHost = Bun.which("powershell.exe", { PATH: process.env["PATH"] ?? "" }) ?? "powershell.exe";
  const childShell = Bun.which("pwsh.exe", { PATH: process.env["PATH"] ?? "" })
    ?? Bun.which("powershell.exe", { PATH: process.env["PATH"] ?? "" })
    ?? "powershell.exe";
  const helperScript = join(import.meta.dir, "windows-standard-shell.ps1");
  const nonce = randomBytes(16).toString("hex");
  const marker = STANDARD_READY_PREFIX + nonce;
  const command = windowsStandardBootstrapCommand(rootShell, helperHost, helperScript, childShell, nonce);
  await paneSendText(paneId, command);
  await Bun.sleep(40);
  await paneSendKeys(paneId, ["Enter"]);
  await waitForMarker(paneId, marker);
}

async function waitForAgent(paneId: string, kind: string, timeoutMs = AGENT_START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new Error("the new pane closed while its agent was starting");
    if (pane.agent === kind || pane.display_agent === kind) return;
    await Bun.sleep(250);
  }
  throw new Error(`${kind} did not start in the standard Windows session`);
}

/**
 * Starts an agent by typing its canonical command into the pane. Unlike herdr agent.start,
 * the process is therefore a child of the already-standard shell and keeps that token.
 */
export async function startAgentInWindowsStandardShell(
  kind: string,
  paneId: string,
  args: string[] = [],
  timeoutMs = AGENT_START_TIMEOUT_MS,
): Promise<void> {
  if (isShellAgentKind(kind)) {
    await startShellAgent(kind, paneId, args, { timeoutMs });
    return;
  }
  const executableName = canonicalWindowsAgentExecutable(kind);
  if (!executableName) throw new Error(`unsupported Windows agent kind ${kind}`);
  const executable = Bun.which(executableName, { PATH: process.env["PATH"] ?? "" }) ?? executableName;
  const command = shellCommandLine("powershell", executable, args);
  await paneSendText(paneId, command);
  await Bun.sleep(40);
  await paneSendKeys(paneId, ["Enter"]);
  await waitForAgent(paneId, kind, timeoutMs);
}

/**
 * Reload Codex auth from a standard-token pane. This avoids the Windows daemon refusing a
 * restart requested by the elevated bridge process. The full completion marker is assembled
 * by PowerShell, so it cannot be mistaken for the echoed command line.
 */
export async function restartCodexDaemonInWindowsStandardShell(
  paneId: string,
  codexHome: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  const codex = Bun.which("codex", { PATH: process.env["PATH"] ?? "" }) ?? "codex";
  const nonce = randomBytes(16).toString("hex");
  const marker = "__HERDR_WEB_CODEX_DAEMON_" + nonce + "__";
  const command = [
    "$__h=" + psQuote(codexHome),
    "$__c=" + psQuote(codex),
    "$__n=" + psQuote(nonce),
    "$__old=$env:CODEX_HOME",
    "$env:CODEX_HOME=$__h",
    "& $__c app-server daemon restart",
    "$__ec=$LASTEXITCODE",
    "if($null -eq $__old){Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue}else{$env:CODEX_HOME=$__old}",
    "Write-Output ('__HERDR_WEB_CODEX_DAEMON_' + $__n + '__' + $__ec)",
  ].join("; ");
  await paneSendText(paneId, command);
  await Bun.sleep(40);
  await paneSendKeys(paneId, ["Enter"]);
  try {
    const code = await waitForMarkerResult(paneId, marker, timeoutMs);
    return code === 0 ? null : `Codex account switched, but the standard-token daemon restart exited with code ${code}.`;
  } catch (error) {
    return `Codex account switched, but the standard-token daemon restart did not finish: ${error instanceof Error ? error.message : String(error)}`;
  }
}


export function workspaceRunLevel(snapshot: SessionSnapshot, pane: HerdrPane): SessionRunLevel | null {
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id);
  const value = workspace?.tokens?.["herdr_web_run_level"];
  return value === "standard" || value === "admin" ? value : null;
}
