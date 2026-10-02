import { describe, expect, it } from "bun:test";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import {
  canonicalWindowsAgentExecutable,
  windowsStandardBootstrapCommand,
  workspaceRunLevel,
} from "./windows-run-level.ts";

describe("Windows session run levels", () => {
  it("uses the same canonical Windows executables as herdr for common agents", () => {
    expect(canonicalWindowsAgentExecutable("codex")).toBe("codex");
    expect(canonicalWindowsAgentExecutable("claude")).toBe("claude");
    expect(canonicalWindowsAgentExecutable("cursor")).toBe("cursor-agent.cmd");
    expect(canonicalWindowsAgentExecutable("kiro")).toBe("kiro-cli");
    expect(canonicalWindowsAgentExecutable("not-an-agent")).toBeNull();
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

  it("reads persistent run-level metadata from the pane's workspace", () => {
    const pane = { pane_id: "w1:p1", workspace_id: "w1" } as HerdrPane;
    const standard = { workspaces: [{ workspace_id: "w1", tokens: { herdr_web_run_level: "standard" } }] } as SessionSnapshot;
    const admin = { workspaces: [{ workspace_id: "w1", tokens: { herdr_web_run_level: "admin" } }] } as SessionSnapshot;
    const old = { workspaces: [{ workspace_id: "w1" }] } as SessionSnapshot;
    expect(workspaceRunLevel(standard, pane)).toBe("standard");
    expect(workspaceRunLevel(admin, pane)).toBe("admin");
    expect(workspaceRunLevel(old, pane)).toBeNull();
  });
});
