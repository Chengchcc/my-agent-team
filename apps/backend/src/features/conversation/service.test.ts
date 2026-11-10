import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import type { AgentRunService } from "../agent-run/service.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { createConversationService } from "./service.js";

const db = openDb(":memory:");
const port = sqliteConversationAdapter(db);

const contextPort = sqliteAgentContextAdapter(db, {
  ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
});
const ledgerResolver = {
  async resolveMessage(conversationId: string, ledgerSeq: number) {
    const hit = port.getLedgerEntry(conversationId, ledgerSeq);
    return hit?.kind === "message" ? (hit.content as never) : null;
  },
};
const contextSvc = createAgentContextService({
  port: contextPort,
  idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
  ledgerResolver,
});

// Fake AgentRunService: records enqueues, controllable acquire/active state.
const enqueueCalls: Array<{
  conversationId: string;
  agentId: string;
  mode: string;
  defaultModel: unknown;
  idempotencyKey: string;
  message: { text?: string };
}> = [];
const dispatchCalls: string[] = [];
let nextAcquired = true;
let activeRunId: string | null = null;
let runIdCounter = 0;
let knownRunConvId = "cid-1";
interface FakeQueuedInput {
  inputId: string;
  branchId: string;
  mode: string;
  text: string;
  status: "pending" | "delivered" | "cancelled";
  agentId: string;
  createdAt: number;
}
const fakeInputs = new Map<string, FakeQueuedInput>();

function makeRunService(): AgentRunService {
  return {
    async listPendingActions() {
      return [];
    },
    async enqueueAndAcquire(input) {
      enqueueCalls.push({
        conversationId: input.conversationId,
        agentId: input.agentId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        defaultModel: input.defaultModel,
        message: input.message as { text?: string },
      });
      const runId = `run-${runIdCounter++}`;
      const inputId = `in-${runId}`;
      if (!nextAcquired) {
        fakeInputs.set(inputId, {
          inputId,
          branchId: "b",
          mode: input.mode,
          text: (input.message as { text?: string }).text ?? "",
          status: "pending",
          agentId: input.agentId,
          createdAt: Date.now(),
        });
      }
      return {
        acquired: nextAcquired,
        queued: !nextAcquired,
        replayed: false,
        run: nextAcquired
          ? ({
              runId,
              branchId: "b",
              conversationId: input.conversationId,
              agentId: input.agentId,
              modelRef: { backendKind: "oma", modelId: "m" },
              status: "running",
              idempotencyKey: input.idempotencyKey,
              terminalResult: null,
              configRevision: 1,
              productTools: null,
              createdAt: Date.now(),
              terminalAt: null,
            } as never)
          : undefined,
        inputId,
      };
    },
    async markInputAccepted(inputId) {
      return { inputId } as never;
    },
    async createPendingAction(runId, action) {
      return { runId, actionId: "a", ...action } as never;
    },
    async consumePendingAction(actionId) {
      return { action: { actionId } as never, runId: "r" };
    },
    async finalizeRun(runId) {
      return { runId } as never;
    },
    async getRun(runId) {
      if (runId === "run-known") {
        return { runId, conversationId: knownRunConvId, branchId: "b" } as never;
      }
      if (runId === "run-other") {
        return { runId, conversationId: "cid-other", branchId: "b" } as never;
      }
      return null;
    },
    async getActiveRun() {
      return activeRunId ? ({ runId: activeRunId, branchId: "b" } as never) : null;
    },
    async listInputs() {
      return [];
    },
    async getInput(inputId) {
      const i = fakeInputs.get(inputId);
      if (!i) return null;
      return {
        inputId: i.inputId,
        branchId: i.branchId,
        mode: i.mode,
        message: { role: "user", text: i.text },
        status: i.status,
        agentId: i.agentId,
      } as never;
    },
    async listInputsForConversation(conversationId: string) {
      return this.listPendingInputsForConversation(conversationId);
    },
    async listPendingInputsForConversation(_conversationId: string) {
      return [...fakeInputs.values()]
        .filter((i) => i.status === "pending")
        .map(
          (i) =>
            ({
              inputId: i.inputId,
              branchId: i.branchId,
              mode: i.mode,
              message: { role: "user", text: i.text },
              status: i.status,
              agentId: i.agentId,
            }) as never,
        );
    },
    async updateInput(inputId, message) {
      const i = fakeInputs.get(inputId);
      if (i?.status !== "pending") return false;
      i.text = (message as { text: string }).text;
      return true;
    },
    async cancelInput(inputId) {
      const i = fakeInputs.get(inputId);
      if (i && i.status === "pending") i.status = "cancelled";
    },
    async hasActiveRunForConversations() {
      return false;
    },
    async listActiveRunsForConversations() {
      return [];
    },
  };
}

