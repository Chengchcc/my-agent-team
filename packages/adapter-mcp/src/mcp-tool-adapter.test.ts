import { describe, expect, mock, test } from "bun:test";
import { adaptMcpTool, mcpToolName, sanitizeServerName } from "./mcp-tool-adapter.js";

describe("sanitizeServerName", () => {
  test("lowercases and replaces non-alphanumeric with dash", () => {
    expect(sanitizeServerName("GitHub Server")).toBe("github-server");
  });

  test("keeps alphanumeric and strips punctuation", () => {
    expect(sanitizeServerName("test123!")).toBe("test123");
  });

  test('falls back to "server" when empty', () => {
    expect(sanitizeServerName("")).toBe("server");
  });

  test('falls back to "server" when all special chars', () => {
    expect(sanitizeServerName("!!!")).toBe("server");
  });
});

describe("mcpToolName", () => {
  test("produces mcp__{server}__{tool}", () => {
    expect(mcpToolName("GitHub Server", "create_issue")).toBe("mcp__github-server__create_issue");
  });
});

describe("adaptMcpTool", () => {
  test("returns a Tool with correct name/description/inputSchema", () => {
    const caller = { callTool: mock(() => Promise.resolve({ content: "ok" })) };
    const tool = adaptMcpTool(
      "GitHub Server",
      { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
      caller,
    );
    expect(tool.name).toBe("mcp__github-server__create_issue");
    expect(tool.description).toBe("Create an issue");
    expect(tool.inputSchema).toEqual({ type: "object" });
  });

  test("defaults description and inputSchema when missing", () => {
    const caller = { callTool: mock(() => Promise.resolve({ content: "ok" })) };
    const tool = adaptMcpTool("srv", { name: "do_thing" }, caller);
    expect(tool.description).toBe("MCP tool: do_thing");
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("execute() calls caller.callTool with the right args", async () => {
    const caller = { callTool: mock(() => Promise.resolve({ content: "done" })) };
    const tool = adaptMcpTool("srv", { name: "do_thing" }, caller);
    const result = await tool.execute({ foo: "bar" });
    expect(result.content).toBe("done");
    expect(result.isError).toBeUndefined();
    expect(caller.callTool).toHaveBeenCalledTimes(1);
    expect(caller.callTool).toHaveBeenCalledWith({ name: "do_thing", arguments: { foo: "bar" } });
  });

  test("execute() stringifies non-string content", async () => {
    const caller = { callTool: mock(() => Promise.resolve({ content: { nested: true } })) };
    const tool = adaptMcpTool("srv", { name: "do_thing" }, caller);
    const result = await tool.execute({});
    expect(result.content).toBe('{"nested":true}');
  });

  test("execute() catches errors and returns isError result", async () => {
    const caller = {
      callTool: mock(() => Promise.reject(new Error("boom"))),
    };
    const tool = adaptMcpTool("srv", { name: "do_thing" }, caller);
    const result = await tool.execute({});
    expect(result.content).toBe("boom");
    expect(result.isError).toBe(true);
  });
});
