import { describe, expect, test } from "bun:test";
import { ACP_AGENTS, harnessOf, resolveAcpAgentKey } from "./registry.js";

describe("resolveAcpAgentKey", () => {
  test("accepts the bare registry key and the acp/<key> packing", () => {
    expect(resolveAcpAgentKey("oma")).toBe("oma");
    expect(resolveAcpAgentKey("acp/claude")).toBe("claude");
  });

  test("an unknown harness fails loudly instead of falling back", () => {
    // A silent default would spawn a different harness than the run named;
    // a mistyped key must never look like it worked.
    expect(() => resolveAcpAgentKey("ghost")).toThrow(
      new RegExp(`unknown ACP harness 'ghost'.*${Object.keys(ACP_AGENTS).join(", ")}`),
    );
    expect(() => resolveAcpAgentKey(undefined)).toThrow(/unknown ACP harness ''/);
  });
});

describe("harnessOf", () => {
  test("prefers the explicit field over the modelId packing", () => {
    expect(harnessOf({ modelId: "acp/omp", harness: "pi" })).toBe("pi");
    expect(harnessOf({ modelId: "acp/omp" })).toBe("acp/omp");
  });
});
