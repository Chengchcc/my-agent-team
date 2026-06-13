import { describe, expect, test } from "bun:test";
import { render } from "./render.js";

describe("render", () => {
  test("renders raw string (non-JSON)", () => {
    expect(render("hello world")).toBe("hello world");
  });

  test("renders {text} object", () => {
    expect(render(JSON.stringify({ text: "hello from agent" }))).toBe("hello from agent");
  });

  test("renders ContentBlock[] — returns joined text blocks", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "text", text: "World" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    ];
    expect(render(JSON.stringify(blocks))).toBe("Hello World");
  });

  test("renders ContentBlock[] with no text blocks — fallback", () => {
    const blocks = [{ type: "tool_use", id: "t1", name: "read", input: {} }];
    expect(render(JSON.stringify(blocks))).toBe("[Unsupported content]");
  });

  test("renders unknown structured object — fallback", () => {
    expect(render(JSON.stringify({ foo: "bar" }))).toBe("[Unsupported content]");
  });

  test("renders JSON string that's already plain text", () => {
    // JSON-encoded string: "\"already a string\""
    expect(render(JSON.stringify("already a string"))).toBe("already a string");
  });
});
