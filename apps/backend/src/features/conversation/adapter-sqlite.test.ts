import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { backfillLegacyThreads } from "./backfill.js";

const dbPath = `/tmp/test-conv-adapter-${Date.now()}.db`;
const db = openDb(dbPath);
const adapter = sqliteConversationAdapter(db);

afterAll(() => {
  db.close();
  try {
    require("node:fs").unlinkSync(dbPath);
  } catch {}
});

// ─── Conversation ──────────────────────────────────────────

describe("Conversation CRUD", () => {
  test("create inserts a conversation row", () => {
    const conv = adapter.createConversation({
      conversationId: "conv-1",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    expect(conv.conversationId).toBe("conv-1");
    expect(conv.triggerMode).toBe("mention");
    expect(conv.hopCount).toBe(0);
  });

  test("getById returns conversation or null", () => {
    const conv = adapter.getConversation("conv-1");
    expect(conv).not.toBeNull();
    expect(conv!.conversationId).toBe("conv-1");
  });

  test("getById returns null for nonexistent", () => {
    expect(adapter.getConversation("nope")).toBeNull();
  });

  test("updateHopCount increments hop_count", () => {
    adapter.updateHopCount("conv-1", 3);
    const conv = adapter.getConversation("conv-1");
    expect(conv!.hopCount).toBe(3);
  });

  test("updateHopCount resets to 0", () => {
    adapter.updateHopCount("conv-1", 0);
    const conv = adapter.getConversation("conv-1");
    expect(conv!.hopCount).toBe(0);
  });
});

// ─── Member ────────────────────────────────────────────────

describe("Member CRUD", () => {
  test("addMember inserts agent member", () => {
    const mem = adapter.addMember({
      memberId: "mem-x1",
      conversationId: "conv-1",
      kind: "agent",
      agentId: "ag-x",
      displayName: "XAgent",
      joinedAt: Date.now(),
    });
    expect(mem.memberId).toBe("mem-x1");
    expect(mem.kind).toBe("agent");
  });

  test("addMember inserts human member", () => {
    const mem = adapter.addMember({
      memberId: "mem-h1",
      conversationId: "conv-1",
      kind: "human",
      userRef: "user-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
    expect(mem.memberId).toBe("mem-h1");
    expect(mem.kind).toBe("human");
  });

  test("getMembers returns all members for a conversation", () => {
    const members = adapter.getMembers("conv-1");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.memberId).sort()).toEqual(["mem-h1", "mem-x1"]);
  });

  test("removeMember deletes member", () => {
    const ok = adapter.removeMember("mem-h1");
    expect(ok).toBe(true);
    const members = adapter.getMembers("conv-1");
    expect(members).toHaveLength(1);
  });

  test("removeMember returns false for nonexistent", () => {
    expect(adapter.removeMember("nope")).toBe(false);
  });

  test("getAgentMember returns only agent members", () => {
    const agents = adapter.getAgentMembers("conv-1");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.memberId).toBe("mem-x1");
  });
});

// ─── Ledger ────────────────────────────────────────────────

describe("Ledger CRUD", () => {
  test("appendLedgerEntry inserts and returns seq", () => {
    const seq = adapter.appendLedgerEntry({
      conversationId: "conv-1",
      senderMemberId: "mem-h1",
      addressedTo: ["mem-x1"],
      kind: "message",
      content: JSON.stringify({ text: "hello" }),
      ts: Date.now(),
    });
    expect(seq).toBe(1);
  });

  test("appendLedgerEntry auto-increments seq", () => {
    const seq = adapter.appendLedgerEntry({
      conversationId: "conv-1",
      senderMemberId: "mem-x1",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "response" }),
      ts: Date.now(),
    });
    expect(seq).toBe(2);
  });

  test("getLedgerEntries returns entries for a conversation", () => {
    const entries = adapter.getLedgerEntries("conv-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.seq).toBe(1);
    expect(entries[0]!.kind).toBe("message");
    expect(entries[1]!.seq).toBe(2);
  });

  test("getLedgerEntries supports sinceSeq filter", () => {
    const entries = adapter.getLedgerEntries("conv-1", { sinceSeq: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seq).toBe(2);
  });
});

// ─── Legacy backfill ──────────────────────────────────────

describe("Legacy backfill", () => {
  test("backfills old thread into conversation with human + agent members", () => {
    // Insert a legacy thread and agent first
    db.run(
      "INSERT OR REPLACE INTO agents (id, name, workspace_path, model_provider, model_name, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ag-legacy", "LegacyAgent", "/ws/legacy", "anthropic", "claude-sonnet-4-6", "ask", Date.now(), Date.now()],
    );
    db.run(
      "INSERT OR REPLACE INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["th-legacy-1", "ag-legacy", "Old thread", Date.now(), Date.now()],
    );

    backfillLegacyThreads(db, adapter);

    const conv = adapter.getConversation("th-legacy-1");
    expect(conv).not.toBeNull();
    expect(conv!.triggerMode).toBe("mention");
    expect(conv!.hopCount).toBe(0);

    const members = adapter.getMembers("th-legacy-1");
    expect(members).toHaveLength(2);
    const kinds = members.map((m) => m.kind).sort();
    expect(kinds).toEqual(["agent", "human"]);

    const ledger = adapter.getLedgerEntries("th-legacy-1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe("member.joined");
  });

  test("backfill is idempotent (calling twice is safe)", () => {
    backfillLegacyThreads(db, adapter);
    // Should not throw or duplicate
    const members = adapter.getMembers("th-legacy-1");
    expect(members).toHaveLength(2);
  });
});
