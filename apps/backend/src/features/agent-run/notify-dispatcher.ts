import type { Message } from "@chengchenccc/message";
import type { AgentRun } from "./domain.js";

/** ADR 0059 D5: everything that travels from a dispatched run back to whoever
 *  dispatched it — its terminal state and its `report` calls. Two rails:
 *
 *  - the dispatcher has an active run: the notice is steered into it (no new
 *    run; the loop's hold wakes within a slice, ADR 0059 slice 1);
 *  - the dispatcher is idle: it becomes a queued input authorized
 *    `result:<worker>` — the human sees the front desk's next turn, never a
 *    bare worker run.
 *
 *  Guardrails live here, not in the callers: chain depth >= 3 degrades to a
 *  ledger note (the mechanism must never drive its own loop forever), and a
 *  run without a parent (or whose parent row is gone) is a no-op.
 *
 *  `progress` reports never wake: they land as unaddressed ledger notes so a
 *  worker cannot interrupt its dispatcher every few minutes. */
export interface NotifyDispatcherInput {
  readonly fromAgentId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly text: string;
  readonly wake: boolean;
  /** False for mid-run `report` notices so they never mark `result_notified_at`
   *  or collide with the terminal notice's idempotency key. Default true. */
  readonly terminal?: boolean;
  /** Explicit idempotency key for steer/result deduplication. */
  readonly idempotencyKey?: string;
}

export type NotifyDelivered = "steer" | "queued" | "ledger";

export interface NotifyDispatcherDeps {
  getRun(runId: string): Promise<AgentRun | null>;
  /** The conversation's front desk (the agent the human talks to). Used when
   *  the chain is too deep to keep waking agents: the human still has to
   *  learn the fact, and the front desk is the human's proxy. */
  getFrontDeskAgent(conversationId: string): Promise<string | null>;
  getActiveRun(branchId: string): Promise<{ readonly runId: string } | null>;
  /** Enqueue-only rail: `mode: "steer"` + an active run leaves a pending
   *  input instead of creating a run (the adapter owns that rule). */
  enqueueSteer(input: {
    conversationId: string;
    agentId: string;
    branchId: string;
    message: Message;
    authorization: string;
    parentRunId: string;
    idempotencyKey: string;
    defaultModel: AgentRun["modelRef"];
    configRevision: number;
  }): Promise<{ inputId: string; queued: boolean; acquired: boolean }>;
  injectSteer(
    branchId: string,
    input: { inputId: string; message: Message },
    opts?: { keepIfIdle?: boolean },
  ): Promise<void>;
  postMessage(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: readonly string[];
    content: string;
    authorization: string;
    parentRunId: string;
  }): Promise<unknown>;
  /** ADR 0060 D6: the notice was handed to a rail (steer, queued input, or -
   *  at the chain-depth limit - the ledger). It does NOT mean a human read it.
   *  Recovery re-delivers every terminal dispatched run without this mark, so
   *  a crash between the commit and the delivery costs a duplicate at worst,
   *  never silence. */
  markNotified?(runId: string): Promise<void>;
}

/** How many dispatch hops a run sits below the human. The front desk's own
 *  run is 0; its dispatched worker is 1. Waking beyond 3 would let a
 *  front-desk → worker → worker → … chain ping-pong on its own. */
export const MAX_WAKE_DEPTH = 3;

export function createNotifyDispatcher(
  deps: NotifyDispatcherDeps,
): (input: NotifyDispatcherInput) => Promise<{ delivered: NotifyDelivered }> {
  return async (input) => {
    const run = await deps.getRun(input.runId);
    if (!run?.parentRunId) return { delivered: "ledger" };
    const parent = await deps.getRun(run.parentRunId);
    if (!parent) return { delivered: "ledger" };
    let depth = 0;
    let cursor: AgentRun | null = parent;
    while (cursor?.parentRunId && depth < 10) {
      depth += 1;
      cursor = await deps.getRun(cursor.parentRunId);
    }
    const authorization = `result:${input.fromAgentId}`;
    const isTerminal = input.terminal !== false;
    // ADR 0070: a dispatched worker runs in its own child conversation, while
    // its dispatcher lives in `parent.conversationId`. Always deliver notices
    // into the dispatcher's room so failed runs, mid-run reports, and recovery
    // re-deliveries actually reach the parent agent.
    const targetConversationId = parent.conversationId || input.conversationId;
    const idemKey =
      input.idempotencyKey ??
      (isTerminal ? `terminal:${input.runId}` : `report:${input.runId}:${Date.now()}`);
    if (depth >= MAX_WAKE_DEPTH) {
      // Too deep to keep waking the CHAIN: the parent is a worker at the
      // limit, and waking it starts another automatic layer. But suppressing
      // the notice entirely would leave a human-actionable fact invisible, so
      // it goes to the human's proxy instead - one hop, and bounded because
      // that run is authorized `result:` (its own terminal never notifies).
      const frontDesk = await deps.getFrontDeskAgent(targetConversationId);
      const target = frontDesk !== null && frontDesk !== parent.agentId ? frontDesk : null;
      await deps.postMessage({
        conversationId: targetConversationId,
        senderMemberId: input.fromAgentId,
        addressedTo: target === null ? [] : [target],
        content: `（自动协作链已到上限（深度 ${MAX_WAKE_DEPTH}），下面这条不再继续自动派发，需要人处理）\n${input.text}`,
        authorization,
        parentRunId: input.runId,
      });
      // Marked only for terminal notices: mid-run reports must not suppress
      // terminal recovery.
      if (isTerminal) await deps.markNotified?.(input.runId);
      return { delivered: target === null ? "ledger" : "queued" };
    }
    if (input.wake) {
      const active = await deps.getActiveRun(parent.branchId);
      if (active) {
        const message: Message = { role: "user", text: input.text };
        try {
          const enqueued = await deps.enqueueSteer({
            conversationId: targetConversationId,
            agentId: parent.agentId,
            branchId: parent.branchId,
            message,
            authorization,
            parentRunId: input.runId,
            idempotencyKey: idemKey,
            defaultModel: parent.modelRef,
            configRevision: parent.configRevision,
          });
          if (enqueued.queued && !enqueued.acquired) {
            // keepIfIdle is deliberately NOT set: a failed steer must cancel
            // the pending row (steer inputs are excluded from promotion, so a
            // survivor would sit in the composer queue forever). The fallback
            // below posts a proper queued input instead.
            await deps.injectSteer(parent.branchId, { inputId: enqueued.inputId, message });
            if (isTerminal) await deps.markNotified?.(input.runId);
            return { delivered: "steer" };
          }
        } catch {
          // Live handle gone or steer enqueue conflicted: fall through to the
          // durable queued rail below instead of dropping the notice.
        }
      }
    }
    await deps.postMessage({
      conversationId: targetConversationId,
      senderMemberId: input.fromAgentId,
      addressedTo: input.wake ? [parent.agentId] : [],
      content: input.text,
      authorization,
      parentRunId: input.runId,
    });
    // Only a terminal wake counts as "the dispatcher was told": a ledger-only
    // note or a mid-run report must never mark result_notified_at.
    if (input.wake && isTerminal) await deps.markNotified?.(input.runId);
    return { delivered: input.wake ? "queued" : "ledger" };
  };
}
