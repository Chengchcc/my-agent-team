import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";

/**
 * SessionManager — owns session identity and Agent lifecycle.
 * Phase 3: in-memory implementation. Capability workstream adds persistence.
 */
export class SessionManager {
  readonly #live = new Map<string, Agent>();

  create(config: AgentConfig): Agent {
    const sessionId = config.sessionId ?? crypto.randomUUID();
    const agent = new Agent({ ...config, sessionId });
    this.#live.set(sessionId, agent);
    return agent;
  }

  open(sessionId: string, config: AgentConfig): Agent {
    const existing = this.#live.get(sessionId);
    if (existing) return existing;
    // Memory miss: create new Agent with the requested sessionId
    const agent = new Agent({ ...config, sessionId });
    this.#live.set(sessionId, agent);
    return agent;
  }

  get(sessionId: string): Agent | undefined {
    return this.#live.get(sessionId);
  }

  dispose(sessionId: string): void {
    const agent = this.#live.get(sessionId);
    if (agent) {
      agent.dispose();
      this.#live.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [id, agent] of this.#live) {
      try {
        agent.dispose();
      } catch {
        /* best-effort */
      }
      this.#live.delete(id);
    }
  }
}
