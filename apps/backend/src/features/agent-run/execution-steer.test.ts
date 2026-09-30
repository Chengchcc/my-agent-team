import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpBackend } from "@chengchenccc/adapter-acp";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { createRunTokenRegistry } from "../product-tools/run-token-registry.js";
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { createAgentRunExecutionService } from "./execution.js";
import { createAgentRunService } from "./service.js";

// ─── Real ACP child (fixture) harness ─────────────────────────────────
// The scripted fake ACP harness stands in for a real one: it holds the turn
// open long enough to attempt a steer injection, then completes. The premise
// this suite used to carry (steer injection into a live child) died with the
// native oma rail: ACP has no steering, so injection must be rejected loudly
// while the live run finishes unharmed. What remains pinned: the input is
// durably cancelled (never replayed), and a steer with no live run cancels
// at enqueue without creating a Run.

const FIXTURE = new URL(
  "../../../../../packages/adapter-acp/src/__fixtures__/fake-acp-harness.ts",
  import.meta.url,
).pathname;

function createFakeAcpDaemon(opts: { holdMs?: number } = {}) {
  return new AcpBackend({
    commands: { oma: [process.execPath, FIXTURE] },
    env: {
      FAKE_ACP_SCRIPT: JSON.stringify([
        ...(opts.holdMs ? [{ delay_ms: opts.holdMs }] : []),
        { text: "done" },
      ]),
    },
  });
}

const acpCatalog = {
  list: async () => ({ models: [{ id: "acp/oma", available: true }] }),
};

// ─── Test harness ──────────────────────────────────────────────────────

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let branchId: string;

const conversationId = "conv-1";
const agentId = "ag-1";

function makeExecution(fake: ReturnType<typeof createFakeAcpDaemon>) {
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  return createAgentRunExecutionService({
    runPort,
    contextPort,
    ledgerResolver,
    backends: {
      acp: { backend: fake, catalog: acpCatalog as never },
    },
    idGen: { ulid: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
    productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
    workspaceLocks: createWorkspaceLockRegistry(),
    productToolsTokenRegistry: createRunTokenRegistry(),
  });
}

async function waitForTerminal(runId: string): Promise<AgentRun> {
  for (let i = 0; i < 200; i++) {
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
  dataDir = mkdtempSync(join(tmpdir(), "exec-steer-"));
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
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "acp");
  branchId = branch.branchId;
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

describe("agent run execution steer on the ACP rail", () => {
  test("a steer injection attempt is rejected, the input cancelled, the live run unharmed", async () => {
    const fake = createFakeAcpDaemon({ holdMs: 1500 });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "steer-1", "first");
    // Fire dispatch WITHOUT awaiting: the injection must be attempted while
    // the run is live (dispatch resolves only after the run settles).
    const dispatchP = execution.dispatch(first.run!.runId);
    for (let i = 0; i < 100; i++) {
      const inputs = await runPort.listInputs(first.run!.branchId);
      if (inputs[0]?.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // ACP has no steering: the backend rejects the injection outright, the
    // rejection must never fail the healthy live run, and the input is
    // cancelled durably (a steer is never replayed as a normal input).
    const steer = await enqueue("steer", "steer-2", "steer me");
    expect(steer.queued).toBe(true);
    await expect(
      execution.injectSteer(first.run!.branchId, {
        inputId: steer.inputId!,
        message: { role: "user", text: "steer me" },
      }),
    ).rejects.toThrow(/steering/i);
    const after = await runPort.listInputs(first.run!.branchId);
    expect(after.find((i) => i.inputId === steer.inputId)!.status).toBe("cancelled");

    await dispatchP;
    const run = await waitForTerminal(first.run!.runId);
    expect(run.status).toBe("completed");
  }, 15_000);

  test("steer with no active run is cancelled at enqueue and never creates a Run", async () => {
    const fake = createFakeAcpDaemon();
    const execution = makeExecution(fake);

    const steer = await enqueue("steer", "steer-5", "steer me");
    expect(steer.acquired).toBe(false);
    const inputs = await runPort.listInputs(branchId);
    expect(inputs.find((i) => i.inputIdempotencyKey === "steer-5")!.status).toBe("cancelled");
    expect(execution).toBeDefined();
  }, 15_000);
});
