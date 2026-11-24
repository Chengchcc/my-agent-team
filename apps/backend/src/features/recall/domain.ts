/** ADR 0058: one recall vocabulary for memory, skills and agents.
 *
 *  Before this, three code paths answered "which of these do I know about?"
 *  with three different shapes: `collectRecall` (history + Q&A), `recallWorkers`
 *  (capability cards), and the run-side memory/skill tools. Fixing recall
 *  quality meant knowing which of the three you were fixing.
 *
 *  This module does not move code between processes — memory and skills live
 *  inside the run's child, and the backend cannot reach them. What it does is
 *  make the vocabulary shared and the gaps explicit: a source that was not
 *  searched appears in `skipped` with a reason, instead of looking like a
 *  source that had nothing. */

/** Where a hit came from. `memory` and `skill` are resolved in the child; the
 *  backend reports them as skipped rather than silently omitting them. */
export type RecallSource =
  | "history"
  | "qa"
  | "capability"
  | "memory"
  | "skill"
  /** ADR 0080: a requirement is a work item the PA wrote down — recalled the
   *  same way memory is, so a new turn can see that this work already exists. */
  | "requirement";

export interface RecallHit {
  readonly source: RecallSource;
  /** A pointer a human or the model can cite back: `seq:412`, `action:01J…`,
   *  `agent:fe`. */
  readonly ref: string;
  /** Epoch ms; 0 when the source has no notion of time. */
  readonly at: number;
  readonly text: string;
  /** Why it surfaced — the cue, the pinned reason, or the scoring component. */
  readonly why: string;
  /** Ranking signal where the source has one (capability recall does). */
  readonly score?: number;
  /** Source-specific payload. Capability hits carry the agent they describe. */
  readonly meta?: { readonly agentId?: string };
}

export interface RecallResult {
  readonly hits: readonly RecallHit[];
  /** What was actually looked at, including sources that found nothing. That
   *  is the difference between "there is nothing" and "nobody looked". */
  readonly searched: ReadonlyArray<{ source: RecallSource; hits: number; detail?: string }>;
  /** Sources the caller asked for that this process cannot answer, with the
   *  reason. Never silent. */
  readonly skipped: ReadonlyArray<{ source: RecallSource; reason: string }>;
}

/** The brief as a query: what to look for, not who. */
export interface RecallBrief {
  readonly verb?: string;
  readonly deliverable?: string;
  readonly object?: string;
  readonly objectKind?: string;
  readonly capability?: string;
  readonly terms?: readonly string[];
}

export interface RecallRequest {
  readonly sources: readonly RecallSource[];
  /** Scopes history and Q&A; required for both. */
  readonly conversationId?: string;
  /** The human's words, used for cues and history search. */
  readonly text?: string;
  /** The facets, used for capability recall. */
  readonly brief?: RecallBrief;
  /** Per-source cap; the total is capped again by the caller. */
  readonly limit?: number;
}
