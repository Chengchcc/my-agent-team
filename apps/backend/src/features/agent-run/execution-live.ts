import { TELEMETRY_EVENT_TYPES } from "./execution-input.js";
import type { BackendEvent, BackendRunSegment } from "./protocol/index.js";

export interface LiveEventBus {
  /** One live event on its way out: the durable telemetry sink (best effort), the observation
   *  hooks, and then whatever a surface does with it. */
  /** Async since durable HITL: an approval must be persisted before any surface may see the
   *  event. */
  broadcast(runId: string, event: BackendEvent): Promise<void>;
  /** Forget a settled run's liveness timestamp: the silence watchdog reads it only while the
   *  run is live, and the map must not grow with every run this process has served. */
  forgetRun(runId: string): void;
  /** Fan out the segment's event stream. Resolves when fully drained. */
  forwardEvents(runId: string, segment: BackendRunSegment): Promise<void>;
  /** Wall-clock of the last event seen for this run (undefined = none yet).
   *  The dispatch's silence watchdog reads it: the loop heartbeats every few
   *  seconds, so a stale value means the child is mute, not "thinking". */
  lastEventAt(runId: string): number | undefined;
}

export function createLiveEventBus(deps: {
  persistRunEvent?: (runId: string, event: BackendEvent) => Promise<void>;
  onMcpMountResult?: (input: {
    serverName: string;
    ok: boolean;
    toolsCount: number;
    error?: string;
    runId: string;
  }) => void;
  onApprovalRequest?: (input: {
    runId: string;
    callId: string;
    payload: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
  /** Every live event, as it is broadcast: the composition root turns these into whatever a
   *  surface consumes (the AHP chat channel today). Observation only - it never affects the run,
   *  which is why a throw here is swallowed. */
  onLiveEvent?: (runId: string, event: BackendEvent) => void;
}): LiveEventBus {
  const lastEventByRun = new Map<string, number>();

  /** Extract a runtime MCP mount observation from the oma extension event.
   *  Returns undefined for every other event shape. */
  function mcpMountResult(
    runId: string,
    event: BackendEvent,
  ):
    | {
        serverName: string;
        ok: boolean;
        toolsCount: number;
        error?: string;
        runId: string;
      }
    | undefined {
    if (event.type !== "backend.oma.mcp_mount_result") return undefined;
    const payload = (event as { payload?: Readonly<Record<string, unknown>> }).payload ?? {};
    const serverName = payload.server;
    if (typeof serverName !== "string") return undefined;
    return {
      serverName,
      ok: payload.ok === true,
      toolsCount: Number(payload.toolsCount ?? 0),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      runId,
    };
  }

  /** Extract a HITL approval request from the core approval event. Returns
   *  undefined for every other event shape or an empty callId (nothing to key
   *  the pending action on - an empty id would be unresolvable forever). */
  function approvalRequest(
    runId: string,
    event: BackendEvent,
  ): { runId: string; callId: string; payload: Readonly<Record<string, unknown>> } | undefined {
    if (event.type !== "approval_requested") return undefined;
    const { payload } = event;
    if (typeof payload.callId !== "string" || payload.callId.length === 0) return undefined;
    return { runId, callId: payload.callId, payload: { ...payload } };
  }

  async function broadcast(runId: string, event: BackendEvent): Promise<void> {
    lastEventByRun.set(runId, Date.now());
    // Durable telemetry: persist the normalized event log (tool calls,
    // status, workflow steps). Transient text/thinking deltas are skipped, and
    // so are liveness heartbeats: they exist for the parent's silence
    // watchdog and would otherwise add a row every few seconds per run.
    const liveness = event.type === "status" && "status" in event && event.status === "heartbeat";
    if (deps.persistRunEvent && !liveness && TELEMETRY_EVENT_TYPES.has(event.type)) {
      void deps.persistRunEvent(runId, event).catch(() => {
        /* telemetry is best-effort */
      });
    }
    const mount = mcpMountResult(runId, event);
    if (mount) {
      try {
        deps.onMcpMountResult?.(mount);
      } catch {
        /* observation never affects the run */
      }
    }
    const approval = approvalRequest(runId, event);
    if (approval) {
      // Durable HITL: the action row must exist BEFORE any surface can see
      // this event - resolveApproval refuses a click with no durable action,
      // so shipping the card first would show the user something unanswerable.
      // On persistence failure we drop the event entirely: the child's own
      // approval deadline then denies it, which is the honest fail-closed.
      try {
        await deps.onApprovalRequest?.(approval);
      } catch (err) {
        console.error(
          `[agent-run] approval persistence failed for ${approval.runId}/${approval.callId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
    }
    // Every observer runs LAST. An approval that reached a surface before its row existed would
    // render a card nobody can answer - resolveApproval refuses a click with no durable action -
    // so the durable write above decides whether the event is seen at all.
    try {
      deps.onLiveEvent?.(runId, event);
    } catch {
      /* observation never affects the run */
    }
  }

  function forgetRun(runId: string): void {
    lastEventByRun.delete(runId);
  }

  /** Drain the segment's live events through `broadcast`. A closing event stream is not a run
   *  failure, so it is swallowed here. */
  function forwardEvents(runId: string, segment: BackendRunSegment): Promise<void> {
    return (async () => {
      try {
        for await (const ev of segment.events) await broadcast(runId, ev);
      } catch {
        /* event stream closing is not a run failure */
      }
    })();
  }

  return {
    broadcast,
    forgetRun,
    forwardEvents,
    lastEventAt: (runId: string) => lastEventByRun.get(runId),
  };
}
