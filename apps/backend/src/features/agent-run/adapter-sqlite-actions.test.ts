import { describe, expect, test } from "bun:test";
import { db, runPort, setupBranch } from "./adapter-sqlite.harness.js";
import { AgentRunConflictError, PendingActionAlreadyConsumedError } from "./domain.js";

describe("ADR 0075: a request records WHO should answer it", () => {
  const raise = async (suffix: string, authorization?: string) => {
    const { conversationId, agentId, branch } = await setupBranch(`pa-${suffix}`);
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: `t-${suffix}` },
      inputIdempotencyKey: `ikey-${suffix}`,
      runIdempotencyKey: `rkey-${suffix}`,
      deliveryIdempotencyKey: `dkey-${suffix}`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      ...(authorization ? { authorization } : {}),
    });
    return runPort.createPendingAction(res.run!.runId, {
      actionId: `action-${suffix}`,
      kind: "approval",
      payload: {},
    });
  };

  test("a human-run request belongs to the user", async () => {
    const action = await raise("owner-user");
    expect(action.owner).toBe("user");
  });

  test("a dispatched request belongs to its dispatcher", async () => {
    const action = await raise("owner-dispatch", "dispatch:pa-front");
    expect(action.owner).toBe("agent:pa-front");
  });
});

describe("ADR 0080: an irreversible dispatch is the person's to approve", () => {
  async function raisedWithRisk(suffix: string) {
    const { conversationId, agentId, branch } = await setupBranch(`pa-risk-${suffix}`);
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: `t-${suffix}` },
      inputIdempotencyKey: `ikey-${suffix}`,
      runIdempotencyKey: `rkey-${suffix}`,
      deliveryIdempotencyKey: `dkey-${suffix}`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      authorization: "dispatch:pa-front",
    });
    const runId = res.run!.runId;
    runPort.setRunRisk?.(runId, { irreversible: true });
    return runPort.createPendingAction(runId, {
      actionId: `action-risk-${suffix}`,
      kind: "approval",
      payload: { toolName: "bash" },
    });
  }

  test("the owner is the person, not the dispatcher", async () => {
    const action = await raisedWithRisk("owner");
    expect(action.owner).toBe("user");
  });

  test("the request carries the mark its answerer is judged by", async () => {
    const action = await raisedWithRisk("payload");
    expect((action.payload as { risk?: { irreversible?: boolean } }).risk?.irreversible).toBe(true);
  });

  test("a run without a mark keeps the dispatcher as owner", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa-risk-none");
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "t-none" },
      inputIdempotencyKey: "ikey-none",
      runIdempotencyKey: "rkey-none",
      deliveryIdempotencyKey: "dkey-none",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      authorization: "dispatch:pa-front",
    });
    const action = await runPort.createPendingAction(res.run!.runId, {
      actionId: "action-risk-none",
      kind: "approval",
      payload: {},
    });
    expect(action.owner).toBe("agent:pa-front");
  });
});

describe("a failed machine route hands the question to the person", () => {
  test("escalation flips the owner to user and records when", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa-escalate");
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "t-escalate" },
      inputIdempotencyKey: "ikey-escalate",
      runIdempotencyKey: "rkey-escalate",
      deliveryIdempotencyKey: "dkey-escalate",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      authorization: "dispatch:pa-front",
    });
    const action = await runPort.createPendingAction(res.run!.runId, {
      actionId: "action-escalate",
      kind: "ask",
      payload: { questions: [{ question: "which db?" }] },
    });
    expect(action.owner).toBe("agent:pa-front");
    await runPort.escalateActionToUser?.("action-escalate");
    const after = await runPort.getPendingAction("action-escalate");
    expect(after?.owner).toBe("user");
    expect(after?.escalatedAt).toBeGreaterThan(0);
  });

  test("a resolved request is not re-owned by a late failure", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa-escalate-late");
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "t-escalate-late" },
      inputIdempotencyKey: "ikey-escalate-late",
      runIdempotencyKey: "rkey-escalate-late",
      deliveryIdempotencyKey: "dkey-escalate-late",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    await runPort.createPendingAction(res.run!.runId, {
      actionId: "action-escalate-late",
      kind: "ask",
      payload: {},
    });
    await runPort.markActionAnswered?.("action-escalate-late", "user", ["conversation:c:1"]);
    await runPort.escalateActionToUser?.("action-escalate-late");
    const after = await runPort.getPendingAction("action-escalate-late");
    expect(after?.owner ?? "user").toBe("user");
    expect(after?.answeredBy).toBe("user");
  });
});

