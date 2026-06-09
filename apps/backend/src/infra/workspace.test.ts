import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { materializeWorkspace, purgeWorkspace } from "./workspace.js";

const ROOT = `/tmp/test-workspace-m11-${Date.now()}`;

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("materializeWorkspace (M11)", () => {
  test("empty workspace → creates memory/ dir and writes BOOTSTRAP.md", async () => {
    const agentId = `agent-${Date.now()}`;
    const wsPath = await materializeWorkspace({
      workspaceRoot: ROOT,
      agentId,
      templateDir: `${ROOT}/templates`,
    });

    expect(existsSync(wsPath)).toBe(true);
    expect(existsSync(path.join(wsPath, "memory"))).toBe(true);
    expect(existsSync(path.join(wsPath, "BOOTSTRAP.md"))).toBe(true);
  });

  test("workspace with existing SOUL.md → no BOOTSTRAP.md written", async () => {
    const agentId = `agent-souled-${Date.now()}`;
    const wsPath = path.join(ROOT, agentId);
    await mkdir(wsPath, { recursive: true });
    await writeFile(path.join(wsPath, "SOUL.md"), "I am an agent");

    const result = await materializeWorkspace({
      workspaceRoot: ROOT,
      agentId,
      templateDir: `${ROOT}/templates`,
    });

    expect(existsSync(path.join(result, "SOUL.md"))).toBe(true);
    expect(existsSync(path.join(result, "BOOTSTRAP.md"))).toBe(false);
  });

  test("template with SOUL.md → BOOTSTRAP.md skipped", async () => {
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
    expect(existsSync(path.join(result, "BOOTSTRAP.md"))).toBe(false);
  });
});

describe("purgeWorkspace (M11)", () => {
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
    // Second purge should not throw
    await purgeWorkspace({ workspaceRoot: ROOT, agentId });

    expect(existsSync(wsPath)).toBe(false);
  });

  test("rejects path traversal (../ attack)", async () => {
    await expect(purgeWorkspace({ workspaceRoot: ROOT, agentId: "../escape" })).rejects.toThrow(
      "path traversal",
    );
  });

  test("rejects path traversal via absolute path outside root", async () => {
    await expect(purgeWorkspace({ workspaceRoot: ROOT, agentId: "/etc/passwd" })).rejects.toThrow(
      "path traversal",
    );
  });
});
