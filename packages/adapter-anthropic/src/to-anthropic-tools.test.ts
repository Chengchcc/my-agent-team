import { describe, expect, test } from "bun:test";
import type { Tool } from "@my-agent-team/core";
import { toAnthropicTools } from "./to-anthropic-tools.js";

describe("toAnthropicTools", () => {
  test("maps name, description, and inputSchema to Anthropic tool shape", () => {
    const tools: Tool[] = [
      {
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute: () => ({ content: "done" }),
      },
      {
        name: "write",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        execute: () => ({ content: "done" }),
      },
    ];

    const result = toAnthropicTools(tools);

    expect(result).toEqual([
      {
        name: "read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write",
        description: "Write a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(toAnthropicTools([])).toEqual([]);
  });
});
