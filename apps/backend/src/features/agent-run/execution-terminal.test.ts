import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessageId, parseMessageRevision } from "@chengchenccc/message";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import {
  createRunTokenRegistry,
  type RunTokenRegistry,
} from "../product-tools/run-token-registry.js";
import { sqliteProjectAdapter } from "../project/adapter-sqlite.js";
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

describe("agent run execution terminal", () => {
  test("retryTerminalCommit replays the STORED outcome without re-executing the Backend", async () => {
    // Fault-inject the commit once so the run lands in commit_failed.
    let failCommit = true;
    const fake = createFakeAcpDaemon({ dataDir });
    const ledgerResolver = {
      async resolveMessage(cid: string, seq: number) {
        const entries = convPort.getLedgerEntries(cid);
        const hit = entries.find((e) => e.seq === seq);
        return hit ? (hit.content as never) : null;
      },
    };
    const failingRunPort = sqliteAgentRunAdapter(db, {
      contextPort,
      ledgerResolver,
      idGen: { ulid: () => `f-${Math.random().toString(36).slice(2, 10)}` },
      commitTestHook: () => {
        if (failCommit) throw new Error("simulated product commit failure");
      },
    });
    const execution = makeExecution(fake, failingRunPort);

    const acquired = await enqueue("normal", "commit-1", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    const failed = await waitForTerminal(runId);
    expect(failed.status).toBe("commit_failed");
    expect(fake.executeCalls).toHaveLength(1);
    // Branch stays occupied: a queued input must NOT be promoted.
    const queued = await enqueue("normal", "commit-2", "second");
    expect(queued.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.executeCalls).toHaveLength(1);

    // Retry the terminal commit: no Backend call, one ledger message.
    failCommit = false;
    await execution.retryTerminalCommit(runId);
    const run = await runPort.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(fake.executeCalls).toHaveLength(1);
    const ledger = convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message");
    expect(ledger).toHaveLength(1);
    const revision = parseMessageRevision(ledger[0]!.content);
    expect(revision.messageId).toBe(assistantMessageId(runId, 0));
  });

  test("per-run product-tools token: unique across runs, revoked at settle", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const registry = createRunTokenRegistry();
    const execution = makeExecution(fake, undefined, undefined, undefined, registry);

    const first = await enqueue("normal", "tok-1", "hello");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    const second = await enqueue("normal", "tok-2", "hello again");
    await execution.dispatch(second.run!.runId);
    await waitForTerminal(second.run!.runId);

    const tokens = fake.executeTokens;
    expect(tokens).toHaveLength(2);
    // Different bearers per run...
    expect(new Set(tokens).size).toBe(2);
    // ...and both runs settled, so neither validates anymore.
    for (const t of tokens) expect(registry.validate(t)).toBeNull();
  }, 15_000);

  test("stop() requests cancellation on the live segment", async () => {
    const fake = createFakeAcpDaemon({ dataDir, outcomeDelayMs: 2000 });
    const stopCalls: string[] = [];
    const recording = Object.create(fake.backend) as typeof fake.backend;
    recording.stop = async (runId: string) => {
      stopCalls.push(runId);
      await fake.backend.stop(runId);
    };
    const execution = makeExecution({ ...fake, backend: recording });
    const acquired = await enqueue("normal", "stop-1", "hello");
    const runId = acquired.run!.runId;
    const dispatchPromise = execution.dispatch(runId);
    // Wait until the run is delivered (Backend acceptance complete): the
    // live handle exists and stop() targets the child.
    for (let i = 0; i < 100; i++) {
      const inputs = await runPort.listInputs(acquired.run!.branchId);
      if (inputs[0]?.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await execution.stop(runId);
    await dispatchPromise;
    expect(stopCalls).toEqual([runId]);
    await waitForTerminal(runId);
  }, 15_000);

  test("project-bound conversation runs with cwd = the worktree", async () => {
    mkdirSync(join(dataDir, "projects", "p-attached"), { recursive: true });
    const projectPort = sqliteProjectAdapter(db);
    for (const pid of ["p-attached", "p-other"]) {
      if (!projectPort.getProject(pid)) {
        projectPort.createProject({
          projectId: pid,
          name: pid,
          repoUrl: null,
          defaultBranch: null,
          createdAt: Date.now(),
        });
      }
    }
    convPort.createConversation({
      conversationId: "conv-proj",
      createdAt: Date.now(),
      projectId: "p-attached",
    });
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);
    const acquired = await backend.enqueueAndAcquire({
      conversationId: "conv-proj",
      agentId,
      backendKind: "acp",
      mode: "normal",
      message: { role: "user", text: "in project" },
      defaultModel: { backendKind: "acp", modelId: "acp/oma" },
      configRevision: 1,
      idempotencyKey: "proj-1",
    });
    await execution.dispatch(acquired.run!.runId);
    await waitForTerminal(acquired.run!.runId);
    // D1: the OS may normalize the spawn cwd (macOS /private, symlinks)
    // — compare realpaths, not raw strings.
    expect(realpathSync(fake.executeCalls[0]!.workspaceRoot)).toBe(
      realpathSync(join(dataDir, "projects", "p-attached")),
    );
  }, 15_000);

  test("project-bound conversation with unattached project fails explicitly", async () => {
    const projectPort2 = sqliteProjectAdapter(db);
    if (!projectPort2.getProject("p-other")) {
      projectPort2.createProject({
        projectId: "p-other",
        name: "p-other",
        repoUrl: null,
        defaultBranch: null,
        createdAt: Date.now(),
      });
    }
    convPort.createConversation({
      conversationId: "conv-unattached",
      createdAt: Date.now(),
      projectId: "p-other",
    });
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);
    const acquired = await backend.enqueueAndAcquire({
      conversationId: "conv-unattached",
      agentId,
      backendKind: "acp",
      mode: "normal",
      message: { role: "user", text: "nope" },
      defaultModel: { backendKind: "acp", modelId: "acp/oma" },
      configRevision: 1,
      idempotencyKey: "proj-2",
    });
    await expect(execution.dispatch(acquired.run!.runId)).rejects.toThrow(
      /has not attached project p-other/,
    );
    const run = await waitForTerminal(acquired.run!.runId);
    expect(run.status).toBe("failed");
  }, 15_000);
});
