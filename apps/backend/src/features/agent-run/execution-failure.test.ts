import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpBackend } from "@chengchenccc/adapter-acp";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import {
  createRunTokenRegistry,
  type RunTokenRegistry,
} from "../product-tools/run-token-registry.js";
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { createAgentRunExecutionService } from "./execution.js";
import { createAgentRunService } from "./service.js";
import { createFakeAcpDaemon, type FakeAcpDaemon } from "./test-acp-daemon.js";

// ─── Test harness ──────────────────────────────────────────────────────

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;

const conversationId = "conv-1";
const agentId = "ag-1";

function makeExecution(
  fakeDaemon: FakeAcpDaemon,
  runPortOverride?: ReturnType<typeof sqliteAgentRunAdapter>,
  modelCatalogOverride?: {
    list: () => Promise<{ models: Array<{ id: string; available: boolean }> }>;
  },
  contextPortOverride?: Partial<typeof contextPort>,
  tokenRegistry?: RunTokenRegistry,
  onRunFailed?: (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }) => void,
) {
  const activeRunPort = runPortOverride ?? runPort;
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  return createAgentRunExecutionService({
    runPort: activeRunPort,
    contextPort: { ...contextPort, ...contextPortOverride } as never,
    ledgerResolver,
    backends: {
      acp: {
        backend: fakeDaemon.backend,
        catalog: (modelCatalogOverride ?? fakeDaemon.modelCatalog) as never,
      },
    },
    idGen: { ulid: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    resolveWorkspace: async ({ conversationId: cid }) => {
      // Mirrors the composition root: a project-bound conversation maps
      // to the agent's worktree; not attached = explicit failure.
      const convRow = convPort.getConversation(cid);
      if (convRow?.projectId) {
        if (convRow.projectId !== "p-attached") {
          throw new Error(
            `agent has not attached project ${convRow.projectId}; attach it via the agent update API (agent.yml runtime_config.projects)`,
          );
        }
        return { root: join(dataDir, "projects", convRow.projectId), access: "read_write" };
      }
      return { root: dataDir, access: "read_write" };
    },
    productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
    workspaceLocks: createWorkspaceLockRegistry(),
    productToolsTokenRegistry: tokenRegistry ?? createRunTokenRegistry(),
    ...(onRunFailed ? { onRunFailed } : {}),
  });
}

async function waitForTerminal(runId: string): Promise<AgentRun> {
  for (let i = 0; i < 100; i++) {
    const run = await runPort.getRun(runId);
    if (
      run &&
      (run.status === "completed" ||
        run.status === "failed" ||
        run.status === "aborted" ||
        run.status === "commit_failed")
    ) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached terminal`);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase5-exec-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 10)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `run-${Math.random().toString(36).slice(2, 10)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
    ledgerResolver,
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
    ledgerResolver,
  });

  convPort.createConversation({ conversationId, agentId, createdAt: Date.now() });
  const tree = await contextPort.getOrCreateTree(conversationId);
  await contextPort.getOrCreateDefaultBranch(tree.treeId, "acp");
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function enqueue(mode: "normal" | "follow_up" | "steer", key: string, text: string) {
  return backend.enqueueAndAcquire({
    conversationId,
    agentId,
    backendKind: "acp",
    mode,
    message: { role: "user", text },
    defaultModel: { backendKind: "acp", modelId: "acp/oma" },
    configRevision: 1,
    idempotencyKey: key,
  });
}

describe("agent run execution failure & subscription", () => {
  test("preflight failure marks the run failed with the reason", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake, undefined, {
      list: async () => {
        throw new Error("catalog down");
      },
    });

    const acquired = await enqueue("normal", "close-1", "hello");
    const runId = acquired.run!.runId;

    await expect(execution.dispatch(runId)).rejects.toThrow("catalog down");

    // Why the run died is a durable fact on the run, not something only a live
    // connection saw.
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    if (run.terminalResult?.status === "failed") {
      expect(run.terminalResult.error).toContain("catalog down");
    }
  }, 15_000);

  test("failed dispatch fires onRunFailed with the error (T3-2)", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const failures: Array<{ runId: string; error: string }> = [];
    const execution = makeExecution(
      fake,
      undefined,
      {
        list: async () => {
          throw new Error("catalog down");
        },
      },
      undefined,
      undefined,
      (input) => {
        failures.push({ runId: input.runId, error: input.error });
      },
    );

    const acquired = await enqueue("normal", "fail-hook", "hello");
    const runId = acquired.run!.runId;
    await expect(execution.dispatch(runId)).rejects.toThrow("catalog down");
    // The surface hook receives the failure so it can persist an assistant
    // error message (T3-2) — the failure survives refresh.
    expect(failures).toEqual([{ runId, error: "catalog down" }]);
  }, 15_000);

  test("spawn failure is permanent: run finalized failed, delivering input cancelled", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const failingBackend = new AcpBackend({
      commands: { oma: ["/nonexistent/definitely-missing-bin"] },
      // The transport factory throwing models the PRE-acceptance spawn
      // failure (node's async ENOENT would otherwise land post-acceptance).
      spawnImpl: () => {
        throw new Error("ENOENT: definitely-missing-bin");
      },
    });
    const execution = makeExecution({ ...fake, backend: failingBackend });

    const acquired = await enqueue("normal", "perm-1", "hello");
    const runId = acquired.run!.runId;

    await expect(execution.dispatch(runId)).rejects.toThrow();

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    if (run.terminalResult?.status === "failed") {
      expect(run.terminalResult.error).toContain("ENOENT");
    }

    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.status).toBe("cancelled");
  }, 15_000);

  test("a prompt failure settles the run failed after delivery", async () => {
    const fake = createFakeAcpDaemon({ dataDir, failFirstExecute: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "perm-2", "hello");
    const runId = acquired.run!.runId;

    // ACP acceptance is spawn + handshake; prompt_error fails INSIDE the
    // accepted turn, so dispatch settles the run instead of rejecting.
    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    if (run.terminalResult?.status === "failed") {
      expect(run.terminalResult.error).toContain("boom");
    }
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("delivered");
  }, 15_000);

  test("Context projection failure: run failed, input cancelled", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake, undefined, undefined, {
      listEntriesToLeaf: async () => {
        throw new Error("projection boom");
      },
    });

    const acquired = await enqueue("normal", "proj-1", "hello");
    const runId = acquired.run!.runId;

    await expect(execution.dispatch(runId)).rejects.toThrow("projection boom");

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("cancelled");
  }, 15_000);

  test("no-live cancel releases the branch and promotes the next queued input", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "cancel-1", "first");
    expect(first.acquired).toBe(true);
    const second = await enqueue("normal", "cancel-2", "second");
    expect(second.queued).toBe(true);

    // Simulate a zombie: the first run is active in the DB but was never
    // dispatched on this process (no live child). stop() must terminal it,
    // cancel its input, and promote the queued input into a FRESH run.
    await execution.stop(first.run!.runId);

    const aborted = await waitForTerminal(first.run!.runId);
    expect(aborted.status).toBe("aborted");
    const inputs = await runPort.listInputs(first.run!.branchId);
    const firstInput = inputs.find((i) => i.inputId === first.inputId)!;
    expect(firstInput.status).toBe("cancelled");

    // The queued input became a new run that actually executed. The chain
    // dispatch is fire-and-forget: poll until the child accepted it.
    const secondInput = inputs.find((i) => i.inputId === second.inputId)!;
    expect(secondInput.runId).not.toBe(first.run!.runId);
    for (let i = 0; i < 100; i++) {
      const rows = await runPort.listInputs(first.run!.branchId);
      const row = rows.find((r) => r.inputId === second.inputId)!;
      if (row.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const delivered = (await runPort.listInputs(first.run!.branchId)).find(
      (r) => r.inputId === second.inputId,
    )!;
    expect(delivered.status).toBe("delivered");
    await waitForTerminal(delivered.runId!);
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeMessages).toEqual(["second"]);
  }, 15_000);
});
