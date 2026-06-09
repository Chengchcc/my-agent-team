import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tool } from "@my-agent-team/core";
import { SandboxError, withWorkspace } from "./sandbox.js";

describe("withWorkspace path rewriting", () => {
  test("rewrites relative path to absolute workspace path", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "write",
      description: "",
      inputSchema: {
        type: "object",
        properties: { path: {} as Record<string, unknown>, content: {} as Record<string, unknown> },
      },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ path: "SOUL.md", content: "hello" });
    expect((received as { path: string }).path).toBe("/tmp/SOUL.md");
  });

  test("rewrites filePath to absolute workspace path", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "read",
      description: "",
      inputSchema: { type: "object", properties: { filePath: {} as Record<string, unknown> } },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ filePath: "file.txt" });
    expect((received as { filePath: string }).filePath).toBe("/tmp/file.txt");
  });

  test("rewrites file_path to absolute workspace path", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "edit",
      description: "",
      inputSchema: { type: "object", properties: { file_path: {} as Record<string, unknown> } },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ file_path: "README.md" });
    expect((received as { file_path: string }).file_path).toBe("/tmp/README.md");
  });

  test("keeps absolute in-workspace path unchanged", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "write",
      description: "",
      inputSchema: { type: "object", properties: { path: {} as Record<string, unknown> } },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ path: "/tmp/OTHER.md" });
    expect((received as { path: string }).path).toBe("/tmp/OTHER.md");
  });

  test("throws SandboxError when path escapes workspace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sandbox-test-"));
    const ws = path.join(dir, "ws");
    const outside = path.join(dir, "outside");
    // need real directories for realpathSync
    Bun.sleepSync(0); // no-op, just ensure mkdir calls are separate
    // Actually just create them
    const fs = await import("node:fs/promises");
    await fs.mkdir(ws, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    // write a file in outside so realpathSync can resolve it
    writeFileSync(path.join(outside, "passwd"), "");

    const tool: Tool = {
      name: "read",
      description: "",
      inputSchema: { type: "object", properties: { filePath: {} as Record<string, unknown> } },
      execute: () => ({ content: "" }),
    };
    const wrapped = withWorkspace(tool, ws);
    await expect(wrapped.execute({ filePath: "../outside/passwd" })).rejects.toBeInstanceOf(
      SandboxError,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("withWorkspace cwd injection", () => {
  test("B2: injects workspace as cwd when tool omits it", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: {
        type: "object",
        properties: { command: {} as Record<string, unknown>, cwd: {} as Record<string, unknown> },
      },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });

  test("B2: keeps explicit in-workspace cwd", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: {
        type: "object",
        properties: { command: {} as Record<string, unknown>, cwd: {} as Record<string, unknown> },
      },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls", cwd: "/tmp" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });

  test("B2: overrides empty cwd string with workspace", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: {
        type: "object",
        properties: { command: {} as Record<string, unknown>, cwd: {} as Record<string, unknown> },
      },
      execute: (input) => {
        received = input;
        return { content: "" };
      },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls", cwd: "" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });
});
