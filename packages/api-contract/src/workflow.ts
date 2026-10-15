import { z } from "zod";

/** The marker a rework budget gate carries in its pending-human `form` (ADR
 *  0042 §2.4). The gate is not a form: its answer is
 *  `{decision: "grant" | "reject"}`, and it exists because a rework verdict
 *  asked for an attempt the budget refused. A surface that cannot read this
 *  shape must fall back to rendering nothing rather than an empty form. */
export const budgetGateSchema = z.object({
  /** The node whose budget ran out — the node the gate is about, NOT the
   *  synthetic id the pending task is keyed by (`<node>#budget`). */
  nodeId: z.string(),
  /** Whose verdict exhausted it. */
  from: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  reason: z.string(),
});

/** The decision a budget gate accepts. */
export const budgetGateDecisionSchema = z.union([z.literal("grant"), z.literal("reject")]);
