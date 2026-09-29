import { AcpBackendError } from "@chengchenccc/adapter-acp";
import { OmaProcessError } from "@chengchenccc/adapter-oma-agent";
import type {
  AgentBackend,
  ApprovalRequestedPayload,
  AskRequestedPayload,
  BackendEvent,
  ResumeDecision,
} from "@chengchenccc/agent-contract";
import { BACKEND_KINDS, debugLog } from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import { isActiveStatus, pendingActionId } from "./domain.js";
import { finalAnswerMessage } from "./execution-input.js";
import type { LiveEventBus } from "./execution-live.js";
import type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

export interface ExecutionServiceCtx {
  deps: AgentRunExecutionDeps;
  liveEvents: LiveEventBus;
  liveRuns: Map<string, LiveRun>;
  inflight: Set<string>;
  inflightPromises: Map<string, Promise<void>>;
  state: { disposed: boolean };
  dispatchFn: (runId: string) => Promise<void>;
  /** ADR 0038: decisions awaiting the resume dispatch of a parked run
   * (shared with the dispatcher — deliverInput drains it into the wire). */
  resumeInbox: Map<string, readonly ResumeDecision[]>;
  entryFor: (
    kind: string,
  ) => AgentRunExecutionDeps["backends"][keyof AgentRunExecutionDeps["backends"]] | undefined;
}

/** Read a durable pending-action payload back into an approval request. The
 *  row is JSON, not a typed value: fields are checked, never asserted, and a
 *  record missing its identity (callId/toolName) is dropped instead of
 *  becoming a card that cannot be resolved. */
function readApprovalPayload(
  payload: Readonly<Record<string, unknown>>,
): ApprovalRequestedPayload | undefined {
  const { callId, toolName } = payload;
  if (typeof callId !== "string" || callId.length === 0) return undefined;
  if (typeof toolName !== "string") return undefined;
  return {
    callId,
    toolName,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...("input" in payload ? { input: payload.input } : {}),
    ...(typeof payload.sandboxed === "boolean" ? { sandboxed: payload.sandboxed } : {}),
    ...(typeof payload.deadlineAt === "number" ? { deadlineAt: payload.deadlineAt } : {}),
  };
}

/** Same for an ask: `questions` is only carried when it is an array, because
 *  the surfaces parse the items themselves (the item shape is not what this
 *  boundary owns). */
function readAskPayload(
  payload: Readonly<Record<string, unknown>>,
): AskRequestedPayload | undefined {
  const { callId, questions } = payload;
  if (typeof callId !== "string" || callId.length === 0) return undefined;
  return { callId, ...(Array.isArray(questions) ? { questions } : {}) };
}

export class ApprovalNotApplicableError extends Error {}

/** A resolution for an approval the run is not waiting on — a stale card
 *  click, or a loop that is gone. Forwarding it would reach the child as an
 *  RPC response for an unknown command id, which the child reads as protocol
 *  corruption and dies: a stale button used to kill a run that was sitting
 *  there waiting for a human. The route answers 409 instead.
 */
