import type { ResumeDecision } from "./protocol/index.js";
import { pendingActionId } from "./domain.js";
import { createExecutionDispatcher } from "./execution-dispatch.js";
import { createLiveEventBus } from "./execution-live.js";
import { createExecutionService } from "./execution-service.js";
import type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

export { ApprovalNotApplicableError } from "./execution-service.js";
export type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

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
        actionId: pendingActionId(runId, callId),
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
