import { describe, expect, mock, test } from "bun:test";
import { AnthropicChatModel } from "./anthropic-chat-model.js";
import type { Message } from "@my-agent-team/core";

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
        tools: [{ name: "read", description: "r", inputSchema: {}, execute: () => ({ content: "" }) }],
      }),
    );

    expect(capturedTools).toEqual([
      { name: "read", description: "r", input_schema: {} },
    ]);
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
});
