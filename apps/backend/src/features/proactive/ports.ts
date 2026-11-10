import type { ProactiveEvent } from "./domain.js";

/** Storage boundary for the proactive event ledger. */
export interface ProactiveEventPort {
  insertEvent(event: ProactiveEvent): void;
  /** Newest first. */
  listEvents(filter: { agentId?: string; limit: number }): ProactiveEvent[];
}
