import { describe, expect, test } from "bun:test";
import type { ThreadRow } from "./domain.js";
import type { ThreadPort } from "./ports.js";
import {
  AgentNotFoundForThreadError,
  createThreadService,
  ThreadNotFoundError,
} from "./service.js";

function makePort(): ThreadPort {
  const rows = new Map<string, ThreadRow>();
  return {
    create(input) {
      const row: ThreadRow = {
        id: input.id,
        agentId: input.agentId,
        title: input.title ?? null,
        kind: "conversation",
        createdAt: input.now,
        updatedAt: input.now,
        lastRunAt: null,
      };
      rows.set(input.id, row);
      return row;
    },
    findById(id) {
      return rows.get(id) ?? null;
    },
    listByAgent(agentId) {
      return [...rows.values()].filter((r) => r.agentId === agentId);
    },
    update(id, input) {
      const r = rows.get(id);
      if (!r) return null;
      if (input.title !== undefined) r.title = input.title;
      if (input.lastRunAt !== undefined) r.lastRunAt = input.lastRunAt;
      r.updatedAt = input.now;
      return r;
    },
    delete(id) {
      return rows.delete(id);
    },
  };
}

function makeSvc() {
  let n = 1;
  const cleanedUp: string[] = [];
  return {
    svc: createThreadService({
      port: makePort(),
      idGen: () => `th-${n++}`,
      agentExists: async (id) => id === "agent-1",
      cleanupCheckpoint: async (tid) => {
        cleanedUp.push(tid);
      },
    }),
    get cleanedUp() {
      return cleanedUp;
    },
  };
}

describe("ThreadService", () => {
  test("create thread for existing agent", async () => {
    const { svc } = makeSvc();
    const th = await svc.create("agent-1", {});
    expect(th.id).toStartWith("th-");
    expect(th.agentId).toBe("agent-1");
  });

  test("create throws for unknown agent", async () => {
    const { svc } = makeSvc();
    await expect(svc.create("unknown", {})).rejects.toThrow(AgentNotFoundForThreadError);
  });

  test("getById throws for unknown thread", async () => {
    const { svc } = makeSvc();
    await expect(svc.getById("nonexistent")).rejects.toThrow(ThreadNotFoundError);
  });

  test("listByAgent returns only that agent's threads", async () => {
    const { svc } = makeSvc();
    await svc.create("agent-1", {});
    const list = await svc.listByAgent("agent-1");
    expect(list.length).toBe(1);
    expect(list[0]?.agentId).toBe("agent-1");
  });

  test("delete removes thread and cleans up checkpoint", async () => {
    const { svc, cleanedUp } = makeSvc();
    const th = await svc.create("agent-1", {});
    await svc.delete(th.id);
    await expect(svc.getById(th.id)).rejects.toThrow(ThreadNotFoundError);
    expect(cleanedUp).toContain(th.id);
  });
});
