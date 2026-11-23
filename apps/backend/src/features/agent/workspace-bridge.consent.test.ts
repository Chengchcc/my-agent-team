import { describe, expect, test } from "bun:test";
import { PRODUCT_CONSENTED_MCP_TOOLS } from "./workspace-bridge.js";

/** ADR 0072/0075: the child's permission classifier must not put a human click
 *  in front of the product's own tools. Live 2026-11-21 the front desk parked
 *  on `team_list` - a read - because the list had not grown with the tools. */
describe("consented product tools", () => {
  test("read-only and product-authorized tools are exempt", () => {
    for (const tool of [
      "mcp__product-tools__team_list",
      "mcp__product-tools__project_list",
      "mcp__product-tools__requirement_query",
      "mcp__product-tools__wiki_query",
      "mcp__product-tools__wiki_read",
      "mcp__product-tools__wiki_lint",
      "mcp__product-tools__history_recent",
    ]) {
      expect(PRODUCT_CONSENTED_MCP_TOOLS).toContain(tool);
    }
  });

  test("storage writes stay gated - consent is not a prefix rule", () => {
    expect(PRODUCT_CONSENTED_MCP_TOOLS).not.toContain("mcp__product-tools__artifact_upload");
  });
});
