import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";
import type { SessionManager } from "./session-manager.js";

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
