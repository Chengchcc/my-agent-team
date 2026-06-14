/**
 * M15.1: Render Lark Card JSON 2.0 for agent run status display.
 * Outputs full card JSON with streaming config per spec §5.6.
 */

import { normalizeForLarkMarkdown } from "./markdown-normalizer.js";

export type LarkRunCardStatus =
  | "thinking"
  | "streaming"
  | "done"
  | "error"
  | "fallback_text";

export interface LarkRunCardModel {
  runId: string;
  conversationId: string;
  title: string;
  status: LarkRunCardStatus;
  content: string;
  footer?: string;
  error?: string;
  updatedAt: number;
}

export interface LarkRunCardRenderOptions {
  maxMarkdownChars: number;
  maxSummaryChars: number;
  includeDebugRunId: boolean;
}

const STATUS_MAP: Record<
  LarkRunCardStatus,
  { header: string; template: string; summary: string }
> = {
  thinking: {
    header: "Mira 正在思考",
    template: "blue",
    summary: "生成中...",
  },
  streaming: {
    header: "Mira 正在回复",
    template: "blue",
    summary: "生成中...",
  },
  done: {
    header: "Mira 已完成",
    template: "green",
    summary: "已完成",
  },
  error: {
    header: "Mira 回复中断",
    template: "red",
    summary: "回复中断",
  },
  fallback_text: {
    header: "Mira 回复",
    template: "grey",
    summary: "",
  },
};

const elementIds = {
  agentOutput: "agent_output",
  divider1: "divider_1",
  runStatus: "run_status",
  debugRunId: "dbg_rid",
};

export function renderLarkRunCard(
  model: LarkRunCardModel,
  options?: Partial<LarkRunCardRenderOptions>,
): Record<string, unknown> {
  const statusMeta = STATUS_MAP[model.status];

  const normalized = normalizeForLarkMarkdown(model.content);
  const markdownContent =
    model.status === "thinking"
      ? "_正在思考..._"
      : normalized.markdown;

  const bodyElements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      element_id: elementIds.agentOutput,
      content: markdownContent,
    },
    {
      tag: "hr",
      element_id: elementIds.divider1,
    },
    {
      tag: "plain_text",
      element_id: elementIds.runStatus,
      content: statusMeta.summary,
    },
  ];

  if (options?.includeDebugRunId) {
    bodyElements.push({
      tag: "plain_text",
      element_id: elementIds.debugRunId,
      content: `run: ${model.runId}`,
    });
  }

  if (model.error) {
    bodyElements.push({
      tag: "plain_text",
      content: model.error,
    });
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 3 },
        print_strategy: "fast",
      },
      summary: { content: statusMeta.summary },
      update_multi: true,
      width_mode: "fill",
      enable_forward: true,
    },
    header: {
      title: { tag: "plain_text", content: statusMeta.header },
      template: statusMeta.template,
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: bodyElements,
    },
  };
}