const runSvc = makeRunService();
const injectSteerCalls: Array<{
  branchId: string;
  inputId: string;
  opts?: { keepIfIdle?: boolean };
}> = [];
const abortStaleCalls: string[] = [];
/** Every continuity record the service announced, in order. */
const continuityAnnouncements: Array<{ conversationId: string; controlSeq: number }> = [];
/** Every conversation whose undo was announced to the surface layer, in order. */
const undoAnnouncements: string[] = [];
/** RunIds considered "live" (in-process child). DB-active alone is not live. */
let liveRunIds = new Set<string>();
/** RunIds with a dispatch in flight (pre-acceptance) on this process. */
let inflightRunIds = new Set<string>();
const svc = createConversationService({
  port,
  agentRunService: runSvc,
  dispatchRun: async (runId) => {
    dispatchCalls.push(runId);
  },
  injectSteer: async (branchId, input, opts) => {
    injectSteerCalls.push({ branchId, inputId: input.inputId, opts });
  },
  isLive: (runId) => liveRunIds.has(runId),
  isInflight: (runId) => inflightRunIds.has(runId),
  abortStaleRun: async (runId) => {
    abortStaleCalls.push(runId);
  },
  contextService: contextSvc,
  onContinuityRecorded: (input) => continuityAnnouncements.push(input),
  onMessagesUndone: (input) => {
    undoAnnouncements.push(input.conversationId);
  },
  resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "fake/echo" }),
  idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      agentId: "a-1",
      createdAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  return { agentId: "a-1" };
}

function messages(id: string) {
  return port.getLedgerEntries(id).filter((e) => e.kind === "message");
}

