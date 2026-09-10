import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasProjectSettings,
  loadProjectSettings,
  resolveRuntimeKnobs,
  saveProjectModel,
} from "./project-settings.js";

describe("project settings", () => {
  test("missing/corrupt file degrades to {}", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      expect(loadProjectSettings(root)).toEqual({});
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(join(root, ".oma", "settings.json"), "{not json", "utf8");
      expect(loadProjectSettings(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("saveProjectModel writes and loadProjectSettings reads it", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      expect(hasProjectSettings(root)).toBe(false);
      saveProjectModel(root, "fake/echo2");
      expect(hasProjectSettings(root)).toBe(true);
      expect(loadProjectSettings(root)).toEqual({ model: "fake/echo2" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads configured skills array", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({ model: "fake/echo", skills: ["skills", "/abs/skills"] }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        model: "fake/echo",
        skills: ["skills", "/abs/skills"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads skill source toggles", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({ enableClaude: true, enableCodex: false, enableAgents: true }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        enableClaude: true,
        enableCodex: false,
        enableAgents: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads P0 numeric/boolean knobs", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({
          maxSteps: 42,
          modelTimeoutMs: 1000,
          mcpTimeoutMs: 2000,
          disableWeb: true,
          bashSandbox: true,
          bashTimeoutMs: 5000,
          maxToolTimeoutMs: 600000,
          titleEnabled: false,
          memoryExtract: true,
          memoryModel: "fake/echo",
          permissionClassifierModel: "fake/echo2",
        }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        maxSteps: 42,
        modelTimeoutMs: 1000,
        mcpTimeoutMs: 2000,
        disableWeb: true,
        bashSandbox: true,
        bashTimeoutMs: 5000,
        maxToolTimeoutMs: 600000,
        titleEnabled: false,
        memoryExtract: true,
        memoryModel: "fake/echo",
        permissionClassifierModel: "fake/echo2",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Runtime knobs are pure data: workspace settings → explicit knobs, process
 *  env only as the deployment default. The runtime no longer WRITES
 *  process.env (a long-lived process runs many Runs; a leaked env write would
 *  apply one Run's workspace settings to the next). */
describe("resolveRuntimeKnobs", () => {
  test("settings win over env", () => {
    const knobs = resolveRuntimeKnobs(
      { maxSteps: 7, modelTimeoutMs: 1000, disableWeb: true, titleEnabled: false },
      {
        OMA_MAX_STEPS: "99",
        OMA_MODEL_TIMEOUT_MS: "9999",
        OMA_DISABLE_WEB: "0",
        OMA_TITLE_ENABLED: "1",
      },
    );
    expect(knobs.maxSteps).toBe(7);
    expect(knobs.modelTimeoutMs).toBe(1000);
    expect(knobs.disableWeb).toBe(true);
    expect(knobs.titleEnabled).toBe(false);
  });

  test("env fills the gaps; absent everywhere stays undefined (caller default)", () => {
    const knobs = resolveRuntimeKnobs(undefined, {
      OMA_MAX_STEPS: "42",
      OMA_BASH_TIMEOUT_MS: "1500",
      OMA_MCP_TIMEOUT_MS: "0",
      OMA_CONV_TITLED: "1",
    });
    expect(knobs.maxSteps).toBe(42);
    expect(knobs.bashTimeoutMs).toBe(1500);
    expect(knobs.mcpTimeoutMs).toBe(0);
    expect(knobs.conversationTitled).toBe(true);
    expect(knobs.modelTimeoutMs).toBeUndefined();
    expect(knobs.memoryModel).toBeUndefined();
  });

  test("garbage numeric env is ignored, never NaN-poisoned", () => {
    const knobs = resolveRuntimeKnobs(undefined, {
      OMA_MAX_STEPS: "abc",
      OMA_EVAL_TIMEOUT_MS: "   ",
    });
    expect(knobs.maxSteps).toBeUndefined();
    expect(knobs.evalTimeoutMs).toBeUndefined();
  });

  test("classifier model is trimmed; blank resolves unset", () => {
    expect(
      resolveRuntimeKnobs({ permissionClassifierModel: " fake/echo2 " }, {})
        .permissionClassifierModel,
    ).toBe("fake/echo2");
    expect(
      resolveRuntimeKnobs(undefined, { OMA_PERMISSION_CLASSIFIER_MODEL: " " })
        .permissionClassifierModel,
    ).toBeUndefined();
  });
});

describe("prune knobs", () => {
  test("a partial prune block is validated field by field", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-prune-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({
          prune: {
            protectTokens: 100,
            minimumSavings: "nope",
            protectedTools: ["bash", 7],
          },
        }),
        "utf8",
      );
      expect(loadProjectSettings(root).prune).toEqual({ protectTokens: 100 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prune reaches the runtime knobs only when present", () => {
    expect(resolveRuntimeKnobs(undefined, {}).prune).toBeUndefined();
    expect(
      resolveRuntimeKnobs({ prune: { protectTokens: 5, protectedTools: ["skill_load"] } }, {})
        .prune,
    ).toEqual({ protectTokens: 5, protectedTools: ["skill_load"] });
  });
});
