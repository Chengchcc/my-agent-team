import { describe, expect, test } from "bun:test";
import { type Model, ProviderError } from "../types.js";
import {
  anthropicModel,
  collectChunks,
  DONE,
  drainAndCaptureError,
  makeProvider,
  mockFetch,
  openaiModel,
  sseData,
  sseRes,
} from "./provider-contract.fixture.js";

describe("Provider contract — anthropic stream decoding", () => {
  test("tool_use pairs input_json_delta with tool id", async () => {
    const provider = makeProvider(anthropicModel);
    const sse = sseRes([
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      }),
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"a' },
      }),
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '.ts"}' },
      }),
      sseData({ type: "content_block_stop", index: 0 }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUse = chunks.find((c) => c.delta?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.id).toBe("toolu_1");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(
      deltas.every((d) => d.delta?.type === "input_json_delta" && d.delta.id === "toolu_1"),
    ).toBe(true);
    const json = deltas
      .map((d) => (d.delta?.type === "input_json_delta" ? d.delta.partial_json : ""))
      .join("");
    expect(json).toBe('{"path":"a.ts"}');
  });
});

describe("Provider contract — openai stream decoding", () => {
  test("tool_calls: first chunk carries id+name, arguments pair by id", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "echo", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }],
      }),
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
      }),
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUse = chunks.find((c) => c.delta?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.id).toBe("call_1");
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.name).toBe("echo");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(
      deltas.every((d) => d.delta?.type === "input_json_delta" && d.delta.id === "call_1"),
    ).toBe(true);
    const json = deltas
      .map((d) => (d.delta?.type === "input_json_delta" ? d.delta.partial_json : ""))
      .join("");
    expect(json).toBe('{"x":1}');

    // No empty-id tool_use for argument-only chunks
    const empties = chunks.filter(
      (c) => c.delta?.type === "tool_use" && !(c.delta as { id: string }).id,
    );
    expect(empties).toHaveLength(0);
  });

  test("multiple tool calls in one chunk each get correct id", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "read", arguments: "" },
                },
                {
                  index: 1,
                  id: "call_b",
                  type: "function",
                  function: { name: "bash", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":"a"}' } },
                { index: 1, function: { arguments: '{"cmd":"pwd"}' } },
              ],
            },
          },
        ],
      }),
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUses = chunks.filter((c) => c.delta?.type === "tool_use");
    expect(toolUses).toHaveLength(2);
    expect((toolUses[0]!.delta as { id: string }).id).toBe("call_a");
    expect((toolUses[1]!.delta as { id: string }).id).toBe("call_b");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0]!.delta as { id: string }).id).toBe("call_a");
    expect((deltas[1]!.delta as { id: string }).id).toBe("call_b");
  });

  test("survives SSE lines split across network chunks", async () => {
    const provider = makeProvider(openaiModel);
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello-world" } }] })}\n\n${DONE}\n`;
    const cut = Math.floor(full.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(full.slice(0, cut)));
        controller.enqueue(new TextEncoder().encode(full.slice(cut)));
        controller.close();
      },
    });
    const restore = mockFetch(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const text = chunks
      .filter((c) => c.delta?.type === "text")
      .map((c) => (c.delta?.type === "text" ? c.delta.text : ""))
      .join("");
    expect(text).toBe("hello-world");
  });

  test("defers done: true until after trailing include_usage frame (never drops usage)", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({ choices: [{ delta: { content: "hi" } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null }),
      sseData({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const usageIdx = chunks.findIndex((c) => c.usage !== undefined);
    const doneIdx = chunks.findIndex((c) => c.done === true);
    expect(usageIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(usageIdx);
    expect(chunks.filter((c) => c.done === true)).toHaveLength(1);
    expect(chunks[usageIdx]?.usage).toEqual({ input: 60, output: 20, cacheRead: 40 });
  });

  test("flushes done: true on clean EOF when gateway omits trailing usage and [DONE]", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({ choices: [{ delta: { content: "ok" } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    expect(chunks.some((c) => c.stopReason === "end_turn")).toBe(true);
    expect(chunks.filter((c) => c.done === true)).toHaveLength(1);
  });
});

describe("Provider contract — openai-responses stream decoding", () => {
  const responsesModel: Model = { ...openaiModel, id: "o4-mini", api: "openai-responses" };

  test("streams text, reasoning, tool calls, non-streaming fallback, and clamps cached usage >= 0", async () => {
    const provider = makeProvider(responsesModel);
    const sse = sseRes([
      sseData({ type: "response.reasoning_summary_text.delta", delta: "thinking..." }),
      sseData({ type: "response.output_text.delta", delta: "answer" }),
      sseData({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "fc_1", name: "read" },
      }),
      sseData({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"path":"a.ts"}',
      }),
      // Second tool call arrives only via output_item.done (non-streaming fallback)
      sseData({
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "function_call", call_id: "fc_2", name: "ls" },
      }),
      sseData({
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "function_call", call_id: "fc_2", name: "ls", arguments: '{"dir":"."}' },
      }),
      sseData({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            // Proxy edge case: cached_tokens exceeds input_tokens → input must clamp to 0
            input_tokens: 50,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 80 },
          },
        },
      }),
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(responsesModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    expect(chunks.find((c) => c.delta?.type === "reasoning")?.delta).toEqual({
      type: "reasoning",
      text: "thinking...",
    });
    expect(chunks.find((c) => c.delta?.type === "text")?.delta).toEqual({
      type: "text",
      text: "answer",
    });
    const argDeltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(argDeltas).toHaveLength(2);
    expect(argDeltas[0]?.delta).toEqual({
      type: "input_json_delta",
      id: "fc_1",
      partial_json: '{"path":"a.ts"}',
    });
    expect(argDeltas[1]?.delta).toEqual({
      type: "input_json_delta",
      id: "fc_2",
      partial_json: '{"dir":"."}',
    });
    const done = chunks.find((c) => c.done === true);
    expect(done?.stopReason).toBe("tool_use");
    expect(done?.usage).toEqual({ input: 0, output: 30, cacheRead: 80 });
  });

  test("maps response.incomplete content_filter → refusal and max_output_tokens → max_tokens", async () => {
    const provider = makeProvider(responsesModel);

    const refusalSse = sseRes([
      sseData({
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      }),
    ]);
    let restore = mockFetch(refusalSse);
    const refusalChunks = await collectChunks(
      provider.stream(responsesModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(refusalChunks.find((c) => c.done)?.stopReason).toBe("refusal");

    const truncSse = sseRes([
      sseData({
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      }),
    ]);
    restore = mockFetch(truncSse);
    const truncChunks = await collectChunks(
      provider.stream(responsesModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(truncChunks.find((c) => c.done)?.stopReason).toBe("max_tokens");
  });

  test("response.failed throws ProviderError", async () => {
    const provider = makeProvider(responsesModel);
    const sse = sseRes([
      sseData({
        type: "response.failed",
        response: { error: { message: "server error" } },
      }),
    ]);
    const restore = mockFetch(sse);
    const err = await drainAndCaptureError(
      provider.stream(responsesModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("server error");
  });
});
