
import type { CodexAccountImportResult, CodexImportTicket, CodexSealedAccount } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";
import type { MachineManager } from "./machines.ts";
import type { CodexAccountService } from "./codex-accounts.ts";

class CodexTransferError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "CodexTransferError";
  }
}

async function remoteAction<T>(manager: MachineManager, machineId: string, body: unknown): Promise<T> {
  const endpoint = manager.endpoint(machineId);
  if (!endpoint) throw new CodexTransferError("machine_offline", "One of the selected PCs is disconnected.", 503);
  let response: Response;
  try {
    response = await fetch(endpoint.url + "/api/codex/transfer", {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CodexTransferError("machine_unavailable", "A PC connection was interrupted during the account transfer.", 502);
  }
  if (!response.ok) {
    let code = "codex_transfer_failed";
    let message = `Codex account transfer failed (${response.status})`;
    try {
      const payload = await response.json() as { error?: { code?: unknown; message?: unknown } };
      if (typeof payload.error?.code === "string") code = payload.error.code;
      if (typeof payload.error?.message === "string") message = payload.error.message;
    } catch {}
    throw new CodexTransferError(code, message, response.status);
  }
  return response.json() as Promise<T>;
}

async function action<T>(
  manager: MachineManager,
  local: CodexAccountService,
  machineId: string,
  body: { action: string; [key: string]: unknown },
): Promise<T> {
  if (machineId !== "local") return remoteAction<T>(manager, machineId, body);
  if (body.action === "import_begin") return local.beginImport() as unknown as T;
  if (body.action === "export_sealed") return local.exportSealed(String(body.account_id ?? ""), String(body.public_key ?? "")) as unknown as T;
  if (body.action === "import_sealed") return local.importSealed(String(body.transfer_id ?? ""), body.sealed as CodexSealedAccount) as unknown as T;
  throw new CodexTransferError("invalid_action", "Unknown local Codex transfer action.");
}

/**
 * Browser-facing orchestrator. The browser names only source/target/account.
 * Raw auth never enters this process: destination creates an ephemeral X25519 key,
 * source returns AES-GCM ciphertext for that key, destination decrypts it.
 */
export async function handleCodexCrossMachineTransfer(
  request: Request,
  manager: MachineManager,
  local: CodexAccountService,
): Promise<Response> {
  try {
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
    const body = await request.json().catch(() => null) as {
      source_machine_id?: unknown;
      target_machine_id?: unknown;
      account_id?: unknown;
    } | null;
    if (!body || typeof body.source_machine_id !== "string" || typeof body.target_machine_id !== "string" || typeof body.account_id !== "string") {
      throw new CodexTransferError("invalid_body", "source_machine_id, target_machine_id and account_id are required.");
    }
    if (body.source_machine_id === body.target_machine_id) {
      throw new CodexTransferError("same_machine", "Choose a different source and destination PC.");
    }

    const ticket = await action<CodexImportTicket>(manager, local, body.target_machine_id, { action: "import_begin" });
    const sealed = await action<CodexSealedAccount>(manager, local, body.source_machine_id, {
      action: "export_sealed",
      account_id: body.account_id,
      public_key: ticket.public_key,
    });
    const result = await action<CodexAccountImportResult>(manager, local, body.target_machine_id, {
      action: "import_sealed",
      transfer_id: ticket.transfer_id,
      sealed,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof CodexTransferError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return jsonResponse({ error: { code: "codex_transfer_failed", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
