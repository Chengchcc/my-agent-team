import { normalizeForLarkMarkdown } from "../markdown-normalizer.js";
import type { RunCardState } from "./card-state.js";

/**
 * ADR 0031: render the card display state as Lark Card JSON 2.0.
 *
 * Single content source for the full-card renders (CardKit create / frame
 * replaces / terminal) and the streaming element pushes. Element ids are
 * stable for the card's whole life and ALL streamed elements exist from
 * creation (CardKit can only push to existing elements).
 *
 * Layout: main output (typewriter stream) · process strip (current action
 * + completed steps) · status footer · action buttons (stop / approve).
 */

/** Keep the tail ~10k chars of the transcript (ADR: 8–12k window). */
const MAX_OUTPUT_CHARS = 10_000;
/** Steps shown while running vs at the terminal (full history lives in Web). */
const LIVE_STEPS = 3;
const TERMINAL_STEPS = 5;

export const OUTPUT_ELEMENT_ID = "agent_output";
export const PROCESS_ELEMENT_ID = "process";
export const STATUS_ELEMENT_ID = "run_status";

export interface RunCardMeta {
  runId: string;
  startedAt: number;
  /** Console deep link; when absent no link is rendered. */
  webUrl: string | null;
}

const HEADER_BY_STATUS: Record<string, { title: string; template: string; footer: string }> = {
  queued: { title: "任务已排队", template: "grey", footer: "排队中" },
  thinking: { title: "思考中", template: "blue", footer: "思考中" },
  tool_running: { title: "执行中", template: "blue", footer: "执行中" },
  streaming: { title: "回复中", template: "blue", footer: "回复中" },
  waiting_approval: { title: "等待你的确认", template: "orange", footer: "等待审批" },
  waiting_input: { title: "等待你的回答", template: "orange", footer: "等待回答" },
  completed: { title: "已完成", template: "green", footer: "已完成" },
  failed: { title: "失败", template: "red", footer: "失败" },
  cancelled: { title: "已停止", template: "grey", footer: "已停止" },
};

/** The card's frame key: header title/template + footer word derive from
 *  it. CardKit element streams cannot touch the header, so the watcher
 *  full-replaces the card whenever this key changes. */
export function cardStatusKey(state: RunCardState): string {
  if (state.terminal) return state.terminal.status;
  if (state.waiting === "approval") return "waiting_approval";
  if (state.waiting === "ask") return "waiting_input";
  return state.phase;
}

function elapsedLine(startedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
}

