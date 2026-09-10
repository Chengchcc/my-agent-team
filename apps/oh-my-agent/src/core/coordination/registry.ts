import type { SessionStore } from "../agent-runtime.js";
import type { SubagentResult, SubagentSpec } from "../delegation/executor.js";

export type EntryStatus = "running" | "completed" | "failed" | "stopped";
export type EntryKind = "bash" | "eval" | "subagent";

export interface RegistryEntry {
  readonly id: string;
  readonly kind: EntryKind;
  readonly scope: string;
  readonly label: string;
  readonly startedAt: number;
  status: EntryStatus;
  finishedAt: number | null;
  partialText: string;
  settle?: Promise<void>;
  output?: string;
  exitCode?: number | null;
  killed?: boolean;
  timedOut?: boolean;
  isError?: boolean;
  kill?: () => void;
  result?: SubagentResult;
  spec?: SubagentSpec;
  store?: SessionStore;
  sessionId?: string;
  batchId?: string;
  agentId?: string;
  stopRequested?: boolean;
}

export interface EntryRow {
  id: string;
  kind: EntryKind;
  status: EntryStatus;
  label: string;
  partialText: string;
  exitCode?: number | null;
  isError?: boolean;
}

const RUNNING_CAP = 32;
const NON_RUNNING_CAP = 64;
const TTL_MS = 5 * 60 * 1000;
const MAX_PARTIAL_CHARS = 4000;

const entries = new Map<string, RegistryEntry>();
let completionListener: ((entry: RegistryEntry) => void) | null = null;

function prune(): void {
  const now = Date.now();
  for (const [id, e] of entries) {
    if (e.status !== "running" && e.finishedAt !== null && now - e.finishedAt > TTL_MS) {
      entries.delete(id);
    }
  }
  const nonRunning = [...entries.values()]
    .filter((e) => e.status !== "running")
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (nonRunning.length > NON_RUNNING_CAP) {
    entries.delete(nonRunning.shift()!.id);
  }
}

export function registerEntry(entry: RegistryEntry): { ok: true } | { ok: false; error: string } {
  if (entry.kind !== "subagent") {
    const running = [...entries.values()].filter(
      (e) => e.kind !== "subagent" && e.status === "running",
    ).length;
    if (running >= RUNNING_CAP) {
      return { ok: false, error: `too many running jobs (${running}/${RUNNING_CAP})` };
    }
  }
  entries.set(entry.id, entry);
  prune();
  return { ok: true };
}

export function getEntry(id: string): RegistryEntry | undefined {
  return entries.get(id);
}

export function updateEntry(id: string, patch: Partial<RegistryEntry>): void {
  const e = entries.get(id);
  if (e) Object.assign(e, patch);
}

export function appendEntryPartial(id: string, text: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.partialText = (e.partialText + text).slice(-MAX_PARTIAL_CHARS);
}

function row(e: RegistryEntry): EntryRow {
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    label: e.label,
    partialText: e.partialText,
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.isError !== undefined ? { isError: e.isError } : {}),
  };
}

export function listEntries(scope: string): EntryRow[] {
  return [...entries.values()].filter((e) => e.scope === scope).map(row);
}

export function countRunningJobs(): number {
  let n = 0;
  for (const e of entries.values()) if (e.status === "running") n++;
  return n;
}

export async function waitEntries(opts: {
  ids?: readonly string[];
  scope: string;
  timeoutMs: number;
}): Promise<{ settled: EntryRow[]; timedOut: boolean }> {
  const watched = [...entries.values()].filter(
    (e) => e.scope === opts.scope && (!opts.ids || opts.ids.includes(e.id)),
  );
  if (watched.length === 0) return { settled: [], timedOut: false };
  const running = watched.filter((e) => e.status === "running" && e.settle);
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : null;
  const timer: Promise<"timeout"> = deadline
    ? new Promise((resolve) => setTimeout(() => resolve("timeout"), deadline - Date.now()))
    : new Promise(() => {});
  if (running.length > 0) {
    // pi hub wait semantics: the FIRST settle resolves the wait; the result
    // is a snapshot split into settled vs still-running rows.
    await Promise.race([Promise.race(running.map((e) => e.settle!)), timer]);
  } else if (deadline) {
    await timer;
  }
  const settled = watched.filter((e) => e.status !== "running").map(row);
  return { settled, timedOut: settled.length === 0 };
}

export function stopEntry(id: string): { ok: boolean; error?: string } {
  const e = entries.get(id);
  if (!e) return { ok: false, error: `unknown id "${id}"` };
  if (e.kind === "subagent") {
    e.stopRequested = true;
    return { ok: true };
  }
  if (e.status !== "running") return { ok: true };
  try {
    e.kill?.();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

export function setEntryCompletionListener(cb: ((entry: RegistryEntry) => void) | null): void {
  completionListener = cb;
}

export function notifyEntryCompletion(entry: RegistryEntry): void {
  if (!completionListener) return;
  try {
    completionListener(entry);
  } catch {
    /* a broken UI listener never breaks the job */
  }
}

export function clearScope(scope: string): void {
  for (const [id, e] of entries) if (e.scope === scope) entries.delete(id);
}

export function clearAll(): void {
  entries.clear();
}
