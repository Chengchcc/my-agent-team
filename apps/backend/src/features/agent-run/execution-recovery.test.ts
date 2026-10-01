import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  inputHooks?: {
    onHumanInputResolved?: (input: {
      runId: string;
      callId: string;
      outcome: "allow" | "deny" | "timeout";
    }) => void;
  },
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
    ...(inputHooks?.onHumanInputResolved
      ? { onHumanInputResolved: inputHooks.onHumanInputResolved }
      : {}),
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

describe("agent run execution recovery", () => {
  test("recovery terminalizes a delivered-active orphan run and promotes the next input", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    void makeExecution(fake);

    const first = await enqueue("normal", "orphan-1", "first");
    expect(first.acquired).toBe(true);
    const second = await enqueue("normal", "orphan-2", "second");
    expect(second.queued).toBe(true);

    // Simulate "child accepted, then the process died": the input is
    // delivered, the run is still active, and there is no live child.
    await runPort.markInputAccepted(first.inputId);

    // A fresh execution service = a restarted process. recover() must
    // terminalize the orphan and promote the queued input.
    const execution2 = makeExecution(fake);
    await execution2.recover();

    const aborted = await waitForTerminal(first.run!.runId);
    expect(aborted.status).toBe("aborted");
    for (let i = 0; i < 100; i++) {
      const rows = await runPort.listInputs(first.run!.branchId);
      const row = rows.find((r) => r.inputId === second.inputId)!;
      if (row.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const promoted = (await runPort.listInputs(first.run!.branchId)).find(
      (r) => r.inputId === second.inputId,
    )!;
    expect(promoted.status).toBe("delivered");
    await waitForTerminal(promoted.runId!);
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeMessages).toEqual(["second"]);
  }, 15_000);

  test("recover() never sweeps a commit_failed run to aborted, even when its retry keeps failing", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    // Fault EVERY terminal commit: the run lands in commit_failed and every
    // boot-retry of the stored outcome fails again.
    const faultedPort = sqliteAgentRunAdapter(db, {
      contextPort,
      ledgerResolver: {
        async resolveMessage(cid: string, seq: number) {
          const hit = convPort.getLedgerEntry(cid, seq);
          return hit ? (hit.content as never) : null;
        },
      },
      idGen: { ulid: () => `run-${Math.random().toString(36).slice(2, 10)}` },
      commitTestHook: () => {
        throw new Error("simulated commit failure");
      },
    });
    const execution = makeExecution(fake, faultedPort);

    const acquired = await enqueue("normal", "cfsweep-1", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    const failed = await waitForTerminal(runId);
    expect(failed.status).toBe("commit_failed");
    // Child accepted then the process died: the input is delivered, no live
    // child — exactly the shape the orphan sweep targets.
    await runPort.markInputAccepted(acquired.inputId);

    // Restart: retry fails again (hook still throws). The run must stay
    // commit_failed with its stored outcome — NOT be aborted by the sweep.
    const execution2 = makeExecution(fake, faultedPort);
    await execution2.recover();

    const after = await runPort.getRun(runId);
    expect(after?.status).toBe("commit_failed");
    expect(after?.terminalResult?.status).toBe("completed");
    // Never re-spawned: recovery replays the STORED outcome only.
    expect(fake.executeCalls).toHaveLength(1);
  }, 20_000);

  test("follow-up chain promotes queued inputs as fresh FIFO runs", async () => {
    const fake = createFakeAcpDaemon({ dataDir, outcomeDelayMs: 120 });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "chain-1", "first");
    expect(first.acquired).toBe(true);
    const followUp = await enqueue("follow_up", "chain-2", "second");
    expect(followUp.queued).toBe(true);
    const third = await enqueue("normal", "chain-3", "third");
    expect(third.queued).toBe(true);

    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);

    // Both queued inputs became FRESH product runs, executed in FIFO order.
    // The ACP harness keeps one session, so prompts (not session/new lines)
    // are the per-turn execution count.
    for (let i = 0; i < 200 && fake.executeMessages.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const inputs = await runPort.listInputs(first.run!.branchId);
    const queued = inputs.filter((i) => i.runId && i.runId !== first.run!.runId);
    expect(queued).toHaveLength(2);
    const [secondRunId, thirdRunId] = [queued[0]!.runId!, queued[1]!.runId!];
    const second = await waitForTerminal(secondRunId);
    expect(second.status).toBe("completed");
    const thirdRun = await waitForTerminal(thirdRunId);
    expect(thirdRun.status).toBe("completed");
    expect(fake.executeMessages).toEqual(["first", "second", "third"]);
  }, 20_000);

  test("a prompt failure settles the run; recover() never re-executes", async () => {
    const fake = createFakeAcpDaemon({ dataDir, failFirstExecute: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "retry-1", "hello");
    const runId = acquired.run!.runId;

    // The child accepts, then prompt_error settles the turn failed. The
    // delivered input must never become a retry queue after a restart.
    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("delivered");

    const execution2 = makeExecution(fake);
    await execution2.recover();
    expect(fake.executeMessages).toHaveLength(1);
  }, 15_000);

  test("pinned workspace reaches the child; recover() is a no-op after terminal failure", async () => {
    const fake = createFakeAcpDaemon({ dataDir, failFirstExecute: true });
    const execution = makeExecution(fake);

    const pinnedWorkspace = `${dataDir}/pinned-ws`;
    mkdirSync(pinnedWorkspace, { recursive: true });
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "acp",
      mode: "normal",
      message: { role: "user", text: "hello" },
      defaultModel: { backendKind: "acp", modelId: "acp/oma" },
      configRevision: 1,
      idempotencyKey: "ws-1",
      workspace: { root: pinnedWorkspace, access: "read_write" },
    });
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    // session/new records its cwd before the scripted prompt failure.
    expect(realpathSync(fake.executeCalls[0]!.workspaceRoot)).toBe(realpathSync(pinnedWorkspace));

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const execution2 = makeExecution(fake);
    await execution2.recover();
    expect(fake.executeMessages).toHaveLength(1);
  }, 15_000);
});