/** Window the transcript to the tail; the full process lives in Web. */
function windowOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `…（较早内容已折叠，完整过程在 Web 查看）\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

/** The streamed body text: identical to what the full card renders. */
export function renderOutputContent(state: RunCardState): string {
  if (state.output.length === 0 && !state.terminal) return "_正在思考…_";
  const normalized = normalizeForLarkMarkdown(windowOutput(state.output));
  if (normalized.markdown) return normalized.markdown;
  return state.terminal ? "（无输出）" : "_正在思考…_";
}

/** The process strip: current action while running, archived steps after.
 *  Raw tool input/output never appears here — labels only. */
export function renderProcessContent(state: RunCardState): string {
  const lines: string[] = [];
  if (state.todos.length > 0) {
    for (const todo of state.todos.slice(-5)) {
      if (todo.status === "completed") lines.push(`✓ ${todo.text}`);
      else if (todo.status === "in_progress") lines.push(`● ${todo.text}`);
      else lines.push(`○ ${todo.text}`);
    }
    if (state.todos.length > 5) lines.push(`… 共 ${state.todos.length} 项`);
    lines.push("");
  }
  if (state.activeTool && !state.terminal) {
    lines.push(`🧪 正在：${state.activeTool.label}`);
  }
  const cap = state.terminal ? TERMINAL_STEPS : LIVE_STEPS;
  const recent = state.completedTools.slice(-cap);
  if (recent.length > 0) {
    lines.push(`已完成 ${state.completedTools.length} 步`);
    for (const step of recent) {
      lines.push(step.outcome === "error" ? `⚠️ ${step.label}（失败）` : `✓ ${step.label}`);
    }
  }
  if (state.terminal?.error) {
    lines.push(`⚠️ 失败：${state.terminal.error.slice(0, 200)}`);
  }
  if (state.pendingAction && state.pendingAction.prompt) {
    lines.push(`❓ ${state.pendingAction.prompt}`);
  }
  if (lines.length === 0) return "…";
  return lines.join("\n");
}

/** The streamed footer line: status word + elapsed + Web link. */
export function renderStatusContent(state: RunCardState, meta: RunCardMeta): string {
  const entry = HEADER_BY_STATUS[cardStatusKey(state)] ?? HEADER_BY_STATUS.streaming!;
  const elapsed = state.terminal ? "" : ` · 耗时 ${elapsedLine(meta.startedAt)}`;
  const webLink = meta.webUrl ? ` · [在 Web 查看](${meta.webUrl})` : "";
  return `**${entry.footer}**${elapsed}${webLink}`;
}

function pendingActionButtons(
  runId: string,
  action: import("./card-state.js").PendingActionState,
): Record<string, unknown>[] {
  const buttons: Record<string, unknown>[] = [];
  for (const opt of action.options.slice(0, 4)) {
    buttons.push({
      tag: "button",
      element_id: `ask_${opt.value.replace(/[^a-zA-Z0-9]/g, "_")}`,
      text: { tag: "plain_text", content: opt.label },
      type: "default",
      behaviors: [
        {
          type: "callback",
          value: {
            runId,
            callId: action.callId,
            questionId: action.questionId,
            action: "answer_ask",
            selectedValue: opt.value,
          },
        },
      ],
    });
  }
  if (action.allowFreeText) {
    buttons.push({
      tag: "button",
      element_id: "ask_other",
      text: { tag: "plain_text", content: "其他…" },
      type: "default",
      behaviors: [
        {
          type: "callback",
          value: {
            runId,
            callId: action.callId,
            questionId: action.questionId,
            action: "answer_ask",
            selectedValue: "",
          },
        },
      ],
    });
  }
  if (action.kind === "approval") {
    return [
      {
        tag: "button",
        element_id: "approve_button",
        text: { tag: "plain_text", content: "批准" },
        type: "primary",
        behaviors: [
          { type: "callback", value: { runId, callId: action.callId, action: "approve" } },
        ],
      },
      {
        tag: "button",
        element_id: "reject_button",
        text: { tag: "plain_text", content: "拒绝" },
        type: "danger",
        behaviors: [
          { type: "callback", value: { runId, callId: action.callId, action: "reject" } },
        ],
      },
    ];
  }
  return buttons;
}

function stopButton(runId: string): Record<string, unknown> {
  return {
    tag: "button",
    element_id: "stop_button",
    text: { tag: "plain_text", content: "停止" },
    type: "danger",
    behaviors: [{ type: "callback", value: { runId, action: "stop" } }],
  };
}

function approvalButtons(runId: string, callId: string): Record<string, unknown>[] {
  return [
    {
      tag: "button",
      element_id: "approve_button",
      text: { tag: "plain_text", content: "批准" },
      type: "primary",
      behaviors: [{ type: "callback", value: { runId, callId, action: "approve" } }],
    },
    {
      tag: "button",
      element_id: "reject_button",
      text: { tag: "plain_text", content: "拒绝" },
      type: "danger",
      behaviors: [{ type: "callback", value: { runId, callId, action: "reject" } }],
    },
  ];
}

export function renderRunCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  const status = cardStatusKey(state);
  const header = HEADER_BY_STATUS[status] ?? HEADER_BY_STATUS.streaming!;

  const elements: Record<string, unknown>[] = [
    { tag: "markdown", element_id: OUTPUT_ELEMENT_ID, content: renderOutputContent(state) },
    { tag: "markdown", element_id: PROCESS_ELEMENT_ID, content: renderProcessContent(state) },
    { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: renderStatusContent(state, meta) },
  ];

  if (state.pendingAction) {
    elements.push(...pendingActionButtons(meta.runId, state.pendingAction));
  } else if (!state.terminal) {
    elements.push(stopButton(meta.runId));
  }

  // streaming_mode only while live: the CardKit create REQUIRES it for the
  // streaming element updates; terminal cards freeze client-side.
  const streamingConfig = state.terminal ? {} : { streaming_mode: true };

  return {
    schema: "2.0",
    config: {
      ...streamingConfig,
      update_multi: true,
      width_mode: "fill",
      enable_forward: false,
    },
    header: {
      title: { tag: "plain_text", content: header.title },
      template: header.template,
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements,
    },
  };
}
