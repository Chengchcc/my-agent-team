import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { Elysia } from "elysia";
import type { AgentRow } from "./domain.js";
import { agentRoutes } from "./http.js";
import type { AgentPort } from "./ports.js";
import { createAgentService } from "./service.js";

function makeSvc(isKnownHarness?: (harness: string) => boolean) {
  const rows = new Map<string, AgentRow>();
  const port: AgentPort = {
    async create(input) {
      const row: AgentRow = {
        id: input.id,
        workspacePath: input.workspacePath,
        config: input.config,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      };
      rows.set(input.id, row);
      return row;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()].filter((r) => r.archivedAt === null);
    },
    async update(id, input) {
      const r = rows.get(id);
      if (!r || r.archivedAt) return null;
      r.config = input.config;
      if (input.workspacePath !== undefined) r.workspacePath = input.workspacePath;
      r.updatedAt = input.now;
      return r;
    },
    async archive(id, now) {
      const r = rows.get(id);
      if (!r || r.archivedAt) return null;
      r.archivedAt = now;
      r.updatedAt = now;
      return r;
    },
    async hardDelete(id) {
      const existed = rows.delete(id);
      return { deletedAgent: existed };
    },
  };
  return new Elysia().use(
    agentRoutes(
      createAgentService({
        port,
        idGen: () => crypto.randomUUID().slice(0, 8),
        workspaceRoot: "/tmp",
        materializeWorkspace: async (id) => {
          const dir = `/tmp/ws/${id}`;
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        purgeWorkspace: async () => {},
        assertNoActiveRun: () => {},
      }),
      { listForAgent: async () => [], setAgentPacks: async () => {} },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      isKnownHarness,
    ),
  );
}

async function readJson(resp: Response): Promise<unknown> {
  return resp.json();
}

describe("agent HTTP routes", () => {
  test("POST /api/agents creates agent and returns 201", async () => {
    const app = makeSvc();
    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", harness: "oma", model: "anthropic/claude" }),
    });
    const resp = await app.handle(req);
    expect(resp.status).toBe(201);
    const body = (await readJson(resp)) as { id: string; name: string };
    expect(body.name).toBe("test");
  });

  test("the response carries the harness model, so the edit form can round-trip it", async () => {
    const app = makeSvc();
    const created = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "harness-model",
          harness: "oma",
          model: "deepseek/deepseek-v4-pro",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const body = (await readJson(created)) as { harness: string; model: string };
    expect(body.harness).toBe("oma");
    expect(body.model).toBe("deepseek/deepseek-v4-pro");

    // Unset reads as null: an empty string would look like a choice and pin
    // every run to whatever the harness last held.
    const plain = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "no-harness-model",
          harness: "oma",
        }),
      }),
    );
    expect(((await readJson(plain)) as { model: string }).model).toBe("");
  });

  test("POST /api/agents returns 422 on invalid body", async () => {
    const app = makeSvc();
    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    const resp = await app.handle(req);
    expect(resp.status).toBe(422); // Elysia TypeBox validation default
  });

  test("GET /api/agents returns list", async () => {
    const app = makeSvc();
    // Create first
    await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "a1", harness: "oma" }),
      }),
    );
    const resp = await app.handle(new Request("http://localhost/api/agents"));
    expect(resp.status).toBe(200);
    const body = (await readJson(resp)) as unknown[];
    expect(body.length).toBe(1);
  });

  test("GET /api/agents/:id returns 404 for unknown", async () => {
    const app = makeSvc();
    const resp = await app.handle(new Request("http://localhost/api/agents/x"));
    expect(resp.status).toBe(404);
  });

  test("PATCH /api/agents/:id updates agent", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "old", harness: "oma" }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const resp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new" }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await readJson(resp)) as { name: string };
    expect(body.name).toBe("new");
  });

  test("DELETE /api/agents/:id archives agent", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "a", harness: "oma" }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const resp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "DELETE",
      }),
    );
    expect(resp.status).toBe(200);
  });

  test("workspace entries/file list and read, traversal rejected", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ws", harness: "oma" }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const ws = `/tmp/ws/${created.id}`;
    mkdirSync(`${ws}/knowledge`, { recursive: true });
    writeFileSync(`${ws}/AGENTS.md`, "# rules");
    writeFileSync(`${ws}/knowledge/README.md`, "# kb");

    // List root: dirs first, then files.
    const entriesResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/entries?path=`),
    );
    expect(entriesResp.status).toBe(200);
    const entries = (await readJson(entriesResp)) as {
      entries: Array<{ name: string; kind: string }>;
    };
    expect(entries.entries.map((e) => e.name).sort()).toEqual([
      "AGENTS.md",
      "agent.yml",
      "knowledge",
    ]);
    expect(entries.entries.find((e) => e.name === "knowledge")?.kind).toBe("dir");

    // Read a file.
    const fileResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/file?path=AGENTS.md`),
    );
    expect(fileResp.status).toBe(200);
    expect(((await readJson(fileResp)) as { content: string }).content).toBe("# rules");

    // Traversal: ../ escapes the workspace.
    const escapeResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/file?path=../../etc/passwd`),
    );
    expect(escapeResp.status).toBe(403);
  });
});

describe("agent harness consistency gate", () => {
  const KNOWN = new Set(["oma"]);
  const knownHarness = (harness: string): boolean => KNOWN.has(harness);

  const post = (app: { handle: (req: Request) => Promise<Response> }, payload: unknown) =>
    app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );

  const patch = (
    app: { handle: (req: Request) => Promise<Response> },
    id: string,
    payload: unknown,
  ) =>
    app.handle(
      new Request(`http://localhost/api/agents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );

  test("POST refuses a harness the registry doesn't know", async () => {
    const app = makeSvc(knownHarness);
    const resp = await post(app, { name: "a", harness: "ghost" });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("unknown harness ghost");
  });

  test("POST accepts a registered harness", async () => {
    const app = makeSvc(knownHarness);
    const resp = await post(app, { name: "a", harness: "oma", model: "anthropic/claude" });
    expect(resp.status).toBe(201);
  });

  test("default routes enforce the built-in ACP_AGENTS registry", async () => {
    const app = makeSvc();
    const resp = await post(app, { name: "a", harness: "ghost" });
    expect(resp.status).toBe(400);
  });

  test("PATCH switching harness refuses an unregistered one", async () => {
    const app = makeSvc(knownHarness);
    const created = await post(app, { name: "a", harness: "oma" });
    const { id } = (await created.json()) as { id: string };
    const resp = await patch(app, id, { harness: "ghost" });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("unknown harness ghost");
  });

  test("PATCH harness + model together passes when the registry knows it", async () => {
    const app = makeSvc(knownHarness);
    const created = await post(app, { name: "a", harness: "oma" });
    const { id } = (await created.json()) as { id: string };
    const resp = await patch(app, id, { harness: "oma", model: "deepseek/deepseek-v4-pro" });
    expect(resp.status).toBe(200);
  });
});