describe("conversation service (Agent Run cutover)", () => {
  test("human message is canonical History FIRST, then an acquired run is dispatched", async () => {
    const id = "cid-a";
    const { agentId } = setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "hello agent" });

    expect(result.seq).toBeGreaterThan(0);
    expect(messages(id)).toHaveLength(1);
    expect(result.triggeredRuns).toMatchObject([{ agentId, runId: "run-0", queued: false }]);
    // The run's originating input is part of the DTO now: the surface uses it
    // to hand a waiting message's card over to the run that finally runs it.
    expect(result.triggeredRuns[0]!.inputId).toBeTruthy();
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      conversationId: id,
      agentId,
      mode: "normal",
      idempotencyKey: `${id}:${result.seq}:${agentId}`,
    });
    expect(dispatchCalls).toEqual(["run-0"]);
  });

  test("explicit addressedTo without the conversation's agent does not trigger", async () => {
    const id = "cid-b";
    setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({ conversationId: id, addressedTo: [], content: "hello" });
    expect(enqueueCalls).toHaveLength(0);

    await svc.postMessage({
      conversationId: id,
      addressedTo: ["someone-else"],
      content: "hello",
    });
    expect(enqueueCalls).toHaveLength(0);
  });

  test("busy branch with LIVE child -> queued as the next turn, no injection", async () => {
    const id = "cid-c";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    liveRunIds = new Set(["run-active"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "steer me" });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("normal");
    expect(result.triggeredRuns).toMatchObject([{ agentId, runId: "", queued: true }]);
    // The input handle travels with it: a message that has to WAIT gets its own
    // card (queued state), and cancelling that card cancels THIS input.
    expect(result.triggeredRuns[0]!.inputId).toBeTruthy();
    // The ACP rail has no mid-turn injection: the message queues as the NEXT
    // turn's input; no new run is dispatched while one is live, and the
    // injection path stays untouched.
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(0);
  });

  test("postMessage modelOverride: same-kind honored, foreign-kind ignored", async () => {
    const id = "cid-mo";
    setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({
      conversationId: id,
      content: "use my model",
      modelOverride: {
        backendKind: "oma",
        modelId: "fake/other",
        harnessModel: "fake/echo2",
        reasoningEffort: "low",
      },
    });
    expect(enqueueCalls[0]!.defaultModel).toEqual({
      backendKind: "oma",
      modelId: "fake/other",
      harnessModel: "fake/echo2",
      reasoningEffort: "low",
    });

    enqueueCalls.length = 0;
    await svc.postMessage({
      conversationId: id,
      content: "foreign kind",
      modelOverride: { backendKind: "claude_code", modelId: "claude-x" },
    });
    expect(enqueueCalls[0]!.defaultModel).toEqual({ backendKind: "oma", modelId: "fake/echo" });
  });

  test("zombie active run (DB active, no live child) -> abortStaleRun + fresh NORMAL run", async () => {
    const id = "cid-z";
    setupConv(id);
    nextAcquired = true;
    activeRunId = "run-zombie";
    liveRunIds = new Set(); // DB-active but NOT live: a zombie
    inflightRunIds = new Set();
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "hello again" });

    // The zombie is terminalized first, then the message becomes a NEW
    // normal Run - never silently dropped as a steer.
    expect(abortStaleCalls).toEqual(["run-zombie"]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("normal");
    expect(dispatchCalls).toHaveLength(1);
    expect(injectSteerCalls).toHaveLength(0);
    expect(result.triggeredRuns[0]!.queued).toBe(false);
  });

  test("inflight run (pre-acceptance dispatch) is queued as follow_up, never aborted", async () => {
    const id = "cid-i";
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-inflight";
    liveRunIds = new Set(); // no live child YET (pre-acceptance window)
    inflightRunIds = new Set(["run-inflight"]); // dispatch is in flight
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "wait for it" });

    // The in-flight run is owned: queue the message as follow-up instead of
    // aborting it and racing a second child.
    expect(abortStaleCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("follow_up");
    expect(injectSteerCalls).toHaveLength(0);
    expect(result.triggeredRuns[0]!.queued).toBe(true);
  });

  test("explicit follow_up mode is honored even when idle", async () => {
    const id = "cid-d";
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    enqueueCalls.length = 0;

    await svc.postMessage({ conversationId: id, content: "later", mode: "follow_up" });
    expect(enqueueCalls[0]!.mode).toBe("follow_up");
  });

  test("startNewConversationForSurface verifies the run owns the conversation", async () => {
    const id = "cid-s1";
    setupConv(id);
    await expect(
      svc.startNewConversationForSurface({
        oldConversationId: id,
        reason: "test",
        requestedByRunId: "run-missing",
      }),
    ).rejects.toThrow("run not found");
    await expect(
      svc.startNewConversationForSurface({
        oldConversationId: id,
        reason: "test",
        requestedByRunId: "run-other",
      }),
    ).rejects.toThrow("does not belong");
  });

  test("startNewConversationForSurface creates the new conversation and control entry", async () => {
    const id = "cid-j";
    knownRunConvId = id;
    setupConv(id);
    const result = await svc.startNewConversationForSurface({
      oldConversationId: id,
      reason: "fresh",
      title: "New chat",
      requestedByRunId: "run-known",
    });
    expect(result.newConversationId).toBeTruthy();
    const control = port.getLedgerEntries(id).find((e) => e.kind === "surface.control");
    expect(control).toBeTruthy();
    // 幂等按规范的 Run 坐标判定：同一个 Run 再问一次，返回同一条新对话、同一条控制记录。
    const again = await svc.startNewConversationForSurface({
      oldConversationId: id,
      reason: "fresh",
      requestedByRunId: "run-known",
    });
    expect(again.newConversationId).toBe(result.newConversationId);
    expect(again.controlSeq).toBe(result.controlSeq);
    // The record is announced both when it is written and when a retry finds it: a surface may
    // have connected in between, and announcing it again is idempotent on the surface's side.
    expect(continuityAnnouncements).toEqual([
      { conversationId: id, controlSeq: result.controlSeq },
      { conversationId: id, controlSeq: result.controlSeq },
    ]);
    expect(port.getLedgerEntries(id).filter((e) => e.kind === "surface.control")).toHaveLength(1);
    // 1:1: the new conversation keeps the same agent binding.
    expect(port.getConversation(result.newConversationId)!.agentId).toBe("a-1");
    expect(port.getConversation(result.newConversationId)!.title).toBe("New chat");
  });

  test("clear stays a no-op; compact refuses while no summarizer is wired", async () => {
    const id = "cid-k";
    setupConv(id);
    await svc.clearConversation(id);
    expect(port.getConversation(id)).toBeTruthy();
    // A silent no-op used to stand here, so a caller believed the context had
    // been compacted. Until the summarizer lands, say so instead.
    await expect(svc.compactConversation(id)).rejects.toThrow(/not configured/);
  });

  test("fork copies the agent binding and history up to fromSeq", async () => {
    const id = "cid-l";
    setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    const { seq } = await svc.postMessage({ conversationId: id, content: "hello" });
    const forked = await svc.forkConversation({ conversationId: id, fromSeq: seq });
    expect(forked.newConversationId).toBeTruthy();
    const copied = port.getLedgerEntries(forked.newConversationId);
    expect(copied.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(port.getConversation(forked.newConversationId)!.agentId).toBe("a-1");
  });

  test("undo soft-deletes the latest message and broadcasts an undo entry", async () => {
    const id = "cid-m";
    setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    await svc.postMessage({ conversationId: id, content: "to undo" });
    undoAnnouncements.length = 0;
    const result = await svc.undoMessages({ conversationId: id, count: 1 });
    expect(result.undoneSeqs).toHaveLength(1);
    expect(port.getLedgerEntries(id).some((e) => e.kind === "undo")).toBe(true);
    // Nothing in the projection stream states a removal, so the surface layer is told (#57).
    expect(undoAnnouncements).toEqual([id]);
  });

  test("an undo with nothing to remove announces nothing", async () => {
    const id = "cid-undo-empty";
    setupConv(id);
    undoAnnouncements.length = 0;
    const result = await svc.undoMessages({ conversationId: id, count: 1 });
    expect(result.undoneSeqs).toHaveLength(0);
    expect(undoAnnouncements).toEqual([]);
  });

  // ─── Pending input queue (Composer queue area) ───

  test("explicit follow_up while LIVE child -> queued, NO steer injection (queue semantics)", async () => {
    const id = "cid-q1";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    const result = await svc.postMessage({
      conversationId: id,
      content: "queue me",
      mode: "follow_up",
    });

    expect(enqueueCalls[0]!.mode).toBe("follow_up");
    expect(result.triggeredRuns).toMatchObject([{ agentId, runId: "", queued: true }]);
    // The input handle travels with it: a message that has to WAIT gets its own
    // card (queued state), and cancelling that card cancels THIS input.
    expect(result.triggeredRuns[0]!.inputId).toBeTruthy();
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(0);
    expect(fakeInputs.size).toBe(1);
  });

  test("listPendingInputs returns queued inputs; steerInput injects one", async () => {
    const id = "cid-q2";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    await svc.postMessage({ conversationId: id, content: "first", mode: "follow_up" });
    await svc.postMessage({ conversationId: id, content: "second", mode: "follow_up" });

    const pending = await svc.listPendingInputs(id);
    expect(pending.map((p) => p.text)).toEqual(["first", "second"]);
    expect(pending[0]!.agentId).toBe(agentId);

    const inputId = pending[0]!.inputId;
    await svc.steerInput(inputId);
    expect(injectSteerCalls).toHaveLength(1);
    expect(injectSteerCalls[0]!.inputId).toBe(inputId);

    // #64: the queue-card flow steers with keepIfIdle — if the turn already
    // ended, the input stays queued for the next turn instead of dying.
    await svc.steerInput(pending[1]!.inputId, { keepIfIdle: true });
    expect(injectSteerCalls[1]!.opts).toEqual({ keepIfIdle: true });
  });

  test("updateInput edits pending text; cancelInput removes it from the queue", async () => {
    const id = "cid-q3";
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    fakeInputs.clear();

    await svc.postMessage({ conversationId: id, content: "original", mode: "follow_up" });
    const inputId = (await svc.listPendingInputs(id))[0]!.inputId;

    expect(await svc.updateInput(inputId, "edited")).toBe(true);
    expect((await svc.listPendingInputs(id))[0]!.text).toBe("edited");

    await svc.cancelInput(inputId);
    expect(await svc.listPendingInputs(id)).toHaveLength(0);

    // edit after cancel is rejected (CAS pending-only)
    expect(await svc.updateInput(inputId, "too late")).toBe(false);
  });
});

