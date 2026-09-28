import type { BackendEvent, ResumeDecision } from "@chengchenccc/agent-contract";
import type { AgentRun } from "./domain.js";
import { isTerminalStatus } from "./domain.js";
import { createExecutionDispatcher } from "./execution-dispatch.js";
import { createLiveEventBus } from "./execution-live.js";
import { createExecutionService } from "./execution-service.js";
import type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

export type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

/** Late-subscription handling for GET /agent-runs/:runId/events.
 *  - settled/unknown run: one terminal status event, then close (never a
 *    permanently open SSE for a run nothing will close);
 *  - commit_failed: the outcome is stored and the child is gone - report a
 *    terminal status WITHOUT touching the Product Run (retryTerminalCommit
 *    owns it); aborting here would conflict with the stored outcome;
 *  - active + live child OR dispatch in flight (pre-acceptance): subscribe
 *    to transient events - an inflight run must NEVER be aborted;
 *  - active, neither live nor inflight (true zombie): terminalize first,
 *    then a terminal status + close so the UI never shows a permanent
 *    Running state. */
export function runEventStreamFor(
  run: Pick<AgentRun, "status"> | null,
  execution: {
    isLive(runId: string): boolean;
    isInflight(runId: string): boolean;
    /** ADR 0038: waiting with a pending action — parked, NOT a zombie. A
     *  restart leaves it childless on purpose, and the answer resumes it. */
    isParked(runId: string): Promise<boolean>;
    abortStaleRun(runId: string): Promise<void>;
    subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
    /** Durable pending HITL actions, as wire events (see the service). */
    pendingActionEvents(runId: string): Promise<BackendEvent[]>;
  },
  runId: string,
  signal?: AbortSignal,
): AsyncIterable<BackendEvent> {
  const terminal = (status: string): AsyncIterable<BackendEvent> =>
    (async function* () {
      yield { type: "status", status };
    })();
  /** Replay the durable HITL state, then the live stream. Neither alone is
   *  enough: the bus has no replay, and an approval can fire before the
   *  subscriber gets here (live acceptance 2026-09-28: the first turn beat
   *  the Lark card's create+send by a second and the card sat on its initial
   *  "queued" frame for the whole park). The live iterator is PRIMED before
   *  the replay read — an async generator only registers its callback on the
   *  first `next()` — so an event landing inside that window is buffered by
   *  the bus instead of lost. A duplicate (replayed AND live) is harmless:
   *  both surfaces reduce an event into idempotent state. */
  const replayThenLive = (): AsyncIterable<BackendEvent> =>
    (async function* () {
      const live = execution.subscribe(runId, signal)[Symbol.asyncIterator]();
      const primed = live.next();
      const replayed = await execution.pendingActionEvents(runId).catch(() => []);
      for (const event of replayed) yield event;
      let next = await primed;
      while (!next.done) {
        yield next.value;
        next = await live.next();
      }
    })();
  if (!run) return terminal("failed");
  if (isTerminalStatus(run.status)) return terminal(run.status);
  if (run.status === "commit_failed") return terminal("failed");
  if (execution.isLive(runId) || execution.isInflight(runId)) return replayThenLive();
  return (async function* () {
    // A parked run is childless BY DESIGN after a restart. Aborting it here
    // was the live bug that killed a parked run the moment the Lark bot
    // re-subscribed on card restore (live acceptance, 2026-09-28): the
    // stream stays quiet until the answer resumes the run and its events
    // flow.
    if (await execution.isParked(runId).catch(() => false)) {
      yield* replayThenLive();
      return;
    }
    await execution.abortStaleRun(runId);
    yield { type: "status", status: "aborted" };
  })();
}

export { ApprovalNotApplicableError } from "./execution-service.js";

export function createAgentRunExecutionService(
  deps: AgentRunExecutionDeps,
): AgentRunExecutionService {
  /** Process-lifetime live refs, only for steer/stop/current-event
   *  subscription. Removed when the run reaches a terminal state. */
  const liveRuns = new Map<string, LiveRun>();
  const inflight = new Set<string>();
  /** Dispatch promises by runId: dispose() drains them AFTER the children
   *  are dead so the DB is never closed mid-finalize. */
  const inflightPromises = new Map<string, Promise<void>>();
  /** ADR 0038 resume inbox: decisions stashed by the service when a parked
   * run's answer arrives with no live child (backend restarted while the
   * run waited on HITL). The dispatcher drains it into the next dispatch's
   * wire input; the child completes the interrupted turn from them. */
  const resumeInbox = new Map<string, readonly ResumeDecision[]>();
  const execState = { disposed: false };
  const liveEvents = createLiveEventBus({
    ...deps,
    // Durable approvals: the bus awaits this hook BEFORE any subscriber sees
    // the approval event, so a card is only shown once its action row exists.
    // createPendingAction is idempotent by actionId (event replays are
    // no-ops) and CASes the run running->waiting.
    onApprovalRequest: async ({ runId, callId, payload }) => {
      await deps.runPort.createPendingAction(runId, {
        actionId: `${runId}:${callId}`,
        kind: "approval",
        payload: { ...payload },
      });
    },
  });
  const { dispatchFn, entryFor } = createExecutionDispatcher({
    deps,
    liveEvents,
    liveRuns,
    inflight,
    inflightPromises,
    state: execState,
    resumeInbox,
  });

  return createExecutionService({
    deps,
    liveEvents,
    liveRuns,
    inflight,
    inflightPromises,
    state: execState,
    dispatchFn,
    entryFor,
    resumeInbox,
  });
}
