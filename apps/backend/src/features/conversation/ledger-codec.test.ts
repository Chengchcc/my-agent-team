import { describe, expect, test } from "bun:test";
import { senderLabelOf } from "./ledger-codec.js";

describe("ledger sender labels", () => {
  test("the label comes from the stored payload, not a dropped column", () => {
    expect(senderLabelOf(JSON.stringify({ role: "user", text: "hi" }))).toBe("User");
    expect(senderLabelOf({ role: "assistant" })).toBe("Agent");
    expect(senderLabelOf({ role: "tool" })).toBe("Tool");
    expect(senderLabelOf({ role: "custom" })).toBe("custom");
    expect(senderLabelOf("not json")).toBe("System");
    expect(senderLabelOf(null)).toBe("System");
  });
});
