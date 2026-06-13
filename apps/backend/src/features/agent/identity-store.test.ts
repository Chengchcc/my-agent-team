import { mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createAgentIdentityStore } from "./identity-store.js";

const tmpBase = `/tmp/identity-store-test-${Date.now()}`;
const dataDir = path.join(tmpBase, "data");

function clean() {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
}

afterAll(() => clean());
beforeEach(() => {
  clean();
});

function makeStore() {
  return createAgentIdentityStore({
    dataDir,
    getAgent: async (id) => {
      // Return a legacy workspace path that may or may not exist
      return { workspacePath: path.join(tmpBase, "legacy", id) };
    },
  });
}

describe("AgentIdentityStore", () => {
  test("getIdentity returns nulls for empty sharedRoot", async () => {
    const store = makeStore();
    const identity = await store.getIdentity(`agent-${Date.now()}`);
    expect(identity.soul).toBeNull();
    expect(identity.user).toBeNull();
    expect(identity.memories).toEqual([]);
  });

  test("getIdentity reads SOUL.md and USER.md from sharedRoot", async () => {
    const agentId = `soul-test-${Date.now()}`;
    // Manually seed sharedRoot (simulating create flow or agent writing)
    const { runnerWorkspacePaths, ensureRunnerWorkspace } = await import(
      "../../infra/runner-workspace.js"
    );
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await writeFile(path.join(paths.sharedRoot, "SOUL.md"), "I am a tester", "utf-8");
    await writeFile(path.join(paths.sharedRoot, "USER.md"), "human dev", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.soul).toBe("I am a tester");
    expect(identity.user).toBe("human dev");
  });

  test("getIdentity reads memory/MEMORY.md as summary", async () => {
    const agentId = `mem-summary-${Date.now()}`;
    const { runnerWorkspacePaths, ensureRunnerWorkspace } = await import(
      "../../infra/runner-workspace.js"
    );
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await mkdir(path.join(paths.sharedRoot, "memory"), { recursive: true });
    await writeFile(
      path.join(paths.sharedRoot, "memory", "MEMORY.md"),
      "dated summary text",
      "utf-8",
    );

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.memories).toHaveLength(1);
    expect(identity.memories[0]).toEqual({ date: "summary", content: "dated summary text" });
  });

  test("getIdentity reads memory/facts/*.md as facts", async () => {
    const agentId = `mem-facts-${Date.now()}`;
    const { runnerWorkspacePaths, ensureRunnerWorkspace } = await import(
      "../../infra/runner-workspace.js"
    );
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await mkdir(path.join(paths.sharedRoot, "memory", "facts"), { recursive: true });
    await writeFile(
      path.join(paths.sharedRoot, "memory", "facts", "2025-06-01.md"),
      "Today I learned X",
      "utf-8",
    );
    await writeFile(
      path.join(paths.sharedRoot, "memory", "facts", "2025-06-02.md"),
      "Today I fixed Y",
      "utf-8",
    );

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.memories).toHaveLength(2);
    const dates = identity.memories.map((m) => m.date).sort();
    expect(dates).toEqual(["2025-06-01", "2025-06-02"]);
  });

  test("lazy migration copies legacy identity files to sharedRoot", async () => {
    const agentId = `lazy-${Date.now()}`;
    // Create legacy workspace with SOUL/USER
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    await mkdir(legacyWs, { recursive: true });
    await writeFile(path.join(legacyWs, "SOUL.md"), "legacy soul", "utf-8");
    await writeFile(path.join(legacyWs, "USER.md"), "legacy user", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);

    // Should have been migrated from legacy
    expect(identity.soul).toBe("legacy soul");
    expect(identity.user).toBe("legacy user");
  });

  test("lazy migration does not overwrite existing sharedRoot files", async () => {
    const agentId = `lazy-nowrite-${Date.now()}`;
    // Pre-seed sharedRoot
    const { runnerWorkspacePaths, ensureRunnerWorkspace } = await import(
      "../../infra/runner-workspace.js"
    );
    const paths = runnerWorkspacePaths(dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    await writeFile(path.join(paths.sharedRoot, "SOUL.md"), "existing soul", "utf-8");

    // Create legacy workspace with a different SOUL.md
    const legacyWs = path.join(tmpBase, "legacy", agentId);
    await mkdir(legacyWs, { recursive: true });
    await writeFile(path.join(legacyWs, "SOUL.md"), "legacy soul", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);

    // Existing sharedRoot file should win
    expect(identity.soul).toBe("existing soul");
  });

  test("updateIdentity writes SOUL.md and USER.md to sharedRoot", async () => {
    const agentId = `update-${Date.now()}`;
    const store = makeStore();

    await store.updateIdentity(agentId, { soul: "updated soul" });
    const identity1 = await store.getIdentity(agentId);
    expect(identity1.soul).toBe("updated soul");
    expect(identity1.user).toBeNull();

    await store.updateIdentity(agentId, { user: "updated user" });
    const identity2 = await store.getIdentity(agentId);
    expect(identity2.soul).toBe("updated soul");
    expect(identity2.user).toBe("updated user");
  });
});
