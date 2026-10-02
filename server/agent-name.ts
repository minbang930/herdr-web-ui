import type { SessionSnapshot } from "../shared/protocol.ts";

const MAX_AGENT_NAME = 32;

function normalizedBase(kind: string): string {
  let base = kind.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  if (!/^[a-z]/.test(base)) base = "agent-" + base;
  base = base.slice(0, MAX_AGENT_NAME).replace(/[-_]+$/, "");
  return base || "agent";
}

export class AgentNameAllocator {
  private readonly used: Set<string>;

  constructor(snapshot: SessionSnapshot) {
    this.used = new Set(
      snapshot.agents
        .map((agent) => agent.name?.trim())
        .filter((name): name is string => Boolean(name)),
    );
  }

  reservePreferred(name: string): string {
    this.used.add(name);
    return name;
  }

  next(kind: string): string {
    const base = normalizedBase(kind);
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    for (let index = 2; index < 100_000; index += 1) {
      const suffix = `-${index}`;
      const candidate = base.slice(0, MAX_AGENT_NAME - suffix.length).replace(/[-_]+$/, "") + suffix;
      if (this.used.has(candidate)) continue;
      this.used.add(candidate);
      return candidate;
    }
    throw new Error("could not allocate a unique Herdr agent name");
  }
}

export function nextAgentName(kind: string, snapshot: SessionSnapshot): string {
  return new AgentNameAllocator(snapshot).next(kind);
}
