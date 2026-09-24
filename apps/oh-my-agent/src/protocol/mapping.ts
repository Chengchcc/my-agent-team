import type { BackendEvent } from "@chengchenccc/agent-contract";

/** Map Oma transport event envelopes to Backend core events,
 *  namespacing Runtime-specific details under `backend.oma.*`.
 *  Outcome mapping is the ONLY terminal authority. Lives in the CONTRACT
 *  package so both sides of the stdio boundary map identically: the Coding
 *  Agent's in-process segment and the adapter's wire consumer. */

export interface TransportRunEvent {
  id: number;
  type: string;
  data: Readonly<Record<string, unknown>>;
}

export function mapRunEvent(event: TransportRunEvent): BackendEvent<"oma"> {
  switch (event.type) {
    case "message_update": {
      const text = String(event.data.text ?? "");
      return { type: "text_delta", text };
    }
    case "thinking_update": {
      const text = String(event.data.text ?? "");
      return { type: "thinking_delta", text };
    }
    case "message_start":
    case "message_end":
    case "retry_start":
    case "retry_end":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
      // Runtime lifecycle: namespaced extension, never product state
      return {
        type: `backend.oma.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
    case "tool_execution_start": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      const activity = event.data.activity;
      // `input` deliberately does NOT cross this boundary: it can hold full
      // commands, absolute paths, MCP args, tokens. Only the tool-authored,
      // sanitized activity line travels.
      if (typeof activity === "string" && activity.length > 0) {
        return { type: "native_tool_started", toolName, callId, activity };
      }
      return { type: "native_tool_started", toolName, callId };
    }
    case "tool_execution_end": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      const result = event.data.result as Readonly<Record<string, unknown>> | undefined;
      return { type: "native_tool_completed", toolName, callId, result };
    }
    case "agent_start":
    case "turn_start":
    case "turn_end":
      return { type: "status", status: event.type };
    case "agent_end": {
      // agent_end carries the ACTUAL terminal status from the loop
      // (completed | failed | stopped): map it onto the core terminal
      // vocabulary - completed stays completed, failed stays failed, stopped
      // becomes aborted. Never a bare "agent_end" status.
      const status = String(event.data.status ?? "completed");
      if (status === "failed") return { type: "status", status: "failed" };
      if (status === "stopped") return { type: "status", status: "aborted" };
      return { type: "status", status: "completed" };
    }
    case "delegation_batch_started": {
      // `source` is a closed union on the wire: only the two known values
      // survive, anything else is treated as absent (conservative render).
      const source = event.data.source;
      return {
        type: "delegation_batch_started",
        batchId: String(event.data.batchId ?? ""),
        label: String(event.data.label ?? ""),
        agentCount: Number(event.data.agentCount ?? 0),
        ...(source === "task" || source === "workflow" ? { source } : {}),
      };
    }
    case "delegation_agent_started":
      return {
        type: "delegation_agent_started",
        batchId: String(event.data.batchId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
      };
    case "delegation_agent_completed": {
      const usage = event.data.usage as Readonly<Record<string, unknown>> | undefined;
      return {
        type: "delegation_agent_completed",
        batchId: String(event.data.batchId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
        ok: event.data.ok === true,
        ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "delegation_batch_completed":
      return {
        type: "delegation_batch_completed",
        batchId: String(event.data.batchId ?? ""),
        ok: event.data.ok === true,
        agentCount: Number(event.data.agentCount ?? 0),
        totalTokens: Number(event.data.totalTokens ?? 0),
      };
    default:
      return {
        type: `backend.oma.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
  }
}

/** Oma-internal fields that must not leave the process, keyed by event type.
 *
 *  `Option A envelope` is written to stdout as-is (rpc-mode's onEvent →
 *  `{ type: "event", runId, event }`), and `mapRunEvent` runs LATER, on the
 *  consumer side. So dropping a field in the mapper is not enough: the raw
 *  frame has already reached the adapter's stdout, its logs, and the backend
 *  process. `tool_execution_start.input` holds exactly what must not travel
 *  (full commands, absolute paths, MCP args, tokens), while the tool-authored
 *  `activity` line is what the wire is supposed to carry.
 *
 *  In-process consumers (the TUI reads `input` for its tool card) see the
 *  unmodified envelope, which is why this is applied at the rpc writer rather
 *  than at envelope construction. */
export function forWire(envelope: TransportRunEvent): TransportRunEvent {
  if (envelope.type !== "tool_execution_start") return envelope;
  const { input: _input, ...data } = envelope.data;
  return { ...envelope, data };
}
