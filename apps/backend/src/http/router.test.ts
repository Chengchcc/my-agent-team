import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqliteAgentAdapter } from "../features/agent/adapter-sqlite.js";
import { agentRoutes, createAgentService } from "../features/agent/index.js";
import { sqliteCheckpointReadAdapter, sqliteCheckpointWriteAdapter } from "../features/checkpoint/adapter-sqlite.js";
import {
  conversationRoutes,
  createConversationService,
  sqliteConversationAdapter,
} from "../features/conversation/index.js";
import { openDb } from "../infra/sqlite/db.js";
import { createRouter } from "./router.js";

const TOKEN = "test-token";

// Set up real features for router testing
const dbPath = `/tmp/test-router-${Date.now()}.db`;
let db: Database;
let router: (req: Request) => Promise<Response>;

beforeAll(async () => {
  db = openDb(dbPath);
  const agentPort = sqliteAgentAdapter(db);
  const agentSvc = createAgentService({
    port: agentPort,
    idGen: () => crypto.randomUUID().slice(0, 8),
    workspaceRoot: `/tmp/test-router-ws-${Date.now()}`,
    materializeWorkspace: async (id) => {
      const { mkdir } = await import("node:fs/promises");
      const p = `/tmp/test-router-ws-${Date.now()}/${id}`;
      await mkdir(p, { recursive: true });
      return p;
    },
    purgeWorkspace: async () => {},
    purgeEventsForThreads: () => {},
    listThreadIds: async () => [],
    assertNoActiveRun: () => {},
  });

  // M10: Real conversation feature for production path testing
  const convPort = sqliteConversationAdapter(db);
  const convSvc = createConversationService({
    port: convPort,
    checkpointRead: sqliteCheckpointReadAdapter(db),
    checkpointWrite: sqliteCheckpointWriteAdapter(db),
    activeConversations: new Set<string>(),
    maxConsecutiveAgentHops: 8,
    forkRun: (runId) => ({ runId, attemptId: `att-${runId}` }),
  });

  router = createRouter(TOKEN, {
    agents: agentRoutes(agentSvc),
    threads: undefined!,
    runs: undefined!,
    checkpoints: undefined!,
    conversations: conversationRoutes(convSvc, () => crypto.randomUUID().slice(0, 8)),
  });
});

afterAll(() => {
  db.close();
  try {
    require("node:fs").unlinkSync(dbPath);
  } catch {}
});

describe("Router with real features", () => {
  test("GET /health returns 200 without auth", async () => {
    const resp = await router(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("unauthenticated request returns 401", async () => {
    const resp = await router(new Request("http://localhost/api/agents"));
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  test("POST /api/agents creates agent and GET returns it in list", async () => {
    // Create an agent
    const cResp = await router(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          name: "router-test",
          model: { provider: "anthropic", model: "claude" },
        }),
      }),
    );
    expect(cResp.status).toBe(201);
    const created = (await cResp.json()) as { id: string; name: string };
    expect(created.name).toBe("router-test");

    // List agents
    const lResp = await router(
      new Request("http://localhost/api/agents", {
        headers: { "x-auth-token": TOKEN },
      }),
    );
    expect(lResp.status).toBe(200);
    const list = (await lResp.json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect((list[0] as { name: string }).name).toBe("router-test");
  });

  test("unknown route returns 404", async () => {
    const resp = await router(
      new Request("http://localhost/unknown", {
        headers: { "x-auth-token": TOKEN },
      }),
    );
    expect(resp.status).toBe(404);
  });

  // ─── M10: Conversation routes ─────────────────────────────

  test("POST /api/conversations creates conversation with members", async () => {
    const resp = await router(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          members: [
            { kind: "human", userRef: "u-1", displayName: "Alice" },
            { kind: "agent", agentId: "ag-x", displayName: "XAgent" },
          ],
        }),
      }),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { conversationId: string; members: unknown[] };
    expect(body.conversationId).toBeTruthy();
    expect(body.members).toHaveLength(2);
  });

  test("POST /api/conversations/:id/messages appends message and triggers agent", async () => {
    // Create conversation first
    const cResp = await router(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          members: [
            { kind: "human", memberId: "alice", userRef: "u-1" },
            { kind: "agent", memberId: "x-agent", agentId: "ag-x" },
          ],
        }),
      }),
    );
    const { conversationId } = (await cResp.json()) as { conversationId: string };

    const resp = await router(
      new Request(`http://localhost/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          senderMemberId: "alice",
          addressedTo: ["x-agent"],
          content: { text: "hello" },
        }),
      }),
    );
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { seq: number; triggeredRuns: unknown[] };
    expect(body.seq).toBeGreaterThan(0);
  });

  test("POST /api/conversations/:id/members adds member", async () => {
    const cResp = await router(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          members: [
            { kind: "human", memberId: "bob", userRef: "u-2" },
          ],
        }),
      }),
    );
    const { conversationId } = (await cResp.json()) as { conversationId: string };

    const resp = await router(
      new Request(`http://localhost/api/conversations/${conversationId}/members`, {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "agent",
          agentId: "ag-y",
          displayName: "YAgent",
        }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { members: unknown[] };
    expect(body.members).toHaveLength(2);
  });

  test("GET /api/conversations returns 405 (only POST allowed)", async () => {
    const resp = await router(
      new Request("http://localhost/api/conversations", {
        headers: { "x-auth-token": TOKEN },
      }),
    );
    expect(resp.status).toBe(405);
  });

  test("GET /api/conversations/:id returns snapshot with members", async () => {
    // Create conversation first
    const cResp = await router(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "x-auth-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          members: [
            { kind: "human", memberId: "eve", userRef: "u-3", displayName: "Eve" },
            { kind: "agent", memberId: "z-agent", agentId: "ag-z", displayName: "ZAgent" },
          ],
        }),
      }),
    );
    const { conversationId } = (await cResp.json()) as { conversationId: string };

    const resp = await router(
      new Request(`http://localhost/api/conversations/${conversationId}`, {
        headers: { "x-auth-token": TOKEN },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      conversationId: string;
      triggerMode: string;
      hopCount: number;
      members: Array<{ memberId: string; kind: string; displayName: string | null }>;
    };
    expect(body.conversationId).toBe(conversationId);
    expect(body.triggerMode).toBe("mention");
    expect(body.hopCount).toBe(0);
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.memberId).sort()).toEqual(["eve", "z-agent"]);
  });

  test("GET /api/conversations/:id returns 404 for unknown id", async () => {
    const resp = await router(
      new Request("http://localhost/api/conversations/nonexistent", {
        headers: { "x-auth-token": TOKEN },
      }),
    );
    expect(resp.status).toBe(404);
  });
});
