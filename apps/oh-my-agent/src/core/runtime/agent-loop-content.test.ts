import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../store/in-memory-session-store.js";
import { createOmaSession } from "./agent-loop.js";

const LOOP_RUN = {
  runId: "r-content",
  model: { backendKind: "oma" as const, modelId: "fake/echo" },
  configRevision: 1,
};

function loopInput(text: string) {
  return {
    input: { inputId: `in-${text}`, message: { role: "user" as const, text } },
    run: LOOP_RUN,
    workspace: { root: "/tmp", access: "read_write" as const },
  };
}

interface ToolBlock {
  type: string;
  content?: string;
}

async function runWithTool(
  toolExecute: () => Promise<Record<string, unknown>>,
): Promise<string | undefined> {
  const store = createInMemorySessionStore();
  const tool = {
    name: "fmt",
    description: "tool under test",
    executionMode: "concurrent" as const,
    execute: toolExecute,
  };
  let turn = 0;
  await store.create({
    sessionId: "s-content",
    backendKind: "oma",
    workspaceRoot: "/tmp",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const session = createOmaSession({
    sessionId: "s-content",
    store,
    plugins: [{ name: "p", tools: [tool] }],
    maxSteps: 2,
    maxForceContinues: 0,
    summarize: async () => "sum",
    modelStream: async function* (): AsyncIterable<AIMessageChunk> {
      turn++;
      if (turn === 1) {
        yield { delta: { type: "tool_use", id: "tc-1", name: "fmt" } };
        yield { stopReason: "tool_use" };
      } else {
        yield { delta: { type: "text", text: "done" } };
      }
    },
  });
  await session.startLoop(loopInput("go") as never);
  const snap = await store.open("s-content");
  const toolMsg = snap.entries.find(
    (e) =>
      (e as { type?: string }).type === "message" &&
      (e as { message?: Message }).message?.role === "tool",
  ) as unknown as { message: Message & { blocks: ToolBlock[] } };
  return toolMsg.message.blocks.find((b) => b.type === "tool_result")?.content;
}

/** Anthropic replays a tool-use turn as a whole: a redacted_thinking block
 *  carries a signature and NO reasoning text, and must be replayed unchanged
 *  or the next request is rejected (400). Gating on `turn.thinking` alone
 *  dropped it, so a redacted tool turn lost the block on the way to the store. */
async function runToolTurnWithRedactedThinking(): Promise<
  Array<{ type: string; signature?: string; redacted?: boolean }>
> {
  const store = createInMemorySessionStore();
  const tool = {
    name: "fmt",
    description: "tool under test",
    executionMode: "concurrent" as const,
    execute: async () => ({ content: "ok" }),
  };
  let turn = 0;
  await store.create({
    sessionId: "s-redacted",
    backendKind: "oma",
    workspaceRoot: "/tmp",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const session = createOmaSession({
    sessionId: "s-redacted",
    store,
    plugins: [{ name: "p", tools: [tool] }],
    maxSteps: 2,
    maxForceContinues: 0,
    summarize: async () => "sum",
    modelStream: async function* (): AsyncIterable<AIMessageChunk> {
      turn++;
      if (turn === 1) {
        yield { delta: { type: "reasoning_signature", signature: "SIG==", redacted: true } };
        yield { delta: { type: "tool_use", id: "tc-1", name: "fmt" } };
        yield { stopReason: "tool_use" };
      } else {
        yield { delta: { type: "text", text: "done" } };
      }
    },
  });
  await session.startLoop(loopInput("go") as never);

  const snap = await store.open("s-redacted");
  const assistant = snap.entries.find(
    (e) => (e as { message?: Message }).message?.role === "assistant",
  ) as unknown as {
    message: Message & {
      blocks: Array<{ type: string; signature?: string; redacted?: boolean }>;
    };
  };
  return assistant.message.blocks;
}

describe("redacted thinking survives a tool turn", () => {
  test("a signature-only thinking block is persisted next to the tool_use", async () => {
    const blocks = await runToolTurnWithRedactedThinking();
    const thinking = blocks.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    expect(thinking?.signature).toBe("SIG==");
    expect(thinking?.redacted).toBe(true);
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
  });
});

describe("tool result content contract", () => {
  test("a result with string content becomes the tool_result text verbatim", async () => {
    const content = await runWithTool(async () => ({
      content: "SUMMARY ONLY",
      rows: [1, 2, 3],
    }));
    expect(content).toBe("SUMMARY ONLY");
  });

  test("a result without content stays a JSON dump", async () => {
    const content = await runWithTool(async () => ({ rows: [1] }));
    expect(content).toBe(JSON.stringify({ rows: [1] }));
  });
});
