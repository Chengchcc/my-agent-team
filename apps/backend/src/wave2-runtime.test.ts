import { describe, expect, test } from "bun:test";
import { sqliteAgentContextAdapter } from "./features/agent-context/adapter-sqlite.js";
import type { IdGenerator, LedgerMessageResolver } from "./features/agent-context/ports.js";
import { createAgentContextService } from "./features/agent-context/service.js";
import { sqliteAgentRunAdapter } from "./features/agent-run/adapter-sqlite.js";
import { beyondFrozenScope } from "./features/agent-run/answer-guard.js";
import {
  createBudgetGate,
  DAILY_BUDGET_SETTING_KEY,
  DailyBudgetExhaustedError,
} from "./features/agent-run/budget-gate.js";
import type { AgentRun } from "./features/agent-run/domain.js";
import { createNotifyDispatcher } from "./features/agent-run/notify-dispatcher.js";
import { createAgentRunService } from "./features/agent-run/service.js";
import { sqliteConversationAdapter } from "./features/conversation/adapter-sqlite.js";
import { createConversationService } from "./features/conversation/service.js";
import { sqliteProductToolCallAdapter } from "./features/product-tools/adapter-sqlite.js";
import { createProductToolsService } from "./features/product-tools/service.js";
import { sqliteProposalAdapter } from "./features/proposal/adapter-sqlite.js";
import { createProposalService } from "./features/proposal/service.js";
import { sqliteReminderAdapter } from "./features/reminder/adapter-sqlite.js";
import { createReminderService } from "./features/reminder/service.js";
import { sqliteRequirementAdapter } from "./features/requirement/adapter-sqlite.js";
import { openDb } from "./infra/sqlite/db.js";

