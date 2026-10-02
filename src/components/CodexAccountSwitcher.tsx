
import { useEffect, useState } from "react";
import { ArrowRightLeft, Check, Save } from "lucide-react";

import "./CodexAccountSwitcher.css";

import type { CodexAccountState } from "../../shared/protocol.ts";
import { ApiError, fetchCodexAccounts, saveCurrentCodexAccount, switchCodexAccount } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";

export interface CodexAccountSwitcherProps {
  machineId: string;
  machineName: string;
  onUsageRefresh: () => void;
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

export function CodexAccountSwitcher({ machineId, machineName, onUsageRefresh }: CodexAccountSwitcherProps) {
  const t = useT();
  const [state, setState] = useState<CodexAccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

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
              {t(pending === "save" ? "Saving…" : "Save current account")}
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
                  {t(pending === account.id ? "Switching…" : "Switch")}
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
      {error && <p className="codex-account-error" role="alert">{error}</p>}
      {warning && <p className="codex-account-warning" role="status">{warning}</p>}
    </section>
  );
}
