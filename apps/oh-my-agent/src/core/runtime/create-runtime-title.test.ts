import { afterAll, describe, expect, test } from "bun:test";
import type { Model, Provider } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import type { RuntimeKnobs } from "../settings/project-settings.js";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
} from "./create-runtime.fixture.js";

const { tmp, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);

/** Auto-titling spends ONE extra model call per completed run and the product
 *  surfaces the result as `outcome.title`. Mutation-proven gap (2026-09-10):
 *  flipping `titleEnabled` off changed nothing in the suite — title.ts was
 *  unit-tested but nothing exercised the runtime path or the knob. */
function titleAwareProvider(titles: string[]): { provider: Provider; seen: string[] } {
  const seen: string[] = [];
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
  const provider: Provider = {
    id: "fake",
    name: "Fake",
    getModels: () => [model],
    async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      // Three distinct callers share this stream: the loop, the title
      // generator, and the post-run memory extractor (fire-and-forget).
      const prompt = messages.map((m) => m.text ?? "").join("\n");
      const kind = prompt.includes("Write a 3-7 word title")
        ? "title"
        : prompt.includes("memory extractor")
          ? "memory"
          : "loop";
      seen.push(kind);
      yield { delta: { type: "text", text: kind === "title" ? titles.shift()! : "done" } };
      yield { usage: { input: 5, output: 2, cacheRead: 0, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  };
  return { provider, seen };
}

async function runWithTitle(
  runId: string,
  knobs: RuntimeKnobs | undefined,
  titleReply: string,
): Promise<{ status: string; title?: string; calls: string[] }> {
  const { provider, seen } = titleAwareProvider([titleReply]);
  const modelRuntime = createModelRuntime();
  modelRuntime.registerProvider(provider);
  const rt = await createOmaRuntime({
    runId,
    modelId: "fake/echo",
    workspaceRoot: tmp,
    workspaceAccess: "read_write",
    modelRuntime,
    skillRoots: [],
    ...(knobs ? { settings: knobs } : {}),
  });
  try {
    const outcome = await (await rt.run(runInput(runId))).outcome;
    return {
      status: outcome.status,
      ...(outcome.title ? { title: outcome.title } : {}),
      // The memory pass is fire-and-forget and races the assertion; it is not
      // what this file tests.
      calls: seen.filter((c) => c !== "memory"),
    };
  } finally {
    await rt.close();
  }
}

describe("auto-title is a runtime dependency (knob + outcome.title)", () => {
  test("a completed run titles itself and surfaces outcome.title", async () => {
    const res = await runWithTitle("r-title-on", undefined, "<title>Fix login flow</title>");
    expect(res.status).toBe("completed");
    expect(res.title).toBe("Fix login flow");
    // Exactly one extra model call, distinguishable from the loop's turn.
    expect(res.calls).toEqual(["loop", "title"]);
  }, 20_000);

  test("settings.titleEnabled=false suppresses the call AND the title", async () => {
    const res = await runWithTitle(
      "r-title-off",
      { titleEnabled: false },
      "<title>ignored</title>",
    );
    expect(res.status).toBe("completed");
    expect(res.title).toBeUndefined();
    expect(res.calls).toEqual(["loop"]);
  }, 20_000);

  test("a titled conversation (conversationTitled) is not re-titled", async () => {
    const res = await runWithTitle(
      "r-title-existing",
      { titleEnabled: true, conversationTitled: true },
      "<title>ignored</title>",
    );
    expect(res.title).toBeUndefined();
    expect(res.calls).toEqual(["loop"]);
  }, 20_000);

  test("a low-signal run asks for a title but stores none when the model says none", async () => {
    // The model answering `<title>none</title>` is the normal path for
    // small-talk runs: no fabricated title on the outcome.
    const res = await runWithTitle("r-title-none", undefined, "<title>none</title>");
    expect(res.title).toBeUndefined();
    expect(res.calls).toEqual(["loop", "title"]);
  }, 20_000);

  test("a failed run is never titled", async () => {
    // maxSteps 1 + a tool call ⟹ the loop exhausts its budget: no title call.
    const { provider, seen } = titleAwareProvider(["<title>ignored</title>"]);
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider({
      ...provider,
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const prompt = messages.map((m) => m.text ?? "").join("\n");
        const kind = prompt.includes("Write a 3-7 word title")
          ? "title"
          : prompt.includes("memory extractor")
            ? "memory"
            : "loop";
        seen.push(kind);
        if (kind === "title") {
          yield { delta: { type: "text", text: "<title>ignored</title>" } };
          yield { stopReason: "end_turn" };
          return;
        }
        yield { delta: { type: "tool_use", id: "tu", name: "glob" } };
        yield { delta: { type: "input_json_delta", id: "tu", partial_json: '{"pattern":"*"}' } };
        yield { stopReason: "tool_use" };
      },
    });
    const rt = await createOmaRuntime({
      runId: "r-title-failed",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      settings: { maxSteps: 1 },
    });
    try {
      const outcome = await (await rt.run(runInput("r-title-failed"))).outcome;
      expect(outcome.status).toBe("failed");
      expect(outcome.title).toBeUndefined();
      expect(seen).not.toContain("title");
    } finally {
      await rt.close();
    }
  }, 20_000);
});
