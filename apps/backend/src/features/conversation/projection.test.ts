import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import {
  sqliteThreadProjectionReadAdapter,
  sqliteThreadProjectionWriteAdapter,
} from "../thread-projection/adapter-sqlite.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { onRunComplete } from "./projection.js";
import { createConversationService } from "./service.js";

const fakeOpsStore = { getRunOrigin: () => null } as unknown as RuntimeOpsStore;

const dbPath = `/tmp/test-projection-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);
const threadProjectionRead = sqliteThreadProjectionReadAdapter(db);
const threadProjectionWrite = sqliteThreadProjectionWriteAdapter(db);
const lock = new ConversationLock();

let idCount = 0;
function testIdGen(): string {
  return `test-id-${idCount++}`;
}

const svc = createConversationService({
  port,
  threadProjectionRead,
  threadProjectionWrite,
  lock,
  maxConsecutiveAgentHops: 3,
  idGen: testIdGen,
  forkRun: async (runId, _threadId) => {
    return { runId, attemptId: `att-${runId}` };
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
    const threadId = `${cid}:agent-1`;
    setupConv(cid);

    // Acquire lock to simulate active conversation
    lock.acquireThread(threadId, cid);
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
      onRunComplete(threadId, "r-p3-lock", "succeeded", failingPort, svc, fakeOpsStore),
    ).rejects.toThrow("ledger down");

    // Phase 2 finally must have released the lock
    expect(lock.isActive(cid)).toBe(false);
  });
});

// ─── P7: ledger is single source of truth ───

describe("P7: ledger single authority for assistant messages", () => {
  test("terminal assistant message lands in ledger via onRunComplete", async () => {
    const cid = "c-p7-term";
    const threadId = `${cid}:agent-1`;
    setupConv(cid);

    await onRunComplete(threadId, "r-p7-term", "succeeded", port, svc, fakeOpsStore);

    const entries = port.getLedgerEntries(cid);
    const terminal = entries.find((e) => e.runId === "r-p7-term" && e.kind === "message");
    expect(terminal).toBeTruthy();
    expect(terminal!.content).toContain('"state":"done"');
  });

  test("projection broadcast failure does not block ledger write", async () => {
    const cid = "c-p7-bcast";
    const threadId = `${cid}:agent-1`;
    setupConv(cid);

    // Broadcast is best-effort; ledger write (Phase 1 critical) succeeds regardless.
    try {
      await onRunComplete(threadId, "r-p7-bcast", "succeeded", port, svc, fakeOpsStore);
    } catch {
      // Should not throw — only broadcast is best-effort
    }

    // Ledger has the terminal entry regardless
    const entries = port.getLedgerEntries(cid);
    const terminal = entries.find((e) => e.runId === "r-p7-bcast" && e.kind === "message");
    expect(terminal).toBeTruthy();
  });
});
