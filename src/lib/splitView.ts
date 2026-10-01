import type { PaneView } from "./actions.ts";

export type SplitLayout = "single" | "2" | "4";

export interface SplitSlot {
  machineId: string;
  paneId: string;
  view: PaneView;
}

export interface SplitState {
  layout: SplitLayout;
  slots: Array<SplitSlot | null>;
}

export interface SplitPreset {
  id: string;
  name: string;
  layout: SplitLayout;
  slots: Array<SplitSlot | null>;
}

export const PANE_DRAG_MIME = "application/x-herdr-pane";

const STATE_KEY = "herdr-web-ui:split-state:v1";
const PRESETS_KEY = "herdr-web-ui:split-presets:v1";

export function splitSlotCount(layout: SplitLayout): number {
  if (layout === "4") return 4;
  if (layout === "2") return 2;
  return 1;
}

function validSlot(value: unknown): value is SplitSlot {
  if (value === null || typeof value !== "object") return false;
  const slot = value as Partial<SplitSlot>;
  return typeof slot.machineId === "string"
    && typeof slot.paneId === "string"
    && (slot.view === "chat" || slot.view === "terminal");
}

export function normalizeSplitState(value: unknown): SplitState {
  if (value === null || typeof value !== "object") return { layout: "single", slots: [null] };
  const candidate = value as Partial<SplitState>;
  const layout: SplitLayout = candidate.layout === "2" || candidate.layout === "4" || candidate.layout === "single"
    ? candidate.layout
    : "single";
  const count = splitSlotCount(layout);
  const raw = Array.isArray(candidate.slots) ? candidate.slots : [];
  const slots = Array.from({ length: count }, (_, index) => validSlot(raw[index]) ? raw[index] : null);
  return { layout, slots };
}

export function resizeSplitState(state: SplitState, layout: SplitLayout): SplitState {
  const count = splitSlotCount(layout);
  const slots = Array.from({ length: count }, (_, index) => state.slots[index] ?? null);
  return { layout, slots };
}

export function readSplitState(): SplitState {
  try {
    return normalizeSplitState(JSON.parse(window.localStorage.getItem(STATE_KEY) ?? "null"));
  } catch {
    return { layout: "single", slots: [null] };
  }
}

export function writeSplitState(state: SplitState): void {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(normalizeSplitState(state)));
  } catch {
    /* private mode: split state is session-only */
  }
}

function validPreset(value: unknown): value is SplitPreset {
  if (value === null || typeof value !== "object") return false;
  const preset = value as Partial<SplitPreset>;
  return typeof preset.id === "string"
    && typeof preset.name === "string"
    && (preset.layout === "single" || preset.layout === "2" || preset.layout === "4")
    && Array.isArray(preset.slots);
}

export function readSplitPresets(): SplitPreset[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PRESETS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(validPreset).map((preset) => {
      const normalized = normalizeSplitState({ layout: preset.layout, slots: preset.slots });
      return { id: preset.id, name: preset.name, ...normalized };
    });
  } catch {
    return [];
  }
}

export function writeSplitPresets(presets: SplitPreset[]): void {
  try {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* private mode: presets are session-only */
  }
}

export function newPresetId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
