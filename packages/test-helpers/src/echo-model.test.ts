import { describe, expect, test } from "bun:test";
import { echoModel } from "./echo-model.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}

describe("echoModel", () => {
  test("streams the scripted turn based on assistant messages already present", async () => {
    const model = echoModel({
      turns: [
        { type: "tool_call", id: "toolu_1", name: "lookup", input: { query: "weather" } },
        { type: "text", text: "done" },
      ],
    });

    const first = await collect(model.stream([{ role: "user", text: "hello" }]));
    expect(first).toEqual([
      { delta: { type: "tool_use", id: "toolu_1", name: "lookup" } },
      {
        delta: {
          type: "input_json_delta",
          id: "toolu_1",
          partial_json: JSON.stringify({ query: "weather" }),
        },
      },
      { done: true, stopReason: "tool_use" },
    ]);

    const second = await collect(
      model.stream([
        { role: "user", text: "hello" },
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "weather" } },
          ],
        },
      ]),
    );
    expect(second).toEqual([
      { delta: { type: "text", text: "done" } },
      { done: true, stopReason: "end_turn" },
    ]);
  });
});
