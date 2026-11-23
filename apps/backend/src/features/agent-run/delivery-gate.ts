/** ADR 0072/0076: the delivery gate.
 *
 *  A person decides whether to merge; "it is done" must not be the producing
 *  agent's own word — and not the front desk's either, since the front desk is
 *  a model. This module turns ledger facts into one line: was a change produced
 *  in this room, and did a DIFFERENT agent later look at it without changing
 *  anything?
 *
 *  Deliberately conservative in one direction only: it can say "unverified"
 *  about work that was in fact checked by a human, and that costs a line of
 *  text. The opposite error (calling unverified work verified) is what this
 *  exists to prevent.
 */

export interface DeliveryGateRun {
  readonly runId: string;
  readonly agentId: string | null;
  readonly parentRunId: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly status: string;
}

export interface DeliveryGateInput {
  /** The delivering (front desk) run. */
  readonly selfAgentId: string;
  /** Recent runs of the conversation, any dispatcher. */
  readonly runs: readonly DeliveryGateRun[];
  /** Did this run use a tool that changes the workspace? */
  readonly produced: (runId: string) => boolean;
}

/** The line to append, or undefined when the delivery is verified (or when
 *  nothing was dispatched at all: a plain answer needs no second opinion). */
export function deliveryNoteOf(input: DeliveryGateInput): string | undefined {
  const dispatched = input.runs.filter(
    (run) => run.parentRunId !== null && run.agentId !== null && run.agentId !== input.selfAgentId,
  );
  const producers = dispatched
    .filter((run) => run.status === "completed" && input.produced(run.runId))
    .sort((a, b) => (a.terminalAt ?? a.createdAt) - (b.terminalAt ?? b.createdAt));
  const last = producers[producers.length - 1];
  if (last === undefined) return undefined;
  const lastAt = last.terminalAt ?? last.createdAt;
  const verified = dispatched.some(
    (run) =>
      run.createdAt >= lastAt &&
      run.agentId !== last.agentId &&
      run.status === "completed" &&
      !input.produced(run.runId),
  );
  if (verified) return undefined;
  return "⚑ 核验：没有第二个成员核对过这份改动——本轮交付未经核验。";
}