describe("free-text ask interception", () => {
  function makeLocal(
    answerPendingTextAsk: (conversationId: string, text: string) => Promise<boolean>,
  ) {
    return createConversationService({
      port,
      agentRunService: runSvc,
      dispatchRun: async (runId) => {
        dispatchCalls.push(runId);
      },
      injectSteer: async () => {},
      isLive: () => false,
      isInflight: () => false,
      abortStaleRun: async () => {},
      contextService: contextSvc,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "fake/echo" }),
      idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
      answerPendingTextAsk,
    });
  }

  test("a reply answers a pending text ask instead of triggering a run", async () => {
    setupConv("conv-ask");
    const answered: Array<{ conversationId: string; text: string }> = [];
    const local = makeLocal(async (conversationId, text) => {
      answered.push({ conversationId, text });
      return true;
    });
    const res = await local.postMessage({
      conversationId: "conv-ask",
      content: "use the blue folder",
      mode: "normal",
    });
    expect(res.triggeredRuns).toEqual([]);
    expect(answered).toEqual([{ conversationId: "conv-ask", text: "use the blue folder" }]);
    // The reply is still ledgered — context for later turns.
    expect(messages("conv-ask").length).toBe(1);
  });

  test("nothing pending → the reply triggers normally", async () => {
    setupConv("conv-noask");
    const local = makeLocal(async () => false);
    const res = await local.postMessage({
      conversationId: "conv-noask",
      content: "hello",
      mode: "normal",
    });
    expect(res.triggeredRuns.length).toBe(1);
  });
});

