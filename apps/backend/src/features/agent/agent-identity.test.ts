import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentIdentityStore, identityTextOf } from "./agent-identity.js";

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
      return { workspacePath: agentRoot(id) };
    },
  });
}

describe("AgentIdentityStore", () => {
  test("getIdentity returns nulls for empty workspace", async () => {
    const store = makeStore();
    const identity = await store.getIdentity(`agent-${Date.now()}`);
    expect(identity.soul).toBeNull();
    expect(identity.user).toBeNull();
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

describe("a seeded template is not an identity", () => {
  test("heading-only bodies read as absent (both template spellings)", () => {
    // Today's seeder writes English; workspaces created earlier carry Chinese.
    // Both are the same thing: nobody has written an identity yet.
    expect(
      identityTextOf(
        "# SOUL\n\nDescribe this agent's identity, personality, and behavior guidelines here.\n",
      ),
    ).toBeNull();
    expect(identityTextOf("# SOUL\n\n在此描述此 Agent 的身份、人格与行为准则。\n")).toBeNull();
    expect(identityTextOf("# SOUL\n\n")).toBeNull();
    expect(identityTextOf("   \n\n")).toBeNull();
    expect(identityTextOf(null)).toBeNull();
  });

  test("real content survives verbatim", () => {
    const written = "# SOUL\n\nBe terse. Never guess a file path.\n";
    // Headings included: the operator's own document is passed through, not
    // re-rendered by us.
    expect(identityTextOf(written)).toBe(written);
    expect(identityTextOf("只有一行也算写过了。")).toBe("只有一行也算写过了。");
  });
});
