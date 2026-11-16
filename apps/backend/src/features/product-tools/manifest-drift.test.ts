import { describe, expect, test } from "bun:test";
import { PRODUCT_TOOLS } from "./dispatch.js";
import { buildHistoryTools } from "./manifest.js";

/** The repo keeps two hand-written copies of the product-tool schema: the
 *  run manifest (`manifest.ts`, persisted + written into the workspace) and
 *  the MCP ListTools list (`dispatch.ts`, what the MODEL actually reads).
 *  They drifted before (ask_question's options shape, ADR 0033 §14), and a
 *  model told the wrong shape posts arguments every consumer drops. This
 *  pins the part that must never disagree: the tool set, each tool's
 *  property names, and its required fields. Descriptions may differ. */
const manifestTools = buildHistoryTools("sse:x");

describe("product tool schemas: manifest ↔ ListTools", () => {
  test("same tool set", () => {
    // Order is presentation (the two lists read differently on purpose);
    // the SET is the contract.
    expect(manifestTools.map((t) => t.name).sort()).toEqual(
      PRODUCT_TOOLS.map((t) => t.name).sort(),
    );
  });

  test("same property names and required fields per tool", () => {
    for (const tool of manifestTools) {
      const other = PRODUCT_TOOLS.find((t) => t.name === tool.name);
      expect(other).toBeDefined();
      // `identity` is rail-owned (MCP sends it as _meta); the manifest may
      // declare it as a fallback, but it is not part of what a model is
      // asked to fill in — comparing it would pin that difference as drift.
      const propsOf = (schema: Readonly<Record<string, unknown>>) =>
        Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {})
          .filter((k) => k !== "identity")
          .sort();
      const mine = {
        properties: propsOf(tool.inputSchema),
        required: ((tool.inputSchema.required as string[] | undefined) ?? []).slice().sort(),
      };
      const theirs = {
        properties: propsOf(other!.inputSchema),
        required: ((other!.inputSchema.required as string[] | undefined) ?? []).slice().sort(),
      };
      expect(mine).toEqual(theirs);
    }
  });
});
