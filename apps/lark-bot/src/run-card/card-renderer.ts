import { normalizeForLarkMarkdown } from "../markdown-normalizer.js";
import type { RunCardState } from "./card-state.js";

/**
 * ADR 0031: render the card display state as Lark Card JSON 2.0.
 *
 * Two consumers share this module as the single content source:
 *  - the full-card renders (CardKit create / terminal replace)
 *  - the streaming element pushes (CardKit `elements/:id/content`), which
 *    need the SAME text the final card shows so the client-side diff only
 *    ever appends
 * Element ids stay stable for the card's whole life; both streamed elements
 * exist from creation (CardKit can only push to existing elements).
 */

/** Keep the tail ~10k chars of the transcript (ADR: 8–12k window). */
const MAX_OUTPUT_CHARS = 10_000;

export const OUTPUT_ELEMENT_ID = "agent_output";
export const STATUS_ELEMENT_ID = "run_status";
export const ERROR_ELEMENT_ID = "err_msg";

export interface RunCardMeta {
  runId: string;
  startedAt: number;
  /** Console deep link; when absent no link is rendered. */
  webUrl: string | null;
}

const HEADER_BY_STATUS: Record<string, { title: string; template: string; footer: string }> = {
  queued: { title: "任务已排队", template: "grey", footer: "排队中" },
  running: { title: "执行中", template: "blue", footer: "执行中" },
  waiting_approval: { title: "等待你的确认", template: "orange", footer: "等待审批" },
  waiting_input: { title: "等待你的回答", template: "orange", footer: "等待回答" },
  completed: { title: "已完成", template: "green", footer: "已完成" },
  failed: { title: "失败", template: "red", footer: "失败" },
  cancelled: { title: "已停止", template: "grey", footer: "已停止" },
};

/** The card's frame key: header title/template + status word all derive
 *  from it. CardKit element streams cannot touch the header, so the
 *  watcher full-replaces the card whenever this key changes. */
export function cardStatusKey(state: RunCardState): string {
  if (state.terminal) return state.terminal.status;
  if (state.waiting === "approval") return "waiting_approval";
  if (state.waiting === "input") return "waiting_input";
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

/** One-line tool summary; empty when there is nothing to say. */
function renderToolContent(state: RunCardState): string {
  if (state.activeTool) return `正在执行：${state.activeTool}`;
  if (state.toolCount > 0) return `已完成 ${state.toolCount} 个工具步骤`;
  return "";
}

/** The streamed footer line: status + tool summary + elapsed + Web link.
 *  The tool summary lives here (not in its own element) so the streamed
 *  element set is stable from card creation. */
export function renderStatusContent(state: RunCardState, meta: RunCardMeta): string {
  const entry = HEADER_BY_STATUS[cardStatusKey(state)] ?? HEADER_BY_STATUS.running!;
  const tool = renderToolContent(state);
  const toolSegment = tool ? ` · ${tool}` : "";
  const elapsed = state.terminal ? "" : ` · 耗时 ${elapsedLine(meta.startedAt)}`;
  const webLink = meta.webUrl ? ` · [在 Web 查看](${meta.webUrl})` : "";
  const stopHint = state.terminal ? "" : " · 点卡片上的「停止」可取消";
  return `**${entry.footer}**${toolSegment}${elapsed}${webLink}${stopHint}`;
}

export function renderRunCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  const status = cardStatusKey(state);
  const header = HEADER_BY_STATUS[status] ?? HEADER_BY_STATUS.running!;

  const elements: Record<string, unknown>[] = [
    { tag: "markdown", element_id: OUTPUT_ELEMENT_ID, content: renderOutputContent(state) },
    { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: renderStatusContent(state, meta) },
  ];

  if (!state.terminal) {
    // Card 2.0 button: callback behavior rides the card.action.trigger
    // event (lark-cli ≥1.0.9x) — no public ingress needed. The payload is
    // cross-checked against the local run_card row on arrival; it is never
    // trusted alone.
    elements.push({
      tag: "button",
      element_id: "stop_button",
      text: { tag: "plain_text", content: "停止" },
      type: "danger",
      behaviors: [{ type: "callback", value: { runId: meta.runId, action: "stop" } }],
    });
  }

  if (state.terminal?.error) {
    // Card 2.0 body elements accept element tags only — `plain_text` is a
    // text-object tag and fails the whole update with 200621 (measured).
    elements.push({ tag: "markdown", element_id: ERROR_ELEMENT_ID, content: state.terminal.error });
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
