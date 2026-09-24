import type {
  BackendRunInput,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { ContentBlock, Message } from "@chengchenccc/message";
import { PRODUCT_CONSENTED_MCP_TOOLS, PRODUCT_MCP_EXPANDABLE_VARS } from "../agent/index.js";
import type { AgentRun, BranchInput } from "./domain.js";

/** The final answer of a canonical run sequence (ADR 0017): the last
 *  assistant message carrying text. Used for mention cascade and surface
 *  display; returns undefined when the run produced no final text. */
export function finalAnswerMessage(messages: readonly Message[] | undefined): Message | undefined {
  return [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && (m.text?.trim() ?? "") !== "");
}

/** Normalized events worth persisting for telemetry. Text/thinking deltas
 *  are transient and large; usage lives on agent_run.terminal_result. */
export const TELEMETRY_EVENT_TYPES = new Set([
  "status",
  "native_tool_started",
  "native_tool_completed",
  "delegation_batch_started",
  "delegation_agent_started",
  "delegation_agent_completed",
  "delegation_batch_completed",
]);

function renderBlock(b: ContentBlock, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (b.type === "text") return `${pad}${b.text}`;
  if (b.type === "tool_use") {
    return `${pad}[tool ${b.name}] ${JSON.stringify(b.input ?? {}).slice(0, 400)}`;
  }
  if (b.type === "tool_result") {
    return `${pad}[${b.is_error ? "tool error" : "tool result"}] ${b.content.slice(0, 600)}`;
  }
  return `${pad}[${b.type}]`;
}

function renderHistoryBridge(history: readonly ProjectedHistoryItem[]): string {
  return history
    .map((h) => {
      const who = h.message.role === "user" ? "User" : "Assistant";
      const body =
        h.message.text && h.message.text.trim() !== ""
          ? h.message.text
          : Array.isArray(h.message.blocks)
            ? h.message.blocks
                .map((b) => renderBlock(b))
                .filter(Boolean)
                .join("\n")
            : "";
      return `${who}: ${body}`;
    })
    .join("\n\n");
}

function renderTodoSection(todoSnapshot: string | null): string {
  if (!todoSnapshot) {
    return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
  }
  try {
    const items = JSON.parse(todoSnapshot) as readonly {
      id: string;
      text: string;
      status: string;
    }[];
    const marks = { pending: "- [ ]", in_progress: "- [~]", done: "- [x]" };
    return `## Current Tasks\n${items
      .map((t) => {
        const mark = marks[t.status as keyof typeof marks] ?? "- [ ]";
        return `${mark} ${t.text} (id: ${t.id})`;
      })
      .join("\n")}`;
  } catch {
    return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
  }
}

/** Assemble the BackendRunInput for a run's single input. The run's
 *  systemPrompt + skillRoots are the frozen snapshot persisted at Run
 *  creation - never re-resolved at dispatch (recovery reuses them); they
 *  stay in the contract as the run-scoped override channel (ADR 0020).
 *  The Product Context (identity + current task list) rides the same
 *  prompt so CLI backends carry their run identity into product tools. */
export function buildRunInput(
  deps: {
    conversationTitleOf?: (conversationId: string) => string | null | undefined;
  },
  run: AgentRun,
  history: readonly ProjectedHistoryItem[],
  input: BranchInput,
  workspace: WorkspaceBinding,
  cliSessionRef: string | undefined,
  lastTodo: string | null,
  productToolsToken: string,
): BackendRunInput {
  const bridge = !cliSessionRef && history.length > 0 ? renderHistoryBridge(history) : "";
  const inputText = input.message.text ?? "";
  const runSnapshot: {
    runId: string;
    model: typeof run.modelRef;
    configRevision: number;
    permissionMode?: "ask" | "auto" | "deny" | "yolo";
    systemPrompt?: string;
    skillRoots?: readonly string[];
    cliSessionRef?: string;
    workflowBudgetTokens?: number;
  } = {
    runId: run.runId,
    model: run.modelRef,
    configRevision: run.configRevision,
  };

  // Product tools are authenticated by the run's bearer token (minted at
  // dispatch, revoked at settle) — the MCP layer takes the run from the token
  // and ignores any `identity` argument. This block therefore exists for what
  // the model legitimately needs: which run it is in, and its current task
  // list.
  // (It used to say "always pass the identity argument", which made an opaque
  // 24-char id a precondition for every product call: the model sometimes
  // echoed a stale one, and the mismatch check rejected a legitimate call.)
  const productContext = [
    "## Product Context",
    "Your run identity (reference only — product tools read it from the",
    "session token, never from your arguments):",
    `- runId: ${run.runId}`,
    `- conversationId: ${run.conversationId}`,
    `- agentId: ${run.agentId}`,
    `- branchId: ${run.branchId}`,
    "",
    renderTodoSection(lastTodo),
  ].join("\n");
  if (run.systemPrompt) {
    runSnapshot.systemPrompt = `${run.systemPrompt}\n\n${productContext}`;
  } else {
    runSnapshot.systemPrompt = productContext;
  }
  if (run.skillRoots && run.skillRoots.length > 0) runSnapshot.skillRoots = run.skillRoots;
  if (cliSessionRef) runSnapshot.cliSessionRef = cliSessionRef;
  if (run.permissionMode) {
    runSnapshot.permissionMode = run.permissionMode as "ask" | "auto" | "deny" | "yolo";
  }
  if (run.workflowBudgetTokens != null) runSnapshot.workflowBudgetTokens = run.workflowBudgetTokens;
  return {
    input: {
      inputId: input.inputId,
      message: bridge ? { ...input.message, text: `${bridge}\n\n${inputText}` } : input.message,
    },
    run: runSnapshot,
    ...(run.workflow ? { workflow: run.workflow } : {}),
    workspace,
    productToolsToken,
    mcpExpandableVars: PRODUCT_MCP_EXPANDABLE_VARS,
    consentedMcpTools: PRODUCT_CONSENTED_MCP_TOOLS,
    // Auto-title: tell the child whether this conversation already has a
    // title so later turns keep retrying only while it is missing.
    convTitled: Boolean(deps.conversationTitleOf?.(run.conversationId)),
    metadata: {
      conversationId: run.conversationId,
      agentId: run.agentId,
      branchId: run.branchId,
    },
  };
}
