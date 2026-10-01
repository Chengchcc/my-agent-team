/** Map ACP `session/update` notifications onto core product events
 *  (ADR 0039 decision 1's contract; same direction as the oma adapter's
 *  mapper). The agent's own vocabulary stops here — the product layer and
 *  both surfaces only ever see core events.
 *
 *  The SDK's zod schema already parsed and validated the update before it
 *  reaches this mapper (unknown `sessionUpdate` tags are dropped at parse
 *  time), so the union here is trusted, not re-guarded. */

import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { Message } from "@chengchenccc/message";
import type { BackendEvent, Usage } from "../protocol/index.js";

type SessionUpdate = SessionNotification["update"];

/** Everything one ACP run accumulates for its terminal outcome. Usage is
 *  NOT here: the v1 update union carries no typed usage payload (it rides
 *  `_meta`, which v1 strips) — the prompt response's `usage` field is the
 *  honest source and the backend reads it at settle time. */
/** One durable piece of a run's output, in arrival order. The canonical
 *  outcome (ADR 0017) is derived from these: text and tool_use become
 *  assistant messages, tool_result becomes a `tool` message. Live events are
 *  transient; these parts are what survives into the ledger. */
export type AcpOutcomePart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool_result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export interface AcpAccumulator {
  /** Durable output pieces, in arrival order. */
  readonly parts: AcpOutcomePart[];
  /** toolCallId → tool name, from the FIRST report: tool_call_update is an
   *  upsert whose later reports omit the name, and the completed event must
   *  still name the tool it finished. */
  readonly toolNames: Map<string, string>;
  /** toolCallId → rawInput, from whichever report carried it: later upserts
   *  omit it, and the durable tool_use must keep the arguments the model
   *  actually sent. */
  readonly toolInputs: Map<string, unknown>;
  /** toolCallIds already recorded as a tool_call part. */
  readonly started: Set<string>;
  /** toolCallIds already recorded as a tool_result part. */
  readonly settled: Set<string>;
}

export function createAcpAccumulator(): AcpAccumulator {
  return {
    parts: [],
    toolNames: new Map(),
    toolInputs: new Map(),
    started: new Set(),
    settled: new Set(),
  };
}

/** Map one session/update into core events (0..n) and accumulate text.
 *  Kinds with no product meaning are listed in the default case and
 *  dropped on purpose. */
export function mapAcpUpdate(
  acc: AcpAccumulator,
  update: SessionUpdate,
): readonly BackendEvent<"acp">[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content.type !== "text") return [];
      acc.parts.push({ kind: "text", text: update.content.text });
      return [{ type: "text_delta", text: update.content.text }];
    }
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return [];
      return [{ type: "thinking_delta", text: update.content.text }];
    }
    case "tool_call":
    case "tool_call_update": {
      const callId = update.toolCallId;
      const reported = update.name ?? update.title;
      if (reported) acc.toolNames.set(callId, reported);
      if (update.rawInput !== undefined) acc.toolInputs.set(callId, update.rawInput);
      const toolName = acc.toolNames.get(callId) ?? "unknown";
      const status = update.status ?? "pending";
      // Durable facts first (ADR 0017): one tool_use when the call is first
      // seen, one tool_result when it settles. The events below are transient
      // and never survive a restart, which is how four tool calls could run
      // and leave zero rows in the ledger.
      if (!acc.started.has(callId)) {
        acc.started.add(callId);
        acc.parts.push({
          kind: "tool_call",
          toolCallId: callId,
          name: toolName,
          input: acc.toolInputs.get(callId) ?? {},
        });
      }
      if ((status === "completed" || status === "failed") && !acc.settled.has(callId)) {
        acc.settled.add(callId);
        acc.parts.push({
          kind: "tool_result",
          toolCallId: callId,
          content: toolResultText(update),
          isError: status === "failed",
        });
      }
      if (status === "pending" || status === "in_progress") {
        return [
          {
            type: "native_tool_started",
            toolName,
            callId,
            // The agent-authored title is the pre-sanitized human activity
            // line (ADR 0033): pass it through verbatim, never synthesize.
            ...(update.title ? { activity: update.title } : {}),
          },
        ];
      }
      return [
        {
          type: "native_tool_completed",
          toolName,
          callId,
          ...(update.rawOutput &&
          typeof update.rawOutput === "object" &&
          !Array.isArray(update.rawOutput)
            ? { result: update.rawOutput as Readonly<Record<string, unknown>> }
            : {}),
        },
      ];
    }
    case "plan": {
      // ponytail: rides the oma-namespaced event so both surfaces render the
      // plan strip today; promote to a core todo_update when a second
      // non-oma consumer needs it (the ADR 0039 decision-1 pattern).
      return [
        {
          type: "backend.oma.todo_update",
          payload: { items: planEntriesToItems(update.entries) },
        } as unknown as BackendEvent<"acp">,
      ];
    }
    case "plan_removed":
      return [
        {
          type: "backend.oma.todo_update",
          payload: { items: [] },
        } as unknown as BackendEvent<"acp">,
      ];
    // "plan_update" is a single-entry patch; our surfaces render
    // replace-semantics full lists only, and a patch cannot rebuild one —
    // dropping it waits for the agent's next full "plan" (omp sends full
    // plans). Rendering a patch as a wipe would be worse than a delay.
    case "plan_update":
      return [];
    default:
      // user_message_chunk (echo of our own prompt), usage_update (payload
      // stripped by the v1 union — see the accumulator note),
      // available_commands_update, current_mode_update, config_option_update,
      // session_info_update, notice, compaction_update: real on the wire,
      // not product state.
      return [];
  }
}

