import { afterAll, describe, expect, test } from "bun:test";
import type { Model, Provider } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
} from "./create-runtime.fixture.js";
import { parseToolFilter } from "./tool-filter.js";

const { tmp, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);

/** A provider that plays one scripted role: whenever the request is a
 *  SUBAGENT turn (its system prompt carries the subagent tail), it asks for
 *  `bash`; on the follow-up it reports whatever the loop said back. The main
 *  loop asks for `workflow_run` first, then answers. */
function filterProbeProvider(toolName: string): Provider {
  const model: Model = {
    id: "echo",
    name: "Fake Echo",
    provider: "fake",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  let sawSubagent = false;
  let sawMain = false;
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [model],
    async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const system = messages.find((m) => m.role === "system")?.text ?? "";
      const isSubagent = system.includes("subagent");
      if (isSubagent) {
        if (!sawSubagent) {
          sawSubagent = true;
          yield { delta: { type: "tool_use", id: "tu-sub", name: toolName } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "tu-sub",
              partial_json: JSON.stringify({
                description: "probe",
                command: "echo SHOULD-NOT-RUN",
              }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        // Report the tool verdict straight back as the subagent's answer.
        const toolResult = messages
          .flatMap((m) => m.blocks ?? [])
          .find((b) => b.type === "tool_result");
        const content =
          toolResult && typeof (toolResult as { content?: unknown }).content === "string"
            ? (toolResult as { content: string }).content
            : "(no tool result)";
        yield { delta: { type: "text", text: content } };
        yield { stopReason: "end_turn" };
        return;
      }
      if (sawMain) {
        yield { delta: { type: "text", text: "fan-out done" } };
        yield { stopReason: "end_turn" };
        return;
      }
      sawMain = true;
      yield { delta: { type: "tool_use", id: "tu-main", name: "workflow_run" } };
      yield {
        delta: {
          type: "input_json_delta",
          id: "tu-main",
          partial_json: JSON.stringify({
            script: 'const r = await agent("probe"); return r.text;',
          }),
        },
      };
      yield { stopReason: "tool_use" };
    },
  };
}

describe("--tools filter governs the subagent tool table", () => {
  test("a filtered-out tool is unknown to subagents (no bash for --tools read)", async () => {
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(filterProbeProvider("bash"));
    const rt = await createOmaRuntime({
      runId: "r-filter-sub",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      // Whitelist WITHOUT bash: main loop and subagents both lose it.
      // (workflow_run stays so the main loop can start the fan-out at all —
      // the filter is literal: it governs every tool, orchestration included.)
      toolFilter: parseToolFilter("read,grep,glob,tree,read_image,workflow_run"),
    });
    try {
      const segment = await rt.run(runInput("r-filter-sub"));
      const outcome = await segment.outcome;
      const text = (outcome.messages ?? []).map((m) => m.text ?? "").join("\n");
      expect(outcome.status).toBe("completed");
      // The subagent asked for bash and the loop answered "unknown tool":
      // proof the child's table was filtered, not just the main session's.
      expect(text).toContain("Unknown tool: bash");
      expect(text).not.toContain("SHOULD-NOT-RUN");
    } finally {
      await rt.close();
    }
  }, 20_000);

  test("without a filter the same subagent call executes bash", async () => {
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(filterProbeProvider("bash"));
    const rt = await createOmaRuntime({
      runId: "r-filter-none",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    try {
      const segment = await rt.run(runInput("r-filter-none"));
      const outcome = await segment.outcome;
      const text = (outcome.messages ?? []).map((m) => m.text ?? "").join("\n");
      expect(text).toContain("SHOULD-NOT-RUN");
      expect(text).not.toContain("Unknown tool: bash");
    } finally {
      await rt.close();
    }
  }, 20_000);
});
