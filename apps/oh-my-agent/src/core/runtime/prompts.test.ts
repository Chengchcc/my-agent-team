import { describe, expect, test } from "bun:test";
import subagentPrompt from "../../prompts/agents/subagent.md" with { type: "text" };
import { resolveAgent } from "../delegation/roles.js";
import { GoalRuntime } from "../goals/runtime.js";
import { createAskQuestionTool } from "../tools/ask-question.js";
import { createEvalTool } from "../tools/eval.js";
import { buildSystemPrompt } from "./prompts.js";

describe("buildSystemPrompt capability gating", () => {
  test("omits coding base.md and local memory.md when disabled and includes hostPrompt", () => {
    const prompt = buildSystemPrompt({
      hostPrompt: "PRODUCT_FRONT_DESK_RULES",
      workspacePrompt: "<repo-rules>RULES</repo-rules>",
      cwd: "/tmp/ws",
      includeBase: false,
      includeLocalMemory: false,
    });
    expect(prompt).toContain("PRODUCT_FRONT_DESK_RULES");
    expect(prompt).toContain("<repo-rules>RULES</repo-rules>");
    expect(prompt).not.toContain("You are oma, a coding agent");
    expect(prompt).not.toContain(".oma/memory/MEMORY.md");
  });

  test("includes base.md and memory.md by default for standalone coding runs", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp/ws" });
    expect(prompt).toContain("You are oma, a coding agent");
    expect(prompt).toContain(".oma/memory/");
  });
});

describe("tool & goal prompt contracts (Batch 1 fixes)", () => {
  test("eval tool requires code and does not instruct omitting it when async", () => {
    const tool = createEvalTool({ scope: "test", workspaceRoot: "/tmp" });
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: { code?: { description?: string } };
    };
    expect(schema.required).toContain("code");
    expect(schema.properties?.code?.description ?? "").not.toContain("Omit when async");
  });

  test("ask_question schema exposes multi, recommended, and allowOther advertised in its description", () => {
    const tool = createAskQuestionTool();
    const qProps = (
      tool.inputSchema as {
        properties: { questions: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.questions.items.properties;
    expect(qProps.multi).toBeDefined();
    expect(qProps.recommended).toBeDefined();
    expect(qProps.allowOther).toBeDefined();
    expect(tool.description).toContain("allowOther");
  });

  test("GoalRuntime.renderTodoContext references todo_write (not nonexistent todo)", () => {
    const block = GoalRuntime.renderTodoContext([{ id: "1", text: "Ship fix", status: "pending" }]);
    expect(block).toContain("`todo_write`");
    expect(block).not.toContain("call `todo`");
  });

  test("subagent.md omits write-only guidance so read-only roles stay consistent while task keeps it", async () => {
    expect(subagentPrompt).not.toContain("Prefer editing existing files");

    const taskRole = await resolveAgent("task", async () => null);
    expect(taskRole?.systemPrompt).toContain("Prefer editing existing files");
  });
});
