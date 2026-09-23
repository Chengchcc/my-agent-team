import { normalizeForLarkMarkdown } from "../markdown-normalizer.js";
import type { RunCardState } from "./card-state.js";

/**
 * ADR 0031: render the card display state as Lark Card JSON 2.0 with
 * streaming_mode (client-side typewriter). Shape resurrected from M15.1
 * (git ae005601^); element_ids stay stable across PATCHes.
 */

/** Keep the tail ~10k chars of the transcript (ADR: 8–12k window). */
const MAX_OUTPUT_CHARS = 10_000;

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

function statusKey(state: RunCardState): string {
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

export function renderRunCard(state: RunCardState, meta: RunCardMeta): Record<string, unknown> {
  const status = statusKey(state);
  const meta2 = HEADER_BY_STATUS[status] ?? HEADER_BY_STATUS.running!;

  const normalized = normalizeForLarkMarkdown(windowOutput(state.output));
  const markdownContent =
    state.output.length === 0 && !state.terminal
      ? "_正在思考…_"
      : normalized.markdown || (state.terminal ? "（无输出）" : "_正在思考…_");

  const elements: Record<string, unknown>[] = [
    { tag: "markdown", element_id: "agent_output", content: markdownContent },
  ];

  // Tool summary: one line for the active tool, a count for the rest.
  const toolLine = state.activeTool
    ? `正在执行：${state.activeTool}`
    : state.toolCount > 0
      ? `已完成 ${state.toolCount} 个工具步骤`
      : null;
  if (toolLine) {
    elements.push({ tag: "plain_text", element_id: "tool_summary", content: toolLine });
  }

  if (state.terminal?.error) {
    elements.push({ tag: "plain_text", element_id: "err_msg", content: state.terminal.error });
  }

  // Footer: status + elapsed + optional Web deep link (markdown link — no
  // card button schema risk; URL affordances need no callback channel).
  const elapsed = state.terminal ? "" : ` · 耗时 ${elapsedLine(meta.startedAt)}`;
  const webLink = meta.webUrl ? ` · [在 Web 查看](${meta.webUrl})` : "";
  const stopHint = state.terminal ? "" : " · 发送 /stop 可停止";
  elements.push({
    tag: "markdown",
    element_id: "run_status",
    content: `**${meta2.footer}**${elapsed}${webLink}${stopHint}`,
  });

  // streaming_mode only while live: terminal cards freeze client-side.
  const streamingConfig = state.terminal
    ? {}
    : {
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 3 },
          print_strategy: "fast",
        },
      };

  return {
    schema: "2.0",
    config: {
      ...streamingConfig,
      summary: { content: meta2.footer },
      update_multi: true,
      width_mode: "fill",
      enable_forward: false,
    },
    header: {
      title: { tag: "plain_text", content: meta2.title },
      template: meta2.template,
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements,
    },
  };
}
