
import { useEffect, useState } from "react";
import { ArrowRightLeft, Check, Download, Save } from "lucide-react";

import "./CodexAccountSwitcher.css";

import type { Machine } from "../../shared/machines.ts";
import type { CodexAccountState } from "../../shared/protocol.ts";
import { ApiError, copyCodexAccountBetweenMachines, fetchCodexAccounts, saveCurrentCodexAccount, switchCodexAccount } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";

export interface CodexAccountSwitcherProps {
  machineId: string;
  machineName: string;
  machines: readonly Machine[];
  onUsageRefresh: () => void;
}

interface ImportCandidate {
  machineId: string;
  machineName: string;
  accountId: string;
  email: string | null;
  plan: string | null;
}

function accountLabel(email: string | null, plan: string | null): string {
  if (email && plan) return email + " · " + plan;
  return email ?? plan ?? "Codex account";
}

function unavailableText(t: Translate, reason: CodexAccountState["reason"]): string {
  if (reason === "non_file_store") return t("One-click switching requires Codex's file credential store on this PC.");
  if (reason === "unsupported_auth") return t("The current Codex auth file is not a ChatGPT sign-in.");
  return t("Sign in to Codex on this PC once, then save the current account here.");
}

export function CodexAccountSwitcher({ machineId, machineName, machines, onUsageRefresh }: CodexAccountSwitcherProps) {
  const t = useT();
  const [state, setState] = useState<CodexAccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [importsOpen, setImportsOpen] = useState(false);
  const [importsLoading, setImportsLoading] = useState(false);
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      setState(await fetchCodexAccounts(machineId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [machineId]);

  const loadImportCandidates = async (): Promise<void> => {
    setImportsLoading(true);
    setError(null);
    try {
      const sources = machines.filter((machine) => machine.id !== machineId && machine.state === "connected");
      const settled = await Promise.allSettled(sources.map(async (machine) => ({ machine, state: await fetchCodexAccounts(machine.id) })));
      const existing = new Set([
        ...(state?.accounts.map((account) => account.id) ?? []),
        ...(state?.current ? [state.current.id] : []),
      ]);
      const candidates: ImportCandidate[] = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const { machine, state: source } = result.value;
        const seen = new Set<string>();
        if (source.current) {
          seen.add(source.current.id);
          if (!existing.has(source.current.id)) candidates.push({
            machineId: machine.id, machineName: machine.name, accountId: source.current.id,
            email: source.current.email, plan: source.current.plan,
          });
        }
        for (const account of source.accounts) {
          if (seen.has(account.id) || existing.has(account.id)) continue;
          seen.add(account.id);
          candidates.push({
            machineId: machine.id, machineName: machine.name, accountId: account.id,
            email: account.email, plan: account.plan,
          });
        }
      }
      setImportCandidates(candidates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportsLoading(false);
    }
  };

  const toggleImports = (): void => {
    const next = !importsOpen;
    setImportsOpen(next);
    if (next) void loadImportCandidates();
  };

  const importFrom = async (candidate: ImportCandidate): Promise<void> => {
    const key = "import:" + candidate.machineId + ":" + candidate.accountId;
    setPending(key);
    setError(null);
    setWarning(null);
    try {
      const result = await copyCodexAccountBetweenMachines(candidate.machineId, machineId, candidate.accountId);
      setState(result.state);
      setImportCandidates((current) => current.filter((item) => item.accountId !== result.imported_account_id));
      onUsageRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  };

  const save = async (): Promise<void> => {
    setPending("save");
    setError(null);
    setWarning(null);
    try {
      setState(await saveCurrentCodexAccount(machineId));
      onUsageRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  };

  const switchTo = async (id: string): Promise<void> => {
    setPending(id);
    setError(null);
    setWarning(null);
    try {
      const result = await switchCodexAccount(id, machineId);
      setState(result.state);
      if (result.warnings.length) setWarning(result.warnings.join(" "));
      onUsageRefresh();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "codex_panes_busy") {
        setError(t("Wait for the current Codex response to finish, then switch again."));
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setPending(null);
    }
  };

  if (loading && state === null) {
    return <section className="codex-account-switcher"><span className="codex-account-note">{t("Loading Codex accounts…")}</span></section>;
  }
  if (state === null) return <section className="codex-account-switcher"><span className="codex-account-error">{error ?? t("Codex accounts unavailable")}</span></section>;

  return (
    <section className="codex-account-switcher" aria-label={t("Codex accounts") + " · " + machineName}>
      <header className="codex-account-head">
        <span>{t("Codex accounts")}</span>
        <span className="usage-machine">{machineName}</span>
      </header>

      {state.current && (
        <div className="codex-current">
          <span className="codex-account-label">{accountLabel(state.current.email, state.current.plan)}</span>
          <span className="codex-active"><Check aria-hidden="true" />{t("Active")}</span>
          {!state.current.saved && state.supported && (
            <button type="button" className="btn btn-small" disabled={pending !== null} onClick={() => void save()}>
              <Save aria-hidden="true" />
              {pending === "save" ? t("Saving…") : t("Save current account")}
            </button>
          )}
        </div>
      )}

      {state.accounts.length > 0 && (
        <div className="codex-account-list">
          {state.accounts.map((account) => (
            <div key={account.id} className={"codex-account-row" + (account.active ? " is-active" : "")}>
              <span className="codex-account-label">{accountLabel(account.email, account.plan)}</span>
              {account.active ? (
                <span className="codex-active"><Check aria-hidden="true" />{t("Active")}</span>
              ) : (
                <button type="button" className="btn btn-small" disabled={pending !== null || !state.supported} onClick={() => void switchTo(account.id)}>
                  <ArrowRightLeft aria-hidden="true" />
                  {pending === account.id ? t("Switching…") : t("Switch")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!state.supported && <p className="codex-account-note">{unavailableText(t, state.reason)}</p>}
      {state.supported && state.accounts.length < 2 && (
        <p className="codex-account-note">{t("Save each Codex account once. After that, switching does not require browser login.")}</p>
      )}
      {state.supported && machines.some((machine) => machine.id !== machineId && machine.state === "connected") && (
        <div className="codex-import">
          <button type="button" className="btn btn-small" disabled={pending !== null} aria-expanded={importsOpen} onClick={toggleImports}>
            <Download aria-hidden="true" />
            {t("Import from another PC")}
          </button>
          {importsOpen && (
            <div className="codex-import-list">
              {importsLoading && <span className="codex-account-note">{t("Looking for Codex accounts on other PCs…")}</span>}
              {!importsLoading && importCandidates.length === 0 && (
                <span className="codex-account-note">{t("No new Codex accounts found on connected PCs.")}</span>
              )}
              {!importsLoading && importCandidates.map((candidate) => {
                const key = "import:" + candidate.machineId + ":" + candidate.accountId;
                return (
                  <div key={candidate.machineId + ":" + candidate.accountId} className="codex-import-row">
                    <span className="codex-import-source">{candidate.machineName}</span>
                    <span className="codex-account-label">{accountLabel(candidate.email, candidate.plan)}</span>
                    <button type="button" className="btn btn-small" disabled={pending !== null} onClick={() => void importFrom(candidate)}>
                      <Download aria-hidden="true" />
                      {pending === key ? t("Importing…") : t("Import")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {error && <p className="codex-account-error" role="alert">{error}</p>}
      {warning && <p className="codex-account-warning" role="status">{warning}</p>}
    </section>
  );
}
