import { describe, expect, test } from "bun:test";
import { renderLarkRunCard } from "./card-renderer.js";
import type { LarkRunCardModel } from "./card-renderer.js";

function baseModel(overrides?: Partial<LarkRunCardModel>): LarkRunCardModel {
  return {
    runId: "run_test",
    conversationId: "conv_test",
    title: "test",
    status: "thinking",
    content: "",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("renderLarkRunCard", () => {
  test("thinking card has correct header and streaming config", () => {
    const card = renderLarkRunCard(baseModel({ status: "thinking" }));
    expect(card.schema).toBe("2.0");
    const config = card.config as Record<string, unknown>;
    expect(config.streaming_mode).toBe(true);
    expect(config.update_multi).toBe(true);
    expect((config as { streaming_config: { print_strategy: string } }).streaming_config.print_strategy).toBe("fast");
    const header = card.header as { title: { content: string }; template: string };
    expect(header.title.content).toBe("Mira 正在思考");
    expect(header.template).toBe("blue");
  });

  test("streaming card has correct header", () => {
    const card = renderLarkRunCard(baseModel({ status: "streaming", content: "# hello" }));
    const header = card.header as { title: { content: string } };
    expect(header.title.content).toBe("Mira 正在回复");
  });

  test("done card has green template", () => {
    const card = renderLarkRunCard(baseModel({ status: "done", content: "result" }));
    const header = card.header as { template: string };
    expect(header.template).toBe("green");
  });

  test("error card has red template and error message", () => {
    const card = renderLarkRunCard(baseModel({ status: "error", content: "partial", error: "run failed" }));
    const header = card.header as { template: string };
    expect(header.template).toBe("red");
    const body = card.body as { elements: Array<{ content?: string; tag: string }> };
    const errorEl = body.elements.find((e) => e.content === "run failed");
    expect(errorEl).toBeDefined();
  });

  test("body has required element_ids", () => {
    const card = renderLarkRunCard(baseModel({ status: "streaming", content: "hello" }));
    const body = card.body as { elements: Array<{ element_id?: string; tag: string; content?: string }> };
    expect(body.elements.some((e) => e.element_id === "agent_output")).toBe(true);
    expect(body.elements.some((e) => e.element_id === "divider_1")).toBe(true);
    expect(body.elements.some((e) => e.element_id === "run_status")).toBe(true);
  });

  test("element_ids are valid (alphanumeric + underscore, <= 20 chars, starts with letter)", () => {
    const card = renderLarkRunCard(baseModel());
    const body = card.body as { elements: Array<{ element_id?: string }> };
    for (const el of body.elements) {
      if (el.element_id) {
        expect(el.element_id.length).toBeLessThanOrEqual(20);
        expect(el.element_id).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  test("summary matches status", () => {
    const statusSummaries: Array<[string, string]> = [
      ["thinking", "生成中..."],
      ["streaming", "生成中..."],
      ["done", "已完成"],
      ["error", "回复中断"],
    ];
    for (const [status, expected] of statusSummaries) {
      const card = renderLarkRunCard(baseModel({ status: status as "thinking" | "streaming" | "done" | "error" }));
      const config = card.config as { summary: { content: string } };
      expect(config.summary.content).toBe(expected);
    }
  });

  test("thinking card renders placeholder markdown", () => {
    const card = renderLarkRunCard(baseModel({ status: "thinking" }));
    const body = card.body as { elements: Array<{ element_id?: string; content?: string }> };
    const agentOutput = body.elements.find((e) => e.element_id === "agent_output");
    expect(agentOutput?.content).toBe("_正在思考..._");
  });

  test("debug runId included when option set", () => {
    const card = renderLarkRunCard(baseModel(), { includeDebugRunId: true });
    const body = card.body as { elements: Array<{ element_id?: string; content?: string }> };
    const debugEl = body.elements.find((e) => e.element_id === "dbg_rid");
    expect(debugEl).toBeDefined();
    expect(debugEl?.content).toContain("run_test");
  });
});
