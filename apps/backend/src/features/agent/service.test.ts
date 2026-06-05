import { describe, expect, test } from "bun:test";
import type { AgentRow } from "./domain.js";
import type { AgentPort } from "./ports.js";
import { AgentNotFoundError, createAgentService } from "./service.js";

function makeInMemoryPort(): AgentPort {
  const rows = new Map<string, AgentRow>();
  return {
    async create(input) {
      const row: AgentRow = {
        id: input.id,
        name: input.name,
        template: input.template ?? null,
        workspacePath: input.workspacePath,
        modelProvider: input.model.provider,
        modelName: input.model.model,
        modelBaseUrl: input.model.baseURL ?? null,
        permissionMode: input.permissionMode ?? "ask",
        maxSteps: input.maxSteps ?? null,
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
    async list(includeArchived) {
      const all = [...rows.values()];
      return includeArchived ? all : all.filter((r) => r.archivedAt === null);
    },
    async update(id, input) {
      const existing = rows.get(id);
      if (!existing || existing.archivedAt) return null;
      if (input.name !== undefined) existing.name = input.name;
      if (input.permissionMode !== undefined) existing.permissionMode = input.permissionMode;
      if (input.maxSteps !== undefined) existing.maxSteps = input.maxSteps;
      existing.updatedAt = input.now;
      return existing;
    },
    async archive(id, now) {
      const existing = rows.get(id);
      if (!existing || existing.archivedAt) return null;
      existing.archivedAt = now;
      existing.updatedAt = now;
      return existing;
    },
  };
}

function makeSvc() {
  let next = 1;
  const port = makeInMemoryPort();
  const svc = createAgentService({
    port,
    idGen: () => `agent-${next++}`,
    workspaceRoot: "/tmp/ws",
    materializeWorkspace: async (id) => `/tmp/ws/${id}`,
  });
  return { svc, port };
}

describe("AgentService", () => {
  test("create returns agent with generated id", async () => {
    const { svc } = makeSvc();
    const agent = await svc.create({
      name: "test",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(agent.id).toStartWith("agent-");
    expect(agent.name).toBe("test");
    expect(agent.permissionMode).toBe("ask");
  });

  test("getById throws AgentNotFoundError for unknown id", async () => {
    const { svc } = makeSvc();
    await expect(svc.getById("nonexistent")).rejects.toThrow(AgentNotFoundError);
  });

  test("getById returns agent after create", async () => {
    const { svc } = makeSvc();
    const created = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    const found = await svc.getById(created.id);
    expect(found.id).toBe(created.id);
  });

  test("list returns active agents only by default", async () => {
    const { svc } = makeSvc();
    await svc.create({ name: "a1", model: { provider: "anthropic", model: "x" } });
    await svc.create({ name: "a2", model: { provider: "anthropic", model: "x" } });
    const list = await svc.list();
    expect(list.length).toBe(2);
  });

  test("list excludes archived agents", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    await svc.archive(a.id);
    const list = await svc.list();
    expect(list.length).toBe(0);
  });

  test("update changes fields", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "old", model: { provider: "anthropic", model: "x" } });
    const updated = await svc.update(a.id, { name: "new" });
    expect(updated.name).toBe("new");
  });

  test("update throws on archived agent", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    await svc.archive(a.id);
    await expect(svc.update(a.id, { name: "x" })).rejects.toThrow(AgentNotFoundError);
  });

  test("archive sets archivedAt", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    const archived = await svc.archive(a.id);
    expect(archived.archivedAt).toBeDefined();
  });
});
