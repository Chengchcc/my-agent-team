/** Translates a run's live events into AHP chat actions (ADR 0040 decision 4).
 *
 *  The execution path already publishes these events for the old run stream; this is the writer
 *  that turns the same facts into the actions the chat channel carries, so a surface that reads
 *  AHP state streams without a second subscription.
 *
 *  A part has to exist before a delta can target it, and re-announcing one would wipe what has
 *  accumulated, so the translator remembers which parts it has opened. Part ids follow the
 *  projection's convention (`<turnId>:text:<n>`), which is what makes the streamed part and the
 *  final projected one the same object on the client. */
import type { StateAction } from "@microsoft/agent-host-protocol";

/** The subset of the run's events a chat channel cares about. */
export interface RunLiveEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface ChatActionTranslator {
  /** Actions to dispatch for this event, in order. Empty when it is not chat-shaped. */
  translate(runId: string, event: RunLiveEvent): StateAction[];
  /** Forget a finished run's parts. */
  drop(runId: string): void;
}

export function createChatActionTranslator(): ChatActionTranslator {
  const opened = new Set<string>();

  const openPart = (runId: string, kind: string, partId: string): StateAction[] => {
    const key = `${runId}:${partId}`;
    if (opened.has(key)) return [];
    opened.add(key);
    return [
      {
        type: "chat/responsePart",
        turnId: runId,
        part: { kind, id: partId, content: "" },
      } as unknown as StateAction,
    ];
  };

  return {
    translate(runId, event) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      switch (event.type) {
        case "text_delta": {
          const text = payload.text;
          if (typeof text !== "string" || text === "") return [];
          const partId = `${runId}:text:0`;
          return [
            ...openPart(runId, "markdown", partId),
            { type: "chat/delta", turnId: runId, partId, content: text } as unknown as StateAction,
          ];
        }
        case "thinking_delta": {
          const text = payload.text;
          if (typeof text !== "string" || text === "") return [];
          const partId = `${runId}:reasoning:0`;
          return [
            ...openPart(runId, "reasoning", partId),
            {
              type: "chat/reasoning",
              turnId: runId,
              partId,
              content: text,
            } as unknown as StateAction,
          ];
        }
        default:
          return [];
      }
    },
    drop(runId) {
      for (const key of [...opened]) {
        if (key.startsWith(`${runId}:`)) opened.delete(key);
      }
    },
  };
}
