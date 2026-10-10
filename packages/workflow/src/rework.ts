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
