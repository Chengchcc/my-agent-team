/** The chat channel's writer (ADR 0040 decision 4).
 *
 *  It turns what happens to a run into the actions a surface's channel carries, and states a
 *  settled turn exactly as the projection has it. The per-run caches that makes possible live
 *  here, not in the composition root: the root hands over three functions - dispatch, the
 *  projection, and the product read behind a run - and keeps none of the state itself. That is
 *  the same shape `run-events.ts` uses for the translation half; the driver used to be left
 *  behind in `features.ts`, which also had to reach into the host's dispatch to make it work. */
import type { BackendEvent } from "@chengchenccc/agent-contract";
import { chatUri } from "@chengchenccc/ahp-client";
import type { StateAction, Turn } from "@microsoft/agent-host-protocol";
import { pendingActionId } from "../agent-run/index.js";
import { type ChatActionTranslator, createChatActionTranslator } from "./run-events.js";

/** Statuses after which a run stops stepping. `commit_failed` is in this set and not in the
 *  product's own terminal list on purpose: the branch stays occupied for the retry, while for a
 *  surface it means the preview it already has is all it will get until it re-reads. */
const STOPPED_STEPPING: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "aborted",
  "commit_failed",
  "timeout",
]);

/** What the writer needs to know about a run before its first part arrives. */
export interface RunTurnContext {
  readonly conversationId: string;
  readonly inputText: string;
  /** The ledger row of that input, so a surface's optimistic item collapses onto it. */
  readonly messageId?: string;
  readonly startedAt: string;
}

/** The turn as the projection has it. */
export type ProjectedTurn = Pick<Turn, "message" | "responseParts" | "startedAt">;

export interface AhpChatWriterDeps {
  /** Push one action to a surface's channel. The result is the host's business, not the writer's:
   *  a channel never fails a run, so a rejection is swallowed at the call site. */
  readonly dispatch: (uri: string, action: StateAction) => Promise<unknown>;
  /** The turn as a fresh subscriber would read it. */
  readonly projectedTurn: (conversationId: string, turnId: string) => Promise<ProjectedTurn | null>;
  /** The product read behind a run's turn: its conversation and the input that started it. */
  readonly readRunTurnContext: (runId: string) => Promise<RunTurnContext | null>;
  /** Injectable so a test can drive the writer without a protocol. */
  readonly translate?: ChatActionTranslator;
}

export interface AhpChatWriter {
  /** Stream a run's live event onto its chat channel. Observation only: a failure here must never
   *  reach the run, and a throw inside the translation is swallowed into the log. */
  onLiveEvent(runId: string, event: BackendEvent): void;
  /** The run's rows are committed: state the turn from the projection and fold it into history.
   *  `durationMs` is display-only; a failed run that never ran a turn passes 0. */
  foldCommittedTurn(runId: string, durationMs: number): Promise<void>;
  /** A continuity record landed: a surface that is already connected has to see it (and move its
   *  binding) instead of waiting for its next snapshot. */
  announceContinuity(input: { conversationId: string; controlSeq: number }): Promise<void>;
  /** A human answered (or the request expired): the part that asked stops reading as pending. */
  announceHumanInput(input: {
    runId: string;
    callId: string;
    outcome: "allow" | "deny" | "timeout";
  }): Promise<void>;
}

export function createAhpChatWriter(deps: AhpChatWriterDeps): AhpChatWriter {
  const actions = deps.translate ?? createChatActionTranslator();
  /** Resolved once per run: reading the run, its branch inputs and its ledger row on every delta
   *  would be a query per event. */
  const contexts = new Map<string, RunTurnContext | null>();

  const contextFor = async (runId: string): Promise<RunTurnContext | null> => {
    const known = contexts.get(runId);
    if (known !== undefined) return known;
    const context = await deps.readRunTurnContext(runId);
    contexts.set(runId, context);
    return context;
  };

  /** Frames have to reach a surface in the order they happened: two deltas in the same tick would
   *  otherwise race their own dispatches, and a part could be announced after content written into
   *  it - which the reducer drops. One chain per run keeps the order. */
  const order = new Map<string, Promise<void>>();
  const queue = (runId: string, work: () => Promise<void>): void => {
    const next = (order.get(runId) ?? Promise.resolve())
      .then(work)
      .catch((err) => console.error(`[ahp] live dispatch failed for ${runId}:`, err));
    order.set(runId, next);
  };

  const send = async (conversationId: string, list: readonly StateAction[]): Promise<void> => {
    for (const action of list) {
      await deps.dispatch(chatUri(conversationId), action).catch(() => {
        /* a surface's channel never fails a run */
      });
    }
  };

  return {
    onLiveEvent(runId, event) {
      // The terminal status only means the run stopped stepping: its preview stays live until the
      // commit hook replaces it with the projection (which is the authority on the turn).
      if (event.type === "status" && "status" in event && STOPPED_STEPPING.has(event.status)) {
        return;
      }
      const translated = actions.translate(runId, event);
      if (translated.length === 0) return;
      queue(runId, async () => {
        const context = await contextFor(runId);
        if (!context) return;
        // Every action below addresses the active turn by id, so the turn has to exist first.
        const opening = actions.openTurn(runId, {
          text: context.inputText,
          startedAt: context.startedAt,
          ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
        });
        await send(context.conversationId, [...opening, ...translated]);
      });
    },

    async foldCommittedTurn(runId, durationMs) {
      // Read fresh rather than through the cache: the fold is the moment the rows exist, and a
      // context cached before them would have nothing to fold.
      const context = await deps.readRunTurnContext(runId);
      if (!context) return;
      const turn = await deps.projectedTurn(context.conversationId, runId);
      if (!turn) return;
      await send(context.conversationId, actions.commitTurn(runId, turn, durationMs));
      actions.drop(runId);
      contexts.delete(runId);
      order.delete(runId);
    },

    async announceContinuity(input) {
      const turnId = `continuity:${input.controlSeq}`;
      const turn = await deps.projectedTurn(input.conversationId, turnId);
      if (!turn) return;
      await send(input.conversationId, actions.announceContinuity(turnId, turn));
    },

    async announceHumanInput(input) {
      const context = await contextFor(input.runId);
      if (!context) return;
      const response = input.outcome === "allow" ? "accept" : "decline";
      await send(
        context.conversationId,
        actions.inputCompleted(pendingActionId(input.runId, input.callId), response),
      );
    },
  };
}
