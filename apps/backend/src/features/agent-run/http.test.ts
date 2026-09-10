import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import { openDb } from "../../infra/sqlite/db.js";
import { api, setupTestApp, type TestApp } from "../../testing/app-harness.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import { createAgentRunService } from "./service.js";

let harness: TestApp;

/** Real adapter/service stack over the SAME sqlite file the app serves, so
 *  seeded runs flow through the true enqueue → finalize code paths. */
let backend: ReturnType<typeof createAgentRunService>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;

const usage = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.5,
};

/** Tool-result verdict gate fixture: is_error drives pass/fail, not text. */
function outcome(status: "completed" | "failed", isError: boolean): BackendRunOutcome {
  return {
    status,
    messages: [
      {
        id: `m-${Math.random().toString(36).slice(2, 8)}`,
        role: "assistant",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "tool output",
            is_error: isError,
          },
        ],
      },
    ],
    usage: status === "completed" ? { ...usage, costUsd: isError ? 0.25 : 0.5 } : undefined,
  };
}

let seq = 0;

interface SeededRun {
  runId: string;
  conversationId: string;
  agentId: string;
  branchId: string;
}

async function seedRun(
  status: "completed" | "failed",
  isError: boolean,
  live = false,
): Promise<SeededRun> {
  const conversationId = `conv-runs-${++seq}`;
  const agentId = `ag-runs-${seq}`;
  const conv = sqliteConversationAdapter(db);
  conv.createConversation({ conversationId, agentId, createdAt: Date.now() });
  const tree = await contextPort.getOrCreateTree(conversationId);
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "oma");

  const acquired = await backend.enqueueAndAcquire({
    conversationId,
    agentId,
    backendKind: "oma",
    mode: "normal",
    message: { role: "user", text: `seed-${seq}` },
    defaultModel: { backendKind: "oma", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: `ikey-${seq}`,
  });
  expect(acquired.acquired).toBe(true);
  const runId = acquired.run!.runId;
  if (!live) await runPort.finalizeRun(runId, outcome(status, isError));
  return { runId, conversationId, agentId, branchId: branch.branchId };
}

let db: ReturnType<typeof openDb>;
let runPass: SeededRun;
let runFail: SeededRun;
let runFailed: SeededRun;
let runLive: SeededRun;

beforeAll(async () => {
  harness = await setupTestApp();
  db = openDb(join(harness.dataDir, "backend.db"));
  const conv = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 10)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, s: number) {
      const hit = conv.getLedgerEntry(cid, s);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `run-${Math.random().toString(36).slice(2, 10)}` },
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: createAgentContextService({
      port: contextPort,
      idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
      ledgerResolver,
    }),
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
    ledgerResolver,
  });

  runPass = await seedRun("completed", false);
  runFail = await seedRun("completed", true);
  runFailed = await seedRun("failed", false);
  runLive = await seedRun("completed", false, true);
});

afterAll(() => {
  db.close();
  return harness.dispose();
});

describe("agent-run routes over seeded runs", () => {
  test("list maps runs with tool-result verdicts and honours filters", async () => {
    const res = await api(harness, "GET", "/api/agent-runs");
    const { runs } = (await res.json()) as {
      runs: Array<{
        runId: string;
        status: string;
        verdict: string;
        usage: { inputTokens: number } | null;
      }>;
    };
    expect(runs).toHaveLength(4);
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect(byId.get(runPass.runId)!.verdict).toBe("pass");
    expect(byId.get(runFail.runId)!.verdict).toBe("fail");
    expect(byId.get(runFailed.runId)!.verdict).toBe("unknown");
    expect(byId.get(runPass.runId)!.usage!.inputTokens).toBe(100);
    expect(byId.get(runLive.runId)!.status).toBe("running");

    const byConv = await api(
      harness,
      "GET",
      `/api/agent-runs?conversationId=${runFail.conversationId}`,
    );
    const onlyFail = (await byConv.json()) as { runs: Array<{ runId: string }> };
    expect(onlyFail.runs.map((r) => r.runId)).toEqual([runFail.runId]);

    const byStatus = await api(harness, "GET", "/api/agent-runs?status=failed");
    const failed = (await byStatus.json()) as { runs: Array<{ runId: string }> };
    expect(failed.runs.map((r) => r.runId)).toEqual([runFailed.runId]);
  });

  test("get returns run detail with its queued input", async () => {
    const res = await api(harness, "GET", `/api/agent-runs/${runPass.runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { runId: string; status: string; verdict: string; usage: { inputTokens: number } };
      inputs: Array<{ mode: string; status: string }>;
    };
    expect(body.run.runId).toBe(runPass.runId);
    expect(body.run.status).toBe("completed");
    expect(body.run.verdict).toBe("pass");
    expect(body.run.usage!.inputTokens).toBe(100);
    expect(body.inputs.length).toBe(1);
    expect(body.inputs[0]!.mode).toBe("normal");
  });

  test("cancel on a terminal run reports already_terminal", async () => {
    const res = await api(harness, "POST", `/api/agent-runs/${runPass.runId}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      state: "already_terminal",
      runId: runPass.runId,
      status: "completed",
    });
  });

  test("approval validates decision shape and rejects terminal runs", async () => {
    const badBody = await api(harness, "POST", `/api/agent-runs/${runLive.runId}/approval`, {
      callId: "c1",
      decision: "maybe",
    });
    expect(badBody.status).toBe(400);
    expect(((await badBody.json()) as { error: string }).error).toContain("callId");

    const terminal = await api(harness, "POST", `/api/agent-runs/${runPass.runId}/approval`, {
      callId: "c1",
      decision: "allow",
    });
    expect(terminal.status).toBe(409);
  });

  test("usage summary prices via reported cost when no catalog entry exists", async () => {
    const res = await api(
      harness,
      "GET",
      `/api/usage/summary?conversationId=${runPass.conversationId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { runs: number; inputTokens: number; costUsd: number } | null;
      today: { runs: number; inputTokens: number; costUsd: number };
    };
    expect(body.conversation!.runs).toBe(1);
    expect(body.conversation!.inputTokens).toBe(100);
    expect(body.conversation!.costUsd).toBeCloseTo(0.5);
    // pass + fail are terminal with usage; failed has a terminal_result with no usage.
    expect(body.today.runs).toBe(3);
    expect(body.today.inputTokens).toBe(200);
    expect(body.today.costUsd).toBeCloseTo(0.75);
  });
});
