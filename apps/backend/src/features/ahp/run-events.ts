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
import type { StateAction, Turn } from "@microsoft/agent-host-protocol";

/** What the surface needs in order to show a turn before its first part arrives. */
export interface TurnOpening {
  /** The message that started the turn. The projection re-states it from the ledger at commit. */
  readonly text: string;
  readonly startedAt: string;
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

  const partsOf = (runId: string): string[] => {
    let list = parts.get(runId);
    if (!list) {
      list = [];
      parts.set(runId, list);
    }
    return list;
  };

  const responsePart = (runId: string, kind: string, partId: string): StateAction =>
    ({
      type: "chat/responsePart",
      turnId: runId,
      part: { kind, id: partId, content: "" },
    }) as unknown as StateAction;

  /** Append a delta, opening the part first when this is a new run of the same kind. */
  const appendDelta = (
    runId: string,
    kind: "markdown" | "reasoning",
    text: string,
  ): StateAction[] => {
    const segment = kind === "reasoning" ? "reasoning" : "text";
    const current = open.get(runId);
    const fresh = current === undefined || !current.startsWith(`${runId}:${segment}:`);
    let partId = current;
    if (fresh) {
      partId = `${runId}:${segment}:${partsOf(runId).length}`;
      partsOf(runId).push(partId as string);
    }
    open.set(runId, partId as string);
    const delta = {
      type: kind === "reasoning" ? "chat/reasoning" : "chat/delta",
      turnId: runId,
      partId,
      content: text,
    } as unknown as StateAction;
    return fresh ? [responsePart(runId, kind, partId as string), delta] : [delta];
  };

  /** A tool call is one part of the turn: it takes a slot, and it ends the current text run. */
  const startTool = (
    runId: string,
    tool: { toolName: string; callId: string; activity?: string },
  ): StateAction[] => {
    partsOf(runId).push(`${runId}:toolCall:${tool.callId}`);
    open.delete(runId);
    return [
      {
        type: "chat/toolCallStart",
        turnId: runId,
        toolCallId: tool.callId,
        toolName: tool.toolName,
        displayName: tool.toolName,
        ...(tool.activity !== undefined ? { intention: tool.activity } : {}),
      } as unknown as StateAction,
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
        type: "chat/toolCallComplete",
        turnId: runId,
        toolCallId: tool.callId,
        result: { success: !failed, pastTenseMessage },
      } as unknown as StateAction,
    ];
  };

  return {
    openTurn(runId, opening) {
      if (openTurns.has(runId)) return [];
      openTurns.set(runId, { startedAt: opening.startedAt });
      return [
        {
          type: "chat/turnStarted",
          turnId: runId,
          startedAt: opening.startedAt,
          message: { text: opening.text, origin: { kind: "user" } },
        } as unknown as StateAction,
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
        default:
          return [];
      }
    },

    commitTurn(runId, turn, durationMs) {
      const opened = openTurns.get(runId);
      if (!opened) return [];
      // `chat/turnStarted` replaces the active turn wholesale, parts included: re-stating it is what
      // discards the preview and puts the projection's parts in its place, under the same ids.
      return [
        {
          type: "chat/turnStarted",
          turnId: runId,
          startedAt: opened.startedAt,
          message: turn.message,
        },
        ...turn.responseParts.map((part) => ({
          type: "chat/responsePart",
          turnId: runId,
          part,
        })),
        { type: "chat/turnComplete", turnId: runId, duration: durationMs },
      ] as unknown as StateAction[];
    },

    drop(runId) {
      parts.delete(runId);
      open.delete(runId);
      openTurns.delete(runId);
    },
  };
}
