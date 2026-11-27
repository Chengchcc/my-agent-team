import { describe, expect, test } from "bun:test";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import type { McpServerRow } from "./domain.js";
import { mcpRoutes } from "./http.js";
import type { McpServerPort } from "./ports.js";
import { createMcpService } from "./service.js";

function makeInMemoryPort(): McpServerPort {
  const rows = new Map<string, McpServerRow>();
  return {
    list: () => [...rows.values()],
    getById: (id) => rows.get(id) ?? null,
    create: (rec) => {
      const row: McpServerRow = {
        serverId: rec.serverId,
        name: rec.name,
        transport: rec.transport === "sse" ? "sse" : "stdio",
        command: rec.command ?? null,
        args: rec.args ? (JSON.parse(rec.args) as string[]) : [],
        env: rec.env ? (JSON.parse(rec.env) as Record<string, string>) : {},
        headers: rec.headers ? (JSON.parse(rec.headers) as Record<string, string>) : {},
        url: rec.url ?? null,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      };
      rows.set(row.serverId, row);
      return row;
    },
    update: (id, patch) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next: McpServerRow = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.command !== undefined ? { command: patch.command } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        updatedAt: patch.updatedAt,
      };
      rows.set(id, next);
      return next;
    },
    delete: (id) => rows.delete(id),
  };
}

describe("MCP server HTTP routes", () => {
  test("CRUD, validation (422), tool catalog/invoke/restart/test, and 404 branches", async () => {
    const fakeManager = {
      getStatus: () => "connected",
      getToolCount: () => 1,
      connect: async () => {},
      disconnect: () => {},
      restart: async () => {},
      getToolCatalog: () => [{ name: "ping", description: "pong", inputSchema: {} }],
      getSchemaHash: () => "hash-1",
      getConnectLatencyMs: () => 12,
      callTool: async (_id: string, tool: string, args: Record<string, unknown>) => ({
        ok: true,
        tool,
        args,
      }),
    } as unknown as McpClientManager;

    let seq = 0;
    const svc = createMcpService({
      port: makeInMemoryPort(),
      mcpClientManager: fakeManager,
      agentExists: async () => true,
      getAgentMcpServers: async () => [],
      setAgentMcpServers: async () => {},
      idGen: () => `srv-${++seq}`,
    });
    const app = mcpRoutes(svc);

    // Empty catalog
    const list0 = await app.handle(new Request("http://localhost/api/mcp-servers"));
    expect(list0.status).toBe(200);
    expect(((await list0.json()) as { mcpServers: unknown[] }).mcpServers).toEqual([]);

    // Missing server -> 404 across GET/PUT/DELETE/test
    expect((await app.handle(new Request("http://localhost/api/mcp-servers/nope"))).status).toBe(
      404,
    );
    expect(
      (
        await app.handle(
          new Request("http://localhost/api/mcp-servers/nope", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "x" }),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.handle(
          new Request("http://localhost/api/mcp-servers/nope/test", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.handle(new Request("http://localhost/api/mcp-servers/nope", { method: "DELETE" })))
        .status,
    ).toBe(404);

    // Invalid stdio (missing command) and invalid sse (missing url) -> 422
    const badStdio = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bad", transport: "stdio" }),
      }),
    );
    expect(badStdio.status).toBe(422);

    const badSse = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bad-sse", transport: "sse" }),
      }),
    );
    expect(badSse.status).toBe(422);

    // Valid create -> 201 with masked env
    const created = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "demo-mcp",
          transport: "stdio",
          command: "echo",
          args: ["hi"],
          env: { API_TOKEN: "secret-1234" },
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { mcpServer } = (await created.json()) as {
      mcpServer: { serverId: string; name: string; env: Record<string, string> };
    };
    expect(mcpServer.serverId).toBe("srv-1");
    expect(mcpServer.env.API_TOKEN).toBe("****1234");

    // Get, update, tools, test, restart, invoke
    const got = await app.handle(new Request("http://localhost/api/mcp-servers/srv-1"));
    expect(got.status).toBe(200);

    const upd = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "demo-renamed" }),
      }),
    );
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as { mcpServer: { name: string } }).mcpServer.name).toBe(
      "demo-renamed",
    );

    const toolsRes = await app.handle(new Request("http://localhost/api/mcp-servers/srv-1/tools"));
    expect(toolsRes.status).toBe(200);

    const testRes = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1/test", { method: "POST" }),
    );
    expect(testRes.status).toBe(200);

    const restartRes = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1/restart", { method: "POST" }),
    );
    expect(restartRes.status).toBe(200);

    const badInvoke = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1/tools/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "" }),
      }),
    );
    expect(badInvoke.status).toBe(422);

    const okInvoke = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1/tools/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "ping", args: { n: 1 } }),
      }),
    );
    expect(okInvoke.status).toBe(200);

    // Delete -> 204
    const del = await app.handle(
      new Request("http://localhost/api/mcp-servers/srv-1", { method: "DELETE" }),
    );
    expect(del.status).toBe(204);
  });
});
