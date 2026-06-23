import { describe, expect, test } from "bun:test";
import type { CronJobPort } from "./ports.js";
import { CronJobNotFoundError, CronJobValidationError, createCronJobService } from "./service.js";

function mockPort(initial: any[] = []): CronJobPort {
  const store = new Map<string, any>();
  for (const r of initial) store.set(r.cronJobId, { ...r });
  return {
    createCronJob(input: any) {
      const r = { ...input };
      store.set(input.cronJobId, r);
      return r;
    },
    getCronJob(id: string) {
      return store.get(id) ?? null;
    },
    listCronJobs() {
      return [...store.values()];
    },
    listEnabledCronJobs() {
      return [...store.values()].filter((r: any) => r.enabled);
    },
    updateCronJob(id: string, patch: any) {
      const r = store.get(id);
      if (!r) return null;
      Object.assign(r, patch);
      return store.get(id) ?? null;
    },
    deleteCronJob(id: string) {
      return store.delete(id);
    },
  };
}

function makeIdGen() {
  let n = 0;
  return () => `cj-${++n}`;
}

describe("createCronJobService", () => {
  test("createCronJob validates agentId", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: (id) => id === "agent-1",
    });
    expect(() =>
      svc.createCronJob({ name: "test", agentId: "nonexistent", cronExpr: "0 9 * * *" }),
    ).toThrow(CronJobValidationError);
  });

  test("createCronJob succeeds with valid agentId", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: (id) => id === "agent-1",
    });
    const job = svc.createCronJob({
      name: "test",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      prompt: "hello",
    });
    expect(job.cronJobId).toBe("cj-1");
    expect(job.name).toBe("test");
    expect(job.prompt).toBe("hello");
    expect(job.enabled).toBe(false);
    expect(job.timeoutMs).toBe(0);
    expect(job.maxRetries).toBe(0);
  });

  test("createCronJob with enabled:true", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    const job = svc.createCronJob({
      name: "enabled job",
      agentId: "agent-1",
      cronExpr: "* * * * *",
      enabled: true,
    });
    expect(job.enabled).toBe(true);
  });

  test("createCronJob with timeout and retries", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    const job = svc.createCronJob({
      name: "x",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      timeoutMs: 30000,
      maxRetries: 5,
    });
    expect(job.timeoutMs).toBe(30000);
    expect(job.maxRetries).toBe(5);
  });

  test("setEnabled toggles", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    const job = svc.createCronJob({ name: "toggle", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(svc.setEnabled(job.cronJobId, true).enabled).toBe(true);
    expect(svc.setEnabled(job.cronJobId, false).enabled).toBe(false);
  });

  test("setEnabled throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    expect(() => svc.setEnabled("nonexistent", true)).toThrow(CronJobNotFoundError);
  });

  test("getById throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    expect(() => svc.getById("nonexistent")).toThrow(CronJobNotFoundError);
  });

  test("list returns all", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    svc.createCronJob({ name: "a", agentId: "agent-1", cronExpr: "0 9 * * *" });
    svc.createCronJob({ name: "b", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(svc.list()).toHaveLength(2);
  });

  test("exists returns true/false", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    expect(svc.exists("anything")).toBe(false);
    const job = svc.createCronJob({ name: "x", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(svc.exists(job.cronJobId)).toBe(true);
  });

  test("update modifies fields", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    const job = svc.createCronJob({
      name: "old",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      timeoutMs: 1000,
    });
    const updated = svc.update(job.cronJobId, { name: "new", timeoutMs: 5000 });
    expect(updated.name).toBe("new");
    expect(updated.timeoutMs).toBe(5000);
    expect(updated.cronExpr).toBe("0 9 * * *"); // unchanged
  });

  test("update validates new agentId", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: (id) => id === "agent-1",
    });
    const job = svc.createCronJob({ name: "x", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(() => svc.update(job.cronJobId, { agentId: "nonexistent" })).toThrow(
      CronJobValidationError,
    );
  });

  test("update throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    expect(() => svc.update("nonexistent", { name: "x" })).toThrow(CronJobNotFoundError);
  });

  test("remove deletes", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    const job = svc.createCronJob({ name: "to-delete", agentId: "agent-1", cronExpr: "0 9 * * *" });
    svc.remove(job.cronJobId);
    expect(() => svc.getById(job.cronJobId)).toThrow(CronJobNotFoundError);
  });

  test("remove throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
    });
    expect(() => svc.remove("nonexistent")).toThrow(CronJobNotFoundError);
  });

  test("convPort failure does not block createCronJob", () => {
    let called = false;
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: () => true,
      convPort: {
        createConversation: () => {
          called = true;
          throw new Error("boom");
        },
        addMember: () => {},
      },
    });
    const job = svc.createCronJob({ name: "conv-test", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(job).not.toBeNull();
    expect(called).toBe(true); // tried but failed silently
  });

  test("convPort success creates conversation and adds owner member", () => {
    const calls: string[] = [];
    const svc = createCronJobService({
      port: mockPort(),
      idGen: () => "cj-conv",
      agentExists: () => true,
      convPort: {
        createConversation: (input) => {
          calls.push(`conv:${input.conversationId}:${input.title}:${input.origin}`);
        },
        addMember: (input) => {
          calls.push(
            `member:${input.conversationId}:${input.memberId}:${input.kind}:${input.agentId}`,
          );
        },
      },
    });
    svc.createCronJob({ name: "My Job", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(calls).toEqual(["conv:cj-conv:My Job:cron", "member:cj-conv:owner:agent:agent-1"]);
  });
});
