import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Consumer side of the oma TUI's structured status contract
 *  (`<worktree>/.oma/agent-status.json`, written by
 *  apps/oh-my-agent/src/modes/tui/agent-status.ts — hand-maintained wire
 *  copy, keep the three fields + staleness rule in sync). Reimplemented
 *  here because backend never imports from sibling apps. */

export type CodingAgentState = "working" | "blocked" | "idle";

export interface CodingAgentStatus {
  state: CodingAgentState;
  ts: number;
}

const STALE_MS = 3 * 60_000;

export function readAgentStatusFor(cwd: string): CodingAgentStatus | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(cwd, ".oma", "agent-status.json"), "utf8"),
    ) as Partial<CodingAgentStatus>;
    if (
      (parsed.state !== "working" && parsed.state !== "blocked" && parsed.state !== "idle") ||
      typeof parsed.ts !== "number"
    ) {
      return null;
    }
    // The writer heartbeats every 60s while working; older than that by a
    // wide margin means the writer died — show nothing rather than a lie.
    if (Date.now() - parsed.ts > STALE_MS) return null;
    return { state: parsed.state, ts: parsed.ts };
  } catch {
    return null;
  }
}
