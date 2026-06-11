import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { invalidateFactsCache, invalidateMemCache } from "./cache.js";
import { fsMemoryPlugin } from "./fs-memory.js";

describe("lifecycle", () => {
  test("dir does not exist → auto-creates dir and facts/", async () => {
    const dir = `${import.meta.dir}/test-lifecycle-${crypto.randomUUID()}`;
    // dir does not exist initially
    try {
      invalidateMemCache(dir);
      invalidateFactsCache(dir);
      const plugin = fsMemoryPlugin({ dir });
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

      // dir should exist now
      await stat(dir);
      await stat(`${dir}/facts`);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("MEMORY.md missing → not auto-created", async () => {
    const dir = `${import.meta.dir}/test-lifecycle-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}/facts`.quiet();
    try {
      invalidateMemCache(dir);
      const plugin = fsMemoryPlugin({ dir });
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
      await expect(stat(`${dir}/MEMORY.md`)).rejects.toThrow();
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
