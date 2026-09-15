import { describe, expect, test } from "bun:test";
import { createYieldTool } from "./yield-tool.js";

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
} as const;

/** omp delivers a subagent's structured result through a `yield` TOOL, so the
 *  payload arrives as provider-parsed arguments. oma used to parse the child's
 *  final TEXT, which a markdown fence breaks — a real 7-agent fan-out lost 5
 *  subagents that way. */
describe("createYieldTool", () => {
  test("a valid payload is captured and terminates the child's loop", async () => {
    let captured: unknown;
    const tool = createYieldTool(schema, (payload) => (captured = payload));
    const result = await tool.execute({ summary: "adapter layer" });
    expect(captured).toEqual({ summary: "adapter layer" });
    // `terminate` is what ends the loop on the same turn (omp's run completes
    // on yield).
    expect(result).toMatchObject({ terminate: true });
    expect(result.isError).toBeUndefined();
  });

  test("an invalid payload is rejected WITHOUT capturing, so the child can fix it", async () => {
    let captured: unknown;
    const tool = createYieldTool(schema, (payload) => (captured = payload));
    const result = await tool.execute({ nope: 1 });
    expect(captured).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("yield rejected");
    expect(result.terminate).toBeUndefined();
  });

  test("the schema is the tool's own inputSchema", () => {
    const tool = createYieldTool(schema, () => {});
    expect(tool.inputSchema).toEqual(schema);
  });
});
