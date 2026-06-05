import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../src/infra/sqlite/db.js";
import { sqliteAgentAdapter } from "../../src/features/agent/adapter-sqlite.js";
import { createAgentService } from "../../src/features/agent/service.js";
import { agentRoutes } from "../../src/features/agent/http.js";

const dbPath = `/tmp/test-e2e-agents-${Date.now()}.db`;
const db = openDb(dbPath);
const adapter = sqliteAgentAdapter(db);

const svc = createAgentService({
  port: adapter,
  idGen: () => crypto.randomUUID().slice(0, 8),
  workspaceRoot: `/tmp/test-e2e-ws-${Date.now()}`,
  materializeWorkspace: async (id) => {
    const { mkdir } = await import("node:fs/promises");
    const p = `/tmp/test-e2e-ws-${Date.now()}/${id}`;
    await mkdir(p, { recursive: true });
    return p;
  },
});

const routes = agentRoutes(svc);

afterAll(() => { db.close(); try { require("node:fs").unlinkSync(dbPath); } catch {} });

describe("E2E Agent CRUD", () => {
  test("full agent lifecycle: create → get → list → update → archive → 404", async () => {
    // Create
    const cResp = await routes.create(new Request("http://localhost/api/agents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e-agent", model: { provider: "anthropic", model: "claude" } }),
    }));
    expect(cResp.status).toBe(201);
    const created = await cResp.json() as { id: string; name: string };
    expect(created.name).toBe("e2e-agent");

    // Get
    const gResp = await routes.getById(new Request("http://localhost/api/agents/x"), created.id);
    expect(gResp.status).toBe(200);

    // List
    const lResp = await routes.list(new Request("http://localhost/api/agents"));
    const list = await lResp.json() as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);

    // Update
    const uResp = await routes.update(new Request(`http://localhost/api/agents/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    }), created.id);
    const updated = await uResp.json() as { name: string };
    expect(updated.name).toBe("renamed");

    // Archive
    const aResp = await routes.archive(new Request(`http://localhost/api/agents/${created.id}`), created.id);
    expect(aResp.status).toBe(200);

    // Get after archive → 404
    const gResp2 = await routes.getById(new Request("http://localhost/api/agents/x"), created.id);
    expect(gResp2.status).toBe(404);
  });
});
