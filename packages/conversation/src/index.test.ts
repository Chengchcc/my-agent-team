import { describe, expect, test } from "bun:test";
import {
  AgentMember,
  assertAgentMember,
  assertMember,
  Conversation,
  HumanMember,
  LedgerEntry,
  Member,
  resolveTriggerTargets,
} from "./index.js";

// ─── Helpers ──────────────────────────────────────────────

const human: HumanMember = {
  kind: "human",
  memberId: "h1",
  userRef: "user-1",
  displayName: "Alice",
};

const agentX: AgentMember = {
  kind: "agent",
  memberId: "x1",
  agentId: "ag-x",
  displayName: "XAgent",
};

const agentY: AgentMember = {
  kind: "agent",
  memberId: "y1",
  agentId: "ag-y",
  displayName: "YAgent",
};

function makeConv(members: Member[] = [human, agentX, agentY]) {
  return Conversation.parse({
    conversationId: "conv-1",
    members,
    triggerMode: "mention",
    createdAt: Date.now(),
  });
}

// ─── Member ────────────────────────────────────────────────

describe("Member", () => {
  test("parses AgentMember", () => {
    const m = Member.parse({ kind: "agent", memberId: "a1", agentId: "ag-1" });
    expect(m.kind).toBe("agent");
    if (m.kind === "agent") expect(m.agentId).toBe("ag-1");
  });

  test("parses HumanMember", () => {
    const m = Member.parse({ kind: "human", memberId: "h1", userRef: "u-1" });
    expect(m.kind).toBe("human");
    if (m.kind === "human") expect(m.userRef).toBe("u-1");
  });

  test("discriminated union rejects missing kind", () => {
    const r = Member.safeParse({ memberId: "x", agentId: "ag-1" });
    expect(r.success).toBe(false);
  });

  test("AgentMember requires agentId", () => {
    const r = AgentMember.safeParse({ kind: "agent", memberId: "x" });
    expect(r.success).toBe(false);
  });

  test("HumanMember accepts optional userRef", () => {
    const r = HumanMember.safeParse({ kind: "human", memberId: "x" });
    expect(r.success).toBe(true);
  });
});

// ─── Conversation ──────────────────────────────────────────

describe("Conversation", () => {
  test("parses valid conversation with members", () => {
    const c = Conversation.parse({
      conversationId: "conv-1",
      members: [agentX, human],
      triggerMode: "mention",
      createdAt: 1700000000000,
    });
    expect(c.conversationId).toBe("conv-1");
    expect(c.members).toHaveLength(2);
  });

  test("defaults triggerMode to mention", () => {
    const c = Conversation.parse({
      conversationId: "conv-2",
      members: [human],
      createdAt: 1700000000000,
    });
    expect(c.triggerMode).toBe("mention");
  });

  test("rejects empty members array", () => {
    const r = Conversation.safeParse({
      conversationId: "conv-3",
      members: [],
      createdAt: 1700000000000,
    });
    expect(r.success).toBe(false);
  });
});

// ─── LedgerEntry ───────────────────────────────────────────

describe("LedgerEntry", () => {
  test("parses message entry", () => {
    const e = LedgerEntry.parse({
      seq: 1,
      conversationId: "conv-1",
      senderMemberId: "h1",
      addressedTo: ["x1"],
      kind: "message",
      content: JSON.stringify({ text: "hello" }),
      ts: 1700000000000,
    });
    expect(e.kind).toBe("message");
    expect(e.senderMemberId).toBe("h1");
    expect(e.addressedTo).toEqual(["x1"]);
  });

  test("parses member.joined entry", () => {
    const e = LedgerEntry.parse({
      seq: 2,
      conversationId: "conv-1",
      senderMemberId: "__system__",
      kind: "member.joined",
      content: JSON.stringify({ memberId: "x1", members: [human, agentX] }),
      ts: 1700000000000,
    });
    expect(e.kind).toBe("member.joined");
    expect(e.senderMemberId).toBe("__system__");
  });

  test("defaults addressedTo to empty array", () => {
    const e = LedgerEntry.parse({
      seq: 3,
      conversationId: "conv-1",
      senderMemberId: "h1",
      kind: "message",
      content: JSON.stringify({}),
      ts: 1700000000000,
    });
    expect(e.addressedTo).toEqual([]);
  });
});

// ─── assertMember ──────────────────────────────────────────

describe("assertMember", () => {
  test("returns member for valid memberId", () => {
    const conv = makeConv();
    const m = assertMember(conv, "h1");
    expect(m.memberId).toBe("h1");
  });

  test("throws for nonexistent memberId", () => {
    const conv = makeConv();
    expect(() => assertMember(conv, "nope")).toThrow();
  });
});

// ─── assertAgentMember ─────────────────────────────────────

describe("assertAgentMember", () => {
  test("returns agent member for valid agent memberId", () => {
    const conv = makeConv();
    const m = assertAgentMember(conv, "x1");
    expect(m.kind).toBe("agent");
    expect(m.agentId).toBe("ag-x");
  });

  test("throws for human memberId", () => {
    const conv = makeConv();
    expect(() => assertAgentMember(conv, "h1")).toThrow();
  });

  test("throws for nonexistent memberId", () => {
    const conv = makeConv();
    expect(() => assertAgentMember(conv, "nope")).toThrow();
  });
});

// ─── resolveTriggerTargets ─────────────────────────────────

describe("resolveTriggerTargets", () => {
  test("returns agent members that are in addressedTo", () => {
    const conv = makeConv();
    const targets = resolveTriggerTargets(conv, ["x1"]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.memberId).toBe("x1");
  });

  test("filters out human members from addressedTo", () => {
    const conv = makeConv();
    const targets = resolveTriggerTargets(conv, ["h1", "x1"]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.memberId).toBe("x1");
  });

  test("filters out nonexistent memberIds", () => {
    const conv = makeConv();
    const targets = resolveTriggerTargets(conv, ["nope", "x1", "also-nope"]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.memberId).toBe("x1");
  });

  test("returns empty array when no agents addressed", () => {
    const conv = makeConv();
    const targets = resolveTriggerTargets(conv, ["h1"]);
    expect(targets).toEqual([]);
  });

  test("returns empty array for empty addressedTo", () => {
    const conv = makeConv();
    const targets = resolveTriggerTargets(conv, []);
    expect(targets).toEqual([]);
  });
});
