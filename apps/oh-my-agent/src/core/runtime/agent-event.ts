import type { ToolPresentation } from "@chengchenccc/agent-contract";
import type { TodoItem } from "../tools/todo-store.js";

/** Pi-style typed lifecycle events per runtime/oma.md. */
export type OmaLoopEvent =
  | { type: "agent_start" }
  /** Liveness only: proves the loop is alive while it waits on something that
   *  produces no events (a long tool, a slow model call, a subagent). Carries
   *  no content, is never persisted, and every surface ignores it. */
  | { type: "heartbeat" }
  | { type: "agent_end"; status: "completed" | "failed" | "stopped" }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "message_start" }
  | { type: "message_update"; text: string }
  | { type: "thinking_update"; text: string }
  | { type: "message_end" }
  | {
      type: "tool_execution_start";
      toolName: string;
      kind?: "native" | "product";
      callId: string;
      /** The tool's resolved input (model call args), for transcript display.
       *  oma-internal: this NEVER crosses the RPC boundary — surfaces get
       *  `activity` instead. */
      input?: Readonly<Record<string, unknown>>;
      /** User-visible one-line description of what the call is doing,
       *  produced by the tool's describeStart and sanitized by
       *  safeToolSummary. Absent means "the tool cannot describe itself" —
       *  surfaces then fall back to the tool name. */
      activity?: string;
      /** Structured form of the same description (title/detail/icon). */
      presentation?: ToolPresentation;
      /** Wall-clock timeout for this tool (ms, 0 = disabled). */
      timeoutMs?: number;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      kind?: "native" | "product";
      callId: string;
      result?: Readonly<Record<string, unknown>>;
      /** Result-side display metadata (resultSummary / errorSummary). */
      presentation?: ToolPresentation;
    }
  | {
      /** Streaming partial output from a running tool (bash stdout). */
      type: "tool_output";
      toolName: string;
      callId: string;
      text: string;
    }
  | { type: "retry_start"; attempt: number }
  | { type: "retry_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  /** Emitted when the loop drains queued steers at a safe boundary.
   * `drained` carries the injected user texts (pi's message_start(user) →
   * addMessageToChat): surfaces render the user message when the loop
   * actually takes it, not when it was submitted. */
  | { type: "queue_update"; drained?: readonly string[] }
  | {
      /** REAL runtime MCP mount result: the child actually connected and
       *  listed tools. Surfaces the manager-probe vs runtime distinction. */
      type: "mcp_mount_result";
      server: string;
      ok: boolean;
      toolsCount: number;
      error?: string;
    }
  | { type: "stream_rule_triggered"; rule: string }
  | { type: "todo_update"; items: readonly TodoItem[] }
  /** Which surface produced this fan-out. The TUI renders a `task` batch in
   *  its live panel (so the transcript keeps only a batch summary line) while
   *  a `workflow`/script fan-out has no panel and must keep its transcript
   *  status lines. Explicit rather than inferred from `label`: the label is
   *  caller-controlled (`orchestrate` accepts `opts.label`), so inferring
   *  would silently mis-render. Absent = unknown source: consumers keep the
   *  pre-existing behavior (transcript status lines). */
  | {
      type: "delegation_batch_started";
      batchId: string;
      label: string;
      agentCount: number;
      source?: "task" | "workflow";
    }
  | { type: "delegation_agent_started"; batchId: string; agentId: string; label: string }
  | {
      type: "delegation_agent_completed";
      batchId: string;
      agentId: string;
      label: string;
      ok: boolean;
      error?: string;
      usage?: unknown;
    }
  | {
      type: "delegation_batch_completed";
      batchId: string;
      ok: boolean;
      agentCount: number;
      totalTokens: number;
    }
  | { type: "delegation_batch_failed"; batchId: string; error: string }
  | {
      /** Live subagent loop event forwarded to the parent stream. */
      type: "delegation_agent_event";
      batchId: string;
      agentId: string;
      label: string;
      event: OmaLoopEvent;
    };

export type AgentLoopListener = (event: OmaLoopEvent) => void | Promise<void>;