describe("agent run restart resume (ADR 0038)", () => {
  test("a run parked on an approval survives recover() and resumes when answered", async () => {
    const fake = createFakeAcpDaemon({ dataDir, outcomeDelayMs: 10 });
    void makeExecution(fake); // the "old" process: parks the run, then dies

    const acquired = await enqueue("normal", "ikey-resume-1", "hello");
    const runId = acquired.run!.runId;
    const callId = "toolu-parked";
    // The parked state: input DELIVERED (child accepted before dying), one
    // approval pending, run CAS'd to waiting.
    await runPort.markInputAccepted(acquired.inputId!);
    await runPort.createPendingAction(runId, {
      actionId: `${runId}:${callId}`,
      kind: "approval",
      payload: { callId, toolName: "bash" },
    });
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // Restart: the orphan sweep must SPARE the parked run (ADR 0038) —
    // its pending action keeps the answer path alive.
    const execution2 = makeExecution(fake);
    await execution2.recover();
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // The human answers on the fresh process: the decision is consumed and
    // the SAME runId/input re-dispatches with the decision on the wire.
    await execution2.resolveApproval(runId, callId, "allow");
    const settled = await waitForTerminal(runId);
    expect(settled.status).toBe("completed");
    // The resumed child carried the decision list.
    expect(fake.resumeCalls).toContainEqual([callId]);
    // Exactly one child ever executed: the resume dispatch.
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeMessages).toEqual(["hello"]);
  }, 20_000);

  test("a parked run with siblings still open stays parked until the last answer", async () => {
    const fake = createFakeAcpDaemon({ dataDir, outcomeDelayMs: 10 });
    void makeExecution(fake);
    const acquired = await enqueue("normal", "ikey-resume-2", "hello");
    const runId = acquired.run!.runId;
    await runPort.markInputAccepted(acquired.inputId!);
    await runPort.createPendingAction(runId, {
      actionId: `${runId}:c-a`,
      kind: "approval",
      payload: { callId: "c-a" },
    });
    await runPort.createPendingAction(runId, {
      actionId: `${runId}:c-b`,
      kind: "approval",
      payload: { callId: "c-b" },
    });

    const announcements: Array<{ runId: string; callId: string; outcome: string }> = [];
    const execution2 = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      onHumanInputResolved: (input) => announcements.push(input),
    });
    await execution2.recover();
    await execution2.resolveApproval(runId, "c-a", "allow");
    // Sibling still open: NOT resumed, no child spawned, still waiting.
    expect(fake.executeCalls).toHaveLength(0);
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    await execution2.resolveApproval(runId, "c-b", "deny");
    const settled = await waitForTerminal(runId);
    expect(settled.status).toBe("completed");
    expect(fake.resumeCalls).toContainEqual(["c-a", "c-b"]);
    // Every settled request is announced, so the surface's card stops reading as pending: the
    // product states the outcome, the surface layer decides how its channel says it.
    expect(announcements).toEqual([
      { runId, callId: "c-a", outcome: "allow" },
      { runId, callId: "c-b", outcome: "deny" },
    ]);
  }, 20_000);
});
