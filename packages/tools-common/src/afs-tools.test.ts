import { describe, expect, test } from "bun:test";
import {
  createEditToolForWorkspace,
  createReadToolForWorkspace,
  createWriteToolForWorkspace,
} from "./afs-tools.js";
import type { AgentFsLike } from "./agent-fs-like.js";

class FakeAgentFs implements AgentFsLike {
  #store = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.#store.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.#store.set(path, content);
  }

  async list(_path: string): Promise<string[]> {
    return [...this.#store.keys()];
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    const v = this.#store.get(path);
    return v !== undefined ? { mtimeMs: 0, size: v.length } : null;
  }

  async exists(path: string): Promise<boolean> {
    return this.#store.has(path);
  }

  async mkdirp(_path: string): Promise<void> {}
}

describe("createReadToolForWorkspace", () => {
  test("returns file content when found", async () => {
    const ws = new FakeAgentFs();
    await ws.write("/hello.txt", "hello world");
    const tool = createReadToolForWorkspace(ws);

    const result = await tool.execute({ path: "/hello.txt" });

    expect(result.content).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  test("returns error when file not found", async () => {
    const ws = new FakeAgentFs();
    const tool = createReadToolForWorkspace(ws);

    const result = await tool.execute({ path: "/missing.txt" });

    expect(result.content).toBe("File not found: /missing.txt");
    expect(result.isError).toBe(true);
  });
});

describe("createWriteToolForWorkspace", () => {
  test("writes content and returns confirmation", async () => {
    const ws = new FakeAgentFs();
    const tool = createWriteToolForWorkspace(ws);

    const result = await tool.execute({ path: "/out.md", content: "# Hello" });

    expect(result.content).toInclude("Wrote 7 bytes to /out.md");
    const written = await ws.read("/out.md");
    expect(written).toBe("# Hello");
  });

  test("overwrites existing file", async () => {
    const ws = new FakeAgentFs();
    await ws.write("/out.md", "old");
    const tool = createWriteToolForWorkspace(ws);

    await tool.execute({ path: "/out.md", content: "new content" });

    expect(await ws.read("/out.md")).toBe("new content");
  });
});

describe("createEditToolForWorkspace", () => {
  test("replaces old_string with new_string", async () => {
    const ws = new FakeAgentFs();
    await ws.write("/f.txt", "hello old world");
    const tool = createEditToolForWorkspace(ws);

    const result = await tool.execute({
      path: "/f.txt",
      old_string: "old",
      new_string: "new",
    });

    expect(result.content).toBe("Edited /f.txt: replaced 1 occurrence");
    expect(await ws.read("/f.txt")).toBe("hello new world");
  });

  test("returns error when file not found", async () => {
    const ws = new FakeAgentFs();
    const tool = createEditToolForWorkspace(ws);

    const result = await tool.execute({
      path: "/missing.txt",
      old_string: "x",
      new_string: "y",
    });

    expect(result.content).toBe("File not found: /missing.txt");
    expect(result.isError).toBe(true);
  });

  test("returns error when old_string not in file", async () => {
    const ws = new FakeAgentFs();
    await ws.write("/f.txt", "some content");
    const tool = createEditToolForWorkspace(ws);

    const result = await tool.execute({
      path: "/f.txt",
      old_string: "nonexistent",
      new_string: "y",
    });

    expect(result.content).toBe("old_string not found in /f.txt");
    expect(result.isError).toBe(true);
  });
});
