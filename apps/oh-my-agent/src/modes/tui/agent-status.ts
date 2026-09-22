import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Herdr-style pane status, structured (P2): the TUI publishes its
 *  turn-driver state to `<workspace>/.oma/agent-status.json` so a
 *  supervisor (the product backend's coding terminals) can show honest
 *  dots without screen scraping. Written on transitions + a 60s heartbeat
 *  while a run is in flight, so a reader can treat a stale file (crashed
 *  process) as "unknown" instead of a lie. Best-effort by contract: a
 *  failure here must never break the session. */

export type AgentState = "working" | "blocked" | "idle";

export interface AgentStatusFile {
  state: AgentState;
  sessionId: string;
  ts: number;
}

export function agentStatusPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "agent-status.json");
}

export function writeAgentStatus(
  workspaceRoot: string,
  state: AgentState,
  sessionId: string,
): void {
  try {
    const dir = join(workspaceRoot, ".oma");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "agent-status.json.tmp");
    writeFileSync(tmp, `${JSON.stringify({ state, sessionId, ts: Date.now() })}\n`);
    renameSync(tmp, agentStatusPath(workspaceRoot));
  } catch {
    // best-effort by contract — status display must never break the session
  }
}

/** Parse with staleness: a status older than `maxAgeMs` is unknown (the
 *  writer heartbeats every 60s while working, so this catches crashed
 *  processes whose file would otherwise say "working" forever). */
export function readAgentStatus(
  workspaceRoot: string,
  maxAgeMs = 3 * 60_000,
): AgentStatusFile | null {
  try {
    const parsed = JSON.parse(
      readFileSync(agentStatusPath(workspaceRoot), "utf8"),
    ) as Partial<AgentStatusFile>;
    if (
      (parsed.state !== "working" && parsed.state !== "blocked" && parsed.state !== "idle") ||
      typeof parsed.ts !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.ts > maxAgeMs) return null;
    return { state: parsed.state, sessionId: parsed.sessionId ?? "", ts: parsed.ts };
  } catch {
    return null;
  }
}
