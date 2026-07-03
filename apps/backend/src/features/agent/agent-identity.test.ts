import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentIdentityStore } from "./agent-identity.js";

const tmpBase = `/tmp/agent-identity-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const dataDir = path.join(tmpBase, "data");

function agentRoot(agentId: string): string {
  return path.join(dataDir, "agents", agentId);
}

function clean() {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

afterAll(() => clean());
beforeEach(() => {
  clean();
});

function makeStore() {
  return createAgentIdentityStore({
    dataDir,
    getAgent: async (id) => {
      return { workspacePath: path.join(tmpBase, "legacy", id) };
    },
  });
}

describe("AgentIdentityStore", () => {
  test("getIdentity returns nulls for empty workspace", async () => {
    const store = makeStore();
    const identity = await store.getIdentity(`agent-${Date.now()}`);
    expect(identity.soul).toBeNull();
    expect(identity.user).toBeNull();
    expect(identity.memories).toEqual([]);
  });

  test("getIdentity reads SOUL.md and USER.md from workspace", async () => {
    const agentId = `soul-test-${Date.now()}`;
    const root = agentRoot(agentId);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "SOUL.md"), "I am a tester", "utf-8");
    await writeFile(path.join(root, "USER.md"), "human dev", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.soul).toBe("I am a tester");
    expect(identity.user).toBe("human dev");
  });

  test("getIdentity reads memory/MEMORY.md as summary", async () => {
    const agentId = `mem-summary-${Date.now()}`;
    const root = agentRoot(agentId);
    await mkdir(path.join(root, "memory"), { recursive: true });
    await writeFile(path.join(root, "memory", "MEMORY.md"), "dated summary text", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.memories).toHaveLength(1);
    expect(identity.memories[0]).toEqual({ date: "summary", content: "dated summary text" });
  });

  test("getIdentity reads memory/facts/*.md as facts", async () => {
    const agentId = `mem-facts-${Date.now()}`;
    const root = agentRoot(agentId);
    await mkdir(path.join(root, "memory", "facts"), { recursive: true });
    await writeFile(
      path.join(root, "memory", "facts", "2025-06-01.md"),
      "Today I learned X",
      "utf-8",
    );
    await writeFile(
      path.join(root, "memory", "facts", "2025-06-02.md"),
      "Today I fixed Y",
      "utf-8",
    );

    const store = makeStore();
    const identity = await store.getIdentity(agentId);
    expect(identity.memories).toHaveLength(2);
    const dates = identity.memories.map((m) => m.date).sort();
    expect(dates).toEqual(["2025-06-01", "2025-06-02"]);
  });

  test("reads identity files from agent workspace", async () => {
    const agentId = `workspace-${Date.now()}`;
    const root = agentRoot(agentId);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "SOUL.md"), "shared soul", "utf-8");
    await writeFile(path.join(root, "USER.md"), "shared user", "utf-8");

    const store = makeStore();
    const identity = await store.getIdentity(agentId);

    expect(identity.soul).toBe("shared soul");
    expect(identity.user).toBe("shared user");
  });

  test("updateIdentity writes SOUL.md and USER.md to workspace", async () => {
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
