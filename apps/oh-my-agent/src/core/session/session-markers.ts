import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { sessionDir, sessionFilePath } from "./session-paths.js";

/** Append a goal-mode event: latest goal state transition for the session. */
export function appendSessionGoalEvent(
  id: string,
  state: {
    enabled: boolean;
    mode: "active" | "exiting";
    reason?: "completed";
    goal: unknown;
  } | null,
  dir: string = sessionDir(),
): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "goal",
      timestamp: new Date().toISOString(),
      goalMode: state,
    })}\n`,
  );
}

/** Append a durable goal COMPLETION record. */
export function appendSessionGoalCompletion(
  id: string,
  record: { objective: string; tokensUsed: number; tokenBudget?: number; timeUsedSeconds: number },
  dir: string = sessionDir(),
): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "goal_completed",
      timestamp: new Date().toISOString(),
      ...record,
    })}\n`,
  );
}

/** Append a plan-mode event (mode + paused flag). */
export function appendSessionPlanEvent(
  id: string,
  state: { planPath: string } | null,
  paused: boolean,
  dir: string = sessionDir(),
): void {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "plan",
      timestamp: new Date().toISOString(),
      planMode: state ? { planPath: state.planPath, paused } : null,
    })}\n`,
  );
}

/** Replay plan-mode events: latest one wins (null = plan mode off). */
export function loadSessionPlanState(
  id: string,
  dir: string = sessionDir(),
): { planPath: string; paused: boolean } | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  let latest: { planPath: string; paused: boolean } | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || !line.includes('"plan"')) continue;
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        planMode?: { planPath?: unknown; paused?: unknown } | null;
      };
      if (evt.type !== "plan") continue;
      const mode = evt.planMode;
      if (mode === null || mode === undefined || typeof mode.planPath !== "string") {
        latest = null;
        continue;
      }
      latest = { planPath: mode.planPath, paused: mode.paused === true };
    } catch {
      /* skip malformed line */
    }
  }
  return latest;
}

/** Reconstruct the current goal-mode state by replaying goal events. */
export function loadSessionGoalState(
  id: string,
  dir: string = sessionDir(),
): {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: {
    id: string;
    objective: string;
    status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
    tokenBudget?: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  };
} | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  let latest: {
    enabled: boolean;
    mode: "active" | "exiting";
    reason?: "completed";
    goal: never;
  } | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || !line.includes('"goal"')) continue;
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        goalMode?: { enabled?: boolean; mode?: string; reason?: string; goal?: unknown } | null;
      };
      if (evt.type !== "goal") continue;
      const mode = evt.goalMode;
      if (mode === null || mode === undefined || mode.goal == null) {
        latest = null;
        continue;
      }
      const g = mode.goal as Record<string, unknown>;
      if (
        typeof g.objective !== "string" ||
        typeof g.status !== "string" ||
        typeof g.id !== "string"
      ) {
        continue;
      }
      latest = {
        enabled: mode.enabled === true,
        mode: mode.mode === "exiting" ? "exiting" : "active",
        ...(mode.reason === "completed" ? { reason: "completed" as const } : {}),
        goal: g as never,
      };
    } catch {
      /* skip malformed line */
    }
  }
  return latest;
}

// ─── Parked-turn markers (ADR 0038) ──────────────────────────────────

/** Append a parked-turn marker: the assistant(tool_use) message of a turn
 *  whose tools are about to execute. */
export function appendParkedTurnMarker(
  id: string,
  message: unknown,
  dir: string = sessionDir(),
): void {
  mkdirSync(dir, { recursive: true });
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "parked_turn",
      timestamp: new Date().toISOString(),
      message,
    })}\n`,
  );
}

/** The last parked-turn marker, and whether it still represents an unresolved
 *  interrupted turn. Superseded by either paired tool_results or a later user turn. */
export function loadLastParkedTurn(
  id: string,
  dir: string = sessionDir(),
): { message: Record<string, unknown>; interrupted: boolean } | null {
  const path = sessionFilePath(id, dir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.trim()) continue;
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        message?: Record<string, unknown>;
      };
      if (evt.type !== "parked_turn" || !evt.message) continue;
      const toolUseIds = new Set(
        ((evt.message.blocks as Array<{ type?: string; id?: string }> | undefined) ?? [])
          .filter((b) => b.type === "tool_use" && typeof b.id === "string")
          .map((b) => b.id as string),
      );
      const answered = new Set<string>();
      let supersededByLaterTurn = false;
      for (const later of lines.slice(i + 1)) {
        if (!later.trim()) continue;
        try {
          const m = JSON.parse(later) as {
            type?: string;
            message?: {
              role?: string;
              blocks?: Array<{ type?: string; tool_use_id?: string }>;
            };
          };
          if (m.type !== "message") continue;
          if (m.message?.role === "user") {
            supersededByLaterTurn = true;
          }
          for (const b of m.message?.blocks ?? []) {
            if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
              answered.add(b.tool_use_id);
            }
          }
        } catch {
          /* skip malformed line */
        }
      }
      return {
        message: evt.message,
        interrupted: !supersededByLaterTurn && [...toolUseIds].some((t) => !answered.has(t)),
      };
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

/** Find the most recent interrupted session in one session directory (ADR 0038). */
export function findInterruptedSession(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files: Array<{ id: string; mtime: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -".jsonl".length);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    try {
      files.push({ id, mtime: statSync(join(dir, f)).mtimeMs });
    } catch {
      /* file vanished during scan */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { id } of files) {
    const marker = loadLastParkedTurn(id, dir);
    if (marker?.interrupted) return id;
  }
  return null;
}
