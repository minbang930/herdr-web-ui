import { describe, expect, it } from "bun:test";

import { normalizeSplitState, resizeSplitState } from "./splitView.ts";

describe("split view state", () => {
  it("normalizes layouts to the right slot count", () => {
    expect(normalizeSplitState({ layout: "2", slots: [] })).toEqual({ layout: "2", slots: [null, null] });
    expect(normalizeSplitState({ layout: "4", slots: [] })).toEqual({ layout: "4", slots: [null, null, null, null] });
    expect(normalizeSplitState({ layout: "wat", slots: [] })).toEqual({ layout: "single", slots: [null] });
  });

  it("keeps valid targets and drops malformed ones", () => {
    const state = normalizeSplitState({
      layout: "2",
      slots: [
        { machineId: "main", paneId: "pane-1", view: "chat" },
        { machineId: "vm", paneId: 123, view: "terminal" },
      ],
    });
    expect(state).toEqual({
      layout: "2",
      slots: [
        { machineId: "main", paneId: "pane-1", view: "chat" },
        null,
      ],
    });
  });

  it("preserves existing assignments while growing a layout", () => {
    const state = normalizeSplitState({
      layout: "2",
      slots: [
        { machineId: "main", paneId: "codex", view: "terminal" },
        { machineId: "vm", paneId: "claude", view: "chat" },
      ],
    });
    expect(resizeSplitState(state, "4")).toEqual({
      layout: "4",
      slots: [
        { machineId: "main", paneId: "codex", view: "terminal" },
        { machineId: "vm", paneId: "claude", view: "chat" },
        null,
        null,
      ],
    });
  });
});
