import { describe, expect, test } from "bun:test";
import { ACP_AGENTS } from "@chengchenccc/adapter-acp";
import { acpAgentForLegacyKind, aliasModelRefForAcp } from "./acp-alias.js";

describe("legacy kinds as ACP aliases", () => {
  test("an old kind resolves to the agent it names, not to the adapter's default", () => {
    // The trap this pins: the adapter resolves its agent from the MODEL id and falls back to the
    // default when it cannot, so a translated kind carrying an untranslated model id would run
    // `omp` for someone who asked for Claude.
    expect(
      aliasModelRefForAcp({ backendKind: "claude_code", modelId: "claude-sonnet-4-6" }),
    ).toEqual({
      backendKind: "acp",
      modelId: "acp/claude",
    });
    expect(aliasModelRefForAcp({ backendKind: "pi", modelId: "pi/whatever" })).toEqual({
      backendKind: "acp",
      modelId: "acp/pi",
    });
    expect(aliasModelRefForAcp({ backendKind: "omp", modelId: "zai/glm-4.6" })).toEqual({
      backendKind: "acp",
      modelId: "acp/omp",
    });
  });

  test("a run that is already ACP, or a kind nobody knows, is left alone", () => {
    expect(aliasModelRefForAcp({ backendKind: "acp", modelId: "acp/omp" })).toBeNull();
    expect(aliasModelRefForAcp({ backendKind: "oma", modelId: "zai/glm-4.6" })).toBeNull();
    expect(aliasModelRefForAcp({ backendKind: "something_new", modelId: "x" })).toBeNull();
  });

  test("the agent's own reasoning effort survives the alias", () => {
    expect(
      aliasModelRefForAcp({ backendKind: "claude_code", modelId: "m", reasoningEffort: "high" }),
    ).toEqual({ backendKind: "acp", modelId: "acp/claude", reasoningEffort: "high" });
  });

  test("every legacy kind names a registry entry that exists", () => {
    // A registry rename would otherwise turn into the adapter's silent default at runtime.
    for (const kind of ["claude_code", "pi", "omp"]) {
      const key = acpAgentForLegacyKind(kind);
      expect(key).toBeDefined();
      expect(key && key in ACP_AGENTS).toBe(true);
    }
  });
});
