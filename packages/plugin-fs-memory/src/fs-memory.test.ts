import { describe, expect, test } from "bun:test";
import { AgentFS, MemoryBackend } from "@my-agent-team/agent-fs";
import type { Message } from "@my-agent-team/message";
import {
  consoleLogger,
  type HookContext,
  inMemoryCheckpointer,
  passthroughContextManager,
} from "@my-agent-team/framework";
import { invalidateMemCache } from "./cache.js";
import { fsMemoryPlugin } from "./fs-memory.js";

function testFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new MemoryBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

/** Backend where read() throws for MEMORY.md to simulate EISDIR */
class ThrowingReadBackend extends MemoryBackend {
  override async read(relPath: string): Promise<string | null> {
    if (relPath === "MEMORY.md") throw new Error("EISDIR: illegal operation on a directory");
    return super.read(relPath);
  }
}

function throwingFS(): AgentFS {
  return new AgentFS({
    mounts: [{ prefix: "/memory/", domain: "shared", backend: new ThrowingReadBackend() }],
    aliases: { toCanonical: (p: string) => p },
  });
}

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
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    await ws.write("/memory/MEMORY.md", "my memory content");

    const plugin = fsMemoryPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text:"You are helpful." },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(testCtx(), msgs))!;
    expect(result).toHaveLength(2);
    expect((result[0] as Message).text).toContain("my memory content");
    expect((result[0] as Message).text).toContain("<memory>");
  });

  test("empty MEMORY.md skips injection (passes through)", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    await ws.write("/memory/MEMORY.md", "");

    const plugin = fsMemoryPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text:"sys" },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(testCtx(), msgs))!;
    // No injection, should be same
    expect((result[0] as Message).text).toBe("sys");
  });

  test("MEMORY.md missing → no injection, no error", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    const plugin = fsMemoryPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text:"sys" },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(testCtx(), msgs))!;
    expect((result[0] as Message).text).toBe("sys");
  });

  test("no system message → warns + passes through", async () => {
    const ws = testFS();
    const root = "/memory/";
    invalidateMemCache(root);
    await ws.write("/memory/MEMORY.md", "memory");

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

    const plugin = fsMemoryPlugin({ ws, root });
    const msgs: Message[] = [{ role: "user", text: "hi" }];

    const result = (await plugin.hooks.beforeModel?.(ctx, msgs as Message[]))!;
    expect(result).toHaveLength(1);
    expect(warnings.some((w) => w.includes("no system message"))).toBe(true);
  });

  test("MEMORY.md read failure → warn + pass through", async () => {
    const ws = throwingFS();
    const root = "/memory/";
    invalidateMemCache(root);
    // Write MEMORY.md so stat succeeds; read will throw (simulates EISDIR)
    await ws.write("/memory/MEMORY.md", "content");

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

    const plugin = fsMemoryPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text:"sys" },
      { role: "user", text: "hi" },
    ];

    const result = (await plugin.hooks.beforeModel?.(ctx, msgs as Message[]))!;
    expect(result).toHaveLength(2);
    expect(warnings.some((w) => w.includes("read failed"))).toBe(true);
    // should still pass through unchanged
    expect((result[0] as Message).text).toBe("sys");
  });

  test("plugin exposes 3 tools", () => {
    const ws = testFS();
    const plugin = fsMemoryPlugin({ ws });
    expect(plugin.tools).toHaveLength(3);
    const names = plugin.tools?.map((t) => t.name);
    expect(names).toContain("memory_read");
    expect(names).toContain("memory_write");
    expect(names).toContain("memory_search");
  });
});
