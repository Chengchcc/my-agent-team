import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Shared structured status contract (`<workspace>/.oma/agent-status.json`)
 *  published by `apps/oh-my-agent` TUI and read by `apps/backend` coding
 *  terminals. Single source of truth for schema, staleness, and PID-unique
 *  atomic writes. */

export type AgentState = "working" | "blocked" | "idle";

export interface AgentStatusFile {
  state: AgentState;
  sessionId: string;
  ts: number;
}

export const DEFAULT_AGENT_STATUS_STALE_MS = 3 * 60_000;

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
    // Unique temp filename prevents ENOENT races when multiple TUI processes
    // share the same workspace.
    const tmp = join(
      dir,
      `agent-status.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    writeFileSync(tmp, `${JSON.stringify({ state, sessionId, ts: Date.now() })}\n`);
    renameSync(tmp, agentStatusPath(workspaceRoot));
  } catch {
    // best-effort by contract — status display must never break the session
  }
}

/** Parse with staleness: a status older than `maxAgeMs` is unknown. */
export function readAgentStatus(
  workspaceRoot: string,
  maxAgeMs = DEFAULT_AGENT_STATUS_STALE_MS,
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
