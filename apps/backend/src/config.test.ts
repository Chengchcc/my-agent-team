import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseEnv } from "@chengchenccc/config";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  test("applies defaults and resolves paths relative to cwd", () => {
    const env = parseEnv({
      BACKEND_AUTH_TOKEN: "test-token",
      BACKEND_DATA_DIR: "./tmp-data",
      BACKEND_RESOURCES_DIR: "./tmp-res",
      WORKFLOW_SCRIPTS_ENABLED: "1",
      WORKFLOW_SANDBOX_DENY_READ: "/secret/a, /secret/b ",
      OMA_BROWSER_LOCAL_NETWORK: "1",
    });
    const cfg = loadConfig(env);
    expect(cfg.authToken).toBe("test-token");
    expect(cfg.dataDir).toBe(resolve(process.cwd(), "./tmp-data"));
    expect(cfg.resourcesDir).toBe(resolve(process.cwd(), "./tmp-res"));
    expect(cfg.builtinSkillsDir).toBe(resolve(process.cwd(), "./tmp-res/skills"));
    expect(cfg.workflowShowcaseDir).toBe(resolve(process.cwd(), "./tmp-res/workflow-showcase"));
    expect(cfg.workflowScriptsEnabled).toBe(true);
    expect(cfg.browserLocalNetwork).toBe(true);
    expect(cfg.workflowScriptDenyReadDirs).toContain("/secret/a");
    expect(cfg.workflowScriptDenyReadDirs).toContain("/secret/b");
    expect(cfg.runTimeoutMs).toBe(30 * 60_000);
    expect(cfg.askTimeoutMs).toBe(24 * 60 * 60_000);
  });

  test("disables script nodes and local network by default", () => {
    const env = parseEnv({ BACKEND_AUTH_TOKEN: "tok" });
    const cfg = loadConfig(env);
    expect(cfg.workflowScriptsEnabled).toBe(false);
    expect(cfg.browserLocalNetwork).toBe(false);
  });
});
