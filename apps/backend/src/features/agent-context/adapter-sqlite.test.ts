import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentContextAdapter } from "./adapter-sqlite.js";
import { ContextRevisionConflictError } from "./domain.js";
import type { AgentContextPort } from "./ports.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const ctx: AgentContextPort = sqliteAgentContextAdapter(db);

/** Create a fresh conversation (with its 1:1 agent) and return their IDs. */
function freshFixture(prefix: string): {
  conversationId: string;
  agentId: string;
} {
  const conversationId = `conv-${prefix}`;
  const agentId = `ag-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    createdAt: Date.now(),
  });
  return { conversationId, agentId };
}

afterAll(() => db.close());

describe("Agent Context: tree and default branch", () => {
  test("getOrCreateTree creates tree for conversation", async () => {
    const { conversationId } = freshFixture("tree");
    const tree = await ctx.getOrCreateTree(conversationId);
    expect(tree.conversationId).toBe(conversationId);
    expect(tree.treeId).toBeTruthy();
  });

  test("getOrCreateTree is idempotent", async () => {
    const { conversationId } = freshFixture("idem");
    const t1 = await ctx.getOrCreateTree(conversationId);
    const t2 = await ctx.getOrCreateTree(conversationId);
    expect(t1.treeId).toBe(t2.treeId);
  });

  test("getTree returns null when no tree exists", async () => {
    const { conversationId } = freshFixture("null");
    const tree = await ctx.getTree(conversationId);
    expect(tree).toBeNull();
  });

  test("getOrCreateDefaultBranch creates default branch", async () => {
    const { conversationId } = freshFixture("branch");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    expect(branch.treeId).toBe(tree.treeId);
    expect(branch.isDefault).toBe(true);
    expect(branch.backendKind).toBe("oma");
    expect(branch.ledgerCursor).toBe(0);
    expect(branch.revision).toBe(1);
  });

  test("getOrCreateDefaultBranch is idempotent", async () => {
    const { conversationId } = freshFixture("idem-branch");
    const tree = await ctx.getOrCreateTree(conversationId);
    const b1 = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    const b2 = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    expect(b1.branchId).toBe(b2.branchId);
  });
});

describe("Agent Context: entry append and CAS", () => {
  test("appendEntry appends to leaf and increments revision", async () => {
    const { conversationId } = freshFixture("append");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");

    const result = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 1,
    });
    expect(result.branch.revision).toBe(2);
    expect(result.branch.leafEntryId).toBe(result.entryId);

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("ledger_message");
  });

  test("appendEntry CAS conflict throws", async () => {
    const { conversationId } = freshFixture("cas");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");

    await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 2,
    });

    // Try to append with stale revision
    expect(
      ctx.appendEntry({
        branchId: branch.branchId,
        expectedRevision: 1,
        type: "ledger_message",
        parentId: null,
        payload: {},
        ledgerSeq: 3,
      }),
    ).rejects.toThrow(ContextRevisionConflictError);
  });

  test("listEntriesToLeaf returns root-to-leaf order", async () => {
    const { conversationId } = freshFixture("order");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");

    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 1,
    });
    await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "ledger_message",
      parentId: r1.entryId,
      payload: {},
      ledgerSeq: 2,
    });

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.entryId).toBe(r1.entryId);
  });
});

describe("Agent Context: ledger_message stores ref only", () => {
  test("ledger_message entry stores ledgerSeq, not message content", async () => {
    const { conversationId } = freshFixture("ref");
    const seq = conv.appendLedgerEntry({
      conversationId,
      kind: "message",
      content: JSON.stringify({ text: "full message content" }),
      ts: Date.now(),
    });

    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    const result = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: seq,
    });

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    const entry = entries[0];
    expect(entry?.type).toBe("ledger_message");
    if (entry?.type === "ledger_message") {
      expect(entry.ledgerSeq).toBe(seq);
    }
    // The entry payload must not contain the message content
    const raw = db
      .query("SELECT payload FROM agent_context_entry WHERE entry_id = ?")
      .get(result.entryId) as { payload: string };
    expect(raw.payload).not.toContain("full message content");
  });
});

describe("Agent Context: fork", () => {
  test("fork creates new branch with inherited backend kind, preserves entries", async () => {
    const { conversationId } = freshFixture("fork1");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 4,
    });

    const { branch: forked } = await ctx.forkBranch({
      sourceBranchId: branch.branchId,
      expectedRevision: 2,
      fromEntryId: r1.entryId,
    });
    expect(forked.backendKind).toBe("oma");
    expect(forked.isDefault).toBe(false);
    expect(forked.branchId).not.toBe(branch.branchId);

    // Original entries are not deleted
    const origEntries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(origEntries).toHaveLength(1);

    // Forked branch sees the same entry
    const forkedEntries = await ctx.listEntriesToLeaf(forked.branchId);
    expect(forkedEntries).toHaveLength(1);
    expect(forkedEntries[0]?.entryId).toBe(r1.entryId);
  });

  test("fork can change backend kind", async () => {
    const { conversationId } = freshFixture("fork2");
    const tree = await ctx.getOrCreateTree(conversationId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "oma");
    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 5,
    });

    const { branch: forked } = await ctx.forkBranch({
      sourceBranchId: branch.branchId,
      expectedRevision: 2,
      fromEntryId: r1.entryId,
      backendKind: "claude_code",
    });
    expect(forked.backendKind).toBe("claude_code");
  });
});