describe("Wave 2 runtime & concurrency regressions", () => {
  test("A1/P1-8/P1-9: notifyDispatcher routes to parent.conversationId, isolates report vs terminal keys, and only marks notified on terminal", async () => {
    const parentRun = {
      runId: "parent-1",
      branchId: "b-parent",
      conversationId: "conv-parent",
      agentId: "pa",
      modelRef: { backendKind: "acp", modelId: "acp/oma" },
      configRevision: 1,
      parentRunId: null,
    } as unknown as AgentRun;
    const childRun = {
      runId: "child-1",
      branchId: "b-child",
      conversationId: "conv-child",
      agentId: "worker-1",
      modelRef: { backendKind: "acp", modelId: "acp/oma" },
      configRevision: 1,
      parentRunId: "parent-1",
    } as unknown as AgentRun;

    const posted: Array<{ conversationId: string; content: string }> = [];
    const steeredKeys: string[] = [];
    const notified: string[] = [];

    const notify = createNotifyDispatcher({
      getRun: async (id) => (id === "parent-1" ? parentRun : id === "child-1" ? childRun : null),
      getFrontDeskAgent: async () => "pa",
      getActiveRun: async () => ({ runId: "parent-1" }),
      enqueueSteer: async (input) => {
        steeredKeys.push(input.idempotencyKey);
        if (input.idempotencyKey.startsWith("report:")) {
          throw new Error("simulated steer conflict");
        }
        return { inputId: "in-1", queued: true, acquired: false };
      },
      injectSteer: async () => {},
      postMessage: async (input) => {
        posted.push({ conversationId: input.conversationId, content: input.content });
      },
      markNotified: async (runId) => {
        notified.push(runId);
      },
    });

    // Mid-run report: steer throws -> falls back to postMessage into conv-parent, does NOT markNotified
    const r1 = await notify({
      fromAgentId: "worker-1",
      conversationId: "conv-child",
      runId: "child-1",
      terminal: false,
      idempotencyKey: "report:child-1:c1",
      text: "working on step 1",
      wake: true,
    });
    expect(r1.delivered).toBe("queued");
    expect(posted).toEqual([{ conversationId: "conv-parent", content: "working on step 1" }]);
    expect(notified).toEqual([]);

    // Terminal notice: uses terminal key and marks notified
    const r2 = await notify({
      fromAgentId: "worker-1",
      conversationId: "conv-child",
      runId: "child-1",
      terminal: true,
      text: "done",
      wake: true,
    });
    expect(r2.delivered).toBe("steer");
    expect(steeredKeys).toEqual(["report:child-1:c1", "terminal:child-1"]);
    expect(notified).toEqual(["child-1"]);
  });

  test("A2: budgetGate prices ACP runs via bare harnessModel key", async () => {
    const db = openDb(":memory:");
    try {
      const now = Date.now();
      db.query(
        "INSERT INTO conversation (conversation_id, agent_id, created_at) VALUES ('c1', 'pa', ?)",
      ).run(now);
      db.query(
        "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_id, created_at) VALUES ('t1', 'c1', 'pa', ?)",
      ).run(now);
      db.query(
        "INSERT INTO agent_context_branch (branch_id, tree_id, backend_kind, ledger_cursor, revision, created_at) VALUES ('b1', 't1', 'acp', 0, 1, ?)",
      ).run(now);
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES ('r1', 'b1', 'c1', 'pa', ?, 'completed', 'k1', 1, ?, ?, ?)`,
      ).run(
        JSON.stringify({
          backendKind: "acp",
          modelId: "acp/oma",
          harnessModel: "anthropic/claude-sonnet-4",
        }),
        JSON.stringify({
          status: "completed",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
        now,
        now,
      );

      const gate = createBudgetGate({
        db,
        modelCosts: Promise.resolve(
          new Map([
            [
              "anthropic/claude-sonnet-4",
              { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            ],
          ]),
        ),
        getSetting: (k) => (k === DAILY_BUDGET_SETTING_KEY ? 2.5 : undefined),
      });
      const status = await gate.dailyStatus();
      expect(status.spentUsd).toBeCloseTo(3, 5);
      await expect(gate.assertWithinDailyBudget()).rejects.toBeInstanceOf(
        DailyBudgetExhaustedError,
      );
    } finally {
      db.close();
    }
  });

  test("P1-10: queued user message arriving during Run 1 is preserved in agent_context_entry on Run 2 promote", async () => {
    const db = openDb(":memory:");
    try {
      const conv = sqliteConversationAdapter(db);
      const ctxPort = sqliteAgentContextAdapter(db);
      const idGen: IdGenerator = {
        ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26),
      };
      const ledgerResolver: LedgerMessageResolver = {
        async resolveMessage(conversationId, seq) {
          const entry = conv.getLedgerEntry(conversationId, seq);
          return entry ? (entry.content as never) : null;
        },
      };
      const ctxSvc = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });
      const runPort = sqliteAgentRunAdapter(db, { contextPort: ctxPort, ledgerResolver, idGen });
      const runSvc = createAgentRunService({
        port: runPort,
        contextService: ctxSvc,
        idGen,
        ledgerResolver,
      });

      conv.createConversation({ conversationId: "c1", agentId: "pa", createdAt: Date.now() });
      const m1 = conv.appendLedgerEntry({
        conversationId: "c1",
        kind: "message",
        content: JSON.stringify({ role: "user", text: "msg-1" }),
        ts: Date.now(),
      });
      const r1 = await runSvc.enqueueAndAcquire({
        conversationId: "c1",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "msg-1" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k1",
      });
      expect(r1.acquired).toBe(true);

      // M2 arrives while Run 1 is active
      const m2 = conv.appendLedgerEntry({
        conversationId: "c1",
        kind: "message",
        content: JSON.stringify({ role: "user", text: "msg-2" }),
        ts: Date.now(),
      });
      const r2 = await runSvc.enqueueAndAcquire({
        conversationId: "c1",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "msg-2" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k2",
      });
      expect(r2.queued).toBe(true);

      // Run 1 commits A1 (seq 3)
      await runPort.commitCompletedRun({
        runId: r1.run!.runId,
        outcome: { status: "completed", messages: [{ role: "assistant", text: "ans-1" }] },
        messages: [{ role: "assistant", text: "ans-1" }],
      });

      // Run 2 promotes M2 via acquireNextRun -> M2 MUST be referenced in agent_context_entry
      const promoted = await runPort.acquireNextRun(r1.run!.branchId);
      expect(promoted).not.toBeNull();
      const entries = await ctxSvc.listEntriesToLeaf(r1.run!.branchId);
      const seqs = entries
        .filter((e) => e.type === "ledger_message")
        .map((e) => (e as { ledgerSeq: number }).ledgerSeq);
      expect(seqs).toContain(m1);
      expect(seqs).toContain(m2);
    } finally {
      db.close();
    }
  });

  test("P1-12/P2-4: durable pendingTextAskForConversation survives restart & beyondFrozenScope enforces deny + resolve", async () => {
    const db = openDb(":memory:");
    try {
      const conv = sqliteConversationAdapter(db);
      const ctxPort = sqliteAgentContextAdapter(db);
      const idGen: IdGenerator = {
        ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26),
      };
      const ledgerResolver: LedgerMessageResolver = {
        async resolveMessage() {
          return null;
        },
      };
      const ctxSvc = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });
      const runPort = sqliteAgentRunAdapter(db, { contextPort: ctxPort, ledgerResolver, idGen });
      const runSvc = createAgentRunService({
        port: runPort,
        contextService: ctxSvc,
        idGen,
        ledgerResolver,
      });

      conv.createConversation({ conversationId: "c-hitl", agentId: "pa", createdAt: Date.now() });
      const acq = await runSvc.enqueueAndAcquire({
        conversationId: "c-hitl",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "go" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k-hitl",
      });
      await runPort.createPendingAction(acq.run!.runId, {
        actionId: `${acq.run!.runId}:call-1`,
        kind: "ask",
        payload: {
          callId: "call-1",
          questions: [{ id: "q1", kind: "text", question: "Which branch?" }],
        },
      });

      // Brand-new ProductToolsService instance (simulates process restart with empty in-memory pendingAsks)
      const pt = createProductToolsService({
        runPort,
        contextPort: ctxPort,
        conversationPort: conv,
        callPort: sqliteProductToolCallAdapter(db),
        idGen,
        artifactService: {} as never,
      });
      const pending = await pt.pendingTextAskForConversation("c-hitl");
      expect(pending).toEqual({ runId: acq.run!.runId, callId: "call-1", questionId: "q1" });
      const resolved = await pt.resolveAskDurable(acq.run!.runId, "call-1", {
        answers: [{ id: "q1", selectedValues: [], freeText: "main" }],
      });
      expect(resolved).toBe(true);
      expect(await pt.pendingTextAskForConversation("c-hitl")).toBeNull();

      // P2-4: beyondFrozenScope checks deny + normalizes `..` via path.resolve
      const refusal = beyondFrozenScope(
        { input: { path: "/tmp/ws/../etc/passwd" } },
        { toolPolicy: { deny: ["/tmp/etc/"], allow: ["/tmp/ws/"] } },
      );
      expect(refusal).toContain("denied");
    } finally {
      db.close();
    }
  });

  test("P1-13/P1-17/P2-5: undoMessages rejects count<=0; proposal pendingById works >200; reminder fireDue is single-flight; requirement requestsOf joins cleanly", async () => {
    const db = openDb(":memory:");
    try {
      const conv = sqliteConversationAdapter(db);
      const ctxPort = sqliteAgentContextAdapter(db);
      const idGen: IdGenerator = {
        ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26),
      };
      const ledgerResolver: LedgerMessageResolver = {
        async resolveMessage() {
          return null;
        },
      };
      const ctxSvc = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });
      const runPort = sqliteAgentRunAdapter(db, { contextPort: ctxPort, ledgerResolver, idGen });
      const runSvc = createAgentRunService({
        port: runPort,
        contextService: ctxSvc,
        idGen,
        ledgerResolver,
      });
      const convSvc = createConversationService({
        port: conv,
        agentRunService: runSvc,
        contextService: ctxSvc,
        dispatchRun: async () => {},
        injectSteer: async () => {},
        isLive: () => false,
        isInflight: () => false,
        abortStaleRun: async () => {},
        resolveDefaultModel: async () => ({ backendKind: "acp", modelId: "acp/oma" }),
        idGen: () => idGen.ulid(),
      });
      conv.createConversation({ conversationId: "c-undo", agentId: "pa", createdAt: Date.now() });
      await expect(convSvc.undoMessages({ conversationId: "c-undo", count: 0 })).rejects.toThrow(
        /positive integer/,
      );
      await expect(convSvc.undoMessages({ conversationId: "c-undo", count: -2 })).rejects.toThrow(
        /positive integer/,
      );

      // P1-17: proposal pendingById finds oldest proposal even when >200 pending exist
      const propSvc = createProposalService({
        port: sqliteProposalAdapter(db),
        idGen: () => idGen.ulid(),
      });
      const first = propSvc.propose("agent_config", "a1", { name: "old" });
      for (let i = 0; i < 205; i++) {
        propSvc.propose("agent_config", `a-${i}`, { name: `p-${i}` });
      }
      expect(propSvc.pendingById(first.id)?.id).toBe(first.id);

      // P2-5: reminder fireDue single-flight prevents overlapping duplicate deliveries
      const remPort = sqliteReminderAdapter(db);
      let deliveredCount = 0;
      const remSvc = createReminderService({
        port: remPort,
        idGen: () => idGen.ulid(),
        now: () => 1_000_000,
        deliver: async () => {
          deliveredCount++;
          await new Promise((r) => setTimeout(r, 30));
        },
      });
      remPort.create({
        id: "rem-1",
        conversationId: "c-undo",
        createdBy: "pa",
        text: "ping",
        fireAt: 999_000,
        createdAt: 998_000,
      });
      const [c1, c2] = await Promise.all([remSvc.fireDue(), remSvc.fireDue()]);
      expect(c1 + c2).toBe(1);
      expect(deliveredCount).toBe(1);

      // P1-17: requirement requestsOf single-JOIN query
      const reqPort = sqliteRequirementAdapter(db);
      const req = reqPort.create({
        requirementId: "req-1",
        title: "T",
        goal: "G",
        background: null,
        constraints: null,
        expectedDeliverables: null,
        acceptanceCriteria: null,
        status: "open",
        projectId: null,
        originConversationId: "c-undo",
        originSeq: null,
        createdByAgentId: "pa",
        acceptedEvidence: null,
        acceptedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const run = await runSvc.enqueueAndAcquire({
        conversationId: "c-undo",
        agentId: "pa",
        backendKind: "acp",
        mode: "normal",
        message: { role: "user", text: "go" },
        defaultModel: { backendKind: "acp", modelId: "acp/oma" },
        configRevision: 1,
        idempotencyKey: "k-req",
      });
      runPort.setRequirementId!(run.run!.runId, req.requirementId);
      await runPort.createPendingAction(run.run!.runId, {
        actionId: `${run.run!.runId}:a1`,
        kind: "ask",
        payload: { question: "Approve?" },
      });
      const reqs = reqPort.requestsOf(req.requirementId);
      expect(reqs.length).toBe(1);
      expect(reqs[0]?.head).toBe("Approve?");
    } finally {
      db.close();
    }
  });
});
