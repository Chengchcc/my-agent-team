import { normalizeForLarkMarkdown } from "../markdown-normalizer.js";
import type { PendingActionState, RunCardState } from "./card-state.js";

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
const LIVE_STEPS = 2;
const TERMINAL_STEPS = 5;

/** Stable element ids (CardKit element updates address these; the renderer
 *  must not depend on element order). */
export const OUTPUT_ELEMENT_ID = "agent_output";
export const ACTIVITY_ELEMENT_ID = "activity_md";
export const TOOLS_ELEMENT_ID = "tool_summary";
export const TODO_ELEMENT_ID = "todo_summary";
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

/** The activity line: what the agent is doing RIGHT NOW. Thinking stays a
 *  light line (raw thinking is never shown), the current tool its label, and
 *  a parked ask its prompt — the ask is the one thing the user must act on. */
export function renderActivityContent(state: RunCardState): string {
  if (state.terminal) return "";
  if (state.pendingAction) {
    const lines: string[] = [];
    if (state.pendingAction.prompt) lines.push(`❓ ${state.pendingAction.prompt}`);
    if (state.pendingAction.kind === "ask" && state.pendingAction.allowFreeText) {
      // Free text: replying in the topic answers the ask (postMessage
      // intercept) — the hint names the action that actually works.
      lines.push("（直接在本话题回复即可作答）");
    }
    return lines.join("\n");
  }
  if (state.activeTool) return `🧪 ${state.activeTool.label}`;
  return "🧠 正在分析问题";
}

/** Completed tool steps: a compact tail. Raw arguments and results never
 *  appear here — the labels come from the tool's own describeStart. */
export function renderToolsContent(state: RunCardState): string {
  // Nothing to say while live with no steps yet.
  if (!state.terminal && state.completedTools.length === 0) return "";
  const recent = state.completedTools.slice(-(state.terminal ? TERMINAL_STEPS : LIVE_STEPS));
  const lines: string[] = [];
  // Terminal headline (the plan: "执行了 N 个操作"); a run with no tools at
  // all still owes the user its failure text below.
  if (state.terminal && state.completedTools.length > 0) {
    lines.push(`执行了 ${state.completedTools.length} 个操作`);
  }
  for (const step of recent) {
    lines.push(step.outcome === "error" ? `⚠️ ${step.label}（失败）` : `✓ ${step.label}`);
  }
  if (state.terminal?.error) lines.push(`⚠️ 失败：${state.terminal.error.slice(0, 200)}`);
  if (lines.length === 0) return "";
  return lines.join("\n");
}

/** The todo panel: a LOW-WEIGHT progress projection (never a second card,
 *  never mixed into the ask area). Shows the active item, at most two
 *  completed and two pending, and says how much is left. Structural state:
 *  it is replaced, never typewriter-updated. */
