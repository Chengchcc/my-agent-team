import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";

/**
 * SessionManager interface — creates/configures Agent instances.
 * Implementation lives in backend (adapter over SqliteSessionManager during migration).
 */
export interface SessionManager {
  create(config: AgentConfig): Agent;
  open(sessionId: string, config: AgentConfig): Agent;
  get(sessionId: string): Agent | undefined;
  dispose(sessionId: string): void;
}

/**
 * In-memory SessionManager for testing.
 */
export class InMemorySessionManager implements SessionManager {
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
}
