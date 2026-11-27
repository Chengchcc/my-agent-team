import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpBackend } from "./acp-backend.js";
import { mapOmaUpdate } from "./event-mapping.js";
import { buildAcpSpawnEnv } from "./transport.js";

describe("Phase 2 ACP P1 regressions", () => {
  test("P1-1: buildAcpSpawnEnv strips backend secrets and preserves allowlisted + explicit keys", () => {
    const env = buildAcpSpawnEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/h",
        ANTHROPIC_API_KEY: "sk-ant-test",
        BACKEND_AUTH_TOKEN: "secret-backend-token",
        LARK_APP_SECRET: "secret-lark",
        MOCK_PASSWORD: "secret-password",
        MCP_ENCRYPTION_KEY: "secret-mcp-key",
        CUSTOM_BACKEND_SECRET: "nope",
      },
      {
        OMA_ALLOW_WRITE_PATHS: "/ws/",
        PRODUCT_TOOLS_RUN_TOKEN: "per-run-tok",
      },
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/h");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.OMA_ALLOW_WRITE_PATHS).toBe("/ws/");
    expect(env.PRODUCT_TOOLS_RUN_TOKEN).toBe("per-run-tok");

    expect(env.BACKEND_AUTH_TOKEN).toBeUndefined();
    expect(env.LARK_APP_SECRET).toBeUndefined();
    expect(env.MOCK_PASSWORD).toBeUndefined();
    expect(env.MCP_ENCRYPTION_KEY).toBeUndefined();
    expect(env.CUSTOM_BACKEND_SECRET).toBeUndefined();
  });

  test("P1-7: mapOmaUpdate forwards heartbeat, delegation_*, and mcp_mount_result", () => {
    expect(mapOmaUpdate({ id: 1, type: "heartbeat", data: {} }, "acp")).toEqual([
      { type: "status", status: "heartbeat" },
    ]);

    expect(
      mapOmaUpdate(
        {
          id: 2,
          type: "delegation_batch_started",
          data: { batchId: "b1", label: "fanout", agentCount: 2 },
        },
        "acp",
      ),
    ).toEqual([
      {
        type: "delegation_batch_started",
        batchId: "b1",
        label: "fanout",
        agentCount: 2,
      },
    ]);

    expect(
      mapOmaUpdate(
        {
          id: 3,
          type: "delegation_agent_started",
          data: { batchId: "b1", agentId: "a1", label: "worker-1" },
        },
        "acp",
      ),
    ).toEqual([
      {
        type: "delegation_agent_started",
        batchId: "b1",
        agentId: "a1",
        label: "worker-1",
      },
    ]);

    expect(
      mapOmaUpdate(
        {
          id: 4,
          type: "delegation_agent_completed",
          data: { batchId: "b1", agentId: "a1", label: "worker-1", ok: true },
        },
        "acp",
      ),
    ).toEqual([
      {
        type: "delegation_agent_completed",
        batchId: "b1",
        agentId: "a1",
        label: "worker-1",
        ok: true,
      },
    ]);

    expect(
      mapOmaUpdate(
        {
          id: 5,
          type: "delegation_batch_completed",
          data: { batchId: "b1", ok: true, agentCount: 2, totalTokens: 150 },
        },
        "acp",
      ),
    ).toEqual([
      {
        type: "delegation_batch_completed",
        batchId: "b1",
        ok: true,
        agentCount: 2,
        totalTokens: 150,
      },
    ]);

    expect(
      mapOmaUpdate(
        {
          id: 6,
          type: "mcp_mount_result",
          data: { server: "prod", ok: true, toolsCount: 3 },
        },
        "acp",
      ),
    ).toEqual([
      {
        type: "backend.acp.mcp_mount_result",
        payload: { server: "prod", ok: true, toolsCount: 3 },
      },
    ]);
  });

  test("P1-6: AcpBackend onMcpMessage returns inner error at result.error (not nested in result.result)", async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    let observedBadMethodResp: unknown;

    const backend = new AcpBackend({
      acpMcpProvider: {
        name: "product-tools",
        serverId: "product-tools",
        listTools: () => ({ tools: [] }),
        call: async () => ({ content: "ok" }),
      },
      spawnImpl: () => {
        const agentStream = acp.ndJsonStream(agentToClient.writable, clientToAgent.readable);
        const exit = acp
          .agent({ name: "fake" })
          .onRequest(acp.methods.agent.initialize, async () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true, mcpCapabilities: { acp: true } },
            authMethods: [],
          }))
          .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "s-1" }))
          .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
            observedBadMethodResp = await ctx.client.request("mcp/message", {
              serverId: "product-tools",
              requestId: "r-1",
              method: "tools/unknown",
              params: {},
            } as never);
            return { stopReason: "end_turn" as const };
          })
          .connect(agentStream)
          .closed.then(() => 0);

        return {
          stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
          exit,
          kill: () => {
            void clientToAgent.writable.close().catch(() => {});
          },
        };
      },
    });

    const seg = await backend.execute({
      input: { inputId: "in-1", message: { role: "user", text: "hi" } },
      run: {
        runId: "r-mcp-err",
        model: { backendKind: "acp", modelId: "oma" },
        configRevision: 1,
      },
      workspace: { root: "/tmp", access: "read_write" },
    });
    const outcome = await seg.outcome;
    expect(outcome.status).toBe("completed");
    expect(observedBadMethodResp).toEqual({
      result: {
        error: {
          code: -32601,
          message: "unsupported MCP method tools/unknown",
        },
      },
    });
  });
});
