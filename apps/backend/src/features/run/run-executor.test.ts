/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mockAgentSvc,
  mockConfig,
  mockOpsStore,
  mockSupervisor,
  testDB,
  waitForFinalize,
} from "../../../test-helpers/mock-deps.js";
import { executeAgentRun, makeRunDeps } from "./run-executor.js";
import type { RunSupervisor } from "./supervisor.js";

describe("executeAgentRun completion signal", () => {
  let db: ReturnType<typeof testDB>;
  let supervisor: RunSupervisor;

  beforeAll(() => {
    db = testDB();
    supervisor = mockSupervisor(db);
  });
  afterAll(() => {
    db.close();
  });

  async function runAndWait(opts: Record<string, unknown>) {
    const calls: string[] = [];
    supervisor.onRunComplete((_t, _r, status) => {
      calls.push(status);
    });
    const config = mockConfig() as any;
    const deps = makeRunDeps({
      config,
      supervisor,
      opsStore: mockOpsStore() as any,
      agentSvc: mockAgentSvc() as any,
    });
    const { runId } = await executeAgentRun(deps, {
      runId: `${opts.prefix}-${Date.now()}`,
      sessionId: opts.threadId as string,
      agentId: opts.agentId as string,
      input: (opts.input as string) ?? "hi",
      origin: { kind: "conversation", conversationId: "", surface: "web", senderName: "unknown" },
    });
    await waitForFinalize(supervisor, runId);
    return { runId, calls };
  }

  test("conversation: completes, fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "c",
      threadId: "c:test",
      agentId: "a",
      originKind: "manual",
    });
    expect(calls).toContain("succeeded");
  });

  test("orchestrator: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "o",
      threadId: "i:a",
      agentId: "a",
      surface: "orchestrator",
      senderName: "o",
      originKind: "orchestrator",
      origin: { issueId: "i1", fromStatus: "p" },
    });
    expect(calls).toContain("succeeded");
  });

  test("cron: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "cr",
      threadId: "cr:o",
      agentId: "a",
      surface: "cron",
      senderName: "cr",
      originKind: "cron",
    });
    expect(calls).toContain("succeeded");
  });
});
