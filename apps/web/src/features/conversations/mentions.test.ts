import { describe, expect, test } from "bun:test";
import { parseMentions } from "./mentions.js";

const roster = [
  { agentId: "coder", displayName: "Coder" },
  { agentId: "data-analyst", displayName: "Data Analyst" },
];

describe("ADR 0041 @mention parsing", () => {
  test("an @displayName hit resolves to the member id", () => {
    expect(parseMentions("hey @Coder can you look?", roster)).toEqual(["coder"]);
  });

  test("an @agentId hit works too (unambiguous form)", () => {
    expect(parseMentions("@data-analyst ping", roster)).toEqual(["data-analyst"]);
  });

  test("multiple mentions resolve in order of appearance, deduplicated", () => {
    expect(parseMentions("@Coder and @coder and @Data", roster)).toEqual(["coder"]);
  });

  test("unknown names mention nobody (they stay plain text)", () => {
    expect(parseMentions("@stranger hello", roster)).toEqual([]);
  });

  test("case-insensitive; word boundary prevents substring hits", () => {
    expect(parseMentions("@CODER", roster)).toEqual(["coder"]);
    expect(parseMentions("email@example.com and @code", roster)).toEqual([]);
  });
});
