import { describe, expect, test } from "bun:test";
import { createMemorySaveTool } from "./memory-save.js";

describe("createMemorySaveTool", () => {
  test("stores key-value in the provided Map", () => {
    const store = new Map<string, string>();
    const tool = createMemorySaveTool(store);

    const result = tool.execute({ key: "name", value: "claude" });

    expect(result).toEqual({ content: "Saved: name" });
    expect(store.get("name")).toBe("claude");
  });

  test("overwrites existing key", () => {
    const store = new Map<string, string>([["key", "old"]]);
    const tool = createMemorySaveTool(store);

    tool.execute({ key: "key", value: "new" });

    expect(store.get("key")).toBe("new");
  });
});
