import { afterAll, describe, expect, test } from "bun:test";
import type { Model, Provider } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import type { PruneKnobs } from "../settings/project-settings.js";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
} from "./create-runtime.fixture.js";

const { tmp, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);

/** Old tool output is pruned READ-SIDE before the next model call. The seam
 *  (pruneOldToolResults + OmaSessionOptions.pruneConfig) existed and was unit
 *  tested, but nothing in production ever set it — a knob-shaped hole. These
 *  tests drive it through the runtime, which is the only place it can break. */
function toolThenReport(): { provider: Provider; secondTurn: Message[][] } {
  const secondTurn: Message[][] = [];
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
  let called = false;
  const provider: Provider = {
    id: "fake",
    name: "Fake",
    getModels: () => [model],
    async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      // Three callers share this stream: the loop, the title generator and
      // the post-run memory extractor. Only the loop's second turn is what
      // this file measures.
      const prompt = messages.map((m) => m.text ?? "").join("\n");
      if (prompt.includes("memory extractor")) {
        yield { delta: { type: "text", text: '{"facts":[]}' } };
        yield { stopReason: "end_turn" };
        return;
      }
      if (prompt.includes("Write a 3-7 word title")) {
        yield { delta: { type: "text", text: "<title>pruning</title>" } };
        yield { stopReason: "end_turn" };
        return;
      }
      if (!called) {
        called = true;
        yield { delta: { type: "tool_use", id: "tu-1", name: "bash" } };
        yield {
          delta: {
            type: "input_json_delta",
            id: "tu-1",
            // ~1.5 KB of output: well over the default protect window.
            partial_json: JSON.stringify({ description: "d", command: "seq 1 400" }),
          },
        };
        yield { stopReason: "tool_use" };
        return;
      }
      secondTurn.push([...messages]);
      yield { delta: { type: "text", text: "done" } };
      yield { stopReason: "end_turn" };
    },
  };
  return { provider, secondTurn };
}

async function runOnce(runId: string, prune?: PruneKnobs): Promise<string> {
  const { provider, secondTurn } = toolThenReport();
  const modelRuntime = createModelRuntime();
  modelRuntime.registerProvider(provider);
  const rt = await createOmaRuntime({
    runId,
    modelId: "fake/echo",
    workspaceRoot: tmp,
    workspaceAccess: "read_write",
    modelRuntime,
    skillRoots: [],
    ...(prune ? { settings: { prune } } : {}),
  });
  try {
    const outcome = await (await rt.run(runInput(runId))).outcome;
    expect(outcome.status).toBe("completed");
  } finally {
    await rt.close();
  }
  expect(secondTurn).toHaveLength(1);
  return secondTurn[0]!
    .map((m) =>
      (m.blocks ?? [])
        .filter((b) => b.type === "tool_result")
        .map((b) => (typeof b.content === "string" ? b.content : ""))
        .join(""),
    )
    .join("");
}

describe("tool-result pruning is a runtime knob (not a dead seam)", () => {
  test("without settings.prune the full tool output reaches the model", async () => {
    const toolResult = await runOnce("r-prune-off");
    expect(toolResult).toContain("397");
    expect(toolResult).not.toContain("[pruned:");
  }, 20_000);

  test("settings.prune replaces old tool output with a summary", async () => {
    // protectTokens 10 < the 1.5 KB result, so the walk-back leaves it outside
    // the window; minimumSavings must be small enough to persist the prune.
    const toolResult = await runOnce("r-prune-on", { protectTokens: 10, minimumSavings: 1 });
    expect(toolResult).toContain("[pruned:");
    expect(toolResult).not.toContain("397");
  }, 20_000);

  test("protectedTools exempts a tool by name", async () => {
    const toolResult = await runOnce("r-prune-protected", {
      protectTokens: 10,
      minimumSavings: 1,
      protectedTools: ["bash"],
    });
    expect(toolResult).toContain("397");
    expect(toolResult).not.toContain("[pruned:");
  }, 20_000);
});
