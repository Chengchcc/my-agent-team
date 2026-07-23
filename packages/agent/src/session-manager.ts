import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";

/**
 * SessionManager — creates/configures Agent instances.
 * Phase 3 target: own persistence/span injection.
 * For now, simple factory around Agent constructor.
 */
export class SessionManager {
  create(config: AgentConfig): Agent {
    return new Agent(config);
  }

  open(sessionId: string, config: AgentConfig): Agent {
    return new Agent({ ...config, sessionId });
  }

  get(_sessionId: string): Agent | undefined {
    return undefined; // ponytail: wire persistence when Capability workstream begins
  }

  dispose(_sessionId: string): void {
    // ponytail: wire cleanup when Capability workstream begins
  }
}
