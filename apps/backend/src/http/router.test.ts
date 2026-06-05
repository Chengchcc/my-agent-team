import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqliteAgentAdapter } from "../features/agent/adapter-sqlite.js";
import { agentRoutes, createAgentService } from "../features/agent/index.js";
import { openDb } from "../infra/sqlite/db.js";
import { createRouter } from "./router.js";

const TOKEN = "test-token";

// Set up real agent feature for router testing
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
  });

  router = createRouter(TOKEN, {
    agents: agentRoutes(agentSvc),
    threads: undefined!,
    runs: undefined!,
    checkpoints: undefined!,
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
});