export function renderTodoPanel(state: RunCardState): Record<string, unknown> | null {
  const items = state.todos;
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === "done");
  const active = items.filter((t) => t.status === "in_progress");
  const pending = items.filter((t) => t.status === "pending");
  const cancelled = items.filter((t) => t.status === "cancelled");
  const visible = [...done.slice(-2), ...active.slice(0, 1), ...pending.slice(0, 2)];

  const icon = (status: string): string => {
    if (status === "done") return "✓";
    if (status === "in_progress") return "●";
    if (status === "cancelled") return "—";
    return "○";
  };
  const sanitize = (text: string): string =>
    text
      .replace(/[*_~`[\]<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  const lines = visible.map((t) => {
    const label = sanitize(t.text);
    return t.status === "in_progress"
      ? `${icon(t.status)} **${label}**`
      : `${icon(t.status)} ${label}`;
  });
  // Cancelled items only clutter a live plan; they show once the run is over.
  if (state.terminal && cancelled.length > 0) {
    for (const t of cancelled.slice(-2)) lines.push(`${icon("cancelled")} ${sanitize(t.text)}`);
  }
  const remaining = items.length - visible.length;
  if (remaining > 0) lines.push(`还有 ${remaining} 项 · 在 Web 查看`);

  return {
    tag: "collapsible_panel",
    element_id: TODO_ELEMENT_ID,
    expanded: active.length > 0 && !state.terminal,
    header: {
      title: { tag: "markdown", content: `**进度 ${done.length} / ${items.length}**` },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    padding: "8px 8px 8px 8px",
    vertical_spacing: "4px",
    elements: [{ tag: "markdown", content: lines.join("\n"), text_size: "notation" }],
  };
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
  action: PendingActionState,
): Record<string, unknown>[] {
  const buttons: Record<string, unknown>[] = [];
  // Element ids must be ASCII, start with a letter and stay ≤20 chars
  // (Feishu 300301). Deriving them from the option VALUE blew that limit on
  // the first real Chinese/path label (`ask_tmp_plans_plan_md`), which
  // rejected the whole card and, after three strikes, degraded it — the ask
  // never became clickable. Position is the only stable, short identity.
  action.options.slice(0, 4).forEach((opt, index) => {
    buttons.push({
      tag: "button",
      element_id: `ask_opt_${index}`,
      text: { tag: "plain_text", content: opt.label },
      type: "default",
      width: "fill",
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
  });
  if (action.kind === "approval") {
    return [
      {
        tag: "button",
        element_id: "approve_button",
        text: { tag: "plain_text", content: "批准" },
        type: "primary",
        width: "fill",
        behaviors: [
          { type: "callback", value: { runId, callId: action.callId, action: "approve" } },
        ],
      },
      {
        tag: "button",
        element_id: "reject_button",
        text: { tag: "plain_text", content: "拒绝" },
        type: "danger",
        width: "fill",
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

/** The dedicated ask/approval card. While a human must act, the run card
 *  steps aside: Card JSON 2.0 cannot nest a form with a collapsible panel,
 *  and the user's attention belongs on the question. Header is orange — an
 *  ask is not a failure. Shows ONE progress line, never the todo panel. */
export function renderAskCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  const action = state.pendingAction;
  const isApproval = action?.kind === "approval";
  const elements: Record<string, unknown>[] = [];

  if (action?.prompt) {
    // ≤3 lines of question: more context belongs in Web.
    const prompt = action.prompt.split("\n").slice(0, 3).join("\n");
    elements.push({ tag: "markdown", content: prompt });
  }
  const freeTextAsk =
    action !== null && !isApproval && action.allowFreeText && action.options.length === 0;
  if (freeTextAsk && action !== null) {
    // Card JSON 2.0 form: the input holds the text locally and one submit
    // carries every field — no per-keystroke callbacks. The button keeps a
    // `value` (Feishu rejects interactive components without one, 200340) AND
    // a `name`, so identity survives whichever carrier the submit preserves.
    elements.push({
      tag: "form",
      name: "ask_form",
      elements: [
        {
          tag: "input",
          name: "answer",
          placeholder: { tag: "plain_text", content: "输入你的回答…" },
        },
        {
          tag: "button",
          element_id: "ask_submit",
          name: "ask_submit",
          type: "primary",
          form_action_type: "submit",
          text: { tag: "plain_text", content: "继续执行" },
          value: {
            runId: meta.runId,
            callId: action.callId,
            questionId: action.questionId,
            action: "answer_ask",
          },
        },
      ],
    });
  } else if (action && !isApproval && action.allowFreeText) {
    elements.push({
      tag: "markdown",
      content: "（也可以直接在本话题回复作答）",
      text_size: "notation",
    });
  }
  if (action && !freeTextAsk) {
    // Options stay OUTSIDE a form: a form container must hold at least one
    // submit button (Feishu 300123, verified against the card API), so a
    // buttons-only form is rejected outright and the question would vanish.
    // Alignment comes from width:fill instead - each option owns a row.
    elements.push(...pendingActionButtons(meta.runId, action));
  }
  // The plan the question is about stays on the card: the progress panel is
  // what makes "which branch?" answerable in context (live feedback).
  const todoPanel = renderTodoPanel(state);
  if (todoPanel) elements.push(todoPanel);
  if (meta.webUrl) {
    elements.push({
      tag: "markdown",
      content: `[在 Web 查看](${meta.webUrl})`,
      text_size: "notation",
    });
  }

  return {
    schema: "2.0",
    config: {
      // No streaming_mode: an interactive card must not be in the streaming
      // view (the watcher closes the mode before replacing with this card).
      update_multi: true,
      width_mode: "fill",
      enable_forward: false,
    },
    header: {
      title: {
        tag: "plain_text",
        content: isApproval ? "需要确认" : "需要你的回答",
      },
      template: "orange",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements,
    },
  };
}

/** One entry point for the watcher: a parked action replaces the run card
 *  with the ask card; everything else renders as the run card. */
export function renderCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  if (state.pendingAction && !state.terminal) return renderAskCard(state, meta);
  return renderRunCard(state, meta);
}

export function renderRunCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  const status = cardStatusKey(state);
  const header = HEADER_BY_STATUS[status] ?? HEADER_BY_STATUS.streaming!;

  // Visual hierarchy (plan): what the agent is doing → the answer → progress
  // → steps → actions → footer. activity/output/tools/status are ALWAYS
  // present even when empty: CardKit's element update needs the target
  // element to exist, and omitting an empty one made the first tool
  // completion fail with 300313 (not find elementID).
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", element_id: ACTIVITY_ELEMENT_ID, content: renderActivityContent(state) },
    {
      tag: "markdown",
      element_id: OUTPUT_ELEMENT_ID,
      content: renderOutputContent(state),
    },
  ];
  const todoPanel = renderTodoPanel(state);
  if (todoPanel) elements.push(todoPanel);
  elements.push({
    tag: "markdown",
    element_id: TOOLS_ELEMENT_ID,
    content: renderToolsContent(state),
  });

  if (state.pendingAction) {
    elements.push(...pendingActionButtons(meta.runId, state.pendingAction));
  } else if (!state.terminal) {
    elements.push(stopButton(meta.runId));
  }
  elements.push({
    tag: "markdown",
    element_id: STATUS_ELEMENT_ID,
    content: renderStatusContent(state, meta),
  });

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
