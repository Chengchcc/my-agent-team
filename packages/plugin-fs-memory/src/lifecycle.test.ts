import { describe, expect, test } from "bun:test";
import { MemoryBackend, AgentFS } from "@my-agent-team/agent-fs";
import { invalidateFactsCache, invalidateMemCache } from "./cache.js";
import { fsMemoryPlugin } from "./fs-memory.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

describe("lifecycle", () => {
  test("beforeModel runs without error when dir does not exist (mkdirp no-op on memory)", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    invalidateFactsCache(root);
    const plugin = fsMemoryPlugin({ ws, root });
    await plugin.hooks.beforeModel?.(
      {
        threadId: "t1",
        logger: {
          level: "silent",
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        checkpointer: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
        contextManager: { shape: (_ctx: never, msgs: readonly never[]) => [...msgs] },
      },
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    );

    // No error thrown — mkdirp succeeded
    expect(true).toBe(true);
  });

  test("MEMORY.md missing → not auto-created", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    const plugin = fsMemoryPlugin({ ws, root });
    await plugin.hooks.beforeModel?.(
      {
        threadId: "t1",
        logger: {
          level: "silent",
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        checkpointer: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
        contextManager: { shape: (_ctx: never, msgs: readonly never[]) => [...msgs] },
      },
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    );

    // verify MEMORY.md was not created
    const s = await ws.stat("/memory/MEMORY.md");
    expect(s).toBeNull();
  });
});