describe("conversation compaction", () => {
  interface Seeded {
    branchId: string;
    revision: number;
    parentId: string | null;
    seq: number;
  }

  /** Append `count` ledger_message entries, continuing from `from` when given. */
  async function seed(id: string, count: number, from?: Seeded): Promise<Seeded> {
    const branch = await contextSvc.getOrCreateDefaultBranch(id, "oma", "a-1");
    // Compaction appends a summary between passes, so the revision and the tip
    // must be read fresh rather than carried from the previous seed.
    const existing = await contextSvc.listEntriesToLeaf(branch.branchId);
    const tip = existing[existing.length - 1];
    let state: Seeded = {
      branchId: branch.branchId,
      revision: branch.revision,
      parentId: from ? (tip?.entryId ?? null) : null,
      seq: from?.seq ?? 0,
    };
    for (let i = 0; i < count; i++) {
      state = { ...state, seq: state.seq + 1 };
      const appended = await contextPort.appendEntry({
        branchId: state.branchId,
        expectedRevision: state.revision,
        type: "ledger_message",
        parentId: state.parentId,
        payload: {},
        ledgerSeq: state.seq,
      });
      state = { ...state, revision: state.revision + 1, parentId: appended.entryId };
    }
    return state;
  }

  function makeCompactable(
    summarize: (input: { texts: readonly string[] }) => Promise<string>,
    resolveLedgerMessage?: (conversationId: string, ledgerSeq: number) => Promise<Message | null>,
  ) {
    return createConversationService({
      port,
      agentRunService: runSvc,
      dispatchRun: async () => {},
      injectSteer: async () => {},
      isLive: () => false,
      isInflight: () => false,
      abortStaleRun: async () => {},
      contextService: contextSvc,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "fake/echo" }),
      idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
      summarize,
      // The projection's own resolver, faked: text per ledger seq, unless the
      // test injects its own (needed to exercise tool blocks).
      resolveLedgerMessage:
        resolveLedgerMessage ??
        (async (_conversationId, ledgerSeq) => ({
          role: "user",
          text: `m-${ledgerSeq}`,
        })),
    });
  }

  test("folds everything older than the kept tail into one summary", async () => {
    const id = "cid-compact";
    setupConv(id);
    const branch = await seed(id, 25);
    const seen: string[][] = [];
    const local = makeCompactable(async ({ texts }) => {
      seen.push([...texts]);
      return "SUMMARY";
    });

    await local.compactConversation(id);

    // 25 messages, the newest 20 stay verbatim => 5 are folded in.
    expect(seen).toEqual([["m-1", "m-2", "m-3", "m-4", "m-5"]]);
    const entries = await contextSvc.listEntriesToLeaf(branch.branchId);
    const summary = entries.find((e) => e.type === "summary");
    expect(summary?.summary).toBe("SUMMARY");
    // Coverage points at the last folded message: exactly the kept tail follows.
    expect(entries.findIndex((e) => e.entryId === summary?.coversThroughEntryId)).toBe(4);
    expect(entries.filter((e) => e.type === "ledger_message")).toHaveLength(25);
  });

  test("a second pass folds the previous summary in and only covers new ground", async () => {
    const id = "cid-compact-2";
    setupConv(id);
    const seeded = await seed(id, 45);
    const seen: string[][] = [];
    const local = makeCompactable(async ({ texts }) => {
      seen.push([...texts]);
      return `SUMMARY-${seen.length}`;
    });

    await local.compactConversation(id);
    // New turns land; the previously replaced region must not be re-summarised.
    await seed(id, 5, seeded);
    await local.compactConversation(id);

    expect(seen[0]).toHaveLength(25);
    // The 5 messages that age out of the kept tail are the only new ground.
    expect(seen[1]).toEqual(["SUMMARY-1", "m-26", "m-27", "m-28", "m-29", "m-30"]);
  });

  test("a branch with nothing older than the tail makes no model call", async () => {
    const id = "cid-compact-3";
    setupConv(id);
    await seed(id, 5);
    let calls = 0;
    const local = makeCompactable(async () => {
      calls += 1;
      return "nope";
    });

    await local.compactConversation(id);

    expect(calls).toBe(0);
  });

  test("the summarizer sees tool calls and results, not just text", async () => {
    const id = "cid-compact-tools";
    setupConv(id);
    await seed(id, 25);
    const seen: string[] = [];
    const local = makeCompactable(
      async ({ texts }) => {
        seen.push(...texts);
        return "S";
      },
      async (_conversationId, ledgerSeq) =>
        ledgerSeq === 3
          ? {
              role: "assistant",
              blocks: [{ type: "tool_use", id: "c1", name: "read", input: { path: "src/a.ts" } }],
            }
          : { role: "user", text: `m-${ledgerSeq}` },
    );

    await local.compactConversation(id);

    // The covered region is m-1..m-5. Row 3 is a tool call with no text, so
    // without rendering blocks the summary would have no trace of what ran.
    const transcript = seen.join("\n");
    expect(transcript).toContain("[tool_use read]");
    expect(transcript).toContain("src/a.ts");
  });
});

