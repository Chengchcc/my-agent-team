import { describe, expect, test } from "bun:test";
import { MemoryBackend } from "./backends.js";
import { WorkspaceAccessError, WorkspaceFS } from "./workspace-fs.js";

describe("WorkspaceFS", () => {
  // ─── mount resolution ───

  test("routes path to matching mount", async () => {
    const mem = new MemoryBackend();
    await mem.write("x.md", "hello");
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    expect(await fs.read("/x.md")).toBe("hello");
  });

  test("longest prefix wins: /memory/ over /", async () => {
    const root = new MemoryBackend();
    const mem = new MemoryBackend();
    await root.write("memory/x.md", "from-root");
    await mem.write("x.md", "from-memory");

    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: root, posixRoot: "/tmp" },
      { prefix: "/memory/", domain: "shared", backend: mem },
    ]);

    expect(await fs.read("/memory/x.md")).toBe("from-memory");
    expect(await fs.read("/y.md")).toBeNull(); // hits /, mem has no y.md
  });

  test("throws on no mount", async () => {
    const fs = new WorkspaceFS([]);
    await expect(fs.read("/anything.md")).rejects.toThrow(WorkspaceAccessError);
  });

  // ─── path normalization ───

  test("normalizes relative path to absolute", async () => {
    const mem = new MemoryBackend();
    await mem.write("SOUL.md", "agent soul");
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    expect(await fs.read("SOUL.md")).toBe("agent soul");
  });

  test("rejects .. escape", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await expect(fs.read("/../escape.md")).rejects.toThrow(WorkspaceAccessError);
  });

  // ─── read/write/exists/stat/list/remove ───

  test("write + read roundtrip", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await fs.write("/tmp/out.json", '{"ok":true}');
    expect(await fs.read("/tmp/out.json")).toBe('{"ok":true}');
  });

  test("exists returns false for missing", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    expect(await fs.exists("/nonexistent.md")).toBe(false);
  });

  test("exists returns true after write", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await fs.write("/file.md", "content");
    expect(await fs.exists("/file.md")).toBe(true);
  });

  test("list returns entries", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await fs.write("/a.md", "a");
    await fs.write("/b.md", "b");
    const entries = await fs.list("/");
    expect(entries).toContain("a.md");
    expect(entries).toContain("b.md");
  });

  test("stat returns mtime and size", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await fs.write("/file.md", "hello world");
    const s = await fs.stat("/file.md");
    expect(s).not.toBeNull();
    expect(s!.size).toBe(11);
  });

  test("remove deletes file", async () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
    ]);

    await fs.write("/file.md", "content");
    await fs.remove("/file.md");
    expect(await fs.exists("/file.md")).toBe(false);
  });

  // ─── read-only mount ───

  test("write to read-only mount throws", async () => {
    const mem = new MemoryBackend();
    const ro = { read: mem.read.bind(mem), list: mem.list.bind(mem), stat: mem.stat.bind(mem), exists: mem.exists.bind(mem) };
    const fs = new WorkspaceFS([
      { prefix: "/ro/", domain: "shared", backend: ro },
    ]);

    await expect(fs.write("/ro/file.md", "nope")).rejects.toThrow(WorkspaceAccessError);
  });

  // ─── posixRoots ───

  test("posixRoots returns only mounts with posixRoot set", () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/data/private" },
      { prefix: "/memory/", domain: "shared", backend: mem },
      { prefix: "/mnt/drive/", domain: "external", backend: mem },
    ]);

    const roots = fs.posixRoots();
    expect(roots).toEqual(["/data/private"]);
  });

  // ─── mountsForDomain ───

  test("mountsForDomain filters by domain", () => {
    const mem = new MemoryBackend();
    const fs = new WorkspaceFS([
      { prefix: "/", domain: "private", backend: mem, posixRoot: "/tmp" },
      { prefix: "/memory/", domain: "shared", backend: mem },
      { prefix: "/mnt/drive/", domain: "external", backend: mem },
    ]);

    expect(fs.mountsForDomain("private").length).toBe(1);
    expect(fs.mountsForDomain("shared").length).toBe(1);
    expect(fs.mountsForDomain("external").length).toBe(1);
    expect(fs.mountsForDomain("runner_state").length).toBe(0);
  });

  // ─── later registration overrides same prefix ───

  test("later mount with same prefix overrides earlier", async () => {
    const first = new MemoryBackend();
    const second = new MemoryBackend();
    await first.write("file.md", "first");
    await second.write("file.md", "second");

    const fs = new WorkspaceFS([
      { prefix: "/test/", domain: "private", backend: first },
      { prefix: "/test/", domain: "private", backend: second },
    ]);

    expect(await fs.read("/test/file.md")).toBe("second");
  });
});
