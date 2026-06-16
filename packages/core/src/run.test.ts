import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel } from "./chat-model.js";
import type { Message } from "@my-agent-team/message";
import { run } from "./run.js";
import type { Tool } from "./tool.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}

function tool(name: string, execute: Tool["execute"]): Tool {
  return { name, description: `${name} tool`, inputSchema: {}, execute };
}

function scriptedModel(
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >,
): ChatModel {
  return {
    async *stream(messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const turn = messages.filter((message) => message.role === "assistant").length;
      const item = turns[Math.min(turn, turns.length - 1)];
      if (item === undefined) {
        return;
      }
      if (item.type === "text") {
        yield { delta: { type: "text", text: item.text } };
        yield { done: true, stopReason: "end_turn" };
        return;
      }
      yield { delta: { type: "tool_use", id: item.id, name: item.name } };
      yield {
        delta: { type: "input_json_delta", id: item.id, partial_json: JSON.stringify(item.input) },
      };
      yield { done: true, stopReason: "tool_use" };
    },
  };
}

describe("run", () => {
  test("streams a text response and appends the completed assistant message", async () => {
    const messages: Message[] = [{ role: "user", text: "hello" }];

    const yielded = await collect(run(scriptedModel([{ type: "text", text: "hi" }]), [], messages));

    expect(yielded).toEqual([{ role: "assistant", blocks: [{ type: "text", text:"hi" }] }]);
    expect(messages).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", blocks: [{ type: "text", text:"hi" }] },
    ]);
  });

  test("executes requested tools, appends results, and continues until text", async () => {
    const messages: Message[] = [{ role: "user", text: "lookup weather" }];
    const lookup = tool("lookup", (input: unknown) => ({
      content: `result:${JSON.stringify(input)}`,
    }));

    const yielded = await collect(
      run(
        scriptedModel([
          { type: "tool_call", id: "toolu_1", name: "lookup", input: { q: "weather" } },
          { type: "text", text: "sunny" },
        ]),
        [lookup],
        messages,
      ),
    );

    expect(yielded.at(-1)).toEqual({
      role: "assistant",
      blocks: [{ type: "text", text:"sunny" }],
    });
    expect(messages).toEqual([
      { role: "user", text: "lookup weather" },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "weather" } }],
      },
      {
        role: "user",
        blocks: [
          { type: "tool_result", tool_use_id: "toolu_1", content: 'result:{"q":"weather"}' },
        ],
      },
      { role: "assistant", blocks: [{ type: "text", text:"sunny" }] },
    ]);
  });

  test("turns missing and thrown tools into error tool results before continuing", async () => {
    const messages: Message[] = [{ role: "user", text: "call tools" }];
    const model = {
      async *stream(history: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const assistantTurns = history.filter((message) => message.role === "assistant").length;
        if (assistantTurns === 0) {
          yield { delta: { type: "tool_use", id: "toolu_1", name: "missing" } };
          yield { delta: { type: "input_json_delta", id: "toolu_1", partial_json: "{}" } };
          yield { delta: { type: "tool_use", id: "toolu_2", name: "boom" } };
          yield { delta: { type: "input_json_delta", id: "toolu_2", partial_json: "{}" } };
          yield { done: true, stopReason: "tool_use" };
          return;
        }
        yield { delta: { type: "text", text: "handled" } };
        yield { done: true, stopReason: "end_turn" };
      },
    };

    await collect(
      run(
        model,
        [
          tool("boom", () => {
            throw new Error("boom failed");
          }),
        ],
        messages,
      ),
    );

    expect(messages[2]).toEqual({
      role: "user",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "Tool not found: missing",
          is_error: true,
        },
        { type: "tool_result", tool_use_id: "toolu_2", content: "boom failed", is_error: true },
      ],
    });
  });

  test("does not append partial turns when aborted or when the model returns no blocks", async () => {
    const abortController = new AbortController();
    const messages: Message[] = [{ role: "user", text: "start" }];
    const abortingModel = {
      async *stream(): AsyncIterable<AIMessageChunk> {
        yield { delta: { type: "text", text: "partial" } };
        abortController.abort();
        yield { done: true, stopReason: "end_turn" };
      },
    };

    const yielded = await collect(
      run(abortingModel, [], messages, { signal: abortController.signal }),
    );

    expect(yielded).toEqual([{ role: "assistant", blocks: [{ type: "text", text:"partial" }] }]);
    expect(messages).toEqual([{ role: "user", text: "start" }]);

    const emptyMessages: Message[] = [{ role: "user", text: "empty" }];
    const emptyModel = {
      async *stream(): AsyncIterable<AIMessageChunk> {
        yield { done: true, stopReason: "end_turn" };
      },
    };

    expect(await collect(run(emptyModel, [], emptyMessages))).toEqual([]);
    expect(emptyMessages).toEqual([{ role: "user", text: "empty" }]);
  });

  test("does not append partial tool results when aborted during tool execution", async () => {
    const abortController = new AbortController();
    const messages: Message[] = [{ role: "user", text: "run tools" }];
    const model = {
      async *stream(): AsyncIterable<AIMessageChunk> {
        yield { delta: { type: "tool_use", id: "toolu_a", name: "record" } };
        yield { delta: { type: "input_json_delta", id: "toolu_a", partial_json: "{}" } };
        yield { delta: { type: "tool_use", id: "toolu_b", name: "record" } };
        yield { delta: { type: "input_json_delta", id: "toolu_b", partial_json: "{}" } };
        yield { done: true, stopReason: "tool_use" };
      },
    };

    await collect(
      run(
        model,
        [
          tool("record", () => {
            abortController.abort();
            return { content: "recorded" };
          }),
        ],
        messages,
        { signal: abortController.signal },
      ),
    );

    expect(messages).toEqual([
      { role: "user", text: "run tools" },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "toolu_a", name: "record", input: {} },
          { type: "tool_use", id: "toolu_b", name: "record", input: {} },
        ],
      },
    ]);
  });

  test("stops after maxSteps and runs multiple tool calls in order", async () => {
    const messages: Message[] = [{ role: "user", text: "loop" }];
    const calls: unknown[] = [];
    const model = {
      async *stream(): AsyncIterable<AIMessageChunk> {
        yield { delta: { type: "tool_use", id: "toolu_a", name: "record" } };
        yield { delta: { type: "input_json_delta", id: "toolu_a", partial_json: '{"n":1}' } };
        yield { delta: { type: "tool_use", id: "toolu_b", name: "record" } };
        yield { delta: { type: "input_json_delta", id: "toolu_b", partial_json: '{"n":2}' } };
        yield { done: true, stopReason: "tool_use" };
      },
    };

    await collect(
      run(
        model,
        [
          tool("record", (input: unknown) => {
            calls.push(input);
            return { content: `recorded:${calls.length}` };
          }),
        ],
        messages,
        { maxSteps: 2 },
      ),
    );

    expect(calls).toEqual([{ n: 1 }, { n: 2 }, { n: 1 }, { n: 2 }]);
    expect(messages).toHaveLength(5);
  });

  test("forwards tools to model via ChatModelOptions", async () => {
    let capturedTools: unknown;
    const model: ChatModel = {
      async *stream(_messages, options): AsyncIterable<AIMessageChunk> {
        capturedTools = options?.tools;
        yield { done: true, stopReason: "end_turn" };
      },
    };
    const messages: Message[] = [{ role: "user", text: "hi" }];
    const lookup = tool("lookup", () => ({ content: "ok" }));

    await collect(run(model, [lookup], messages));

    expect(capturedTools).toEqual([lookup]);
  });
});