export function createExecutionService(ctx: ExecutionServiceCtx): AgentRunExecutionService {
  const { deps, liveEvents, liveRuns, inflight, inflightPromises, state, dispatchFn, entryFor } =
    ctx;
  const { runPort, backends } = deps;
  const { resumeInbox } = ctx;

  /** ADR 0038: a parked run's answer arrived with no live child (the
   *  backend restarted while it waited). Stash the decided actions and
   *  re-dispatch the SAME runId/input: the fresh child completes the
   *  interrupted turn from its session seed with the decisions attached. */
  const resumeParkedRun = async (runId: string): Promise<void> => {
    const run = await runPort.getRun(runId);
    // Only a WOKEN run resumes: still-waiting means sibling actions are
    // open — their consume will trigger this again (multi-slot rule).
    if (run?.status !== "running" || liveRuns.has(runId)) return;
    const decided = (await runPort
      .listDecidedActions(runId)
      .catch(
        () => [] as { callId: string; kind: string; response: Record<string, unknown> }[],
      )) as readonly ResumeDecision[];
    resumeInbox.set(runId, decided);
    debugLog("agent-run", `resume_parked runId=${runId} decisions=${decided.length}`);
    await dispatchFn(runId).catch((err) => {
      console.error(`[agent-run] resume dispatch failed for ${runId}:`, err);
    });
  };

  return {
    async dispatch(runId) {
      await dispatchFn(runId);
    },

    /** Inject a steer into the LIVE run of a branch. When the run has no
     *  live handle (settled, or on another process after restart) the input
     *  is cancelled and the caller gets an explicit error - a steer is never
     *  replayed as a normal input. */
    async injectSteer(
      branchId: string,
      input: { inputId: string; message: Message },
    ): Promise<void> {
      const active = await runPort.getActiveRun(branchId);
      if (!active) {
        // No active run: the steer cannot be delivered. Explicit conflict -
        // never silently dropped, never converted to a normal input.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: no active run on branch ${branchId}`);
      }
      const live = liveRuns.get(active.runId);
      if (!live) {
        // The run is active in the DB but this process lost its live handle
        // (restart). Live steer cannot cross processes - cancel and report.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: run ${active.runId} has no live loop on this process`);
      }
      const claimed = await runPort.deliverSteerInput(input.inputId, active.runId);
      if (!claimed) return; // already delivering/delivered or gone
      const entry = entryFor(active.modelRef.backendKind);
      if (!entry) {
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(
          `steer rejected: unknown or unregistered backend kind "${active.modelRef.backendKind}" ` +
            `(known: ${BACKEND_KINDS.join(", ")})`,
        );
      }
      try {
        await (entry.backend as AgentBackend).steer(active.runId, {
          inputId: input.inputId,
          message: input.message,
        });
      } catch (err) {
        // The child rejected the steer (run settled in between): the input
        // must not linger as a phantom delivering row.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw err;
      }
      await runPort.markInputAccepted(input.inputId);
    },

    /** Startup recovery: redeliver every durable `delivering` input (same
     *  runId/inputId/idempotency - the Backend dedupes), promote every
     *  branch with a pending non-steer input that never became a Run
     *  (crash gap), and surface commit_failed runs for retryTerminalCommit.
     *  Called once at boot. */
    async recover() {
      const delivering = await runPort.listDeliveringInputs();
      for (const claimed of delivering) {
        await dispatchFn(claimed.runId).catch((err) => {
          console.error(`[agent-run] recover dispatch failed for ${claimed.runId}:`, err);
        });
      }
      // Crash gap: pending input with run_id IS NULL on an idle branch. Each
      // branch promotes its oldest input into a fresh Run from the input's
      // OWN snapshot (FIFO); acquireNextRun no-ops on busy branches.
      const idleBranches = await runPort.listIdleBranchesWithPendingInputs();
      for (const branchId of idleBranches) {
        const promoted = await runPort.acquireNextRun(branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover promote dispatch failed for ${promoted.runId}:`, err);
        });
      }
      const failed = await runPort.listCommitFailedRuns();
      for (const run of failed) {
        await this.retryTerminalCommit(run.runId).catch((err) => {
          console.error(`[agent-run] recover commit retry failed for ${run.runId}:`, err);
        });
      }
      // Restart orphans: a run whose input was DELIVERED (child accepted)
      // has no live child after a restart — EXCEPT one parked on HITL
      // (ADR 0038): its pending actions keep the answer path alive, and
      // answering re-dispatches it. Everything else cannot be resumed
      // (one-shot child architecture): terminal it, cancel nothing
      // (already delivered), release the branch, promote the next input.
      const orphans = await runPort.listActiveRunsWithDeliveredInputs();
      for (const orphan of orphans) {
        if (liveRuns.has(orphan.runId)) continue;
        if (orphan.status === "waiting") {
          const pending = await runPort.listPendingActions(orphan.runId).catch(() => []);
          if (pending.length > 0) {
            debugLog(
              "agent-run",
              `recover_parked runId=${orphan.runId} pending=${pending.length} (awaiting answer)`,
            );
            continue;
          }
        }
        debugLog(
          "agent-run",
          `recover_orphan runId=${orphan.runId} status=${orphan.status} branchId=${orphan.branchId}`,
        );
        await runPort
          .finalizeRun(orphan.runId, {
            status: "aborted",
            error: "stale run without live child after restart",
          })
          .catch((err) => {
            console.error(`[agent-run] recover orphan finalize failed for ${orphan.runId}:`, err);
          });
        // run_lost: the approval can never be answered - cancel it.
        await runPort
          .cancelPendingActionsForRun(orphan.runId)
          .catch((err) => console.error(`[agent-run] recover orphan cancel failed:`, err));
        const promoted = await runPort.acquireNextRun(orphan.branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover orphan promote failed for ${promoted.runId}:`, err);
        });
      }
    },

    /** Retry the Product commit of a commit_failed run from the STORED
     *  outcome only - never re-invokes the Backend. */
    async retryTerminalCommit(runId) {
      const run = await runPort.getRun(runId);
      if (run?.status !== "commit_failed" || !run.terminalResult) return;
      const outcome = run.terminalResult;
      if (outcome.status !== "completed") {
        // Non-completed terminal: finalize (idempotent) and release.
        await runPort.finalizeRun(runId, outcome).catch(() => {});
        return;
      }
      const { seqs } = await runPort.commitCompletedRun({
        runId,
        outcome,
        messages: outcome.messages ?? [],
      });
      deps.onRunCommitted?.(runId, finalAnswerMessage(outcome.messages), seqs);
      liveRuns.delete(runId);
      liveEvents.closeSubscribers(runId);
    },

    async resolveApproval(runId, callId, decision) {
      // Validate against the durable action first: an unknown callId is a
      // stale click, not a decision, and must never reach the child.
      const actionId = pendingActionId(runId, callId);
      const action = await runPort.getPendingAction(actionId);
      if (!action || action.status === "cancelled") {
        throw new ApprovalNotApplicableError(
          `approval rejected: run ${runId} is not waiting for ${callId}`,
        );
      }
      if (action.status === "resolved") {
        // Replay of a click the backend already accepted (double-tap, a
        // card that outlived its refresh): same decision returns the stored
        // outcome - and the same-key consume's replay branch also repairs a
        // waiting->running CAS a crash may have left behind. An opposite
        // decision is a conflict, never a second answer forwarded to the
        // child.
        const stored = action.response as { decision?: unknown } | null;
        if (stored?.decision !== decision) {
          throw new ApprovalNotApplicableError(
            `approval rejected: ${callId} was already answered "${String(stored?.decision)}"`,
          );
        }
        await runPort
          .consumePendingAction(
            actionId,
            { actionId, response: { decision } },
            `${actionId}:${decision}`,
          )
          .catch((err) => {
            console.error(`[agent-run] approval replay repair failed for ${actionId}:`, err);
          });
        return;
      }
      const live = liveRuns.get(runId);
      if (!live) {
        // ADR 0038: the child died with the backend while parked on this
        // approval. A WAITING run records the decision durably and
        // resume-dispatches — the fresh child completes the interrupted
        // turn with the decision pre-supplied. Anything else (settling,
        // terminal, zombie) keeps the explicit failure.
        const parked = await runPort.getRun(runId);
        if (parked?.status === "waiting") {
          await runPort
            .consumePendingAction(
              actionId,
              { actionId, response: { decision } },
              `${actionId}:${decision}`,
            )
            .catch((err) => {
              console.error(`[agent-run] parked approval consume failed for ${actionId}:`, err);
            });
          await resumeParkedRun(runId);
          return;
        }
        throw new ApprovalNotApplicableError(
          `approval rejected: run ${runId} has no live loop on this process`,
        );
      }
      const run = await runPort.getRun(runId);
      const entry = run ? entryFor(run.modelRef.backendKind) : undefined;
      if (!entry?.backend.resolveApproval) {
        throw new Error(
          `approval rejected: backend "${run?.modelRef.backendKind}" has no approval pipeline`,
        );
      }
      try {
        await entry.backend.resolveApproval(runId, callId, decision);
      } catch (err) {
        // The child no longer knows this approval (its deadline denied it,
        // or the run is settling): the decision NEVER reached the loop.
        // Consume the durable row honestly as timed out and answer 409 -
        // recording the operator's click as the outcome would be a lie the
        // UI shows as success. Other failures (protocol, transport) stay
        // loud: their cause is not "this approval is gone".
        // Adapter not-found errors carry the same string codes in
        // per-adapter classes (oma and acp today); recognize either class
        // so a late click on ANY backend's gone approval settles as
        // timeout instead of a 500.
        const adapterErr =
          err instanceof OmaProcessError || err instanceof AcpBackendError ? err : undefined;
        if (adapterErr && (adapterErr.code === "conflict" || adapterErr.code === "not_found")) {
          if (adapterErr.code === "conflict") {
            await runPort
              .consumePendingAction(
                actionId,
                { actionId, response: { timeout: true } },
                `${actionId}:timeout`,
              )
              .catch((consumeErr) => {
                console.error(
                  `[agent-run] approval timeout consume failed for ${actionId}:`,
                  consumeErr,
                );
              });
          }
          throw new ApprovalNotApplicableError(
            `approval rejected: the child has no pending approval for ${callId} (${adapterErr.message})`,
          );
        }
        throw err;
      }
      // Durable approvals v1: record the response and repair the run's
      // waiting->running CAS. Best-effort - the child already has the
      // decision; a missing/stale action must not fail the HTTP call.
      await runPort
        .consumePendingAction(
          actionId,
          { actionId, response: { decision } },
          `${actionId}:${decision}`,
        )
        .catch((err) => {
          console.error(`[agent-run] approval consume failed for ${actionId}:`, err);
        });
    },
    resumeParkedRun,

    async stop(runId) {
      const live = liveRuns.get(runId);
      if (live) {
        await live.segment.stop();
        return;
      }
      const run = await runPort.getRun(runId);
      if (run && isActiveStatus(run.status)) {
        // Zombie: active in DB, no live child. Terminal it, cancel its
        // input, and promote the next queued input so the branch does not
        // stay blocked by a run nobody can drive.
        await runPort.finalizeRun(runId, {
          status: "aborted",
          error: "stale run without live child",
        });
        await runPort.cancelPendingActionsForRun(runId).catch(() => {});
        await runPort.cancelRunInput(runId);
        const next = await runPort.acquireNextRun(run.branchId);
        if (next) {
          void dispatchFn(next.runId).catch((err) => {
            console.error(`[agent-run] chain dispatch failed for ${next.runId}:`, err);
          });
        }
      }
    },

    isLive(runId) {
      return liveRuns.has(runId);
    },

    isInflight(runId) {
      return inflight.has(runId);
    },

    async dispose() {
      state.disposed = true;
      // Children first: their exit settles every pending outcome/acceptance,
      // which unblocks the in-flight dispatches below.
      await Promise.all(Object.values(backends).map((entry) => entry.backend.dispose()));
      await Promise.allSettled([...inflightPromises.values()]);
      inflightPromises.clear();
    },

    async abortStaleRun(runId) {
      const run = await runPort.getRun(runId);
      if (!run || !isActiveStatus(run.status)) return;
      await runPort.finalizeRun(runId, {
        status: "aborted",
        error: "stale run without live child",
      });
      await runPort.cancelPendingActionsForRun(runId).catch(() => {});
      await runPort.cancelRunInput(runId);
    },

    /** ADR 0038: waiting AND still holding a pending action — a parked run,
     *  not a zombie. Every "childless means dead" cleanup path must ask this
     *  first (recover's sweep and the SSE late-subscription path both do). */
    async isParked(runId) {
      const run = await runPort.getRun(runId);
      if (run?.status !== "waiting") return false;
      const pending = await runPort.listPendingActions(runId).catch(() => []);
      return pending.length > 0;
    },

    subscribe(runId, signal) {
      return liveEvents.subscribe(runId, signal);
    },

    /** ADR 0038: the durable side of a HITL park, in wire-event form, so a
     *  subscriber that arrived late still learns what is being asked. Kind
     *  -> event type, and the stored record is the payload: one fact, read
     *  back two ways. The read is validated rather than asserted - a row is
     *  JSON that a previous build may have written differently, and a card
     *  built from a half-shaped payload is a card the human cannot answer. */
    async pendingActionEvents(runId) {
      const actions = await runPort.listPendingActions(runId).catch(() => []);
      const events: BackendEvent[] = [];
      for (const action of actions) {
        if (action.status !== "pending") continue;
        if (action.kind === "approval") {
          const payload = readApprovalPayload(action.payload);
          if (payload) events.push({ type: "approval_requested", payload });
        } else if (action.kind === "ask") {
          const payload = readAskPayload(action.payload);
          if (payload) events.push({ type: "ask_requested", payload });
        }
      }
      return events;
    },

    broadcastRunEvent(runId, event) {
      // ask/todo only - never approvals; the ordering for those is enforced
      // inside the bus itself.
      void liveEvents.broadcast(runId, event);
    },
  };
}
