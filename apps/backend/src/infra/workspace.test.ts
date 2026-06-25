import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { materializeWorkspace, purgeWorkspace } from "./workspace.js";

const ROOT = `/tmp/test-workspace-m11-${Date.now()}`;

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("materializeWorkspace", () => {
  test("creates workspace and memory/ directory", async () => {
    const agentId = `agent-${Date.now()}`;
    const wsPath = await materializeWorkspace({
      workspaceRoot: ROOT,
      agentId,
      templateDir: `${ROOT}/templates`,
    });

    expect(existsSync(wsPath)).toBe(true);
    expect(existsSync(path.join(wsPath, "memory"))).toBe(true);
  });

  test("copies template if provided", async () => {
    const agentId = `agent-templated-${Date.now()}`;
    const templateDir = `${ROOT}/templates/coding`;
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, "SOUL.md"), "coding soul");

    const result = await materializeWorkspace({
      workspaceRoot: ROOT,
      agentId,
      template: "coding",
      templateDir: `${ROOT}/templates`,
    });

    expect(existsSync(path.join(result, "SOUL.md"))).toBe(true);
  });
});

describe("purgeWorkspace", () => {
  test("removes workspace directory", async () => {
    const wsPath = path.join(ROOT, `purge-test-${Date.now()}`);
    await mkdir(wsPath, { recursive: true });
    await writeFile(path.join(wsPath, "some-file.txt"), "data");

    await purgeWorkspace({ workspaceRoot: ROOT, agentId: path.basename(wsPath) });

    expect(existsSync(wsPath)).toBe(false);
  });

  test("idempotent: double purge does not throw", async () => {
    const agentId = `purge-idem-${Date.now()}`;
    const wsPath = path.join(ROOT, agentId);
    await mkdir(wsPath, { recursive: true });

    await purgeWorkspace({ workspaceRoot: ROOT, agentId });
    await purgeWorkspace({ workspaceRoot: ROOT, agentId });

    expect(existsSync(wsPath)).toBe(false);
  });

  test("rejects path traversal", async () => {
    await expect(purgeWorkspace({ workspaceRoot: ROOT, agentId: "../escape" })).rejects.toThrow(
      "path traversal",
    );
  });
});
