
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CodexAccountError, CodexAccountService, codexResumeTarget, parseCodexAuth, type CodexAccountRuntime } from "./codex-accounts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env["HERDR_WEB_CODEX_ACCOUNTS_DIR"];
});

function jwt(payload: Record<string, unknown>): string {
  return "x." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".y";
}

function auth(email: string, user: string, workspace: string, plan = "plus"): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_user_id: user,
          chatgpt_account_id: workspace,
          chatgpt_plan_type: plan,
        },
        "https://api.openai.com/profile": { email },
      }),
      id_token: jwt({ email, sub: user }),
      refresh_token: "refresh-" + user,
      account_id: workspace,
    },
  });
}

function dirs(): { root: string; state: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-accounts-"));
  roots.push(root);
  const state = join(root, "state");
  const home = join(root, "codex");
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  return { root, state, home };
}

function snapshot(panes: HerdrPane[]): SessionSnapshot {
  return { version: "test", protocol: 22, agents: [], panes, tabs: [], workspaces: [], layouts: [] };
}

function codexPane(status: HerdrPane["agent_status"] = "idle", agent: string | null = "codex"): HerdrPane {
  return {
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    workspace_id: "w1",
    terminal_id: "term-1",
    revision: 1,
    focused: true,
    agent,
    agent_status: status,
    agent_session: { agent: "codex", kind: "id", source: "rollout", value: "11111111-1111-4111-8111-111111111111" },
  };
}

describe("Codex managed accounts", () => {
  it("parses a browser-safe stable identity from Codex auth", () => {
    const parsed = parseCodexAuth(auth("a@example.com", "user-a", "workspace-a", "pro"));
    expect(parsed?.email).toBe("a@example.com");
    expect(parsed?.plan).toBe("pro");
    expect(parsed?.id).toMatch(/^[a-f0-9]{24}$/);
    expect(parsed?.id).toBe(parseCodexAuth(auth("a@example.com", "user-a", "workspace-a", "pro"))?.id);
  });

  it("recovers a Codex resume id from an id or rollout path", () => {
    expect(codexResumeTarget(codexPane())).toBe("11111111-1111-4111-8111-111111111111");
    const pane = codexPane();
    pane.agent_session = { agent: "codex", kind: "path", source: "rollout", value: "rollout-2026-10-02-22222222-2222-4222-8222-222222222222.jsonl" };
    expect(codexResumeTarget(pane)).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("saves two accounts, switches auth, and resumes the same idle pane", async () => {
    const { state, home } = dirs();
    const a = auth("a@example.com", "user-a", "workspace-a");
    const b = auth("b@example.com", "user-b", "workspace-b");
    writeFileSync(join(home, "auth.json"), a);

    let running = true;
    const started: Array<{ paneId: string; sessionId: string }> = [];
    const sent: string[] = [];
    const runtime: CodexAccountRuntime = {
      snapshot: async () => snapshot([codexPane("idle", running ? "codex" : null)]),
      sendText: async (_paneId, value) => { sent.push(value); },
      sendKeys: async () => { running = false; },
      start: async (pane) => { started.push({ paneId: pane.paneId, sessionId: pane.sessionId }); running = true; },
      sleep: async () => {},
      restartDaemon: async () => null,
    };
    const service = new CodexAccountService(state, home, () => {}, runtime);
    const savedA = service.saveCurrent();
    const aId = savedA.current!.id;

    writeFileSync(join(home, "auth.json"), b);
    service.saveCurrent();
    expect(service.state().accounts).toHaveLength(2);

    const result = await service.switchTo(aId);
    expect(parseCodexAuth(readFileSync(join(home, "auth.json"), "utf8"))?.email).toBe("a@example.com");
    expect(sent).toEqual(["/exit"]);
    expect(result.resumed_panes).toEqual(["w1:p1"]);
    expect(started).toEqual([{ paneId: "w1:p1", sessionId: "11111111-1111-4111-8111-111111111111" }]);
    expect(result.state.current?.email).toBe("a@example.com");
  });

  it("copies an account source-to-destination without exposing plaintext in transit", () => {
    const sourceDirs = dirs();
    const targetDirs = dirs();
    const sourceAuth = auth("source@example.com", "source-user", "source-workspace", "pro");
    const targetAuth = auth("target@example.com", "target-user", "target-workspace", "plus");
    writeFileSync(join(sourceDirs.home, "auth.json"), sourceAuth);
    writeFileSync(join(targetDirs.home, "auth.json"), targetAuth);

    const source = new CodexAccountService(sourceDirs.state, sourceDirs.home);
    const target = new CodexAccountService(targetDirs.state, targetDirs.home);
    const sourceId = source.state().current!.id;

    const ticket = target.beginImport();
    const sealed = source.exportSealed(sourceId, ticket.public_key);
    expect(JSON.stringify(sealed)).not.toContain("source@example.com");
    expect(JSON.stringify(sealed)).not.toContain("refresh-source-user");

    const imported = target.importSealed(ticket.transfer_id, sealed);
    expect(imported.imported_account_id).toBe(sourceId);
    expect(imported.state.current?.email).toBe("target@example.com");
    expect(imported.state.accounts.some((account) => account.email === "source@example.com")).toBe(true);
    expect(parseCodexAuth(readFileSync(join(targetDirs.home, "auth.json"), "utf8"))?.email).toBe("target@example.com");
  });

  it("makes encrypted import tickets one-time and rejects tampering", () => {
    const sourceDirs = dirs();
    const targetDirs = dirs();
    writeFileSync(join(sourceDirs.home, "auth.json"), auth("source@example.com", "source-user", "source-workspace"));
    writeFileSync(join(targetDirs.home, "auth.json"), auth("target@example.com", "target-user", "target-workspace"));

    const source = new CodexAccountService(sourceDirs.state, sourceDirs.home);
    const target = new CodexAccountService(targetDirs.state, targetDirs.home);
    const sourceId = source.state().current!.id;
    const ticket = target.beginImport();
    const sealed = source.exportSealed(sourceId, ticket.public_key);
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) + (sealed.ciphertext.endsWith("A") ? "B" : "A") };

    expect(() => target.importSealed(ticket.transfer_id, tampered)).toThrow("could not be decrypted");
    expect(() => target.importSealed(ticket.transfer_id, sealed)).toThrow("expired");
  });

  it("does not change auth while a Codex pane is working", async () => {
    const { state, home } = dirs();
    const a = auth("a@example.com", "user-a", "workspace-a");
    const b = auth("b@example.com", "user-b", "workspace-b");
    writeFileSync(join(home, "auth.json"), a);
    const runtime: CodexAccountRuntime = {
      snapshot: async () => snapshot([codexPane("working")]),
      sendText: async () => { throw new Error("must not stop"); },
      sendKeys: async () => {},
      start: async () => {},
      sleep: async () => {},
      restartDaemon: async () => null,
    };
    const service = new CodexAccountService(state, home, () => {}, runtime);
    const aId = service.saveCurrent().current!.id;
    writeFileSync(join(home, "auth.json"), b);
    const bId = service.saveCurrent().current!.id;
    expect(aId).not.toBe(bId);

    await expect(service.switchTo(aId)).rejects.toBeInstanceOf(CodexAccountError);
    expect(parseCodexAuth(readFileSync(join(home, "auth.json"), "utf8"))?.email).toBe("b@example.com");
  });
});
