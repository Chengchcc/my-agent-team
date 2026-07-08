import { describe, expect, test } from "bun:test";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteMcpServerAdapter } from "./adapter-sqlite.js";
import { createMcpService, McpServerNotFoundError, McpValidationError } from "./service.js";

const db = openDb(":memory:");
const port = sqliteMcpServerAdapter(db);

let idCount = 0;
const testIdGen = () => `test-mcp-${idCount++}`;

const connectCalls: unknown[] = [];
const disconnectCalls: string[] = [];

// Deterministic connect-waiter: update()'s disconnect->connect runs in a
// fire-and-forget async IIFE, so we expose a promise that resolves when the
// next connect lands - no wall-clock timers needed.
const connectWaiters: Array<() => void> = [];
function waitForConnect(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  connectWaiters.push(resolve);
  return promise;
}

const mockManager: McpClientManager = {
  connect: async (config) => {
    connectCalls.push(config);
    connectWaiters.shift()?.();
  },
  disconnect: async (serverId) => {
    disconnectCalls.push(serverId);
  },
  getTools: () => [],
  getStatus: () => "connected",
  getToolCount: () => 3,
  disconnectAll: async () => {},
};

const svc = createMcpService({
  port,
  mcpClientManager: mockManager,
  agentExists: async () => true,
  idGen: testIdGen,
});

// service whose agentExists always returns false, for the not-found validation path
const svcNoAgent = createMcpService({
  port,
  mcpClientManager: mockManager,
  agentExists: async () => false,
  idGen: testIdGen,
});

describe("McpService", () => {
  test("create stdio", async () => {
    const before = connectCalls.length;
    const row = await svc.create("agent-1", {
      name: "stdio-server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/tmp/data" },
    });
    expect(row.serverId).toStartWith("test-mcp-");
    expect(row.agentId).toBe("agent-1");
    expect(row.name).toBe("stdio-server");
    expect(row.transport).toBe("stdio");
    expect(row.command).toBe("npx");
    expect(row.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    // maskEnv: **** + last4 chars (value "/tmp/data" has 9 chars > 4)
    expect(row.env).toEqual({ ROOT: "****data" });
    expect(row.url).toBeNull();
    expect(row.enabled).toBe(true);
    expect(row.createdAt).toBeGreaterThan(0);
    // fire-and-forget connect on enabled server - mock pushes synchronously
    expect(connectCalls.length).toBe(before + 1);
  });

  test("create sse", async () => {
    const before = connectCalls.length;
    const row = await svc.create("agent-1", {
      name: "sse-server",
      transport: "sse",
      url: "https://example.com/sse",
    });
    expect(row.transport).toBe("sse");
    expect(row.url).toBe("https://example.com/sse");
    expect(row.command).toBeNull();
    expect(row.enabled).toBe(true);
    expect(connectCalls.length).toBe(before + 1);
  });

  test("create non-existent agent throws McpValidationError", async () => {
    await expect(
      svcNoAgent.create("ghost-agent", { name: "x", transport: "stdio", command: "echo" }),
    ).rejects.toBeInstanceOf(McpValidationError);
  });

  test("listByAgent returns masked env + status + toolsCount", async () => {
    const row = await svc.create("agent-list", {
      name: "env-server",
      transport: "stdio",
      command: "echo",
      env: { API_KEY: "sk-1234567890", NORMAL_VAR: "hello" },
    });

    const list = svc.listByAgent("agent-list");
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect(item.serverId).toBe(row.serverId);
    // both env values masked to **** + last4
    expect(item.env).toEqual({ API_KEY: "****7890", NORMAL_VAR: "****ello" });
    expect(item.status).toBe("connected");
    expect(item.toolsCount).toBe(3);
  });

  test("update changes name and triggers disconnect->connect", async () => {
    const row = await svc.create("agent-upd", {
      name: "before-update",
      transport: "stdio",
      command: "echo",
    });
    const connectBefore = connectCalls.length;
    const disconnectBefore = disconnectCalls.length;

    // update()'s disconnect->connect runs in a fire-and-forget async IIFE;
    // await the connect signal deterministically instead of guessing a delay.
    const connectPromise = waitForConnect();
    const updated = await svc.update("agent-upd", row.serverId, { name: "after-update" });
    expect(updated.name).toBe("after-update");

    await connectPromise;
    expect(disconnectCalls.length).toBe(disconnectBefore + 1);
    expect(connectCalls.length).toBe(connectBefore + 1);
  });

  test("update non-existent throws McpServerNotFoundError", async () => {
    await expect(svc.update("agent-1", "no-such-server", { name: "x" })).rejects.toBeInstanceOf(
      McpServerNotFoundError,
    );
  });

  test("delete removes server and disconnects", async () => {
    const row = await svc.create("agent-del", {
      name: "to-delete",
      transport: "stdio",
      command: "echo",
    });
    const disconnectBefore = disconnectCalls.length;

    await svc.delete("agent-del", row.serverId);
    // disconnect mock pushes synchronously during the fire-and-forget call
    expect(disconnectCalls.length).toBeGreaterThan(disconnectBefore);
    // row is gone
    expect(svc.listByAgent("agent-del")).toHaveLength(0);
  });

  test("delete non-existent throws McpServerNotFoundError", async () => {
    await expect(svc.delete("agent-1", "no-such-server")).rejects.toBeInstanceOf(
      McpServerNotFoundError,
    );
  });
});
