
/**
 * Local Codex account slots.
 *
 * Credentials never leave this PC. A saved account is a private copy of Codex auth.json
 * under the web bridge state directory. Switching stops idle Codex TUIs, swaps auth.json,
 * restarts the Codex app-server daemon when one is running, then resumes the same recorded
 * sessions in the same herdr panes.
 *
 * This intentionally supports the file credential store only. Keyring/auto/ephemeral stores
 * are owned by Codex and are not copied or rewritten by herdr-web-ui.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CodexAccountState, CodexAccountSwitchResult, CodexManagedAccount, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";
import { agentStart, paneSendKeys, paneSendText, sessionSnapshot } from "./herdr/client.ts";

const ACCOUNT_ID_RE = /^[a-f0-9]{24}$/;
const SESSION_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const EXIT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function jwtClaims(token: string): Json {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try { return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { return {}; }
}

export interface ParsedCodexAuth {
  id: string;
  email: string | null;
  plan: string | null;
  raw: string;
}

/** A browser-safe identity for one ChatGPT auth.json. */
export function parseCodexAuth(raw: string): ParsedCodexAuth | null {
  let parsed: Json;
  try { parsed = record(JSON.parse(raw)); } catch { return null; }
  const tokens = record(parsed["tokens"]);
  const accessToken = text(tokens["access_token"]);
  if (!accessToken) return null;
  const access = jwtClaims(accessToken);
  const auth = record(access["https://api.openai.com/auth"]);
  const profile = record(access["https://api.openai.com/profile"]);
  const idClaims = jwtClaims(text(tokens["id_token"]) ?? "");
  const email = text(profile["email"]) ?? text(idClaims["email"]);
  const user = text(auth["chatgpt_user_id"]) ?? text(auth["user_id"]) ?? text(idClaims["sub"]);
  const workspace = text(tokens["account_id"]) ?? text(auth["chatgpt_account_id"]);
  if (!user && !workspace && !email) return null;
  const identity = JSON.stringify([user ?? "", workspace ?? "", email ?? ""]);
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return { id, email, plan: text(auth["chatgpt_plan_type"]), raw };
}

/** codex resume accepts an id; herdr may remember either that id or the rollout path. */
export function codexResumeTarget(pane: HerdrPane): string | null {
  const session = pane.agent_session;
  if (!session || session.agent !== "codex") return null;
  const value = session.value.trim();
  if (!value) return null;
  if (session.kind === "id") return value;
  const matches = value.match(SESSION_UUID_RE);
  return matches?.at(-1) ?? null;
}

function liveCodexHome(explicit?: string): string {
  if (explicit?.trim()) return explicit;
  if (process.env["CODEX_HOME"]?.trim()) return process.env["CODEX_HOME"]!;
  const standard = join(homedir(), ".codex");
  if (existsSync(join(standard, "auth.json"))) return standard;
  const legacy = join(homedir(), ".config", "codex");
  if (existsSync(join(legacy, "auth.json"))) return legacy;
  return standard;
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function privateWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, data, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own this */ }
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs own this */ }
}

