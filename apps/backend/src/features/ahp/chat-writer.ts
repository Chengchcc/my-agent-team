/** The chat channel's writer (ADR 0040 decision 4).
 *
 *  It turns what happens to a run into the actions a surface's channel carries, and states a
 *  settled turn exactly as the projection has it. The per-run caches that makes possible live
 *  here, not in the composition root: the root hands over three functions - dispatch, the
 *  projection, and the product read behind a run - and keeps none of the state itself. That is
 *  the same shape `run-events.ts` uses for the translation half; the driver used to be left
 *  behind in `features.ts`, which also had to reach into the host's dispatch to make it work. */

import { chatUri, enumValue } from "@chengchenccc/ahp-client";
import type {
  ChatResponsePartAction,
  ResponsePartKind,
  StateAction,
  Turn,
} from "@microsoft/agent-host-protocol";
import type { BackendEvent } from "../../features/agent-run/protocol/index.js";
import { pendingActionId } from "../agent-run/index.js";
import { type ChatActionTranslator, createChatActionTranslator } from "./run-events.js";

/** Statuses after which a run stops stepping. `commit_failed` is in this set and not in the
 *  product's own terminal list on purpose: the branch stays occupied for the retry, while for a
 *  surface it means the preview it already has is all it will get until it re-reads. */
/** The images inside a tool's raw result: oma's tools report them as
 *  `{ images: [{ type: "image", mediaType, base64 }] }` (browser screenshots,
 *  read_image). Capped at four, and only the four media types the protocol
 *  carries. */
function toolResultImages(event: BackendEvent): Array<{ mediaType: string; base64: string }> {
  const result = (event as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return [];
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  const out: Array<{ mediaType: string; base64: string }> = [];
  for (const entry of images.slice(0, 4)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, mediaType, base64 } = entry as {
      type?: unknown;
      mediaType?: unknown;
      base64?: unknown;
    };
    if (type !== "image" || typeof mediaType !== "string" || typeof base64 !== "string") continue;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) continue;
    out.push({ mediaType, base64 });
  }
  return out;
}

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
  /** How the run ended. The fold needs it: `aborted` is a cancellation, not a completion. */
  readonly status: string;
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
  /** Drop a channel's cached projection. Some live facts have no action to carry them -- the
   *  plan strip rides `state._meta.todos`, which only a snapshot can set -- so the surface's
   *  next read has to be served from the DB instead (#52). */
  readonly invalidate: (uri: string) => void;
  /** Persist a tool-produced image and return where it lives (#65 output side): the bytes go
   *  to the artifact store, and the part that reaches surfaces is only a reference. */
  readonly saveImage?: (input: {
    runId: string;
    conversationId: string;
    mediaType: string;
    base64: string;
  }) => Promise<{ uri: string; contentType: string; size: number }>;
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
  /** A human answered (or the request expired): the part that asked stops reading as pending.
   *  `answered` is an ask answered with content - the *outcome* reaches a live surface here, the
   *  answer's content comes with the projection (mapping the product's answer onto upstream's
   *  `ChatInputAnswer` kinds is a decision of its own). */
  /** An undo flipped `undone` flags on ledger rows: the projection KEEPS those messages (an
   *  undone message reads as undone), and no action can carry a per-message flag, so the cached
   *  projection is dropped and the flags ride the next snapshot (#57). */
  announceMessagesUndone(conversationId: string): Promise<void>;
  announceHumanInput(input: {
    runId: string;
    callId: string;
    outcome: "allow" | "deny" | "timeout" | "answered";
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
      // The plan strip is a DB-only fact: no chat action can carry `_meta.todos` (every reducer
      // spreads `...state`, so only a snapshot can set it), which means a surface keeps painting
      // whichever list its first snapshot carried. Dropping the cursor is what makes the next read
      // come from the DB. Queued on the run's own chain so it cannot overtake the actions above.
      if (event.type === "backend.oma.todo_update") {
        queue(runId, async () => {
          const context = await contextFor(runId);
          if (context) deps.invalidate(chatUri(context.conversationId));
        });
      }
      // A tool that produced images (screenshots, read_image): the bytes exist only on this
      // event, so they are written somewhere durable NOW and the surfaces get a reference part.
      // The AHP vocabulary already carries this -- ResourceResponsePart + `chat/responsePart` --
      // so no new action, and the surfaces can render whatever they render for a resource.
      if (event.type === "native_tool_completed") {
        const images = toolResultImages(event);
        if (images.length > 0 && deps.saveImage) {
          queue(runId, async () => {
            const context = await contextFor(runId);
            if (!context) return;
            for (const image of images) {
              const saved = await deps
                .saveImage?.({
                  runId,
                  conversationId: context.conversationId,
                  mediaType: image.mediaType,
                  base64: image.base64,
                })
                .catch(() => undefined);
              if (!saved) continue;
              await send(context.conversationId, [
                {
                  type: enumValue<ChatResponsePartAction["type"]>("chat/responsePart"),
                  turnId: runId,
                  part: {
                    kind: enumValue<ResponsePartKind>("contentRef"),
                    uri: saved.uri as never,
                    contentType: saved.contentType,
                    sizeHint: saved.size,
                  },
                } as never,
              ]);
            }
          });
        }
      }
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

    async announceMessagesUndone(conversationId) {
      // Not a truncation: the projection keeps undone messages (flagged), and `chat/truncated`
      // would remove turns the source still states -- and drop a live activeTurn while at it.
      // The flag change is a DB-only fact of the #52 kind: drop the cache, and the next read
      // carries `undone: true` on the affected messages.
      deps.invalidate(chatUri(conversationId));
    },

    async foldCommittedTurn(runId, durationMs) {
      // Read fresh rather than through the cache: the fold is the moment the rows exist, and a
      // context cached before them would have nothing to fold.
      const context = await deps.readRunTurnContext(runId);
      if (!context) return;
      const turn = await deps.projectedTurn(context.conversationId, runId);
      if (!turn) return;
      await send(
        context.conversationId,
        actions.commitTurn(runId, turn, durationMs, context.status),
      );
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
      const response =
        input.outcome === "allow" || input.outcome === "answered" ? "accept" : "decline";
      await send(
        context.conversationId,
        actions.inputCompleted(pendingActionId(input.runId, input.callId), response),
      );
    },
  };
}
