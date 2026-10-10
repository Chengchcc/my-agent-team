import { descendantsOf, evalData } from "./graph.js";
import { evalJsonLogic } from "./json-logic.js";
import type { JsonLogicRule, ReworkBudget, WorkflowDefinition } from "./types.js";

/** One granted rework (ADR 0042 §2): the source judged the target's output
 *  unusable and the budget still allows another attempt. */
export interface ReworkGrant {
  /** The node that judged the work unusable. */
  readonly from: string;
  /** The node to redo: the rework edge's target. */
  readonly to: string;
  /** 1-based attempt the target would take next. */
  readonly attempt: number;
  readonly budget: ReworkBudget;
  /** True when the next attempt would exceed `maxAttempts`: the grant is the
   *  verdict, and the caller applies `onExhausted` (fail, or a human gate that
   *  may grant the attempt anyway). */
  readonly exhausted: boolean;
  /** The target plus every node downstream of it, target first. Their recorded
   *  completions describe work this attempt replaces: history, not state. */
  readonly invalidated: readonly string[];
  /** What the source said went wrong, as text for the next attempt. */
  readonly reason: string;
}

/** The input segment a reworked node's next attempt receives (ADR 0042 §2.3). */
export interface ReworkContext {
  readonly attempt: number;
  readonly rework: { readonly from: string; readonly reason: string };
}

export interface ReworkInput {
  readonly def: WorkflowDefinition;
  /** The node that just completed. */
  readonly from: string;
  /** Its output — where the reason comes from. */
  readonly sourceOutput?: Record<string, unknown>;
  /** Recorded node-run rows per nodeId in this execution: the attempt number is
   *  "how many attempts this node has already had, plus one". */
  readonly attempts: Readonly<Record<string, number>>;
  readonly store: Record<string, unknown>;
}

/** The fields a reviewer's verdict usually lands in, in the order they should
 *  be read. The DSL has no field for "which of my outputs is the reason", so
 *  the convention is written down here rather than guessed per call site. */
const REASON_KEYS = ["reason", "feedback", "error", "message", "summary"] as const;
/** A next attempt needs enough of the verdict to act on, not a transcript. */
const REASON_MAX = 2000;

function reasonOf(output: Record<string, unknown> | undefined): string {
  if (!output) return "";
  for (const key of REASON_KEYS) {
    const value = output[key];
    if (typeof value === "string" && value.trim() !== "") return clip(value);
  }
  const json = JSON.stringify(output) ?? "";
  return clip(json === "{}" ? "" : json);
}

