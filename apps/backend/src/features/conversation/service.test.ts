import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteCheckpointReadAdapter, sqliteCheckpointWriteAdapter } from "../checkpoint/adapter-sqlite.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { createConversationService } from "./service.js";

const dbPath = `/tmp/test-conv-svc-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);
const checkpointRead = sqliteCheckpointReadAdapter(db);
const checkpointWrite = sqliteCheckpointWriteAdapter(db);

// Track fork calls for @ trigger verification
const forkLog: Array<{ runId: string; threadId: string }> = [];
let nextRunId = 0;
const activeConversations = new Set<string>();

const svc = createConversationService({
  port,
  checkpointRead,
  checkpointWrite,
  activeConversations,
  maxConsecutiveAgentHops: 3,
  forkRun: (runId, threadId, _specJson) => {
    forkLog.push({ runId, threadId });
    activeConversations.add(""); // placeholder — caller owns lock management
    return { runId, attemptId: `att-${runId}` };
  },
});

afterAll(() => {
  db.close();
  try {
    require("node:fs").unlinkSync(dbPath);
  } catch {}
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-h1-${id}`,
      conversationId: id,
      kind: "human",
      userRef: "u-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-x1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-x",
      displayName: "XAgent",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  try {
    port.addMember({
      memberId: `mem-y1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "ag-y",
      displayName: "YAgent",
      joinedAt: Date.now(),
    });
  } catch { /* already exists */ }
  // Create thread rows for agent members
  db.run("INSERT OR IGNORE INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    `${id}:mem-x1-${id}`, "ag-x", "X thread", Date.now(), Date.now(),
  ]);
  db.run("INSERT OR IGNORE INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    `${id}:mem-y1-${id}`, "ag-y", "Y thread", Date.now(), Date.now(),
  ]);
  return { id };
}

// ─── broadcastMessage ──────────────────────────────────────

describe("broadcastMessage", () => {
  test("projects message into all agent member checkpoints", async () => {
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
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    expect(xMsgs).toHaveLength(1);
    expect((xMsgs![0] as { role: string; content: string }).role).toBe("user");
    expect((xMsgs![0] as { role: string; content: string }).content).toContain("[Alice]");

    // Y should also see the message (broadcast visibility)
    const yMsgs = await checkpointRead.getMessages(`${id}:mem-y1-${id}`);
    expect(yMsgs).toHaveLength(1);
    expect((yMsgs![0] as { role: string; content: string }).content).toContain("[Alice]");
  });

  test("projects agent output as assistant to self, user to others", async () => {
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
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    const xLast = xMsgs![xMsgs!.length - 1] as { role: string; content: string };
    expect(xLast.role).toBe("assistant");
    expect(xLast.content).toBe("I handled it");

    // Y sees X's message as user with [XAgent] prefix
    const yMsgs = await checkpointRead.getMessages(`${id}:mem-y1-${id}`);
    const yLast = yMsgs![yMsgs!.length - 1] as { role: string; content: string };
    expect(yLast.role).toBe("user");
    expect(yLast.content).toContain("[XAgent]");
  });
});

// ─── postMessage ───────────────────────────────────────────

describe("postMessage", () => {
  test("appends ledger entry, broadcasts, and triggers addressed agent", async () => {
    activeConversations.clear();
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

    // Broadcast: X sees the message
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    expect(xMsgs?.length).toBeGreaterThan(0);

    // @ trigger: X's fork was called
    expect(forkLog).toHaveLength(1);
    expect(forkLog[0]!.threadId).toBe(`${id}:mem-x1-${id}`);
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
    expect(forkLog.some((f) => f.threadId === `${id}:mem-x1-${id}`)).toBe(true);
    // Y was NOT triggered
    expect(forkLog.some((f) => f.threadId === `${id}:mem-y1-${id}`)).toBe(false);
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
    activeConversations.add(id);

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
      activeConversations.delete(id);
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
    expect(conv!.hopCount).toBe(0);
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
    expect(conv!.hopCount).toBe(1);
  });

  test("rejects trigger when hop_count exceeds max", async () => {
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
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    const last = xMsgs![xMsgs!.length - 1] as { role: string; content: string };
    expect(last.content).toContain("暂停");
  });
});

// ─── member join/leave ─────────────────────────────────────

describe("member join/leave", () => {
  test("addMember creates member and broadcasts system message", async () => {
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
    const xMsgs = await checkpointRead.getMessages(`${id}:mem-x1-${id}`);
    const last = xMsgs![xMsgs!.length - 1] as { role: string; content: string };
    expect(last.content).toContain("系统");
    expect(last.content).toContain("加入");
  });

  test("removeMember deletes member and broadcasts system message", async () => {
    const { id } = setupConv("conv-mem2");

    await svc.removeMember(id, `mem-x1-${id}`);

    const members = port.getMembers(id);
    expect(members.some((m) => m.memberId === `mem-x1-${id}`)).toBe(false);

    // System message broadcast
    const yMsgs = await checkpointRead.getMessages(`${id}:mem-y1-${id}`);
    const last = yMsgs![yMsgs!.length - 1] as { role: string; content: string };
    expect(last.content).toContain("离开");
  });
});

// ─── conversation SSE ──────────────────────────────────────

describe("subscribeConversation", () => {
  test("returns ledger entries as async iterable, newest first", async () => {
    activeConversations.clear();
    const { id } = setupConv("conv-sse1");

    // Post two messages, unlocking between each (simulating run completion)
    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "first" },
    });
    activeConversations.delete(id);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "second" },
    });
    activeConversations.delete(id);

    const stream = svc.subscribeConversation(id, { afterSeq: 0 });
    const entries: unknown[] = [];
    for await (const entry of stream) {
      entries.push(entry);
    }

    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  test("afterSeq filters out seen entries", async () => {
    activeConversations.clear();
    const { id } = setupConv("conv-sse2");

    await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "msg1" },
    });
    activeConversations.delete(id);

    const result2 = await svc.postMessage({
      conversationId: id,
      senderMemberId: `mem-h1-${id}`,
      addressedTo: [`mem-x1-${id}`],
      content: { text: "msg2" },
    });
    activeConversations.delete(id);

    const stream = svc.subscribeConversation(id, { afterSeq: result2.seq });
    const entries: unknown[] = [];
    for await (const entry of stream) {
      entries.push(entry);
    }

    // No new entries after the last one
    expect(entries).toHaveLength(0);
  });
});