describe("ambient rules on the observe seam (ADR 0046)", () => {
  type AmbientFn = NonNullable<Parameters<typeof createConversationService>[0]["evaluateAmbient"]>;

  function makeAmbient(evaluateAmbient: AmbientFn) {
    return createConversationService({
      port,
      agentRunService: runSvc,
      dispatchRun: async (runId) => {
        dispatchCalls.push(runId);
      },
      injectSteer: async () => {},
      isLive: () => false,
      isInflight: () => false,
      abortStaleRun: async () => {},
      contextService: contextSvc,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "fake/echo" }),
      idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
      evaluateAmbient,
    });
  }

  const ACT_RULE = {
    id: "deploy-alarm",
    chats: [] as string[],
    senders: [] as string[],
    keyword: "deploy",
    mode: "act" as const,
    instruction: "去查部署问题",
  };
  const OBSERVE_INPUT = {
    senderMemberId: "human:lark:ou_alice",
    addressedTo: [] as string[],
    source: { kind: "lark" as const, chatId: "oc_dev" },
  };

  test("an act match promotes the observation: framed ledger row + one run", async () => {
    const id = "cid-amb-act";
    setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    enqueueCalls.length = 0;
    const local = makeAmbient(async () => ({ rule: ACT_RULE, outcome: "triggered" }));

    const result = await local.postMessage({
      conversationId: id,
      ...OBSERVE_INPUT,
      content: "deploy is broken",
    });

    // The message became a task: one triggered run on the ordinary path.
    expect(result.triggeredRuns).toHaveLength(1);
    expect(result.triggeredRuns[0]!.queued).toBe(false);
    expect(enqueueCalls).toHaveLength(1);
    // The ledger row is the FRAMED task and quotes the original verbatim —
    // one row, not two (the observation was promoted, not duplicated).
    const rows = messages(id);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]!.content);
    expect(text).toContain("deploy-alarm");
    expect(text).toContain("去查部署问题");
    expect(text).toContain("deploy is broken");
  });

  test("a record match keeps the observation: no run, raw text in the ledger", async () => {
    const id = "cid-amb-rec";
    setupConv(id);
    enqueueCalls.length = 0;
    const local = makeAmbient(async () => ({
      rule: { ...ACT_RULE, mode: "record" as const, instruction: "" },
      outcome: "recorded",
    }));

    const result = await local.postMessage({
      conversationId: id,
      ...OBSERVE_INPUT,
      content: "deploy is broken",
    });

    expect(result.triggeredRuns).toEqual([]);
    expect(enqueueCalls).toHaveLength(0);
    expect(JSON.stringify(messages(id)[0]!.content)).toContain("deploy is broken");
  });

  test("no source, no evaluation: observe stays observe for web-style posts", async () => {
    const id = "cid-amb-nosrc";
    setupConv(id);
    enqueueCalls.length = 0;
    let called = 0;
    const local = makeAmbient(async () => {
      called++;
      return null;
    });

    await local.postMessage({ conversationId: id, addressedTo: [], content: "no source" });
    expect(called).toBe(0);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("an evaluator crash cannot take the human message down with it", async () => {
    const id = "cid-amb-err";
    setupConv(id);
    enqueueCalls.length = 0;
    const local = makeAmbient(async () => {
      throw new Error("rule table corrupted");
    });

    const result = await local.postMessage({
      conversationId: id,
      ...OBSERVE_INPUT,
      content: "deploy is broken",
    });

    // Failure degrades to plain observation: ledgered, unrouted, no throw.
    expect(result.triggeredRuns).toEqual([]);
    expect(messages(id)).toHaveLength(1);
  });

  test("the evaluator sees the sender label and the source chat", async () => {
    const id = "cid-amb-args";
    setupConv(id);
    const seen: string[] = [];
    const local = makeAmbient(async (input) => {
      seen.push(input.agentId, input.senderMemberId, input.source.chatId, input.text);
      return null;
    });
    await local.postMessage({
      conversationId: id,
      ...OBSERVE_INPUT,
      content: "deploy is broken",
    });
    expect(seen).toEqual(["a-1", "human:lark:ou_alice", "oc_dev", "deploy is broken"]);
  });
});
