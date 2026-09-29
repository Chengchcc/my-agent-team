/** Translates a run's live events into AHP chat actions (ADR 0040 decision 4).
 *
 *  The execution path already publishes these events for the old run stream; this is the writer
 *  that turns the same facts into the actions the chat channel carries, so a surface that reads
 *  AHP state streams without a second subscription.
 *
 *  The event shapes are the contract's (`@chengchenccc/agent-contract`), and typing the translator
 *  against that union is what makes a shape change a build error instead of silence. The first
 *  version of this file declared its own `{type, payload}` shape: it matched nothing the runtime
 *  ever emits, so every run streamed zero actions, and its vectors - written against the same
 *  private guess - stayed green the whole time.
 *
 *  Ordering is forced by the protocol: a turn has to exist before any of its parts do, and a part
 *  has to exist before a delta can target it (every chat action addresses the active turn by id
 *  and is a no-op without it). So the wiring opens the turn, streams into it, and folds it into
 *  history when the run's rows are committed - the projection is the authority for history.
 *
 *  A part's id carries its position among the turn's parts, because that is how the projection
 *  numbers them; the stream has to hand out the same ids or the surface keeps two copies of the
 *  same text. (Upstream action shapes read on 2026-09-29, protocol v0.9.0.) */
import type { BackendEvent } from "@chengchenccc/agent-contract";
import { enumValue } from "@chengchenccc/ahp-client";
import type {
  ChatDeltaAction,
  ChatInputCompletedAction,
  ChatReasoningAction,
  ChatResponsePartAction,
  ChatToolCallCompleteAction,
  ChatToolCallStartAction,
  ChatTurnCompleteAction,
  ChatTurnStartedAction,
  InputRequestResponsePart,
  MarkdownResponsePart,
  Message,
  ReasoningResponsePart,
  ResponsePart,
  StateAction,
  Turn,
} from "@microsoft/agent-host-protocol";
import { pendingActionId } from "../agent-run/domain.js";

/** What the surface needs in order to show a turn before its first part arrives. */
export interface TurnOpening {
  /** The message that started the turn. The projection re-states it from the ledger at commit. */
  readonly text: string;
  readonly startedAt: string;
  /** The ledger row that carries this message, once the product knows it. A surface keys its item
   *  by that id, and a preview without one would sit beside the real message as a second bubble
   *  when the commit re-states the turn. */
  readonly messageId?: string;
}

export interface ChatActionTranslator {
  /** Open the turn an event stream belongs to. Empty once it is open. */
  openTurn(runId: string, opening: TurnOpening): StateAction[];
  /** Actions to dispatch for this event, in order. Empty when the event is not chat-shaped. */
  translate(runId: string, event: BackendEvent): StateAction[];
  /** The run's rows are committed: replace the previewed turn with the projection's own - its
   *  message and parts carry the ledger ids and coordinates the stream cannot know - and fold it
   *  into the history. Empty when the turn was never opened (nothing streamed): a run this process
   *  did not watch from the start arrives with the next snapshot, and re-stating it here would put
   *  a second copy of it on a surface that already has one. */
  commitTurn(
    runId: string,
    turn: Pick<Turn, "message" | "responseParts">,
    durationMs: number,
  ): StateAction[];
  /** A turn the host just appended to the ledger, with nothing streamed for it: the projection is
   *  the only source (the continuity record works this way). Announcing it in full is what a
   *  surface watching before the record existed needs; there is no preview to fold. */
  announceContinuity(
    turnId: string,
    turn: Pick<Turn, "message" | "responseParts" | "startedAt">,
  ): StateAction[];
  /** The human answered, or the request expired: the part that asked stops reading as pending.
   *  Upstream targets it by request id, and the response is the projection's own vocabulary, so a
   *  surface that reloads later agrees with what it was told live. */
  inputCompleted(requestId: string, response: "accept" | "decline" | "cancel"): StateAction[];
  /** Forget a finished run. */
  drop(runId: string): void;
}

