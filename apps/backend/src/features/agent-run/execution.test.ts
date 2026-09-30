import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { AcpBackendError } from "./acp/acp-backend.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { ApprovalNotApplicableError, createAgentRunExecutionService } from "./execution.js";
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
  extraDeps: Record<string, unknown> = {},
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
    ...extraDeps,
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

/** A backend that records the model it was handed and completes immediately. */
function recordingBackend(seen: Array<{ backendKind: string; modelId: string }>) {
  return {
    async execute(input: { run: { model: { backendKind: string; modelId: string } } }) {
      seen.push(input.run.model);
      return {
        events: (async function* () {})(),
        outcome: Promise.resolve({ status: "completed", messages: [] } as never),
        stop: async () => {},
      } as never;
    },
  };
}

describe("agent run execution (Run-centric)", () => {
  test("a retired kind is refused at preflight, never silently aliased", async () => {
    // The alias retired with the native adapters (ADR 0040 R3 complete): a
    // stored kind from before the cut can only be a misconfiguration now,
    // and the loud preflight error beats spawning a DIFFERENT harness than
    // the row names. No backend call may happen.
    const seen: Array<{ backendKind: string; modelId: string }> = [];
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      backends: {
        acp: {
          backend: recordingBackend(seen),
          catalog: {
            list: async () => ({ models: [{ id: "acp/claude", name: "claude", available: true }] }),
          },
        },
      },
    });
    const queued = await backend.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "claude_code",
      mode: "normal",
      message: { role: "user", text: "hello" },
      defaultModel: { backendKind: "claude_code", modelId: "claude-sonnet-4-6" },
      configRevision: 1,
      idempotencyKey: "alias-1",
    });
    await execution.dispatch(queued.run!.runId).catch(() => {
      /* dispatch rejecting is fine; the run row is the authority */
    });
    const run = await waitForTerminal(queued.run!.runId);
    expect(run.status).toBe("failed");
    expect(run.terminalResult?.status).toBe("failed");
    if (run.terminalResult?.status === "failed") {
      expect(run.terminalResult.error).toContain("unknown or unregistered backend kind");
    }
    expect(seen).toEqual([]);
  }, 15_000);

  test("a normal input creates one Run; terminal commit writes a parseable final Message", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const events: string[] = [];
    const execution = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      onLiveEvent: (_runId: string, ev: { type: string }) => events.push(ev.type),
    });

    const acquired = await enqueue("normal", "ikey-1", "hello");
    expect(acquired.acquired).toBe(true);
    const runId = acquired.run!.runId;

    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("completed");

    // one input, one backend execute, one delivered input (the ACP wire
    // carries the prompt, never the product runId)
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeMessages).toEqual(["hello"]);
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.status).toBe("delivered");

    // exactly one assistant message in the ledger - a VALID MessageRevision
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    const revision = parseMessageRevision(messages[0]!.content);
    expect(revision).toMatchObject({
      messageId: assistantMessageId(runId, 0),
      role: "assistant",
      state: "done",
      conversationId,
    });
    expect(revision.updatedAt).toBeGreaterThan(0);

    // exactly one ledger_message ref in context
    const entries = await contextPort.listEntriesToLeaf(run.branchId);
    const refs = entries.filter((e) => e.type === "ledger_message");
    expect(refs).toHaveLength(1);

    // subscriber saw the transient stream event (ACP emits no synthetic
    // status event; the run row owns terminal state)
    expect(events).toContain("text_delta");
  });

  test("first-turn bridge: a foreign session ref flattens projected history into the input message", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);

    // Run 1: fresh branch, empty history -> the message is the raw input.
    const first = await enqueue("normal", "bridge-1", "hello");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    expect(fake.executeMessages[0]).toBe("hello");

    // Run 2: model the branch left over from a pre-ACP backend. A foreign
    // kind-scoped ref is deliberately NOT forwarded, so the bridge flattens
    // history into the message.
    await contextPort.updateBranchCliSessionRef(first.run!.branchId, "oma:legacy-session");
    const followUp = await enqueue("follow_up", "bridge-2", "second");
    // The branch is free after run 1 settles: the follow-up acquires a
    // fresh run immediately (no promotion chain needed).
    expect(followUp.acquired).toBe(true);
    await execution.dispatch(followUp.run!.runId);
    await waitForTerminal(followUp.run!.runId);
    // The projected history (run 1's committed assistant message) is flat
    // text ahead of the new input.
    expect(fake.executeMessages[1]).toContain("Assistant: done");
    expect(fake.executeMessages[1]).toContain("second");
    expect(fake.executeMessages[1]!.trimEnd().endsWith("second")).toBe(true);
  }, 15_000);

  test("first-turn bridge keeps tool structure from block messages", async () => {
    const fake = createFakeAcpDaemon({
      dataDir,
      script: [
        { text: "running checks" },
        {
          tool_call: {
            id: "call-1",
            name: "bash",
            input: { cmd: "ls" },
            output: "file-a",
          },
        },
      ],
    });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "blocks-1", "run checks");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    await contextPort.updateBranchCliSessionRef(first.run!.branchId, "oma:legacy-session");

    const followUp = await enqueue("follow_up", "blocks-2", "continue");
    await execution.dispatch(followUp.run!.runId);
    await waitForTerminal(followUp.run!.runId);

    const bridged = fake.executeMessages[1] ?? "";
    expect(bridged).toContain("running checks");
    expect(bridged).toContain("[tool bash]");
    expect(bridged).toContain('"cmd":"ls"');
    expect(bridged).toContain("[tool result] file-a");
    expect(bridged.endsWith("continue")).toBe(true);
  }, 15_000);
  test("a child that stops reporting is stopped by the silence watchdog", async () => {
    // The loop heartbeats while it works, so silence means the child went
    // mute. Before this, such a run waited for the 30-minute wall clock and
    // the user saw a card with nothing but a climbing timer.
    const fake = createFakeAcpDaemon({ dataDir, script: [{ delay_ms: 10_000 }] });
    const execution = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      silenceWindowMs: 300,
    });
    const run = await enqueue("normal", "silent-1", "go");
    await execution.dispatch(run.run!.runId);
    const settled = await waitForTerminal(run.run!.runId);
    // stop() races the ACP connection-close error, so the watchdog's contract
    // here is "the mute child is terminal now", not which of the two names.
    expect(["aborted", "failed"]).toContain(settled.status);
  }, 15_000);

  test("the silence watchdog stands down while a human owes an answer", async () => {
    const fake = createFakeAcpDaemon({ dataDir, script: [{ delay_ms: 10_000 }] });
    const execution = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      silenceWindowMs: 300,
    });
    const run = await enqueue("normal", "silent-2", "go");
    const runId = run.run!.runId;
    const dispatched = execution.dispatch(runId);
    // The park CAS is running->waiting, so the action can only land once the
    // run is actually running.
    for (let i = 0; i < 60; i++) {
      const current = await runPort.getRun(runId);
      if (current?.status === "running") break;
      await Bun.sleep(25);
    }
    const actionId = `${runId}:c1`;
    await runPort.createPendingAction(runId, {
      actionId,
      kind: "ask",
      payload: { callId: "c1", questions: [{ id: "q", kind: "text", question: "hi" }] },
    });
    for (let i = 0; i < 60; i++) {
      const current = await runPort.getRun(runId);
      if (current?.status === "waiting") break;
      await Bun.sleep(25);
    }
    // Well past the silence window: a parked run is NOT silent (the human is
    // the progress, and the ask carries its own deadline).
    await Bun.sleep(900);
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // Answer it: the watchdog may act again and settle the run.
    await runPort.consumePendingAction(
      actionId,
      { actionId, response: { answered: true } },
      `${actionId}:resolved`,
    );
    await dispatched;
    const settled = await waitForTerminal(runId);
    expect(["aborted", "failed"]).toContain(settled.status);
  }, 20_000);

  test("session ref round-trip: the second run carries the ref, no history bridge", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);

    // Run 1: the ACP harness settles with its own session id, and the branch
    // stores it kind-scoped (`acp:<id>`, settleOutcome's prefix).
    const first = await enqueue("normal", "ref-1", "hello");
    await execution.dispatch(first.run!.runId);
    const firstRun = await waitForTerminal(first.run!.runId);
    expect(firstRun.terminalResult?.cliSessionRef).toBe("sess-fake-1");

    // Run 2 (follow_up): session/load keeps the id, so the message carries
    // NO flat-text history bridge, and only run 1 minted a fresh session.
    const followUp = await enqueue("follow_up", "ref-2", "second");
    expect(followUp.acquired).toBe(true);
    await execution.dispatch(followUp.run!.runId);
    const secondRun = await waitForTerminal(followUp.run!.runId);
    expect(secondRun.terminalResult?.cliSessionRef).toBe("sess-fake-1");
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeMessages).toEqual(["hello", "second"]);
  }, 15_000);

  test("tool trace and todo_update survive the wire onto the live channel", async () => {
    const fake = createFakeAcpDaemon({ dataDir, toolTodo: true });
    const seen: Array<Record<string, unknown>> = [];
    const execution = makeExecution(fake, undefined, undefined, undefined, undefined, undefined, {
      onLiveEvent: (_runId: string, ev: unknown) => seen.push(ev as Record<string, unknown>),
    });

    const acquired = await enqueue("normal", "ikey-tools", "use ls");
    const runId = acquired.run!.runId;

    await execution.dispatch(runId);
    await waitForTerminal(runId);

    expect(seen).toContainEqual(
      expect.objectContaining({ type: "native_tool_started", toolName: "ls", callId: "call-1" }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: "native_tool_completed",
        toolName: "ls",
        callId: "call-1",
        result: { empty: true },
      }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: "backend.oma.todo_update",
        payload: expect.objectContaining({
          items: [
            { id: "0", text: "step 1", status: "done" },
            { id: "1", text: "step 2", status: "pending" },
          ],
        }),
      }),
    );
    // ACP keeps the canonical tool pair AND the final text (ADR 0017); the
    // transient todo strip never survives into the ledger.
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(3);
    const revision = parseMessageRevision(messages[2]!.content);
    expect(revision.text).toContain("done");
    expect(JSON.stringify(ledger)).not.toContain("todo_update");
  });

  test("replay of the same dispatch must NOT call the Backend again", async () => {
    const fake = createFakeAcpDaemon({ dataDir });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "ikey-replay", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    await waitForTerminal(runId);
    expect(fake.executeCalls).toHaveLength(1);
    // replay of the same dispatch is idempotent
    await execution.dispatch(runId);
    expect(fake.executeCalls).toHaveLength(1);
    const ledgerAfter = convPort
      .getLedgerEntries(conversationId)
      .filter((e) => e.kind === "message");
    expect(ledgerAfter).toHaveLength(1);
  }, 15_000);
});

