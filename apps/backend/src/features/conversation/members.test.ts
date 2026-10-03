import { describe, expect, test } from "bun:test";
import { createConversationMembers } from "./members.js";

/** Minimal port double: an in-memory member roster. */
type MemberPort = Parameters<typeof createConversationMembers>[0]["port"];

function portWith(initial: Record<string, string[]>): MemberPort & {
  roster: Map<string, Set<string>>;
} {
  const roster = new Map(Object.entries(initial).map(([k, v]) => [k, new Set(v)]));
  return {
    roster,
    listMembers: (cid: string) => [...(roster.get(cid) ?? [])],
    addMember: (cid: string, agentId: string, _addedAt: number) => {
      const set = roster.get(cid) ?? new Set<string>();
      const added = !set.has(agentId);
      set.add(agentId);
      roster.set(cid, set);
      return added;
    },
    removeMember: (cid: string, agentId: string) => {
      const set = roster.get(cid);
      if (!set?.has(agentId)) return false;
      set.delete(agentId);
      return true;
    },
  } satisfies MemberPort & { roster: Map<string, Set<string>> };
}

const agents = new Set(["coder", "writer"]);

describe("conversation members (ADR 0041)", () => {
  test("add is idempotent and validates the agent exists", async () => {
    const p = portWith({ c1: ["coder"] });
    const m = createConversationMembers({ port: p, agentExists: (id) => agents.has(id) });
    await expect(m.add("c1", "writer")).resolves.toBe(true);
    await expect(m.add("c1", "writer")).resolves.toBe(false); // already a member
    await expect(m.add("c1", "ghost")).rejects.toThrow(/unknown agent/);
    expect(m.list("c1").sort()).toEqual(["coder", "writer"]);
  });

  test("the last member cannot be removed — a room never goes memberless", () => {
    const p = portWith({ c1: ["coder"] });
    const m = createConversationMembers({ port: p, agentExists: () => true });
    expect(() => m.remove("c1", "coder")).toThrow(/last member/);
  });

  test("remove drops membership but keeps others intact; non-member remove is false", () => {
    const p = portWith({ c1: ["coder", "writer"] });
    const m = createConversationMembers({ port: p, agentExists: () => true });
    expect(m.remove("c1", "writer")).toBe(true);
    expect(m.remove("c1", "writer")).toBe(false);
    expect(m.list("c1")).toEqual(["coder"]);
  });
});
