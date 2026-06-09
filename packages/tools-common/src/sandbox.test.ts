import { describe, test, expect } from "bun:test";
import type { Tool } from "@my-agent-team/core";
import { withWorkspace } from "./sandbox.js";

describe("withWorkspace cwd injection", () => {
  test("B2: injects workspace as cwd when tool omits it", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: { type: "object", properties: { command: {} as Record<string,unknown>, cwd: {} as Record<string,unknown> } },
      execute: (input) => { received = input; return { content: "" }; },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });

  test("B2: keeps explicit in-workspace cwd", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: { type: "object", properties: { command: {} as Record<string,unknown>, cwd: {} as Record<string,unknown> } },
      execute: (input) => { received = input; return { content: "" }; },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls", cwd: "/tmp" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });

  test("B2: overrides empty cwd string with workspace", async () => {
    let received: unknown;
    const tool: Tool = {
      name: "bash",
      description: "",
      inputSchema: { type: "object", properties: { command: {} as Record<string,unknown>, cwd: {} as Record<string,unknown> } },
      execute: (input) => { received = input; return { content: "" }; },
    };
    await withWorkspace(tool, "/tmp").execute({ command: "ls", cwd: "" });
    expect((received as { cwd: string }).cwd).toBe("/tmp");
  });
});
