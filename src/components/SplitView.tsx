import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Columns2, Grid2X2, MessageSquare, Save, Square, SquareTerminal, Trash2, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { Palette, ResolvedTheme } from "../lib/settings.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import type { PaneView } from "../lib/actions.ts";
import { PANE_DRAG_MIME, type SplitLayout, type SplitPreset, type SplitSlot } from "../lib/splitView.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { PaneTerminal } from "./PaneTerminal.tsx";
import "./SplitView.css";

interface ControlsProps {
  layout: SplitLayout;
  presets: SplitPreset[];
  onLayoutChange(layout: SplitLayout): void;
  onApplyPreset(id: string): void;
  onSavePreset(name: string): void;
  onDeletePreset(id: string): void;
}

export function SplitViewControls({ layout, presets, onLayoutChange, onApplyPreset, onSavePreset, onDeletePreset }: ControlsProps) {
  const t = useT();
  const [presetId, setPresetId] = useState("");

  useEffect(() => {
    if (presetId && !presets.some((preset) => preset.id === presetId)) setPresetId("");
  }, [presetId, presets]);

  const save = (): void => {
    if (layout === "single") return;
    const current = presets.find((preset) => preset.id === presetId)?.name ?? "";
    const name = window.prompt(t("Preset name"), current || t("Split preset"));
    if (!name?.trim()) return;
    onSavePreset(name.trim());
  };

  return <div className="split-controls" aria-label={t("Split view")}>
    <div className="split-layout-switch" role="group" aria-label={t("Layout")}>
      <button type="button" className="icon-button" aria-pressed={layout === "single"} title={t("Single pane")} onClick={() => onLayoutChange("single")}><Square aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-pressed={layout === "2"} title={t("2-way split")} onClick={() => onLayoutChange("2")}><Columns2 aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-pressed={layout === "4"} title={t("4-way split")} onClick={() => onLayoutChange("4")}><Grid2X2 aria-hidden="true" /></button>
    </div>
    <select
      className="split-preset-select"
      aria-label={t("Split preset")}
      value={presetId}
      onChange={(event) => {
        const id = event.target.value;
        setPresetId(id);
        if (id) onApplyPreset(id);
      }}
    >
      <option value="">{t("Presets")}</option>
      {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select>
    <button type="button" className="icon-button split-preset-action" disabled={layout === "single"} aria-label={t("Save split preset")} title={t("Save split preset")} onClick={save}><Save aria-hidden="true" /></button>
    <button type="button" className="icon-button split-preset-action" disabled={!presetId} aria-label={t("Delete split preset")} title={t("Delete split preset")} onClick={() => { if (!presetId) return; onDeletePreset(presetId); setPresetId(""); }}><Trash2 aria-hidden="true" /></button>
  </div>;
}

interface WorkspaceProps {
  machines: Machine[];
  layout: Exclude<SplitLayout, "single">;
  slots: Array<SplitSlot | null>;
  terminalFontSize: number;
  theme: ResolvedTheme;
  palette: Palette;
  onAssign(index: number, machineId: string, paneId: string): void;
  onClear(index: number): void;
  onViewChange(index: number, view: PaneView): void;
  onActivate(machineId: string, paneId: string): void;
  onServerMessage?(message: ServerMessage): void;
  onOpenFile(machineId: string, paneId: string, path: string): void;
}

export function SplitWorkspace(props: WorkspaceProps) {
  return <main className="split-host">
    <div className="split-grid" data-layout={props.layout}>
      {props.slots.map((slot, index) => <SplitCell key={index} {...props} index={index} slot={slot} />)}
    </div>
  </main>;
}

function SplitCell({ index, slot, machines, terminalFontSize, theme, palette, onAssign, onClear, onViewChange, onActivate, onServerMessage, onOpenFile }: WorkspaceProps & { index: number; slot: SplitSlot | null }) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const [connected, setConnected] = useState(false);

  const machine = slot ? machines.find((candidate) => candidate.id === slot.machineId) ?? null : null;
  const pane = slot ? machine?.snapshot?.panes.find((candidate) => candidate.pane_id === slot.paneId) ?? null : null;
  const workspace = pane ? machine?.snapshot?.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id) ?? null : null;
  const targetHerdr = machine?.herdr;
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;
  const title = pane ? displayPaneTitle(pane) : slot?.paneId ?? t("Empty slot");
  const unavailable = slot !== null && (machine === null || machine.state !== "connected" || pane === null);

  const fileOpener = useMemo(() => {
    if (!slot) return null;
    return (path: string) => onOpenFile(slot.machineId, slot.paneId, path);
  }, [slot?.machineId, slot?.paneId, onOpenFile]);

  const drop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragOver(false);
    let payload: { machine_id?: string; pane_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData(PANE_DRAG_MIME)); } catch { return; }
    if (typeof payload.machine_id !== "string" || typeof payload.pane_id !== "string") return;
    onAssign(index, payload.machine_id, payload.pane_id);
  };

  return <section
    className={`split-cell${dragOver ? " is-drop-target" : ""}`}
    onDragEnter={(event) => {
      if (!Array.from(event.dataTransfer.types).includes(PANE_DRAG_MIME)) return;
      event.preventDefault();
      setDragOver(true);
    }}
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes(PANE_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    }}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragOver(false);
    }}
    onDrop={drop}
    onMouseDown={() => { if (slot) onActivate(slot.machineId, slot.paneId); }}
  >
    <header className="split-cell-header">
      <div className="split-cell-title">
        {pane?.agent && <AgentMark agent={pane.agent} size={18} />}
        <span className={`split-cell-connection ${connected ? "is-live" : unavailable ? "is-offline" : ""}`} aria-hidden="true" />
        <span className="split-cell-title-copy">
          <span className="split-cell-primary">{title}</span>
          <span className="split-cell-secondary">{slot ? `${machine?.name ?? slot.machineId} · ${workspace?.label ?? pane?.workspace_id ?? "unavailable"}` : t("Drag a pane from the sidebar")}</span>
        </span>
      </div>
      {slot && pane && <div className="segmented split-cell-view" role="group" aria-label={t("Pane view")}>
        <button type="button" aria-pressed={slot.view === "chat"} title={t("Chat transcript")} onClick={(event) => { event.stopPropagation(); onViewChange(index, "chat"); }}><MessageSquare aria-hidden="true" /></button>
        <button type="button" aria-pressed={slot.view === "terminal"} disabled={!terminalAttach} title={terminalAttach ? t("Live terminal") : t("Terminal unavailable")} onClick={(event) => { event.stopPropagation(); onViewChange(index, "terminal"); }}><SquareTerminal aria-hidden="true" /></button>
      </div>}
      {slot && <button type="button" className="icon-button split-cell-clear" aria-label={t("Clear split slot")} title={t("Clear split slot")} onClick={(event) => { event.stopPropagation(); onClear(index); }}><X aria-hidden="true" /></button>}
    </header>

    <div className="split-cell-body">
      {!slot && <div className="split-empty"><div className="split-empty-inner"><strong>{t("Drop a pane here")}</strong><span>{t("Drag any pane from any PC in the left sidebar.")}</span></div></div>}
      {unavailable && <div className="split-unavailable"><div className="split-empty-inner"><strong>{title}</strong><span>{machine?.state === "connected" ? t("This pane is no longer available.") : t("This PC is not connected.")}</span></div></div>}
      {slot && pane && machine && !unavailable && <MachineContext.Provider value={slot.machineId}>
        <OpenFileContext.Provider value={fileOpener}>
          <div className="terminal-host">
            <PaneTerminal
              key={`${slot.machineId}:${slot.paneId}`}
              paneId={pane.restore_error ? null : slot.paneId}
              restoreError={pane.restore_error ?? null}
              agent={pane.agent}
              agentStatus={pane.agent_status}
              view={slot.view}
              terminalFontSize={terminalFontSize}
              theme={theme}
              palette={palette}
              onConnectionChange={setConnected}
              onServerMessage={onServerMessage}
            />
          </div>
        </OpenFileContext.Provider>
      </MachineContext.Provider>}
    </div>
  </section>;
}

export function rememberSplitSlotView(slot: SplitSlot, view: PaneView): void {
  try {
    window.localStorage.setItem(`herdr-web-ui:view:${paneStorageId(slot.machineId, slot.paneId)}`, view);
  } catch {
    /* storage denied */
  }
}