/** Map the prompt response's experimental usage report onto ours. Fields
 *  are optional by design; missing stays missing (never zero). */
export function mapAcpUsage(usage: PromptResponse["usage"]): Usage | undefined {
  if (!usage) return undefined;
  const num = (value: unknown): value is number => typeof value === "number";
  const mapped = {
    ...(num(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(num(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
    ...(num(usage.cachedReadTokens) ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(num(usage.cachedWriteTokens) ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** Build the canonical outcome messages: one assistant message per text
 *  piece, in order (matches the omp adapter's outcome shape; the final
 *  answer is the last one with text). */
export function buildOutcomeMessages(parts: readonly AcpOutcomePart[]): Message[] {
  const out: Message[] = [];
  let text = "";
  const flush = () => {
    if (text === "") return;
    out.push({ role: "assistant", text });
    text = "";
  };
  for (const part of parts) {
    if (part.kind === "text") {
      text += part.text;
      continue;
    }
    flush();
    if (part.kind === "tool_call") {
      out.push({
        role: "assistant",
        blocks: [{ type: "tool_use", id: part.toolCallId, name: part.name, input: part.input }],
      });
      continue;
    }
    out.push({
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          is_error: part.isError,
        },
      ],
    });
  }
  flush();
  return out;
}

/** Text of a settled tool call. `rawOutput` wins when it is a string; then
 *  the text blocks inside `content`; otherwise the structured payload is
 *  serialized as-is. A tool result must say something — silence in the
 *  ledger is the defect this file just stopped producing. */
function toolResultText(update: {
  readonly rawOutput?: unknown;
  readonly content?: readonly unknown[] | null;
}): string {
  if (typeof update.rawOutput === "string" && update.rawOutput !== "") return update.rawOutput;
  const texts: string[] = [];
  for (const entry of update.content ?? []) {
    const item = entry as { type?: unknown; text?: unknown; content?: unknown };
    const inner = item.content as { type?: unknown; text?: unknown } | undefined;
    if (inner?.type === "text" && typeof inner.text === "string") texts.push(inner.text);
    else if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  if (texts.length > 0) return texts.join("");
  if (update.content && update.content.length > 0) return JSON.stringify(update.content);
  if (update.rawOutput === undefined || update.rawOutput === null) return "";
  try {
    return JSON.stringify(update.rawOutput);
  } catch {
    return String(update.rawOutput);
  }
}

function planEntriesToItems(
  entries:
    | readonly { content: string; status: "pending" | "in_progress" | "completed" }[]
    | undefined,
) {
  return (entries ?? []).map((entry, index) => ({
    id: String(index),
    text: entry.content,
    status:
      entry.status === "completed"
        ? "done"
        : entry.status === "in_progress"
          ? "in_progress"
          : "pending",
  }));
}
