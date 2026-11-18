/** ADR 0063 D2: a job that started and never reported an end was cut off
 *  with its run (teardown kills the child's jobs). The fact is already in
 *  telemetry - this derives it instead of storing a second copy.
 *
 *  Derived, not marked: a crash produces no terminal event at all, so a
 *  "mark on teardown" would cover exactly the case where we still have a
 *  process to write the mark - the least useful one. */

export interface JobStateEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface InterruptedJob {
  readonly jobId: string;
  readonly jobKind: string;
  readonly label: string;
}

const TERMINAL = new Set(["finished", "failed", "cancelled"]);

/** Jobs with a `started` row and no terminal row for the same id. */
export function deriveInterruptedJobs(events: readonly JobStateEvent[]): InterruptedJob[] {
  const started = new Map<string, InterruptedJob>();
  const ended = new Set<string>();
  for (const event of events) {
    if (!event.type.endsWith("job_state")) continue;
    const { jobId, jobKind, label, state } = event.data as {
      jobId?: unknown;
      jobKind?: unknown;
      label?: unknown;
      state?: unknown;
    };
    if (typeof jobId !== "string" || typeof state !== "string") continue;
    if (state === "started") {
      if (typeof label !== "string" || typeof jobKind !== "string") continue;
      started.set(jobId, { jobId, jobKind, label });
    } else if (TERMINAL.has(state)) {
      ended.add(jobId);
    }
  }
  return [...started.values()].filter((job) => !ended.has(job.jobId));
}

/** The block the next turn reads. Silent when nothing was cut off: an empty
 *  section on every turn is noise that trains the model to skim. */
export function renderInterruptedJobs(jobs: readonly InterruptedJob[]): string {
  if (jobs.length === 0) return "";
  const lines = jobs.map((job) => `- ${job.label}（${job.jobKind}）`);
  return [
    "## Interrupted work (last turn)",
    "",
    "These background jobs started and never finished - the run ended first.",
    "Nothing was replayed. Re-run one only if its result is still needed, and",
    "check whether it has side effects before doing so:",
    "",
    ...lines,
  ].join("\n");
}