describe("ADR 0075 P4b: a correction keeps the row and flips the audit", () => {
  test("the stored response becomes the human's, attributed to user", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa-correct");
    const res = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "t" },
      inputIdempotencyKey: "ikey-correct",
      runIdempotencyKey: "rkey-correct",
      deliveryIdempotencyKey: "dkey-correct",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      authorization: "dispatch:pa-front",
    });
    const runId = res.run!.runId;
    await runPort.createPendingAction(runId, {
      actionId: "action-correct",
      kind: "approval",
      payload: {},
    });
    await runPort.consumePendingAction(
      "action-correct",
      { actionId: "action-correct", response: { decision: "allow" } },
      "resp-correct",
    );
    await runPort.markActionAnswered?.("action-correct", "agent:pa-front", ["brief:x"]);
    // The person overrules the machine: same row, new answer, new author.
    await runPort.correctActionResponse?.("action-correct", { decision: "deny" });
    const after = await runPort.getPendingAction("action-correct");
    expect(after?.answeredBy).toBe("user");
    expect(after?.response).toEqual({ decision: "deny" });
  });
});

describe("Agent Run: PendingAction consume-once", () => {
  test("create and consume pending action", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa1`,
      runIdempotencyKey: `rkey-pa1`,
      deliveryIdempotencyKey: `dkey-pa1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const action = await runPort.createPendingAction(runId, {
      actionId: `action-pa1`,
      kind: "approval",
      payload: { question: "ok?" },
    });
    expect(action.status).toBe("pending");

    const waitingRun = await runPort.getRun(runId);
    expect(waitingRun?.status).toBe("waiting");

    const consumed = await runPort.consumePendingAction(
      `action-pa1`,
      { actionId: `action-pa1`, response: { approved: true } },
      "resp-pa1",
    );
    expect(consumed.action.status).toBe("resolved");

    const runningRun = await runPort.getRun(runId);
    expect(runningRun?.status).toBe("running");
  });

  test("same response idempotency key returns stored result", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa2`,
      runIdempotencyKey: `rkey-pa2`,
      deliveryIdempotencyKey: `dkey-pa2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.createPendingAction(runId, {
      actionId: `action-pa2`,
      kind: "approval",
      payload: {},
    });

    await runPort.consumePendingAction(
      `action-pa2`,
      { actionId: `action-pa2`, response: { approved: true } },
      "resp-pa2",
    );

    const replay = await runPort.consumePendingAction(
      `action-pa2`,
      { actionId: `action-pa2`, response: { approved: true } },
      "resp-pa2",
    );
    expect(replay.action.status).toBe("resolved");
  });

  test("conflicting response throws", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa3`,
      runIdempotencyKey: `rkey-pa3`,
      deliveryIdempotencyKey: `dkey-pa3`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.createPendingAction(runId, {
      actionId: `action-pa3`,
      kind: "approval",
      payload: {},
    });

    await runPort.consumePendingAction(
      `action-pa3`,
      { actionId: `action-pa3`, response: { approved: true } },
      "resp-pa3-a",
    );

    expect(
      runPort.consumePendingAction(
        `action-pa3`,
        { actionId: `action-pa3`, response: { approved: false } },
        "resp-pa3-b",
      ),
    ).rejects.toThrow(PendingActionAlreadyConsumedError);
  });
});

describe("Agent Run: multi-slot PendingActions", () => {
  async function acquiredRun(tag: string): Promise<string> {
    const { conversationId, agentId, branch } = await setupBranch(tag);
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: tag },
      inputIdempotencyKey: `ikey-${tag}`,
      runIdempotencyKey: `rkey-${tag}`,
      deliveryIdempotencyKey: `dkey-${tag}`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    return result.run!.runId;
  }

  test("a second action opens while the run is waiting; the run wakes only after the last one", async () => {
    const runId = await acquiredRun("ms1");
    await runPort.createPendingAction(runId, {
      actionId: "a-ms1-a",
      kind: "approval",
      payload: {},
    });
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // The concurrent-tool-batch case: sibling approval raised while parked.
    await runPort.createPendingAction(runId, {
      actionId: "a-ms1-b",
      kind: "approval",
      payload: {},
    });
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // First consume: the sibling still parks the run.
    await runPort.consumePendingAction(
      "a-ms1-a",
      { actionId: "a-ms1-a", response: { decision: "allow" } },
      "resp-ms1-a",
    );
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // Last consume wakes it.
    await runPort.consumePendingAction(
      "a-ms1-b",
      { actionId: "a-ms1-b", response: { decision: "deny" } },
      "resp-ms1-b",
    );
    expect((await runPort.getRun(runId))?.status).toBe("running");
  });

  test("a replay of a resolved action never wakes a run parked on a sibling", async () => {
    const runId = await acquiredRun("ms2");
    await runPort.createPendingAction(runId, {
      actionId: "a-ms2-a",
      kind: "approval",
      payload: {},
    });
    await runPort.createPendingAction(runId, {
      actionId: "a-ms2-b",
      kind: "approval",
      payload: {},
    });
    await runPort.consumePendingAction(
      "a-ms2-a",
      { actionId: "a-ms2-a", response: { decision: "allow" } },
      "resp-ms2-a",
    );

    // The exact regression: replaying the OLD click while b is still open.
    await runPort.consumePendingAction(
      "a-ms2-a",
      { actionId: "a-ms2-a", response: { decision: "allow" } },
      "resp-ms2-a",
    );
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    // And b still consumes cleanly - the state machine did not desync.
    await runPort.consumePendingAction(
      "a-ms2-b",
      { actionId: "a-ms2-b", response: { decision: "deny" } },
      "resp-ms2-b",
    );
    expect((await runPort.getRun(runId))?.status).toBe("running");
  });

  test("terminal runs still refuse new actions", async () => {
    const runId = await acquiredRun("ms3");
    await runPort.finalizeRun(runId, { status: "completed", messages: [] });
    await expect(
      runPort.createPendingAction(runId, { actionId: "a-ms3", kind: "approval", payload: {} }),
    ).rejects.toThrow(/not active/);
  });
});

describe("Agent Run: terminal CAS", () => {
  test("finalizeRun sets terminal status and result", async () => {
    const { conversationId, agentId, branch } = await setupBranch("term1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term1`,
      runIdempotencyKey: `rkey-term1`,
      deliveryIdempotencyKey: `dkey-term1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const finalized = await runPort.finalizeRun(runId, {
      status: "completed",
      messages: [{ role: "assistant", text: "done" }],
    });
    expect(finalized.status).toBe("completed");
    expect(finalized.terminalResult?.status).toBe("completed");
    expect(finalized.terminalAt).not.toBeNull();

    const active = await runPort.getActiveRun(branch.branchId);
    expect(active).toBeNull();
  });

  test("same terminal replay returns stored result", async () => {
    const { conversationId, agentId, branch } = await setupBranch("term2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term2`,
      runIdempotencyKey: `rkey-term2`,
      deliveryIdempotencyKey: `dkey-term2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const outcome = { status: "completed" as const };
    await runPort.finalizeRun(runId, outcome);
    const replay = await runPort.finalizeRun(runId, outcome);
    expect(replay.status).toBe("completed");
  });

  test("conflicting terminal outcome throws", async () => {
    const { conversationId, agentId, branch } = await setupBranch("term3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term3`,
      runIdempotencyKey: `rkey-term3`,
      deliveryIdempotencyKey: `dkey-term3`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.finalizeRun(runId, { status: "completed" });
    expect(runPort.finalizeRun(runId, { status: "failed", error: "oops" })).rejects.toThrow(
      AgentRunConflictError,
    );
  });

  test("commit_failed keeps active slot and terminal result", async () => {
    const { conversationId, agentId, branch } = await setupBranch("term4");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term4`,
      runIdempotencyKey: `rkey-term4`,
      deliveryIdempotencyKey: `dkey-term4`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    db.exec(
      "UPDATE agent_run SET status='commit_failed', terminal_result=?, terminal_at=? WHERE run_id=?",
      [
        JSON.stringify({ status: "completed", output: { role: "assistant", text: "done" } }),
        Date.now(),
        runId,
      ],
    );

    const active = await runPort.getActiveRun(branch.branchId);
    expect(active?.status).toBe("commit_failed");
    expect(active?.terminalResult?.status).toBe("completed");
  });
});

describe("Agent Run: Phase 5 config snapshot", () => {
  test("the Run persists systemPrompt + skillRoots frozen at creation", async () => {
    const { conversationId, agentId, branch } = await setupBranch("snap1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "go" },
      inputIdempotencyKey: "ikey-snap1",
      runIdempotencyKey: "rkey-snap1",
      deliveryIdempotencyKey: "dkey-snap1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      systemPrompt: "frozen prompt",
      skillRoots: ["/skills/a", "/skills/b"],
    });
    expect(result.acquired).toBe(true);
    const run = result.run!;
    expect(run.systemPrompt).toBe("frozen prompt");
    expect(run.skillRoots).toEqual(["/skills/a", "/skills/b"]);
    const reloaded = await runPort.getRun(run.runId);
    expect(reloaded?.systemPrompt).toBe("frozen prompt");
    expect(reloaded?.skillRoots).toEqual(["/skills/a", "/skills/b"]);
  });

  test("a queued input keeps its OWN config snapshot; acquireNextRun promotes with IT, never the previous run's config", async () => {
    const { conversationId, agentId, branch } = await setupBranch("snap2");
    const first = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: "ikey-snap2-1",
      runIdempotencyKey: "rkey-snap2-1",
      deliveryIdempotencyKey: "dkey-snap2-1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      systemPrompt: "first prompt",
    });
    expect(first.acquired).toBe(true);

    const queued = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: "ikey-snap2-2",
      runIdempotencyKey: "rkey-snap2-2",
      deliveryIdempotencyKey: "dkey-snap2-2",
      defaultModel: { backendKind: "oma", modelId: "model-b" },
      configRevision: 7,
      workspace: { root: "/pinned-other", access: "read_only" },
      systemPrompt: "second prompt",
      skillRoots: ["/skills/loop"],
      expectedRevision: branch.revision + 1,
    });
    expect(queued.queued).toBe(true);

    await runPort.finalizeRun(first.run!.runId, { status: "completed" });
    const second = await runPort.acquireNextRun(branch.branchId);
    expect(second).not.toBeNull();
    expect(second!.modelRef).toEqual({ backendKind: "oma", modelId: "model-b" });
    expect(second!.configRevision).toBe(7);
    expect(second!.workspace).toEqual({ root: "/pinned-other", access: "read_only" });
    expect(second!.systemPrompt).toBe("second prompt");
    expect(second!.skillRoots).toEqual(["/skills/loop"]);
  });

  test("ADR 0047: the authorization basis freezes on the run and survives promotion", async () => {
    const { conversationId, agentId, branch } = await setupBranch("authz1");
    const first = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "lead dispatches" },
      inputIdempotencyKey: "ikey-authz1-1",
      runIdempotencyKey: "rkey-authz1-1",
      deliveryIdempotencyKey: "dkey-authz1-1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      authorization: "dispatch:lead-1",
      // ADR 0051: the dispatching run is the parent — the chain outlives
      // the run that started it.
      parentRunId: "run-lead-0",
    });
    expect(first.acquired).toBe(true);
    expect(first.run!.authorization).toBe("dispatch:lead-1");
    expect(first.run!.parentRunId).toBe("run-lead-0");

    // The queued dispatch keeps its basis in the queue snapshot; the
    // promoted run answers "on whose authority" with the SAME value.
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "worker follows up" },
      inputIdempotencyKey: "ikey-authz1-2",
      runIdempotencyKey: "rkey-authz1-2",
      deliveryIdempotencyKey: "dkey-authz1-2",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision + 1,
      authorization: "ambient:deploy-alarm",
      parentRunId: "run-lead-0",
    });
    await runPort.finalizeRun(first.run!.runId, { status: "completed" });
    const promoted = await runPort.acquireNextRun(branch.branchId);
    expect(promoted).not.toBeNull();
    expect(promoted!.authorization).toBe("ambient:deploy-alarm");
    // The queue snapshot carried the parent link across the wait.
    expect(promoted!.parentRunId).toBe("run-lead-0");
  });

  test("listIdleBranchesWithPendingInputs returns FIFO branches whose pending input never became a Run", async () => {
    const a = await setupBranch("idle-a");
    const b = await setupBranch("idle-b");
    const bFirst = await runPort.enqueueAndAcquire({
      conversationId: b.conversationId,
      agentId: b.agentId,
      branchId: b.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "b-first" },
      inputIdempotencyKey: "ikey-idle-b1",
      runIdempotencyKey: "rkey-idle-b1",
      deliveryIdempotencyKey: "dkey-idle-b1",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: b.branch.revision,
    });
    expect(bFirst.acquired).toBe(true);
    await runPort.enqueueAndAcquire({
      conversationId: b.conversationId,
      agentId: b.agentId,
      branchId: b.branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "b-pending" },
      inputIdempotencyKey: "ikey-idle-b2",
      runIdempotencyKey: "rkey-idle-b2",
      deliveryIdempotencyKey: "dkey-idle-b2",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: b.branch.revision + 1,
    });
    const aFirst = await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "a-first" },
      inputIdempotencyKey: "ikey-idle-a1",
      runIdempotencyKey: "rkey-idle-a1",
      deliveryIdempotencyKey: "dkey-idle-a1",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision,
    });
    expect(aFirst.acquired).toBe(true);
    await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "a-pending" },
      inputIdempotencyKey: "ikey-idle-a2",
      runIdempotencyKey: "rkey-idle-a2",
      deliveryIdempotencyKey: "dkey-idle-a2",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision + 1,
    });
    await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "steer",
      message: { role: "user", text: "steer" },
      inputIdempotencyKey: "ikey-idle-a3",
      runIdempotencyKey: "rkey-idle-a3",
      deliveryIdempotencyKey: "dkey-idle-a3",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision + 1,
    });

    const idle = await runPort.listIdleBranchesWithPendingInputs();
    expect(idle).toContain(b.branch.branchId);
    expect(idle).toContain(a.branch.branchId);
    expect(idle.indexOf(b.branch.branchId)).toBeLessThan(idle.indexOf(a.branch.branchId));

    expect(await runPort.acquireNextRun(a.branch.branchId)).toBeNull();
    await runPort.finalizeRun(bFirst.run!.runId, { status: "completed" });
    const promoted = await runPort.acquireNextRun(b.branch.branchId);
    expect(promoted).not.toBeNull();
    const after = await runPort.listIdleBranchesWithPendingInputs();
    expect(after).not.toContain(b.branch.branchId);
    expect(after).toContain(a.branch.branchId);
  });
});

describe("Agent Run: a waiting run still settles", () => {
  test("commit succeeds while a durable ask is open", async () => {
    // Observed 2026-09-25: an ask parked the run in `waiting`, the child then
    // exited (its MCP call had hit the SDK's 60s default), and the terminal
    // commit was refused because only running/commit_failed were accepted —
    // the run became an unsettleable zombie holding the branch forever, and
    // the user saw a card sealed "completed" with no options.
    const { conversationId, agentId, branch } = await setupBranch("pa-wait");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: "ikey-pa-wait",
      runIdempotencyKey: "rkey-pa-wait",
      deliveryIdempotencyKey: "dkey-pa-wait",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;
    await runPort.createPendingAction(runId, {
      actionId: "action-wait",
      kind: "ask",
      payload: { callId: "call-wait", questions: [] },
    });
    expect((await runPort.getRun(runId))?.status).toBe("waiting");

    await runPort.commitCompletedRun({
      runId,
      outcome: { status: "completed", messages: [] },
      messages: [],
    });
    expect((await runPort.getRun(runId))?.status).toBe("completed");
  });
});
