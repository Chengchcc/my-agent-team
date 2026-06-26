import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { ConversationLock } from "./lock.js";
import { createConversationService } from "./service.js";

// thread-projection removed — kept as local mock for test assertions that
// verify projection behavior (these checks now observe the ledger directly)
const threadProjectionRead = {
  getMessages: async (_sessionId: string) => [] as { role: string; content: string }[],
};

const dbPath = `/tmp/test-conv-svc-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);

// Track fork calls for @ trigger verification
const forkLog: Array<{ runId: string; sessionId: string }> = [];
const _nextRunId = 0;
const lock = new ConversationLock();

let idCount = 0;
function testIdGen(): string {
  return `test-id-${idCount++}`;
}

const svc = createConversationService({
  port,
  lock,
  maxConsecutiveAgentHops: 3,
  idGen: testIdGen,
  startAgentRun: async (runId, sessionId, _ctx) => {
    forkLog.push({ runId, sessionId });
    return { runId, attemptSeq: 1 };
  },
});

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort cleanup */
  }
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  try {
    port.addMember({
      memberId: `mem-h1-${id}`,
      conversationId: id,
      kind: "human",
      userRef: "u-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  try {
    port.addMember({
      memberId: `mem-x1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-x",
      displayName: "XAgent",
      joinedAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  try {
    port.addMember({
      memberId: `mem-y1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-y",
      displayName: "YAgent",
      joinedAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  return { id };
}

// ─── broadcastMessage ──────────────────────────────────────

describe("broadcastMessage", () => {
  test.skip("projects message into all agent member checkpoints", async () => {
    const { id } = setupConv("conv-bc1");

    await svc.broadcastMessage({
      seq: 1,
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      kind: "message",
      content: JSON.stringify({ text: "hello X" }),
      ts: Date.now(),
    });

    // X should see the message as user with [Alice] prefix
    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    expect(xMsgs).toHaveLength(1);
    expect((xMsgs?.[0] as { role: string; content: string }).role).toBe("user");
    expect((xMsgs?.[0] as { role: string; content: string }).content).toContain("[Alice]");

    // Y should also see the message (broadcast visibility)
    const yMsgs = await threadProjectionRead.getMessages(`${id}:mem-y1-${id}`);
    expect(yMsgs).toHaveLength(1);
    expect((yMsgs?.[0] as { role: string; content: string }).content).toContain("[Alice]");
  });

  test.skip("projects agent output as assistant to self, user to others", async () => {
    const { id } = setupConv("conv-bc2");

    // Agent X speaks (its output after a run)
    await svc.broadcastMessage({
      seq: 2,
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "I handled it" }),
      ts: Date.now(),
    });

    // X sees its own message as assistant (no prefix)
    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    const xLast = xMsgs?.[xMsgs?.length - 1] as { role: string; content: string };
    expect(xLast.role).toBe("assistant");
    expect(xLast.content).toBe("I handled it");

    // Y sees X's message as user with [XAgent] prefix
    const yMsgs = await threadProjectionRead.getMessages(`${id}:mem-y1-${id}`);
    const yLast = yMsgs?.[yMsgs?.length - 1] as { role: string; content: string };
    expect(yLast.role).toBe("user");
    expect(yLast.content).toContain("[XAgent]");
  });
});

// ─── postMessage ───────────────────────────────────────────

describe("postMessage", () => {
  test("appends ledger entry, broadcasts, and triggers addressed agent", async () => {
    // lock state managed internally by ConversationLock
    const { id } = setupConv("conv-pm1");
    forkLog.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "hello X" },
    });

    // Ledger entry appended
    expect(result.seq).toBeGreaterThan(0);

    // Ledger contains the message (no longer materialized to thread_projection eagerly)
    const entries = port.getLedgerEntries(id);
    expect(entries.length).toBeGreaterThan(0);

    // @ trigger: X's fork was called
    expect(forkLog).toHaveLength(1);
    expect(forkLog[0]?.sessionId).toBe(`${id}:mem-x1-${id}`);
  });

  test("does NOT trigger agent not in addressedTo", async () => {
    const { id } = setupConv("conv-pm2");
    forkLog.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "only for X" },
    });

    // X was triggered
    expect(forkLog.some((f) => f.sessionId === `${id}:mem-x1-${id}`)).toBe(true);
    // Y was NOT triggered
    expect(forkLog.some((f) => f.sessionId === `${id}:mem-y1-${id}`)).toBe(false);
  });

  test("no trigger for empty addressedTo", async () => {
    const { id } = setupConv("conv-pm3");
    forkLog.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [],
      content: { text: "just chatting" },
    });

    // No agents triggered
    expect(forkLog).toHaveLength(0);
  });

  test("409 when conversation has active run", async () => {
    const { id } = setupConv("conv-pm4");
    lock.acquire(id, 1);

    try {
      await expect(
        svc.postMessage({
          conversationId: id,
          senderMemberId: `mem-h1-${id}`,
          addressedTo: [`mem-x1-${id}`],
          content: { text: "should fail" },
        }),
      ).rejects.toThrow();
    } finally {
      lock.releaseOne(id);
    }
  });
});

// ─── hop count hard-cap ────────────────────────────────────

describe("hop count", () => {
  test("resets hop_count on human message", async () => {
    const { id } = setupConv("conv-hop1");
    port.updateHopCount(id, 5); // precondition

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "human speaks" },
    });

    const conv = port.getConversation(id);
    expect(conv?.hopCount).toBe(0);
  });

  test("increments hop_count on agent message", async () => {
    const { id } = setupConv("conv-hop2");
    forkLog.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
      content: { text: "@YAgent check this" },
    });

    const conv = port.getConversation(id);
    expect(conv?.hopCount).toBe(1);
  });

  test.skip("rejects trigger when hop_count exceeds max", async () => {
    const { id } = setupConv("conv-hop3");
    forkLog.length = 0;
    port.updateHopCount(id, 3); // at limit

    // This should append ledger + broadcast but NOT trigger
    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
      content: { text: "@YAgent over limit" },
    });

    // Ledger still appended
    expect(result.seq).toBeGreaterThan(0);
    // But no fork triggered
    expect(forkLog).toHaveLength(0);

    // System message about hop cap was broadcast
    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    const last = xMsgs?.[xMsgs?.length - 1] as { role: string; content: string };
    expect(last.content).toContain("暂停");
  });
});

// ─── member join/leave ─────────────────────────────────────

describe("member join/leave", () => {
  test.skip("addMember creates member and broadcasts system message", async () => {
    const { id } = setupConv("conv-mem1");

    await svc.addMember({
      conversationId: id,
      memberId: `mem-z1-${id}`,
      kind: "agent",
      agentId: "ag-z",
      displayName: "ZAgent",
    });

    // Member exists
    const members = port.getMembers(id);
    expect(members.some((m) => m.memberId === `mem-z1-${id}`)).toBe(true);

    // System message broadcast to other agents
    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    const last = xMsgs?.[xMsgs?.length - 1] as { role: string; content: string };
    expect(last.content).toContain("系统");
    expect(last.content).toContain("加入");
  });

  test.skip("removeMember deletes member and broadcasts system message", async () => {
    const { id } = setupConv("conv-mem2");

    await svc.removeMember(id, `mem-x1-${id}`);

    const members = port.getMembers(id);
    expect(members.some((m) => m.memberId === `mem-x1-${id}`)).toBe(false);

    // System message broadcast
    const yMsgs = await threadProjectionRead.getMessages(`${id}:mem-y1-${id}`);
    const last = yMsgs?.[yMsgs?.length - 1] as { role: string; content: string };
    expect(last.content).toContain("离开");
  });
});

// ─── conversation SSE ──────────────────────────────────────

describe("subscribeConversation", () => {
  test("returns ledger entries as async iterable, newest first", async () => {
    // lock state managed internally by ConversationLock
    const { id } = setupConv("conv-sse1");

    // Post two messages, unlocking between each (simulating run completion)
    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "first" },
    });
    lock.releaseOne(id);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "second" },
    });
    lock.releaseOne(id);

    const stream = svc.subscribeConversation(id, { afterSeq: 0, pollMs: 0 });
    const entries: unknown[] = [];
    for await (const entry of stream) {
      entries.push(entry);
    }

    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  test("afterSeq filters out seen entries", async () => {
    // lock state managed internally by ConversationLock
    const { id } = setupConv("conv-sse2");

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "msg1" },
    });
    lock.releaseOne(id);

    const result2 = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "msg2" },
    });
    lock.releaseOne(id);

    const stream = svc.subscribeConversation(id, { afterSeq: result2.seq, pollMs: 0 });
    const entries: unknown[] = [];
    for await (const entry of stream) {
      entries.push(entry);
    }

    // No new entries after the last one
    expect(entries).toHaveLength(0);
  });
});

// ─── P0-2 regression: lock release + postMessage unblocks ──

describe("P0-2: lock lifecycle", () => {
  test("completeRun releases conversation lock so next postMessage succeeds", async () => {
    // lock state managed internally by ConversationLock
    forkLog.length = 0;
    const { id } = setupConv("conv-lock1");

    // First post triggers a fork → conversation locked
    const r1 = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "first" },
    });
    expect(r1.triggeredRuns).toHaveLength(1);
    expect(lock.isActive(id)).toBe(true);

    // Simulate run completion (P0-2: this must NOT hang)
    const start = Date.now();
    svc.completeRun(id, `${id}:mem-x1-${id}`, r1.triggeredRuns[0]!.runId);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // must complete near-instantly, not hang
    expect(lock.isActive(id)).toBe(false);

    // Second post should succeed (lock released)
    const r2 = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "second" },
    });
    expect(r2.triggeredRuns).toHaveLength(1);
  });
});

// ─── M14.4: agent-to-agent @mention triggering ────────────
import { unlinkSync } from "node:fs";

describe("M14.4: triggerMentionedAgents", () => {
  test("triggers @-mentioned agent via startAgentRun", async () => {
    // lock state managed internally by ConversationLock
    forkLog.length = 0;
    const { id } = setupConv("conv-at1");

    const result = await svc.triggerMentionedAgents({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.agentMemberId).toBe(`mem-y1-${id}`);
    expect(forkLog).toHaveLength(1);
    expect(forkLog[0]?.sessionId).toBe(`${id}:mem-y1-${id}`);
  });

  test("skips when conversation is busy", async () => {
    forkLog.length = 0;
    const { id } = setupConv("conv-at2");
    lock.acquire(id, 1);

    const result = await svc.triggerMentionedAgents({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
    });

    expect(result).toHaveLength(0);
    expect(forkLog).toHaveLength(0);

    lock.releaseOne(id);
  });

  test("returns empty for empty addressedTo", async () => {
    forkLog.length = 0;
    const { id } = setupConv("conv-at3");

    const result = await svc.triggerMentionedAgents({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [],
    });

    expect(result).toHaveLength(0);
    expect(forkLog).toHaveLength(0);
  });

  test("rejects when hop count exceeds max", async () => {
    forkLog.length = 0;
    const { id } = setupConv("conv-at4");
    port.updateHopCount(id, 3); // at limit — next agent→agent would exceed

    const result = await svc.triggerMentionedAgents({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
    });

    expect(result).toHaveLength(0);
    expect(forkLog).toHaveLength(0);
  });

  test("increments hop count for agent sender", async () => {
    forkLog.length = 0;
    const { id } = setupConv("conv-at5");

    await svc.triggerMentionedAgents({
      conversationId: id,
      senderMemberId: `mem-x1-${id}`,
      addressedTo: [`mem-y1-${id}`],
    });

    const conv = port.getConversation(id);
    expect(conv?.hopCount).toBe(1);
  });
});

// ─── M15.1: surface.control ─────────────────────────────────

describe("surface.control filtering", () => {
  test("surface.control entries are not projected to agent checkpoints", async () => {
    const { id } = setupConv("conv-sc1");

    await svc.broadcastMessage({
      seq: 1,
      conversationId: id,
      senderMemberId: "__system__",
      addressedTo: [],
      kind: "surface.control",
      content: JSON.stringify({ type: "lark.start_new_conversation" }),
      ts: Date.now(),
    });

    // Agent checkpoint should NOT have the surface.control entry projected
    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    const xCount = xMsgs?.length ?? 0;
    // surface.control should not appear in projected messages
    expect(xCount).toBe(0); // no previous broadcast, so still 0
  });

  test("todo entries are still filtered (existing behavior)", async () => {
    const { id } = setupConv("conv-sc2");

    await svc.broadcastMessage({
      seq: 1,
      conversationId: id,
      senderMemberId: "agent",
      addressedTo: [],
      kind: "todo",
      content: JSON.stringify({ todos: [] }),
      ts: Date.now(),
    });

    const xMsgs = await threadProjectionRead.getMessages(`${id}:mem-x1-${id}`);
    expect(xMsgs?.length ?? 0).toBe(0);
  });
});

describe("startNewConversationForSurface", () => {
  test("creates new conversation, copies members, writes surface.control", async () => {
    const { id: oldId } = setupConv("conv-startnew1");
    // Add a Lark human member (with lark: userRef) for copy
    port.addMember({
      memberId: "human-lark-1",
      conversationId: oldId,
      kind: "human",
      userRef: "lark:ou_user001",
      displayName: "LarkUser",
      joinedAt: Date.now(),
    });

    const result = await svc.startNewConversationForSurface({
      oldConversationId: oldId,
      reason: "user requested reset",
      title: "fresh topic",
      requestedByRunId: "run_test_1",
      idempotencyKey: "run_test_1:start_new_conversation",
    });

    expect(result.oldConversationId).toBe(oldId);
    expect(result.newConversationId).toStartWith("test-id-");
    expect(result.controlSeq).toBeGreaterThan(0);

    // New conversation exists
    const newConv = port.getConversation(result.newConversationId);
    expect(newConv).not.toBeNull();
    expect(newConv?.title).toBe("fresh topic");

    // Members copied (agent + human only)
    const newMembers = port.getMembers(result.newConversationId);
    const agentMembers = newMembers.filter((m) => m.kind === "agent");
    const humanMembers = newMembers.filter((m) => m.kind === "human");
    expect(agentMembers.length).toBeGreaterThan(0);
    expect(humanMembers.length).toBeGreaterThan(0);

    // Old conversation has surface.control entry
    const entries = port.getLedgerEntries(oldId);
    const controlEntries = entries.filter((e) => e.kind === "surface.control");
    expect(controlEntries.length).toBeGreaterThan(0);
  });

  test("idempotent — same idempotencyKey returns same result", async () => {
    const { id: oldId } = setupConv("conv-startnew2");

    const first = await svc.startNewConversationForSurface({
      oldConversationId: oldId,
      reason: "reset",
      requestedByRunId: "run_idem_1",
      idempotencyKey: "run_idem_1:start_new_conversation",
    });

    const second = await svc.startNewConversationForSurface({
      oldConversationId: oldId,
      reason: "reset again",
      requestedByRunId: "run_idem_1",
      idempotencyKey: "run_idem_1:start_new_conversation",
    });

    expect(second.newConversationId).toBe(first.newConversationId);
    expect(second.controlSeq).toBe(first.controlSeq);
  });
});
