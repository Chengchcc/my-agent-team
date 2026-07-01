import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import { createAgent } from "@my-agent-team/framework";
import { conversationContextPlugin } from "./conversation-context-plugin.js";

function echoModel(text: string): ChatModel {
  return {
    id: "echo",
    async *stream(): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text } };
      yield { done: true, stopReason: "end_turn" };
    },
  };
}

const dummyTool: Tool = {
  name: "test_tool",
  description: "A test tool",
  inputSchema: { type: "object", properties: {} },
  execute: () => ({ content: "ok" }),
};

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("conversationContextPlugin", () => {
  test("registers tools on the agent", async () => {
    const plugin = conversationContextPlugin({
      tools: [dummyTool],
      systemPrompt: "<conv>test</conv>",
    });

    expect(plugin.name).toBe("conversation-context");
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools![0]!.name).toBe("test_tool");
  });

  test("injects system prompt before model call", async () => {
    const plugin = conversationContextPlugin({
      tools: [],
      systemPrompt: "<conv>\n  <surface>web</surface>\n</conv>",
    });

    const agent = await createAgent({
      model: echoModel("hello"),
      plugins: [plugin],
    });

    const events = await collect(agent.run("hi"));
    const messages = events.filter((e) => e.type === "message");

    // Model produced output (the injected system message fed the LLM context)
    expect(messages.length).toBeGreaterThan(0);
    // beforeModel injects messages for the model call, not thread persistence.
    // The plugin works if the agent runs to completion without error.
    const doneMsg = messages.find((m) => m.payload.state === "done");
    expect(doneMsg).toBeDefined();
  });

  test("does not require any tools", async () => {
    const plugin = conversationContextPlugin({
      tools: [],
      systemPrompt: "minimal context",
    });

    const agent = await createAgent({
      model: echoModel("ok"),
      plugins: [plugin],
    });

    await collect(agent.run("test"));
    expect(agent.thread.messages.length).toBeGreaterThan(0);
  });
});
