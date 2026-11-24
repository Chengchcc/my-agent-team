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
  /** The runs attached to what is being delivered (its requirement; a room as
   *  the fallback when nothing is tracked). */
  readonly runs: readonly DeliveryGateRun[];
  /** Did this run use a tool that changes the workspace? */
  readonly produced: (runId: string) => boolean;
}

/** Tools that change the workspace. A producer is any run that used one —
 *  `mcp__product-tools__project_push` carries a prefix, and that mismatch is
 *  exactly how the gate stayed silent on a real hand-back (2026-11-23). */
export function producedByEvent(serialized: string): boolean {
  // `edit` or a push — NOT plain `write`: a verifier writes its own report file
  // (measured: the Reviewer used write + artifact_upload + report, never edit),
  // and counting that as production would erase every verification.
  return /"toolName":"edit"/.test(serialized) || serialized.includes("project_push");
}

/** The line to append, or undefined when the delivery is verified (or when
 *  nothing was dispatched at all: a plain answer needs no second opinion). */
export function deliveryNoteOf(input: DeliveryGateInput): string | undefined {
  // How a run reached the requirement does not matter — dispatched from a room,
  // or a person driving a worker on a direct line. What matters is that a
  // DIFFERENT agent did it (ADR 0077: the requirement is the unit of delivery).
  const dispatched = input.runs.filter(
    (run) => run.agentId !== null && run.agentId !== input.selfAgentId,
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
  // Say what the judgement CAN see: another member finished a run afterwards
  // without changing files. It does not see what that member read, nor whether
  // their conclusion holds — so a missing note is not a pass either
  // (independent audit, 2026-11-24).
  return "⚑ 核验：没有第二个成员核对过这份改动——本轮交付未经核验。（判据：只认「另一成员在其之后完成且未改文件」；不判断他读了什么、结论是否成立。）";
}
