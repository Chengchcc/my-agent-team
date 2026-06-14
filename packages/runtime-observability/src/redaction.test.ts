import { describe, test, expect } from "bun:test";
import { redactAttributes, isRedactedKey } from "./redaction.js";
import type { RuntimeSpanAttributes } from "./types.js";

describe("redactAttributes", () => {
  test("passes through allowed attributes", () => {
    const attrs: RuntimeSpanAttributes = {
      "run.id": "r1",
      "agent.id": "a1",
      "run.kind": "main",
    };
    expect(redactAttributes(attrs)).toEqual(attrs);
  });

  test("strips message.text", () => {
    const attrs = {
      "run.id": "r1",
    } as RuntimeSpanAttributes;
    (attrs as Record<string, unknown>)["message.text"] = "hello world";
    const result = redactAttributes(attrs);
    expect(result["run.id"]).toBe("r1");
    expect((result as Record<string, unknown>)["message.text"]).toBeUndefined();
  });

  test("strips tool.input", () => {
    const attrs = {
      "run.id": "r1",
    } as RuntimeSpanAttributes;
    (attrs as Record<string, unknown>)["tool.input"] = "rm -rf /";
    const result = redactAttributes(attrs);
    expect((result as Record<string, unknown>)["tool.input"]).toBeUndefined();
  });

  test("strips lark private identifiers", () => {
    expect(isRedactedKey("lark.chat_id")).toBe(true);
    expect(isRedactedKey("lark.open_id")).toBe(true);
  });

  test("strips secrets", () => {
    expect(isRedactedKey("profile.secret")).toBe(true);
    expect(isRedactedKey("api.key")).toBe(true);
  });

  test("allows non-sensitive keys", () => {
    expect(isRedactedKey("run.id")).toBe(false);
    expect(isRedactedKey("agent.id")).toBe(false);
    expect(isRedactedKey("tool.name")).toBe(false);
  });
});
