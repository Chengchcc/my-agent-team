/** The authority ledger's rows (ADR 0046/0047/0051), derived from agent runs.
 *
 *  Pure: the page supplies the run rows it loaded, this decides what each row
 *  says. Nothing here approves, grants or changes anything — the ledger is a
 *  record of what already happened, read off `agent_run.authorization` and
 *  `parent_run_id`. */

/** Where a run's authority came from, in the three words the ledger filters by.
 *  - `owner`: allowed by configuration the workspace owner set up — a standing
 *    rule, the assessment gate, or the system clock.
 *  - `human`: a person typed or spoke.
 *  - `dispatch`: a front agent dispatched it.
 *  `handback` and `unrecorded` are real states too; they have no filter of
 *  their own and show under "all". */
export type LedgerSource = "owner" | "human" | "dispatch" | "handback" | "unrecorded";

/** The fields of an agent run the ledger reads (a subset of the list row). */
export interface LedgerRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: number;
  /** The basis the run was started under, frozen at start. Null for runs that
   *  predate the column. */
  readonly authorization: string | null;
  readonly parentRunId: string | null;
}

/** One link of a source chain: a run and the basis it was started under. */
export interface LedgerStep {
  readonly runId: string;
  readonly agentId: string;
  /** The basis as stored (`user`, `ambient:<rule>`, `dispatch:<runId>`, ...). */
  readonly basis: string;
  readonly source: LedgerSource;
  /** The standing rule's id, or `assessment` for the assessment gate. */
  readonly ruleId: string | null;
}

export interface LedgerRow {
  readonly runId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly status: string;
  readonly createdAt: number;
  readonly source: LedgerSource;
  readonly basis: string;
  readonly ruleId: string | null;
  /** run → parent run → … The first step is the run itself; the last is the
   *  root, whose own basis is what started the whole chain. */
  readonly chain: readonly LedgerStep[];
  /** A parent run is outside the loaded rows (or the chain loops), so the
   *  walk stopped before the root. */
  readonly chainBroken: boolean;
  /** For a handback: the run whose work the worker returned. */
  readonly refusedRunId: string | null;
}

const DISPATCH = "dispatch:";
const HANDBACK = "handback:";
const AMBIENT = "ambient:";
/** The backend's wake guard refuses a chain past a few hops (ADR 0060 D3); a
 *  row that names a longer (or circular) chain is folded here, not walked. */
const MAX_HOPS = 16;

export function classifyAuthorization(authorization: string | null): {
  source: LedgerSource;
  ruleId: string | null;
  /** The id inside `dispatch:` / `handback:`, if any. */
  refId: string | null;
} {
  if (authorization === null || authorization === "") {
    return { source: "unrecorded", ruleId: null, refId: null };
  }
  if (authorization === "user") return { source: "human", ruleId: null, refId: null };
  if (authorization === "system") return { source: "owner", ruleId: null, refId: null };
  if (authorization === `${AMBIENT}assessment`) {
    return { source: "owner", ruleId: "assessment", refId: null };
  }
  if (authorization.startsWith(AMBIENT)) {
    return { source: "owner", ruleId: authorization.slice(AMBIENT.length), refId: null };
  }
  if (authorization.startsWith(DISPATCH)) {
    return { source: "dispatch", ruleId: null, refId: authorization.slice(DISPATCH.length) };
  }
  if (authorization.startsWith(HANDBACK)) {
    return { source: "handback", ruleId: null, refId: authorization.slice(HANDBACK.length) };
  }
  return { source: "unrecorded", ruleId: null, refId: null };
}

function chainOf(
  run: LedgerRun,
  byId: ReadonlyMap<string, LedgerRun>,
): { chain: LedgerStep[]; chainBroken: boolean } {
  const chain: LedgerStep[] = [];
  const seen = new Set<string>();
  let current: LedgerRun | undefined = run;
  let chainBroken = false;
  // Walk up one stored hop at a time until no parent is named. A dispatch
  // names its parent twice (the column and the basis); the basis is the
  // fallback when the column is empty. A handback's id is the run refused,
  // not a parent, so it is never followed.
  while (current !== undefined) {
    seen.add(current.runId);
    const basis = classifyAuthorization(current.authorization);
    chain.push({
      runId: current.runId,
      agentId: current.agentId,
      basis: current.authorization ?? "",
      source: basis.source,
      ruleId: basis.ruleId,
    });
    let parentId = current.parentRunId;
    if (parentId === null && basis.source === "dispatch") parentId = basis.refId;
    if (parentId === null) break;
    if (seen.has(parentId) || chain.length >= MAX_HOPS) {
      // A parent is named but cannot be followed: a cycle or the hop cap.
      chainBroken = true;
      break;
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      // The parent is older than the rows the page loaded.
      chainBroken = true;
      break;
    }
    current = parent;
  }
  return { chain, chainBroken };
}

export function deriveLedgerRows(runs: readonly LedgerRun[]): LedgerRow[] {
  const byId = new Map<string, LedgerRun>();
  for (const run of runs) byId.set(run.runId, run);

  const rows: LedgerRow[] = [];
  for (const run of runs) {
    const classified = classifyAuthorization(run.authorization);
    const { chain, chainBroken } = chainOf(run, byId);
    rows.push({
      runId: run.runId,
      agentId: run.agentId,
      conversationId: run.conversationId,
      status: run.status,
      createdAt: run.createdAt,
      source: classified.source,
      basis: run.authorization ?? "",
      ruleId: classified.ruleId,
      chain,
      chainBroken,
      refusedRunId: classified.refId,
    });
  }
  return rows;
}

/** How many rows each filter shows. The page's tab counts come from here. */
export function countLedgerSources(rows: readonly LedgerRow[]): Record<LedgerSource, number> {
  const counts: Record<LedgerSource, number> = {
    owner: 0,
    human: 0,
    dispatch: 0,
    handback: 0,
    unrecorded: 0,
  };
  for (const row of rows) counts[row.source] += 1;
  return counts;
}
