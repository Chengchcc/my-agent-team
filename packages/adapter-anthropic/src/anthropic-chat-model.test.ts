import { describe, expect, mock, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { AnthropicChatModel } from "./anthropic-chat-model.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("AnthropicChatModel", () => {
  test("translates text SSE stream into AIMessageChunks", async () => {
    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: () => ({
            [Symbol.asyncIterator]() {
              let i = 0;
              const events = [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "hello " },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "world" },
                },
              ];
              return {
                next: () => {
                  if (i >= events.length) return { done: true, value: undefined };
                  return { done: false, value: events[i++] };
                },
              };
            },
            finalMessage: () =>
              Promise.resolve({
                stop_reason: "end_turn",
                usage: { input_tokens: 5, output_tokens: 2 },
              }),
          }),
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const chunks = await collect(model.stream(messages));

    expect(chunks).toEqual([
      { delta: { type: "text", text: "hello " } },
      { delta: { type: "text", text: "world" } },
      { done: true, stopReason: "end_turn", usage: { input: 5, output: 2 } },
    ]);
  });

  test("translates tool_use SSE stream into AIMessageChunks", async () => {
    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: () => ({
            [Symbol.asyncIterator]() {
              let i = 0;
              const events = [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "tool_use", id: "toolu_1", name: "read" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", id: "toolu_1", partial_json: '{"path":"/x"}' },
                },
              ];
              return {
                next: () => {
                  if (i >= events.length) return { done: true, value: undefined };
                  return { done: false, value: events[i++] };
                },
              };
            },
            finalMessage: () =>
              Promise.resolve({
                stop_reason: "tool_use",
                usage: { input_tokens: 10, output_tokens: 8 },
              }),
          }),
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    const messages: Message[] = [{ role: "user", content: "read /tmp/x" }];
    const chunks = await collect(model.stream(messages));

    expect(chunks).toEqual([
      { delta: { type: "tool_use", id: "toolu_1", name: "read" } },
      { delta: { type: "input_json_delta", id: "toolu_1", partial_json: '{"path":"/x"}' } },
      { done: true, stopReason: "tool_use", usage: { input: 10, output: 8 } },
    ]);
  });

  test("extracts last system message as system prompt", async () => {
    let capturedSystem: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedSystem = params.system;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ];
    await collect(model.stream(messages));

    expect(capturedSystem).toBe("You are helpful.");
  });

  test("merges ALL system messages into one, not just last", async () => {
    let capturedSystem: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedSystem = params.system;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([
        { role: "system", content: "Rule A." },
        { role: "system", content: "Rule B." },
        { role: "user", content: "hi" },
      ]),
    );

    expect(capturedSystem).toContain("Rule A.");
    expect(capturedSystem).toContain("Rule B.");
  });

  test("merges adjacent same-role messages into one", async () => {
    let capturedMessages: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedMessages = params.messages;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([
        { role: "user", content: "first question" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "response" },
      ]),
    );

    const msgs = capturedMessages as Array<{ role: string }>;
    expect(msgs.length).toBe(2); // user merged + assistant
    expect(msgs[0]!.role).toBe("user");
  });

  test("filters empty content messages", async () => {
    let capturedMessages: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedMessages = params.messages;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([
        { role: "system", content: "sys" },
        { role: "user", content: "" },
        { role: "assistant", content: "valid" },
      ]),
    );

    const msgs = capturedMessages as Array<{ role: string; content: unknown }>;
    expect(msgs.length).toBe(1); // only assistant (user "" filtered)
    expect(msgs[0]!.role).toBe("assistant");
  });

  test("filters internal-role messages out of model context", async () => {
    let capturedMessages: unknown;
    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedMessages = params.messages;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 } }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([
        { role: "user", content: "save this" },
        { role: "assistant", content: "saved" },
        { role: "internal", content: "memory written to /notes/x" },
        { role: "assistant", content: "anything else?" },
      ]),
    );

    const msgs = capturedMessages as Array<{ role: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.some((m) => m.role === "internal")).toBe(false);
  });

  test("explicitly skips thinking and redacted_thinking blocks", async () => {
    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: () => ({
            [Symbol.asyncIterator]() {
              let i = 0;
              const events = [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "thinking", thinking: "..." },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "thinking_delta", thinking: "more" },
                },
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "redacted_thinking", data: "..." },
                },
                {
                  type: "content_block_start",
                  index: 2,
                  content_block: { type: "text", text: "actual output" },
                },
              ];
              return {
                next: () => {
                  if (i >= events.length) return { done: true, value: undefined };
                  return { done: false, value: events[i++] };
                },
              };
            },
            finalMessage: () =>
              Promise.resolve({
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
          }),
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    const chunks = await collect(model.stream([{ role: "user", content: "hi" }]));

    // Only "actual output" text + done should pass through
    const textChunks = chunks.filter((c) => "delta" in c && c.delta?.type === "text");
    expect(textChunks.length).toBe(1);
    // @ts-expect-error text property on text delta
    expect(textChunks[0]!.delta.text).toBe("actual output");
  });

  test("passes tools to API when provided in options", async () => {
    let capturedTools: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedTools = params.tools;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([{ role: "user", content: "hi" }], {
        tools: [
          { name: "read", description: "r", inputSchema: {}, execute: () => ({ content: "" }) },
        ],
      }),
    );

    expect(capturedTools).toEqual([{ name: "read", description: "r", input_schema: {} }]);
  });

  test("omits system when none present", async () => {
    let capturedSystem: unknown = "SENTINEL";

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedSystem = params.system;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(model.stream([{ role: "user", content: "hi" }]));

    expect(capturedSystem).toBeUndefined();
  });

  test("forwards thinking and effort config to API", async () => {
    let capturedThinking: unknown;
    let capturedEffort: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedThinking = params.thinking;
            capturedEffort = params.effort;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({
      apiKey: "test-key",
      thinking: { type: "adaptive" },
      effort: "xhigh",
    });
    await collect(model.stream([{ role: "user", content: "hi" }]));

    expect(capturedThinking).toEqual({ type: "adaptive" });
    expect(capturedEffort).toBe("xhigh");
  });

  test("extracts system prompt from ContentBlock array", async () => {
    let capturedSystem: unknown;

    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedSystem = params.system;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => ({ done: true, value: undefined }) };
              },
              finalMessage: () =>
                Promise.resolve({
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
            };
          },
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    await collect(
      model.stream([
        { role: "system", content: [{ type: "text", text: "sys from blocks" }] },
        { role: "user", content: "hi" },
      ]),
    );

    expect(capturedSystem).toBe("sys from blocks");
  });

  test("handles empty messages array gracefully", async () => {
    mock.module("@anthropic-ai/sdk", () => ({
      Anthropic: class {
        messages = {
          stream: () => ({
            [Symbol.asyncIterator]() {
              return { next: () => ({ done: true, value: undefined }) };
            },
            finalMessage: () =>
              Promise.resolve({
                stop_reason: "end_turn",
                usage: { input_tokens: 0, output_tokens: 0 },
              }),
          }),
        };
      },
    }));

    const model = new AnthropicChatModel({ apiKey: "test-key" });
    const chunks = await collect(model.stream([]));

    expect(chunks).toEqual([
      { done: true, stopReason: "end_turn", usage: { input: 0, output: 0 } },
    ]);
  });
});