export function createChatActionTranslator(): ChatActionTranslator {
  /** Each run's parts, in the order they opened, so a new part's id carries its position. A tool
   *  call is a part too (the reducer appends one), so it reserves a slot without owning an id. */
  const parts = new Map<string, string[]>();
  /** The part the current run of deltas appends to. */
  const open = new Map<string, string>();
  /** Turns this process opened, with the start time the surface was told. */
  const openTurns = new Map<string, { startedAt: string }>();
  /** Human input requests already announced. The durable row is idempotent by id, and so is the
   *  card: announcing one twice would put two cards on the surface for one question. */
  const announcedRequests = new Map<string, Set<string>>();

  const partsOf = (runId: string): string[] => {
    let list = parts.get(runId);
    if (!list) {
      list = [];
      parts.set(runId, list);
    }
    return list;
  };

  const partAction = (runId: string, part: ResponsePart): StateAction => ({
    type: enumValue<ChatResponsePartAction["type"]>("chat/responsePart"),
    turnId: runId,
    part,
  });

  /** Announce a part with an empty body; the deltas append to it. */
  const responsePart = (
    runId: string,
    kind: "markdown" | "reasoning",
    partId: string,
  ): StateAction =>
    partAction(
      runId,
      kind === "reasoning"
        ? { kind: enumValue<ReasoningResponsePart["kind"]>("reasoning"), id: partId, content: "" }
        : { kind: enumValue<MarkdownResponsePart["kind"]>("markdown"), id: partId, content: "" },
    );

  const announceRequest = (runId: string, requestId: string): boolean => {
    let seen = announcedRequests.get(runId);
    if (!seen) {
      seen = new Set();
      announcedRequests.set(runId, seen);
    }
    if (seen.has(requestId)) return false;
    seen.add(requestId);
    return true;
  };

  /** Append a delta, opening the part first when this is a new run of the same kind. */
  const appendDelta = (
    runId: string,
    kind: "markdown" | "reasoning",
    text: string,
  ): StateAction[] => {
    const segment = kind === "reasoning" ? "reasoning" : "text";
    const current = open.get(runId);
    const fresh = current === undefined || !current.startsWith(`${runId}:${segment}:`);
    const partId = fresh ? `${runId}:${segment}:${partsOf(runId).length}` : (current as string);
    if (fresh) partsOf(runId).push(partId);
    open.set(runId, partId);
    const delta: ChatDeltaAction | ChatReasoningAction =
      kind === "reasoning"
        ? {
            type: enumValue<ChatReasoningAction["type"]>("chat/reasoning"),
            turnId: runId,
            partId,
            content: text,
          }
        : {
            type: enumValue<ChatDeltaAction["type"]>("chat/delta"),
            turnId: runId,
            partId,
            content: text,
          };
    return fresh ? [responsePart(runId, kind, partId), delta] : [delta];
  };

  /** State a turn exactly as the projection has it: `chat/turnStarted` replaces the active turn
   *  wholesale, parts included, which is what puts projected parts in place of a preview. */
  const turnActions = (
    turnId: string,
    startedAt: string,
    turn: Pick<Turn, "message" | "responseParts">,
    durationMs: number,
  ): StateAction[] => [
    {
      type: enumValue<ChatTurnStartedAction["type"]>("chat/turnStarted"),
      turnId,
      startedAt,
      message: turn.message,
    },
    ...turn.responseParts.map((part) => partAction(turnId, part)),
    {
      type: enumValue<ChatTurnCompleteAction["type"]>("chat/turnComplete"),
      turnId,
      duration: durationMs,
    },
  ];

  /** A tool call is one part of the turn: it takes a slot, and it ends the current text run. */
  const startTool = (
    runId: string,
    tool: { toolName: string; callId: string; activity?: string },
  ): StateAction[] => {
    partsOf(runId).push(`${runId}:toolCall:${tool.callId}`);
    open.delete(runId);
    return [
      {
        type: enumValue<ChatToolCallStartAction["type"]>("chat/toolCallStart"),
        turnId: runId,
        toolCallId: tool.callId,
        toolName: tool.toolName,
        displayName: tool.toolName,
        ...(tool.activity !== undefined ? { intention: tool.activity } : {}),
      },
    ];
  };

  const completeTool = (
    runId: string,
    tool: { toolName: string; callId: string; result?: Readonly<Record<string, unknown>> },
  ): StateAction[] => {
    // The bus carries the tool's raw result, whose `isError` is what the loop itself reads.
    // A tool that fails without saying so streams as success and is corrected by the projection
    // when the run commits: the committed rows are the authority, the stream is a preview.
    const failed = tool.result?.isError === true;
    const pastTenseMessage = failed ? `${tool.toolName} failed` : `${tool.toolName} finished`;
    return [
      {
        type: enumValue<ChatToolCallCompleteAction["type"]>("chat/toolCallComplete"),
        turnId: runId,
        toolCallId: tool.callId,
        result: { success: !failed, pastTenseMessage },
      },
    ];
  };

  return {
    openTurn(runId, opening) {
      if (openTurns.has(runId)) return [];
      openTurns.set(runId, { startedAt: opening.startedAt });
      return [
        {
          type: enumValue<ChatTurnStartedAction["type"]>("chat/turnStarted"),
          turnId: runId,
          startedAt: opening.startedAt,
          message: {
            text: opening.text,
            origin: { kind: enumValue<Message["origin"]["kind"]>("user") },
            ...(opening.messageId === undefined ? {} : { _meta: { messageId: opening.messageId } }),
          },
        },
      ];
    },

    translate(runId, event) {
      switch (event.type) {
        case "text_delta":
          return event.text === "" ? [] : appendDelta(runId, "markdown", event.text);
        case "thinking_delta":
          return event.text === "" ? [] : appendDelta(runId, "reasoning", event.text);
        case "native_tool_started":
        case "product_tool_started":
          return startTool(runId, {
            toolName: event.toolName,
            callId: event.callId,
            ...(event.type === "native_tool_started" && event.activity !== undefined
              ? { activity: event.activity }
              : {}),
          });
        case "native_tool_completed":
        case "product_tool_completed":
          return completeTool(runId, {
            toolName: event.toolName,
            callId: event.callId,
            ...(event.result !== undefined ? { result: event.result } : {}),
          });
        case "approval_requested":
        case "ask_requested": {
          // A parked run is a product fact, not a backend detail: without this the surface learns
          // nothing until it re-subscribes, which is exactly the case the card exists for.
          const requestId = pendingActionId(runId, event.payload.callId);
          if (!announceRequest(runId, requestId)) return [];
          // The request is a part of the turn too, so it holds a position among them.
          partsOf(runId).push(`${runId}:inputRequest:${requestId}`);
          open.delete(runId);
          return [
            partAction(runId, {
              kind: enumValue<InputRequestResponsePart["kind"]>("inputRequest"),
              request: {
                id: requestId,
                message: enumValue<Message["origin"]["kind"]>(
                  event.type === "ask_requested" ? "ask" : "approval",
                ),
                // The durable row's payload, under the same key the projection uses, so a card
                // shows what is being approved on the live edge too. Spread rather than written as
                // a property: upstream's `ChatInputRequest` has no `_meta` slot, and spreading is
                // how the projection carries it - the key is the convention, not a typed field.
                ...(event.payload === undefined
                  ? {}
                  : { _meta: { productRequest: event.payload } }),
              },
            }),
          ];
        }
        default:
          return [];
      }
    },

    commitTurn(runId, turn, durationMs) {
      const opened = openTurns.get(runId);
      if (!opened) return [];
      return turnActions(runId, opened.startedAt, turn, durationMs);
    },

    announceContinuity(turnId, turn) {
      // No duration: a notice is not a turn that ran. The rest is the projection's own statement.
      return turnActions(turnId, turn.startedAt ?? new Date(0).toISOString(), turn, 0);
    },

    inputCompleted(requestId, response) {
      return [
        {
          type: enumValue<ChatInputCompletedAction["type"]>("chat/inputCompleted"),
          requestId,
          response: enumValue<ChatInputCompletedAction["response"]>(response),
        },
      ];
    },

    drop(runId) {
      parts.delete(runId);
      open.delete(runId);
      openTurns.delete(runId);
      announcedRequests.delete(runId);
    },
  };
}
