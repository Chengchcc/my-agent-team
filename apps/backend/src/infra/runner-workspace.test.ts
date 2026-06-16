import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureRunnerWorkspace,
  migrateLegacyWorkspaceToShared,
  purgeRunnerWorkspace,
  runnerWorkspacePaths,
  safeRunnerAgentId,
} from "./runner-workspace.js";

const tmpBase = `/tmp/runner-workspace-test-${Date.now()}`;
const dataDir = path.join(tmpBase, "data");

function clean() {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

beforeAll(() => clean());
afterAll(() => clean());

describe("runnerWorkspacePaths", () => {
  test("returns structured paths for an agentId", () => {
    const paths = runnerWorkspacePaths(dataDir, "test-agent");
    expect(paths.runnerRoot).toEndWith("runners/test-agent");
    expect(paths.sharedRoot).toEndWith("runners/test-agent/shared");
    expect(paths.privateRoot).toEndWith("runners/test-agent/private");
    expect(paths.stateRoot).toEndWith("runners/test-agent/state");
    expect(paths.socketPath).toEndWith("runners/test-agent/runner.sock");
    expect(paths.pidFile).toEndWith("runners/test-agent/runner.pid");
  });
});

describe("safeRunnerAgentId", () => {
  test("passes through ULID-formatted ids", () => {
    expect(safeRunnerAgentId("64feaf4a79af4c0b90165be300")).toBe("64feaf4a79af4c0b90165be300");
    expect(safeRunnerAgentId("abc123-DEF_ghi")).toBe("abc123-DEF_ghi");
  });

  test("rejects characters outside [a-zA-Z0-9_-]", () => {
    expect(() => safeRunnerAgentId("a/b")).toThrow("invalid runner agentId");
    expect(() => safeRunnerAgentId("a b")).toThrow("invalid runner agentId");
    expect(() => safeRunnerAgentId("a.b")).toThrow("invalid runner agentId");
  });
});

describe("ensureRunnerWorkspace", () => {
  test("creates shared/private/state dirs", async () => {
    const agentId = `ensure-test-${Date.now()}`;
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    // All three should exist
    const { stat } = await import("node:fs/promises");
    await expect(stat(paths.sharedRoot)).resolves.toBeDefined();
    await expect(stat(paths.privateRoot)).resolves.toBeDefined();
    await expect(stat(paths.stateRoot)).resolves.toBeDefined();
  });

  test("idempotent — calling twice doesn't throw", async () => {
    const agentId = `idem-test-${Date.now()}`;
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await ensureRunnerWorkspace(paths); // should not throw
  });
});

describe("migrateLegacyWorkspaceToShared", () => {
  test("copies identity files from legacy to sharedRoot", async () => {
    const agentId = `migrate-id-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(legacyWs, { recursive: true });
    await mkdir(path.join(legacyWs, "memory"), { recursive: true });
    await writeFile(path.join(legacyWs, "SOUL.md"), "I am a coder", "utf-8");
    await writeFile(path.join(legacyWs, "USER.md"), "User is a dev", "utf-8");
    await writeFile(path.join(legacyWs, "BOOTSTRAP.md"), "Boot content", "utf-8");

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    expect(await readFile(path.join(sharedRoot, "SOUL.md"), "utf-8")).toBe("I am a coder");
    expect(await readFile(path.join(sharedRoot, "USER.md"), "utf-8")).toBe("User is a dev");
    expect(await readFile(path.join(sharedRoot, "BOOTSTRAP.md"), "utf-8")).toBe("Boot content");
  });

  test("does not overwrite existing sharedRoot files", async () => {
    const agentId = `migrate-nowrite-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(legacyWs, { recursive: true });
    await mkdir(sharedRoot, { recursive: true });
    await writeFile(path.join(legacyWs, "SOUL.md"), "legacy soul", "utf-8");
    await writeFile(path.join(sharedRoot, "SOUL.md"), "existing soul", "utf-8");

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    // Existing file should NOT be overwritten
    expect(await readFile(path.join(sharedRoot, "SOUL.md"), "utf-8")).toBe("existing soul");
  });

  test("migrates MEMORY.md to shared/memory/MEMORY.md", async () => {
    const agentId = `migrate-mem-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(path.join(legacyWs, "memory"), { recursive: true });
    await writeFile(path.join(legacyWs, "memory", "MEMORY.md"), "summary content", "utf-8");

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    const memPath = path.join(sharedRoot, "memory", "MEMORY.md");
    expect(await readFile(memPath, "utf-8")).toBe("summary content");
  });

  test("migrates legacy flat memory/*.md to shared/memory/facts/", async () => {
    const agentId = `migrate-flat-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(path.join(legacyWs, "memory"), { recursive: true });
    await writeFile(path.join(legacyWs, "memory", "2025-01-15.md"), "old fact", "utf-8");

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    const factPath = path.join(sharedRoot, "memory", "facts", "2025-01-15.md");
    expect(await readFile(factPath, "utf-8")).toBe("old fact");
  });

  test("migrates legacy memory/facts/*.md to shared/memory/facts/", async () => {
    const agentId = `migrate-facts-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(path.join(legacyWs, "memory", "facts"), { recursive: true });
    await writeFile(
      path.join(legacyWs, "memory", "facts", "2025-03-20.md"),
      "fact from facts dir",
      "utf-8",
    );

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    const factPath = path.join(sharedRoot, "memory", "facts", "2025-03-20.md");
    expect(await readFile(factPath, "utf-8")).toBe("fact from facts dir");
  });

  test("creates shared/memory/ parent dir before copying MEMORY.md", async () => {
    const agentId = `migrate-parent-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    // sharedRoot exists but shared/memory/ does NOT — this was the P0 bug
    await mkdir(sharedRoot, { recursive: true });
    await mkdir(path.join(legacyWs, "memory"), { recursive: true });
    await writeFile(path.join(legacyWs, "memory", "MEMORY.md"), "should survive", "utf-8");

    // Should not throw — copyIfMissing creates parent dirs
    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    const memPath = path.join(sharedRoot, "memory", "MEMORY.md");
    expect(await readFile(memPath, "utf-8")).toBe("should survive");
  });

  test("idempotent — calling twice doesn't overwrite", async () => {
    const agentId = `migrate-twice-${Date.now()}`;
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    const sharedRoot = path.join(tmpBase, "shared", agentId);
    await mkdir(path.join(legacyWs, "memory"), { recursive: true });
    await writeFile(path.join(legacyWs, "SOUL.md"), "soul v1", "utf-8");

    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);
    // Modify legacy source — should not affect already-migrated file
    await writeFile(path.join(legacyWs, "SOUL.md"), "soul v2", "utf-8");
    await migrateLegacyWorkspaceToShared(sharedRoot, legacyWs);

    expect(await readFile(path.join(sharedRoot, "SOUL.md"), "utf-8")).toBe("soul v1");
  });
});

describe("purgeRunnerWorkspace", () => {
  test("removes entire runner directory including shared/private/state", async () => {
    const agentId = `purge-test-${Date.now()}`;
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await writeFile(path.join(paths.sharedRoot, "test.txt"), "data", "utf-8");

    await purgeRunnerWorkspace({ dataDir, agentId });

    // After purge, runnerRoot should not exist
    const { stat } = await import("node:fs/promises");
    await expect(stat(paths.runnerRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("idempotent — purging twice doesn't throw", async () => {
    const agentId = `purge-twice-${Date.now()}`;
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await purgeRunnerWorkspace({ dataDir, agentId });
    await purgeRunnerWorkspace({ dataDir, agentId }); // should not throw
  });

  test("rejects empty agentId", async () => {
    await expect(purgeRunnerWorkspace({ dataDir, agentId: "" })).rejects.toThrow(
      "invalid runner agentId",
    );
  });

  test("rejects path traversal", async () => {
    await expect(purgeRunnerWorkspace({ dataDir, agentId: "../escape" })).rejects.toThrow(
      "invalid runner agentId",
    );
  });
});
