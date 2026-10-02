import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import {
  canonicalWindowsAgentExecutable,
  windowsAgentArgs,
  windowsStandardBootstrapCommand,
  WindowsRunLevelStore,
  workspaceRunLevel,
} from "./windows-run-level.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshotWithRunLevel(level?: "standard" | "admin"): SessionSnapshot {
  return {
    agents: [],
    layouts: [],
    panes: [],
    protocol: 1,
    tabs: [],
    version: "test",
    workspaces: [{
      active_tab_id: "t1",
      agent_status: "unknown",
      focused: false,
      label: "Test",
      number: 1,
      pane_count: 1,
      tab_count: 1,
      ...(level ? { tokens: { herdr_web_run_level: level } } : {}),
      workspace_id: "w1",
    }],
  };
}

describe("Windows session run levels", () => {
  it("uses the same canonical Windows executables as herdr for common agents", () => {
    expect(canonicalWindowsAgentExecutable("codex")).toBe("codex");
    expect(canonicalWindowsAgentExecutable("claude")).toBe("claude");
    expect(canonicalWindowsAgentExecutable("cursor")).toBe("cursor-agent.cmd");
    expect(canonicalWindowsAgentExecutable("kiro")).toBe("kiro-cli");
    expect(canonicalWindowsAgentExecutable("not-an-agent")).toBeNull();
  });

  it("always isolates Windows Codex from the shared daemon", () => {
    expect(windowsAgentArgs("codex")).toEqual(["--no-daemon"]);
    expect(windowsAgentArgs("codex", ["resume", "thread-id"])).toEqual(["--no-daemon", "resume", "thread-id"]);
    expect(windowsAgentArgs("claude", ["--verbose"])).toEqual(["--verbose"]);
  });

  it("boots the linked-token helper and never falls back to the outer PowerShell prompt", () => {
    const command = windowsStandardBootstrapCommand(
      "powershell",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\bundle\\server\\windows-standard-shell.ps1",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "0123456789abcdef0123456789abcdef",
    );
    expect(command).toContain("windows-standard-shell.ps1");
    expect(command).toContain("0123456789abcdef0123456789abcdef");
    expect(command).toContain("; exit $LASTEXITCODE");
  });

  it("closes an outer cmd prompt after the standard child exits", () => {
    const command = windowsStandardBootstrapCommand(
      "cmd",
      "powershell.exe",
      "C:\\bundle\\server\\windows-standard-shell.ps1",
      "pwsh.exe",
      "fedcba9876543210fedcba9876543210",
    );
    expect(command).toContain("exit /b %ERRORLEVEL%");
  });

  it("ships an intact linked-token PowerShell helper", () => {
    const helper = readFileSync(join(import.meta.dir, "windows-standard-shell.ps1"), "utf8");
    expect(helper).toContain("if ($Marker -notmatch '^[A-Fa-f0-9]{32}$')");
    expect(helper).toContain("if ($CommandBase64 -notmatch '^[A-Za-z0-9+/=]+$')");
    expect(helper).toContain("CreateProcessAsUserW");
    expect(helper).toContain("CreateProcessWithTokenW");
    expect(helper).toContain("TokenLinkedToken");
    expect(helper).toContain("Process.GetProcessesByName(\"explorer\")");
    expect(helper).toContain("TokenElevationTypeLimited");
    expect(helper).not.toContain("private static extern bool CreateRestrictedToken(");
    expect(helper).not.toContain("private const uint LUA_TOKEN");
    expect(helper).toContain("TokenElevation");
    expect(helper).toContain("elevation.TokenIsElevated != 0");
    expect(helper).toContain("HERDR_SOCKET_PATH");
    expect((helper.match(/Add-Type -TypeDefinition/g) ?? [])).toHaveLength(1);
    expect(helper.trimEnd().endsWith("exit $code")).toBe(true);
  });

  it("persists workspace run levels outside Herdr's transient metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-run-levels-"));
    roots.push(root);

    const first = new WindowsRunLevelStore(root);
    first.set("w1", "standard");
    first.set("w2", "admin");

    const second = new WindowsRunLevelStore(root);
    expect(second.get("w1")).toBe("standard");
    expect(second.get("w2")).toBe("admin");
    second.delete("w1");

    const third = new WindowsRunLevelStore(root);
    expect(third.get("w1")).toBeNull();
    expect(third.get("w2")).toBe("admin");
  });

  it("reads persistent run-level metadata from the pane's workspace", () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1" } as HerdrPane;
    const standard = snapshotWithRunLevel("standard");
    const admin = snapshotWithRunLevel("admin");
    const old = snapshotWithRunLevel();

    expect(workspaceRunLevel(standard, pane)).toBe("standard");
    expect(workspaceRunLevel(admin, pane)).toBe("admin");
    expect(workspaceRunLevel(old, pane)).toBeNull();
    expect(workspaceRunLevel(old, pane, (workspaceId) => workspaceId === "w1" ? "standard" : null))
      .toBe("standard");
  });
});
