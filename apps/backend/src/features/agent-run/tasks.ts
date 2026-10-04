/** Raft #3 task cards: the input queue's semantics made user-visible.
 *  A task IS a queued input plus its run — no new execution semantics, no
 *  new tables; statuses are DERIVED so the run state machine stays the only
 *  truth. Claim = the run's agent (the branch owner); nothing to claim by
 *  hand in v1. */

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "closed";

export function deriveTaskStatus(input: {
  queueStatus: string;
  runStatus: string | null;
}): TaskStatus {
  if (input.queueStatus === "cancelled") return "closed";
  if (input.queueStatus === "pending" || input.runStatus === null) return "todo";
  switch (input.runStatus) {
    case "running":
      return "in_progress";
    case "waiting":
    case "commit_failed":
      // waiting = parked on a human; commit_failed = the outcome could not
      // be persisted — both need a person, which is what in_review means.
      return "in_review";
    case "completed":
      return "done";
    default:
      // failed / aborted / timeout
      return "closed";
  }
}

export interface TaskCard {
  inputId: string;
  runId: string | null;
  status: TaskStatus;
  /** The agent that owns (claimed) the work — the run's agent. */
  owner: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  text: string;
  createdAt: number;
}

export function taskCardOf(input: {
  queue: {
    inputId: string;
    status: string;
    runId?: string | null;
    createdAt: number;
    message: string;
  };
  run: { status: string; agentId?: string | null; conversationId?: string | null } | null;
  conversationTitle: string | null;
}): TaskCard {
  let text = "";
  try {
    const parsed = JSON.parse(input.queue.message) as { text?: unknown };
    if (typeof parsed.text === "string") text = parsed.text;
  } catch {
    // malformed payload: an empty card beats a thrown projection
  }
  return {
    inputId: input.queue.inputId,
    runId: input.queue.runId ?? null,
    status: deriveTaskStatus({
      queueStatus: input.queue.status,
      runStatus: input.run?.status ?? null,
    }),
    owner: input.run?.agentId ?? null,
    conversationId: input.run?.conversationId ?? null,
    conversationTitle: input.conversationTitle,
    text,
    createdAt: input.queue.createdAt,
  };
}
