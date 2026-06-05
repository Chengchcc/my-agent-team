import { describe, expect, test } from "bun:test";
import { createMemoryRecallTool } from "./memory-recall.js";

describe("createMemoryRecallTool", () => {
  test("returns value for existing key", () => {
    const store = new Map<string, string>([["name", "claude"]]);
    const tool = createMemoryRecallTool(store);

    const result = tool.execute({ key: "name" });

    expect(result).toEqual({ content: "claude" });
  });

  test("returns isError when key not found", () => {
    const store = new Map<string, string>();
    const tool = createMemoryRecallTool(store);

    const result = tool.execute({ key: "missing" });

    expect(result).toEqual({ content: "Key not found: missing", isError: true });
  });
});