function configuredStoreMode(codexHome: string): "file" | "keyring" | "auto" | "ephemeral" {
  const config = readText(join(codexHome, "config.toml"));
  const match = config?.match(/^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|ephemeral)["']/m);
  return (match?.[1] as "file" | "keyring" | "auto" | "ephemeral" | undefined) ?? "file";
}

function isRunningCodexPane(pane: HerdrPane): boolean {
  return pane.agent !== null && pane.agent !== undefined
    && (pane.agent === "codex" || pane.agent_session?.agent === "codex");
}

interface ResumePane {
  paneId: string;
  name: string;
  sessionId: string;
}

export interface CodexAccountRuntime {
  snapshot(): Promise<SessionSnapshot>;
  sendText(paneId: string, value: string): Promise<void>;
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  start(pane: ResumePane): Promise<void>;
  sleep(ms: number): Promise<void>;
  restartDaemon(codexHome: string): Promise<string | null>;
}

async function restartCodexDaemon(codexHome: string): Promise<string | null> {
  const binary = Bun.which("codex", { PATH: process.env["PATH"] ?? "" });
  if (!binary) return "Codex CLI was not found; existing background app-server processes may need a manual restart.";
  const env = { ...process.env, CODEX_HOME: codexHome };
  try {
    const version = Bun.spawn([binary, "app-server", "daemon", "version"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([version.exited, new Response(version.stdout).text()]);
    if (code !== 0) return null;
    let status: string | null = null;
    try { status = text(record(JSON.parse(output))["status"]); } catch { /* old output */ }
    if (status !== "running") return null;
    const restart = Bun.spawn([binary, "app-server", "daemon", "restart"], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [restartCode, stderr] = await Promise.all([restart.exited, new Response(restart.stderr).text()]);
    return restartCode === 0 ? null : "Codex account switched, but app-server restart failed: " + (stderr.trim() || ("exit " + restartCode));
  } catch (error) {
    return "Codex account switched, but app-server restart failed: " + (error instanceof Error ? error.message : String(error));
  }
}

const defaultRuntime: CodexAccountRuntime = {
  snapshot: sessionSnapshot,
  sendText: paneSendText,
  sendKeys: paneSendKeys,
  start: async (pane) => {
    await agentStart({ name: pane.name, kind: "codex", paneId: pane.paneId, args: ["resume", pane.sessionId], timeoutMs: 60_000 });
  },
  sleep: Bun.sleep,
  restartDaemon: restartCodexDaemon,
};

export class CodexAccountError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "CodexAccountError";
  }
}

export class CodexAccountService {
  readonly codexHome: string;
  readonly accountsDir: string;
  private switching = false;

  constructor(
    stateDir: string,
    codexHome?: string,
    private readonly onChanged: () => void = () => {},
    private readonly runtime: CodexAccountRuntime = defaultRuntime,
  ) {
    this.codexHome = liveCodexHome(codexHome);
    this.accountsDir = join(stateDir, "codex-accounts");
    process.env["HERDR_WEB_CODEX_ACCOUNTS_DIR"] = this.accountsDir;
  }

  private livePath(): string { return join(this.codexHome, "auth.json"); }
  private managedPath(id: string): string { return join(this.accountsDir, id, "auth.json"); }

  private currentAuth(): ParsedCodexAuth | null {
    const raw = readText(this.livePath());
    return raw === null ? null : parseCodexAuth(raw);
  }

  private storedAccounts(activeId: string | null): CodexManagedAccount[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.accountsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ACCOUNT_ID_RE.test(entry.name))
        .map((entry) => entry.name);
    } catch { return []; }
    const accounts: CodexManagedAccount[] = [];
    for (const directoryId of entries) {
      const path = this.managedPath(directoryId);
      const raw = readText(path);
      const auth = raw === null ? null : parseCodexAuth(raw);
      if (!auth || auth.id !== directoryId) continue;
      let savedAt = new Date(0).toISOString();
      try { savedAt = statSync(path).mtime.toISOString(); } catch {}
      accounts.push({ id: auth.id, email: auth.email, plan: auth.plan, active: auth.id === activeId, saved_at: savedAt });
    }
    return accounts.sort((a, b) => Number(b.active) - Number(a.active) || b.saved_at.localeCompare(a.saved_at));
  }

  state(): CodexAccountState {
    const mode = configuredStoreMode(this.codexHome);
    const current = this.currentAuth();
    const accounts = this.storedAccounts(current?.id ?? null);
    const saved = current ? accounts.some((account) => account.id === current.id) : false;
    const reason: CodexAccountState["reason"] = mode !== "file" ? "non_file_store"
      : current === null && accounts.length === 0 ? "not_signed_in"
      : current === null && existsSync(this.livePath()) ? "unsupported_auth"
      : null;
    return {
      supported: mode === "file" && reason !== "unsupported_auth",
      reason,
      current: current ? { id: current.id, email: current.email, plan: current.plan, saved } : null,
      accounts,
    };
  }

  saveCurrent(): CodexAccountState {
    if (configuredStoreMode(this.codexHome) !== "file") {
      throw new CodexAccountError("codex_non_file_store", "Codex is not using the file credential store on this PC.", 409);
    }
    const raw = readText(this.livePath());
    const auth = raw === null ? null : parseCodexAuth(raw);
    if (!auth) throw new CodexAccountError("codex_not_signed_in", "No file-backed ChatGPT Codex sign-in was found on this PC.", 409);
    privateWrite(this.managedPath(auth.id), auth.raw);
    this.onChanged();
    return this.state();
  }

  remove(id: string): CodexAccountState {
    if (!ACCOUNT_ID_RE.test(id)) throw new CodexAccountError("invalid_account", "Invalid Codex account id.");
    rmSync(join(this.accountsDir, id), { recursive: true, force: true });
    this.onChanged();
    return this.state();
  }

  async switchTo(id: string): Promise<CodexAccountSwitchResult> {
    if (this.switching) throw new CodexAccountError("codex_switch_busy", "Another Codex account switch is already running.", 409);
    if (!ACCOUNT_ID_RE.test(id)) throw new CodexAccountError("invalid_account", "Invalid Codex account id.");
    if (configuredStoreMode(this.codexHome) !== "file") {
      throw new CodexAccountError("codex_non_file_store", "Codex is not using the file credential store on this PC.", 409);
    }
    const raw = readText(this.managedPath(id));
    const target = raw === null ? null : parseCodexAuth(raw);
    if (!target || target.id !== id) throw new CodexAccountError("codex_account_missing", "That saved Codex account is no longer available.", 404);
    const current = this.currentAuth();
    if (current?.id === id) return { state: this.state(), resumed_panes: [], warnings: [] };

    this.switching = true;
    try {
      const snapshot = await this.runtime.snapshot();
      const running = snapshot.panes.filter(isRunningCodexPane);
      const busy = running.filter((pane) => pane.agent_status !== "idle" && pane.agent_status !== "done");
      if (busy.length) {
        throw new CodexAccountError(
          "codex_panes_busy",
          "Wait for the current Codex turn to finish before switching accounts (" + busy.length + " pane" + (busy.length === 1 ? "" : "s") + " still active).",
          409,
        );
      }
      const resumable: ResumePane[] = running.map((pane) => {
        const sessionId = codexResumeTarget(pane);
        if (!sessionId) throw new CodexAccountError(
          "codex_session_unknown",
          "Codex pane " + pane.pane_id + " has no resumable session id; close it before switching accounts.",
          409,
        );
        return { paneId: pane.pane_id, name: pane.agent ?? "codex", sessionId };
      });

      if (current) privateWrite(this.managedPath(current.id), current.raw);

      const stopped: ResumePane[] = [];
      try {
        await Promise.all(resumable.map(async (pane) => {
          await this.runtime.sendText(pane.paneId, "/exit");
          await this.runtime.sleep(40);
          await this.runtime.sendKeys(pane.paneId, ["Enter"]);
        }));
        const deadline = Date.now() + EXIT_TIMEOUT_MS;
        for (;;) {
          const next = await this.runtime.snapshot();
          stopped.splice(0, stopped.length, ...resumable.filter((pane) => !next.panes.some((candidate) => candidate.pane_id === pane.paneId && isRunningCodexPane(candidate))));
          if (stopped.length === resumable.length) break;
          if (Date.now() >= deadline) throw new CodexAccountError("codex_exit_timeout", "A Codex pane did not exit in time; the account was not changed.", 409);
          await this.runtime.sleep(POLL_MS);
        }
      } catch (error) {
        await Promise.allSettled(stopped.map((pane) => this.runtime.start(pane)));
        throw error;
      }

      privateWrite(this.livePath(), target.raw);
      const warnings: string[] = [];
      const daemonWarning = await this.runtime.restartDaemon(this.codexHome);
      if (daemonWarning) warnings.push(daemonWarning);

      const resumed: string[] = [];
      const results = await Promise.allSettled(resumable.map(async (pane) => {
        await this.runtime.start(pane);
        resumed.push(pane.paneId);
      }));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          warnings.push("Could not resume Codex pane " + resumable[index]!.paneId + ": " + (result.reason instanceof Error ? result.reason.message : String(result.reason)));
        }
      });
      this.onChanged();
      return { state: this.state(), resumed_panes: resumed, warnings };
    } finally {
      this.switching = false;
    }
  }
}

export async function handleCodexAccountRequest(request: Request, url: URL, service: CodexAccountService): Promise<Response> {
  try {
    if (url.pathname !== "/api/codex/accounts") return jsonResponse({ error: { code: "not_found", message: "Unknown Codex account endpoint" } }, 404);
    if (request.method === "GET") return jsonResponse(service.state());
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET or POST" } }, 405);
    const body = await request.json().catch(() => null) as { action?: unknown; account_id?: unknown } | null;
    if (!body || typeof body !== "object") throw new CodexAccountError("invalid_body", "Expected a JSON object.");
    if (body.action === "save") return jsonResponse(service.saveCurrent());
    if (body.action === "remove") {
      if (typeof body.account_id !== "string") throw new CodexAccountError("missing_account", "account_id is required.");
      return jsonResponse(service.remove(body.account_id));
    }
    if (body.action === "switch") {
      if (typeof body.account_id !== "string") throw new CodexAccountError("missing_account", "account_id is required.");
      return jsonResponse(await service.switchTo(body.account_id));
    }
    throw new CodexAccountError("invalid_action", "action must be save, switch or remove.");
  } catch (error) {
    if (error instanceof CodexAccountError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return jsonResponse({ error: { code: "codex_account_failed", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
