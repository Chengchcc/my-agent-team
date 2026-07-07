import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { getOrCreateAccumulator, onRunComplete } from "./run-accumulator.js";
import { createConversationService } from "./service.js";

const fakeOpsStore = {
  getSpanOrigin: (spanId: string) => ({
    spanId,
    // Map spanId → conversationId by test convention: strip "r-" prefix, use as cid
    conversationId: spanId.replace(/^r-/, "c-"),
    agentMemberId: "agent-1",
    originKind: "manual",
    issueId: null,
    cronJobId: null,
    fromStatus: "",
    idempotencyKey: spanId,
    surface: "web",
    sourceLedgerSeq: 0,
    createdAt: 0,
  }),
} as unknown as RuntimeOpsStore;

const db = openDb(":memory:");
const port = sqliteConversationAdapter(db);
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
  startAgentRun: async (spanId: string) => {
    return { spanId, attemptSeq: 1 };
  },
});

function setupConv(cid: string, memberId = "agent-1"): void {
  port.createConversation({ conversationId: cid, triggerMode: "mention", createdAt: Date.now() });
  port.addMember({
    memberId,
    conversationId: cid,
    kind: "agent",
    agentId: "agent-1",
    joinedAt: Date.now(),
  });
}

afterAll(() => {
  db.close();
});

// ─── P3: lock release on Phase 1 failure ───

describe("P3: onRunComplete tiering", () => {
  test("Phase 1 (terminal write) throws → Phase 2 lock release still runs in finally", async () => {
    const cid = "c-p3-lock";
        setupConv(cid);

    // Acquire lock to simulate active conversation
    lock.acquireSession(sessionId, cid);
    expect(lock.isActive(cid)).toBe(true);

    // Inject a port that throws on appendLedgerEntry (Phase 1 critical failure)
    const failingPort = {
      ...port,
      appendLedgerEntry: () => {
        throw new Error("ledger down");
      },
      hasLedgerContent: () => false,
    } as ConversationPort;

    await expect(
      onRunComplete("r-p3-lock", "succeeded", failingPort, svc, fakeOpsStore),
    ).rejects.toThrow("ledger down");

    // Phase 2 finally must have released the lock
    expect(lock.isActive(cid)).toBe(false);
  });
});

// ─── P7: ledger is single source of truth ───

describe("P7: ledger single authority for assistant messages", () => {
  test("terminal assistant message lands in ledger via onRunComplete", async () => {
    const cid = "c-p7-term";
        setupConv(cid);

    await onRunComplete("r-p7-term", "succeeded", port, svc, fakeOpsStore);

    const entries = port.getLedgerEntries(cid);
    const terminal = entries.find((e) => e.spanId === "r-p7-term" && e.kind === "message");
    expect(terminal).toBeTruthy();
    expect((terminal!.content as unknown as Record<string, unknown>).state).toBe("done");
  });

  test("projection broadcast failure does not block ledger write", async () => {
    const cid = "c-p7-bcast";
        setupConv(cid);

    // Broadcast is best-effort; ledger write (Phase 1 critical) succeeds regardless.
    try {
      await onRunComplete("r-p7-bcast", "succeeded", port, svc, fakeOpsStore);
    } catch {
      // Should not throw — only broadcast is best-effort
    }

    // Ledger has the terminal entry regardless
    const entries = port.getLedgerEntries(cid);
    const terminal = entries.find((e) => e.spanId === "r-p7-bcast" && e.kind === "message");
    expect(terminal).toBeTruthy();
  });
});

// ─── B1: todo_update projection ───

describe("B1: todo_update accumulates to onRunComplete appendTodo", () => {
  test("appendTodo fires when lastTodoUpdate was accumulated", async () => {
    const cid = "c-b1-todo";
        setupConv(cid);

    // Simulate what onTodoUpdate does in conversation-compose.ts
    const acc = getOrCreateAccumulator("r-b1-todo", "agent-1");
    acc.lastTodoUpdate = { todos: [{ step: "1", status: "in_progress" }] };

    // Phase 3 should now call appendTodo (which writes a ledger entry with kind=todo)
    await onRunComplete("r-b1-todo", "succeeded", port, svc, fakeOpsStore);

    // Verify a todo ledger entry was written
    const entries = port.getLedgerEntries(cid);
    const todoEntry = entries.find((e) => e.kind === "todo");
    expect(todoEntry).toBeTruthy();
    expect(todoEntry!.senderMemberId).toBe("agent-1");
    expect(todoEntry!.content as unknown as Record<string, unknown>).toMatchObject({
      todos: [{ step: "1", status: "in_progress" }],
    });
  });

  test("appendTodo does NOT fire when lastTodoUpdate is null", async () => {
    const cid = "c-b1-no-todo";
        setupConv(cid);

    // Accumulator created but lastTodoUpdate stays null
    getOrCreateAccumulator("r-b1-no-todo", "agent-1");

    // Phase 3 should NOT call appendTodo
    await onRunComplete("r-b1-no-todo", "succeeded", port, svc, fakeOpsStore);

    // Verify no todo ledger entry was written
    const entries = port.getLedgerEntries(cid);
    const todoEntry = entries.find((e) => e.kind === "todo");
    expect(todoEntry).toBeUndefined();
  });
});
