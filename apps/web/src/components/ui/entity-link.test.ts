import { describe, expect, test } from "bun:test";
import { entityLabelText, shortEntityId } from "./entity-link";

describe("entityLabelText", () => {
  test("prefers the human-readable label when present", () => {
    expect(entityLabelText("requirement", "req_019abc1234567890", "Lark channel wizard")).toBe(
      "Lark channel wizard",
    );
  });

  test("falls back to kind + shortened id when label is missing or blank", () => {
    const out = entityLabelText("conversation", "conv_019abc1234567890", "   ");
    expect(out).toContain(shortEntityId("conv_019abc1234567890"));
    expect(out).not.toBe("conv_019abc1234567890");
  });
});

describe("shortEntityId", () => {
  test("truncates long opaque ids while keeping short ids intact", () => {
    expect(shortEntityId("abc12345")).toBe("abc12345");
    expect(shortEntityId("019abc12-3456-7890-abcd-ef1234567890")).toBe("019abc12…");
  });
});
