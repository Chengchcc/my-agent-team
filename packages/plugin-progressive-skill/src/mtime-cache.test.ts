import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import { invalidateSkillCache, loadSkillIndexWithMtimeCache } from "./cache.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("mtime cache", () => {
  test("second call serves from cache", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/alpha/SKILL.md",
      ["---", "name: alpha", "description: first skill", "---", "", "body"].join("\n"),
    );
    invalidateSkillCache(root);

    const first = await loadSkillIndexWithMtimeCache(ws, root);
    const second = await loadSkillIndexWithMtimeCache(ws, root);
    expect(second).toBe(first); // same array reference
  });

  test("invalidate forces re-read", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/alpha/SKILL.md",
      ["---", "name: alpha", "description: first skill", "---", "", "body"].join("\n"),
    );
    invalidateSkillCache(root);

    const first = await loadSkillIndexWithMtimeCache(ws, root);
    invalidateSkillCache(root);
    const second = await loadSkillIndexWithMtimeCache(ws, root);
    expect(second).not.toBe(first);
  });

  test("new skill directory added triggers re-read after cache invalidation", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(
      "/skills/alpha/SKILL.md",
      ["---", "name: alpha", "description: first skill", "---", "", "body"].join("\n"),
    );
    invalidateSkillCache(root);

    const first = await loadSkillIndexWithMtimeCache(ws, root);
    expect(first.length).toBeGreaterThanOrEqual(1);

    // Add a new skill directory
    await ws.write(
      "/skills/beta/SKILL.md",
      ["---", "name: beta", "description: second skill", "---", "", "body"].join("\n"),
    );
    // Force cache invalidation to avoid mtime resolution flakiness
    invalidateSkillCache(root);

    const second = await loadSkillIndexWithMtimeCache(ws, root);
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.some((s) => s.name === "beta")).toBe(true);
  });
});
