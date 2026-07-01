/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fakeModel,
  mockAgentSvc,
  mockConfig,
  mockOpsStore,
  mockSupervisor,
  TID,
  testDB,
  waitForFinalize,
} from "../../../test-helpers/mock-deps.js";
import { executeAgentRun, makeRunDeps } from "./span-executor.js";
import type { SpanSupervisor } from "./supervisor.js";

describe("executeAgentRun completion signal", () => {
  let db: ReturnType<typeof testDB>;
  let supervisor: SpanSupervisor;

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
      makeModel: () => fakeModel(),
    });
    const { spanId } = await executeAgentRun(deps, {
      spanId: `${opts.prefix}-${Date.now()}`,
      sessionId: (opts.sessionId as string) ?? TID.session(),
      agentId: opts.agentId as string,
      input: (opts.input as string) ?? "hi",
      origin: { kind: "conversation", conversationId: "", surface: "web", senderName: "unknown" },
    });
    await waitForFinalize(supervisor, spanId);
    return { spanId, calls };
  }

  test("conversation: completes, fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "c",
      sessionId: TID.session("c", "test"),
      agentId: "a",
    });
    expect(calls).toContain("succeeded");
  });

  test("orchestrator: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "o",
      sessionId: TID.session("i", "a"),
      agentId: "a",
    });
    expect(calls).toContain("succeeded");
  });

  test("cron: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "cr",
      sessionId: TID.session("cr", "o"),
      agentId: "a",
    });
    expect(calls).toContain("succeeded");
  });
});
