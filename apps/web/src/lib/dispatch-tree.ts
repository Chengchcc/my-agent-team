/** ADR 0060 D3: the execution side of one dispatched request.
 *
 *  The tree is DERIVED from `parent_run_id` — nothing is stored for it. This
 *  file holds the derivation only; rendering lives in the component, so the
 *  grouping is testable without a query client. */

export interface DispatchRunRow {
  readonly runId: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: number;
  readonly parentRunId: string | null;
  readonly verdict?: "pass" | "fail" | "unknown" | null;
  /** The tracked work this run advances, when it has one. */
  readonly goal?: string | null;
}

export interface DispatchNode {
  readonly runId: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: number;
  readonly verdict?: "pass" | "fail" | "unknown" | null;
  readonly goal?: string | null;
  readonly children: readonly DispatchNode[];
}

/** Depth cap: a chain past this is folded, not painted. The backend's wake
 *  guard uses the same number (ADR 0060 D3), so the UI cannot promise a chain
 *  the mechanism refuses to extend. */
export const MAX_DISPATCH_DEPTH = 3;

/** Children of `parentRunId`, each with its own children. `seen` guards a
 *  malformed row that names itself as its parent — a tree that cannot render
 *  must not loop. */
export function buildDispatchTree(
  runs: readonly DispatchRunRow[],
  parentRunId: string,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): DispatchNode[] {
  if (depth >= MAX_DISPATCH_DEPTH) return [];
  return runs
    .filter((r) => r.parentRunId === parentRunId && r.runId !== parentRunId && !seen.has(r.runId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      runId: r.runId,
      agentId: r.agentId,
      status: r.status,
      createdAt: r.createdAt,
      verdict: r.verdict ?? null,
      goal: r.goal ?? null,
      children: buildDispatchTree(runs, r.runId, depth + 1, new Set([...seen, r.runId])),
    }));
}
