import type { SessionStore } from "../agent-runtime.js";
import type { SubagentResult, SubagentSpec } from "./executor.js";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface RegisteredSubagent {
  readonly handle: string;
  readonly sessionId: string;
  readonly batchId: string;
  readonly agentId: string;
  readonly label: string;
  /** Pinned at first dispatch; resume ignores later role edits. */
  readonly spec: SubagentSpec;
  /** In-memory store kept alive for cross-Run resume in this process. */
  readonly store: SessionStore;
  status: SubagentStatus;
  result?: SubagentResult;
  /** Set when stop/steer-away requested; terminal verdict becomes stopped. */
  stopRequested?: boolean;
  /** Accumulated streaming text of the latest turn (capped). */
  partialText: string;
  readonly createdAt: number;
}

/** Process-wide subagent registry (bash.ts jobs pattern): completed handles
 *  survive their spawning Run so a later Run in the same process can resume
 *  them. The store is kept alive; the OmaSession object is run-scoped and
 *  rebuilt on revive. Never evicts a running handle. */
const MAX_HANDLES = 16;
const MAX_PARTIAL_CHARS = 4000;
const handles = new Map<string, RegisteredSubagent>();

export function registerSubagent(entry: RegisteredSubagent): void {
  handles.set(entry.handle, entry);
  while (handles.size > MAX_HANDLES) {
    let oldest: RegisteredSubagent | undefined;
    for (const e of handles.values()) {
      if (e.status === "running") continue;
      if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
    }
    if (!oldest) break; // all running: never evict
    handles.delete(oldest.handle);
  }
}

export function getSubagent(handle: string): RegisteredSubagent | undefined {
  return handles.get(handle);
}

export function updateSubagentStatus(
  handle: string,
  status: SubagentStatus,
  result?: SubagentResult,
): void {
  const e = handles.get(handle);
  if (!e) return;
  e.status = status;
  if (result) e.result = result;
}

export function appendSubagentPartial(handle: string, text: string): void {
  const e = handles.get(handle);
  if (!e) return;
  e.partialText = (e.partialText + text).slice(-MAX_PARTIAL_CHARS);
}

export function listSubagents(): Array<{
  handle: string;
  label: string;
  status: SubagentStatus;
  partialText: string;
  usage?: SubagentResult["usage"];
}> {
  return [...handles.values()].map((e) => ({
    handle: e.handle,
    label: e.label,
    status: e.status,
    partialText: e.partialText,
    ...(e.result?.usage ? { usage: e.result.usage } : {}),
  }));
}

export function clearSubagents(): void {
  handles.clear();
}
