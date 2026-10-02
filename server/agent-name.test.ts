import { describe, expect, it } from "bun:test";

import type { SessionSnapshot } from "../shared/protocol.ts";
import { AgentNameAllocator, nextAgentName } from "./agent-name.ts";

function snapshot(names: Array<string | null>): SessionSnapshot {
  return {
    version: "test",
    protocol: 22,
    agents: names.map((name, index) => ({
      terminal_id: `term-${index}`,
      name,
      agent: "codex",
      agent_status: "idle",
      pane_id: `w${index}:p1`,
      tab_id: `w${index}:t1`,
      workspace_id: `w${index}`,
      focused: false,
      revision: 1,
    })),
    panes: [],
    tabs: [],
    workspaces: [],
    layouts: [],
  };
}

describe("agent name allocation", () => {
  it("uses the kind when it is free and numbers repeats", () => {
    expect(nextAgentName("codex", snapshot([]))).toBe("codex");
    expect(nextAgentName("codex", snapshot(["codex"]))).toBe("codex-2");
    expect(nextAgentName("codex", snapshot(["codex", "codex-2", "codex-4"]))).toBe("codex-3");
  });

  it("keeps names within Herdr's 32-character grammar", () => {
    const allocator = new AgentNameAllocator(snapshot([]));
    const first = allocator.next("123 THIS IS A VERY LONG AGENT KIND WITH SPACES");
    const second = allocator.next("123 THIS IS A VERY LONG AGENT KIND WITH SPACES");
    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(second).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(second.length).toBeLessThanOrEqual(32);
    expect(second).not.toBe(first);
  });

  it("reserves explicit names while allocating automatic ones", () => {
    const allocator = new AgentNameAllocator(snapshot(["codex"]));
    allocator.reservePreferred("codex-2");
    expect(allocator.next("codex")).toBe("codex-3");
  });
});