function clip(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

/** The rework grants a completed node's outgoing rework edges call for: empty
 *  when none declared, when the condition is false, or when the edge's kind is
 *  forward. Pure — the caller records the rows and applies the verdict. */
export function planRework(input: ReworkInput): readonly ReworkGrant[] {
  const data = evalData(input.from, input.sourceOutput, input.store);
  const grants: ReworkGrant[] = [];
  for (const edge of input.def.edges) {
    if (edge.kind !== "rework" || edge.from !== input.from) continue;
    if (edge.budget === undefined) continue; // parse rejects this; never guess a budget
    if (edge.when !== undefined && !evalJsonLogic(edge.when as JsonLogicRule, data)) continue;
    const attempt = (input.attempts[edge.to] ?? 0) + 1;
    grants.push({
      from: edge.from,
      to: edge.to,
      attempt,
      budget: edge.budget,
      exhausted: attempt > edge.budget.maxAttempts,
      invalidated: [edge.to, ...descendantsOf(input.def, edge.to)],
      reason: reasonOf(input.sourceOutput),
    });
  }
  return grants;
}

/** The input segment for a reworked node's next attempt. */
export function reworkInputOf(grant: ReworkGrant): ReworkContext {
  return { attempt: grant.attempt, rework: { from: grant.from, reason: grant.reason } };
}

/** The bits of a recorded node run the derivation needs. */
export interface ReworkRow {
  readonly nodeId: string;
  /** `running` | `waiting_human` | `completed` | `failed` | `superseded`. */
  readonly status: string;
  readonly output?: Record<string, unknown> | null;
}

/** The marker a budget gate leaves in a row's output, both while it waits
 *  (`decision` absent) and after a human decided it. */
export interface BudgetGateRecord {
  /** The node whose budget ran out. */
  readonly nodeId: string;
  /** Whose verdict exhausted it. */
  readonly from: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
}

/** A budget gate is not the reworked node's own run: it is a separate waiting
 *  row, so it gets a separate id (the pending-human store keys on
 *  execution+node, and the target's attempt count must not see the gate). */
export function budgetGateNodeId(nodeId: string): string {
  return `${nodeId}#budget`;
}

export function budgetGateOf(output: Record<string, unknown> | null | undefined): BudgetGateRecord | undefined {
  const gate = output?.budgetGate;
  if (typeof gate !== "object" || gate === null) return undefined;
  const record = gate as Record<string, unknown>;
  if (
    typeof record.nodeId !== "string" ||
    typeof record.from !== "string" ||
    typeof record.attempt !== "number" ||
    typeof record.maxAttempts !== "number" ||
    typeof record.reason !== "string"
  ) {
    return undefined;
  }
  return {
    nodeId: record.nodeId,
    from: record.from,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    reason: record.reason,
  };
}

export interface DerivedRework {
  /** Nodes whose latest row a rework invalidated: the retry replaces them. */
  readonly invalidated: ReadonlySet<string>;
  /** Verdicts the execution may still act on. */
  readonly grants: readonly ReworkGrant[];
  /** Verdicts whose budget is spent: the caller applies `onExhausted`. */
  readonly exhausted: readonly ReworkGrant[];
}

/** A rework, derived from the recorded rows instead of remembered in memory.
 *
 *  A verdict was used exactly when its source row is `superseded` — that is
 *  what applying a rework does to the rows it replaces. So "the source is
 *  superseded and so is the target's latest row" means a retry is owed, and it
 *  stays true across a restart, a crash or a second process: the rows are the
 *  only state there is. A row that never existed (the target never ran) owes
 *  nothing, and a target that already re-ran has a fresh non-superseded row. */
export function deriveRework(def: WorkflowDefinition, rows: readonly ReworkRow[]): DerivedRework {
  const latest = new Map<string, ReworkRow>();
  const count = new Map<string, number>();
  for (const row of rows) {
    count.set(row.nodeId, (count.get(row.nodeId) ?? 0) + 1);
    latest.set(row.nodeId, row);
  }
  const invalidated = new Set<string>();
  for (const [nodeId, row] of latest) {
    if (row.status === "superseded") invalidated.add(nodeId);
  }
  // A human may grant an attempt the budget did not: each granted gate row is
  // one more attempt the target is allowed (ADR 0042 §2.4).
  const grantedByHuman = new Map<string, number>();
  for (const row of rows) {
    const gate = budgetGateOf(row.output);
    if (gate && row.output?.decision === "grant") {
      grantedByHuman.set(gate.nodeId, (grantedByHuman.get(gate.nodeId) ?? 0) + 1);
    }
  }
  const grants: ReworkGrant[] = [];
  const exhausted: ReworkGrant[] = [];
  for (const edge of def.edges) {
    if (edge.kind !== "rework" || edge.budget === undefined) continue;
    const from = latest.get(edge.from);
    const to = latest.get(edge.to);
    if (from?.status !== "superseded" || to?.status !== "superseded" || edge.to === edge.from) {
      continue;
    }
    const granted = grantedByHuman.get(edge.to) ?? 0;
    const attempt = (count.get(edge.to) ?? 0) + 1;
    const grant: ReworkGrant = {
      from: edge.from,
      to: edge.to,
      attempt,
      budget: edge.budget,
      exhausted: attempt > edge.budget.maxAttempts + granted,
      invalidated: [edge.to, ...descendantsOf(def, edge.to)],
      reason: reasonOf(from.output ?? undefined),
    };
    (grant.exhausted ? exhausted : grants).push(grant);
  }
  return { invalidated, grants, exhausted };
}