describe("approval late clicks (deadline already denied the child)", () => {
  test("a rejected child answer consumes the row as timeout, 409s, and never fakes success", async () => {
    const fake = createFakeAcpDaemon({ dataDir, outcomeDelayMs: 10_000 });
    // The backend-side truth after a deadline: the settled ACP session has
    // no held permission anymore, so the late click is a conflict.
    const rejecting = Object.create(fake.backend) as typeof fake.backend;
    rejecting.resolveApproval = async () => {
      throw new AcpBackendError("conflict", "no pending ACP permission c-late on the settled run");
    };
    const execution = makeExecution({ ...fake, backend: rejecting });

    const acquired = await enqueue("normal", "ikey-late", "hello");
    const runId = acquired.run!.runId;
    const dispatched = execution.dispatch(runId);
    await Bun.sleep(500); // acceptance handshake + live-loop registration

    const actionId = `${runId}:c-late`;
    await runPort.createPendingAction(runId, {
      actionId,
      kind: "approval",
      payload: { callId: "c-late" },
    });
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // First late click: 409-shaped rejection, row consumed as timeout.
    await expect(execution.resolveApproval(runId, "c-late", "allow")).rejects.toThrow(
      ApprovalNotApplicableError,
    );
    const action = await runPort.getPendingAction(actionId);
    expect(action?.status).toBe("resolved");
    expect(action?.response).toEqual({ timeout: true });
    // No sibling pending: the timeout consume woke the run.
    expect((await runPort.getRun(runId))?.status).toBe("running");

    // A SECOND late click must not turn into a replay success either.
    await expect(execution.resolveApproval(runId, "c-late", "allow")).rejects.toThrow(
      ApprovalNotApplicableError,
    );

    await execution.dispose();
    await dispatched.catch(() => {});
  }, 20_000);
});
