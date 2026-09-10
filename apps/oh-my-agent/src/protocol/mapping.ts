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
    case "delegation_batch_started":
      return {
        type: "delegation_batch_started",
        batchId: String(event.data.batchId ?? ""),
        label: String(event.data.label ?? ""),
        agentCount: Number(event.data.agentCount ?? 0),
      };
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
