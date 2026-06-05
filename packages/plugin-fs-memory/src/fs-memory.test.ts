import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import {
  type HookContext,
  consoleLogger,
  inMemoryCheckpointer,
  passthroughContextManager,
} from "@my-agent-team/framework";
import { invalidateMemCache } from "./cache.js";
import { fsMemoryPlugin } from "./fs-memory.js";

function testCtx(): HookContext {
  return {
    threadId: "t1",
    logger: consoleLogger({ level: "silent" }),
    checkpointer: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
  };
}

describe("fsMemoryPlugin", () => {
  test("injects MEMORY.md into system message", async () => {
    const dir = `${import.meta.dir}/test-fsmem-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      invalidateMemCache(dir);
      await Bun.write(`${dir}/MEMORY.md`, "my memory content");

      const plugin = fsMemoryPlugin({ dir });
      const msgs: Message[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ];

      const result = await plugin.hooks.beforeModel!(testCtx(), msgs);
      expect(result).toHaveLength(2);
      expect((result[0] as Message).content).toContain("my memory content");
      expect((result[0] as Message).content).toContain("<memory>");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("empty MEMORY.md skips injection (passes through)", async () => {
    const dir = `${import.meta.dir}/test-fsmem-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      invalidateMemCache(dir);
      await Bun.write(`${dir}/MEMORY.md`, "");

      const plugin = fsMemoryPlugin({ dir });
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ];

      const result = await plugin.hooks.beforeModel!(testCtx(), msgs);
      // No injection, should be same
      expect((result[0] as Message).content).toBe("sys");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("MEMORY.md missing → no injection, no error", async () => {
    const dir = `${import.meta.dir}/test-fsmem-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      invalidateMemCache(dir);
      const plugin = fsMemoryPlugin({ dir });
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ];

      const result = await plugin.hooks.beforeModel!(testCtx(), msgs);
      expect((result[0] as Message).content).toBe("sys");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("no system message → warns + passes through", async () => {
    const dir = `${import.meta.dir}/test-fsmem-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      invalidateMemCache(dir);
      await Bun.write(`${dir}/MEMORY.md`, "memory");

      const warnings: string[] = [];
      const ctx = {
        ...testCtx(),
        logger: {
          ...testCtx().logger,
          warn: (msg: string) => {
            warnings.push(msg);
          },
        },
      };

      const plugin = fsMemoryPlugin({ dir });
      const msgs: Message[] = [{ role: "user", content: "hi" }];

      const result = await plugin.hooks.beforeModel!(ctx, msgs as Message[]);
      expect(result).toHaveLength(1);
      expect(warnings.some((w) => w.includes("no system message"))).toBe(true);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("MEMORY.md read failure → warn + pass through", async () => {
    // make MEMORY.md a directory so readFile fails with EISDIR
    const dir = `${import.meta.dir}/test-fsmem-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    try {
      invalidateMemCache(dir);
      // Create MEMORY.md as a directory (stat works but readFile will fail)
      await Bun.$`mkdir ${dir}/MEMORY.md`.quiet();

      const warnings: string[] = [];
      const ctx = {
        ...testCtx(),
        logger: {
          ...testCtx().logger,
          warn: (msg: string) => {
            warnings.push(msg);
          },
        },
      };

      const plugin = fsMemoryPlugin({ dir });
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ];

      const result = await plugin.hooks.beforeModel!(ctx, msgs as Message[]);
      expect(result).toHaveLength(2);
      expect(warnings.some((w) => w.includes("read failed"))).toBe(true);
      // should still pass through unchanged
      expect((result[0] as Message).content).toBe("sys");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("plugin exposes 3 tools", () => {
    const plugin = fsMemoryPlugin({ dir: "/tmp/test" });
    expect(plugin.tools).toHaveLength(3);
    const names = plugin.tools!.map((t) => t.name);
    expect(names).toContain("memory_read");
    expect(names).toContain("memory_write");
    expect(names).toContain("memory_search");
  });
});
