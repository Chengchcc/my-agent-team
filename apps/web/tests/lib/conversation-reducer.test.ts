import { describe, test, expect } from "bun:test";
import {
  reducer,
  initialState,
  type Action,
  type ConvState,
  type SenderRef,
} from "../../src/lib/conversation-reducer";

const a1 = "agent-1";
const a2 = "agent-2";
const viewer = "human-me";
const viewerRef: SenderRef = { memberId: viewer, kind: "human", displayName: "Me" };
const agentRef: SenderRef = { memberId: a1, kind: "agent", displayName: "AgentX" };
const agent2Ref: SenderRef = { memberId: a2, kind: "agent", displayName: "AgentY" };

function bootstrap(viewerMemberId?: string, members?: SenderRef[]): Action {
  return {
    type: "bootstrap",
    viewerMemberId: viewerMemberId ?? viewer,
    members: members ?? [viewerRef, agentRef],
  };
}

function run(...actions: Action[]): ConvState {
  return actions.reduce(reducer, initialState());
}

function runWithBootstrap(...actions: Action[]): ConvState {
  return [bootstrap(), ...actions].reduce(reducer, initialState());
}

describe("conversation-reducer", () => {
  // ─── Bootstrap ──────────────────────────────────────────

  test("bootstrap sets viewerMemberId and roster (with __system__)", () => {
    const s = run(bootstrap());
    expect(s.viewerMemberId).toBe(viewer);
    expect(s.roster["__system__"]).toEqual({
      memberId: "__system__",
      kind: "system",
    });
    expect(s.roster[a1]!.displayName).toBe("AgentX");
    expect(s.roster[viewer]!.kind).toBe("human");
  });

  test("bootstrap picks first human as viewerMemberId", () => {
    const s = run(
      bootstrap("human-b", [
        { memberId: "human-a", kind: "human", displayName: "A" },
        { memberId: "human-b", kind: "human", displayName: "B" },
        agentRef,
      ]),
    );
    expect(s.viewerMemberId).toBe("human-b");
    expect(Object.keys(s.roster)).toHaveLength(4); // 3 + __system__
  });

  // ─── Self optimistic replaced by authoritative, no duplicate ───

  test("self optimistic replaced by same-memberId authoritative ledger/message", () => {
    const s = runWithBootstrap(
      { type: "send", text: "hi", viewer: viewerRef },
      {
        type: "ledger/message",
        seq: 2,
        senderMemberId: viewer,
        content: "hi",
      },
    );
    const selfMsgs = s.messages.filter(
      (m) => m.sender.memberId === viewer,
    );
    expect(selfMsgs).toHaveLength(1);
    expect(selfMsgs[0]!.id).toBe("s-2");
  });

  // ─── Other (agent) message does not overwrite optimistic ───

  test("other agent message renders sender.kind=agent, does not overwrite optimistic", () => {
    const s = runWithBootstrap(
      { type: "send", text: "hello", viewer: viewerRef },
      {
        type: "ledger/message",
        seq: 3,
        senderMemberId: a1,
        content: "hello back",
      },
    );
    expect(s.messages.filter((m) => m.sender.memberId === viewer)).toHaveLength(1);
    expect(s.messages.filter((m) => m.sender.memberId === a1)).toHaveLength(1);
    expect(s.messages[1]!.sender.kind).toBe("agent");
  });

  // ─── Draft cleared by authoritative ─────────────────────

  test("delta → same-agent authoritative clears draft", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "Hello",
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: " world",
      },
      {
        type: "ledger/message",
        seq: 5,
        senderMemberId: a1,
        content: "Hello world, complete",
      },
    );
    expect(s.draft).toBeNull();
    expect(
      s.messages.filter((m) => m.sender.memberId === a1),
    ).toHaveLength(1);
    expect(s.messages.at(-1)!.content).toBe("Hello world, complete");
  });

  test("self authoritative message clears draft", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "thinking...",
      },
      {
        type: "ledger/message",
        seq: 3,
        senderMemberId: viewer,
        content: "next question",
      },
    );
    expect(s.draft).toBeNull();
  });

  // ─── Multi-agent: different agent authoritative does NOT clear draft ───

  test("multi-agent: A draft persists when B's authoritative message arrives", () => {
    const init = runWithBootstrap(
      bootstrap(viewer, [viewerRef, agentRef, agent2Ref]),
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "AgentX thinking...",
      },
    );
    expect(init.draft).not.toBeNull();
    expect(init.draft!.agentMemberId).toBe(a1);

    const s = reducer(init, {
      type: "ledger/message",
      seq: 10,
      senderMemberId: a2,
      content: "AgentY finished first",
    });
    // A1's draft should survive because the authoritative was from A2
    expect(s.draft).not.toBeNull();
    expect(s.draft!.agentMemberId).toBe(a1);
    expect(s.draft!.text).toBe("AgentX thinking...");
    // Both messages present
    expect(s.messages.filter((m) => m.sender.memberId === a2)).toHaveLength(1);
  });

  test("multi-agent: A's own authoritative clears A's draft, B's does not", () => {
    const init = runWithBootstrap(
      bootstrap(viewer, [viewerRef, agentRef, agent2Ref]),
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "A working",
      },
    );
    const s = reducer(init, {
      type: "ledger/message",
      seq: 5,
      senderMemberId: a1,
      content: "A done",
    });
    expect(s.draft).toBeNull();
    expect(s.messages.filter((m) => m.sender.memberId === a1)).toHaveLength(1);
  });

  // ─── member.joined / member.left ────────────────────────

  test("member.joined updates roster and drops system notice", () => {
    const s = runWithBootstrap(
      {
        type: "ledger/member",
        seq: 4,
        kind: "member.joined",
        payload: {
          members: [
            { memberId: viewer, kind: "human", displayName: "Me" },
            { memberId: a1, kind: "agent", displayName: "AgentX" },
            { memberId: a2, kind: "agent", displayName: "AgentY" },
          ],
        },
      },
    );
    expect(s.roster[a2]!.displayName).toBe("AgentY");
    expect(
      s.messages.filter((m) => m.sender.kind === "system"),
    ).toHaveLength(1);
    const sysMsg = s.messages.find((m) => m.sender.kind === "system");
    expect(typeof sysMsg!.content).toBe("string");
    expect(sysMsg!.content as string).toContain("加入");
    expect(sysMsg!.content as string).toContain("AgentY");
  });

  test("member.left updates roster and drops system notice", () => {
    const s = run(
      bootstrap(viewer, [viewerRef, agentRef, agent2Ref]),
      {
        type: "ledger/member",
        seq: 5,
        kind: "member.left",
        payload: {
          members: [
            { memberId: viewer, kind: "human", displayName: "Me" },
            { memberId: a1, kind: "agent", displayName: "AgentX" },
          ],
        },
      },
    );
    const sysMsg = s.messages.find((m) => m.sender.kind === "system");
    expect(typeof sysMsg!.content).toBe("string");
    expect(sysMsg!.content as string).toContain("离开");
    // A2 is no longer in roster payload, but we keep last-known roster
    // (ledger/member does full replace of payload members)
    expect(s.roster[a1]!.displayName).toBe("AgentX");
  });

  // ─── run/done + run/completed idempotent ────────────────

  test("run/done and run/completed double-trigger is idempotent", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      { type: "run/done" },
      { type: "run/completed" },
    );
    expect(s.run.phase).toBe("done");
  });

  test("run/completed does not overwrite interrupted phase", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "run/interrupted",
        payload: { pendingTool: { id: "t1", name: "bash", input: {} } },
      },
      { type: "run/completed" },
    );
    expect(s.run.phase).toBe("interrupted");
    expect(s.pendingInterrupt).not.toBeNull();
  });

  test("run/error phase survives run/done", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "partial",
      },
      { type: "run/error", message: "boom" },
      { type: "run/done" },
    );
    expect(s.run.phase).toBe("error");
    expect(s.draft).toBeNull();
  });

  // ─── Unknown sender falls back to agent kind ────────────

  test("unknown senderMemberId falls back to agent kind, does not crash", () => {
    const s = runWithBootstrap(
      {
        type: "ledger/message",
        seq: 7,
        senderMemberId: "ghost-unknown",
        content: "mystery",
      },
    );
    const msg = s.messages.find(
      (m) => m.id === "s-7",
    );
    expect(msg).not.toBeNull();
    expect(msg!.sender.memberId).toBe("ghost-unknown");
    expect(msg!.sender.kind).toBe("agent");
  });

  // ─── Tool tracking ─────────────────────────────────────

  test("toolStart and toolEnd track active tools in draft", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "Let me check",
      },
      { type: "stream/toolStart", id: "t1", name: "bash" },
      { type: "stream/toolStart", id: "t2", name: "read" },
      { type: "stream/toolEnd", id: "t1" },
    );
    expect(s.draft!.tools).toHaveLength(1);
    expect(s.draft!.tools[0]!.name).toBe("read");
  });

  // ─── run/error clears draft ─────────────────────────────

  test("run/error sets phase and clears draft", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      {
        type: "stream/delta",
        runId: "r1",
        agentMemberId: a1,
        blockIndex: 0,
        text: "partial",
      },
      { type: "run/error", message: "boom" },
    );
    expect(s.run.phase).toBe("error");
    expect(s.draft).toBeNull();
  });

  // ─── Degeneracy: resolveAddressedTo (single agent) ─────

  test("resolveAddressedTo returns single agent memberId for single-agent roster", () => {
    function resolveAddressedTo(s: ConvState): string[] {
      const agents = Object.values(s.roster).filter(
        (m) => m.kind === "agent",
      );
      return agents.length === 1 ? [agents[0]!.memberId] : [];
    }
    const s = run(bootstrap());
    expect(resolveAddressedTo(s)).toEqual([a1]);
  });

  test("resolveAddressedTo returns empty for multi-agent roster", () => {
    function resolveAddressedTo(s: ConvState): string[] {
      const agents = Object.values(s.roster).filter(
        (m) => m.kind === "agent",
      );
      return agents.length === 1 ? [agents[0]!.memberId] : [];
    }
    const s = run(
      bootstrap(viewer, [viewerRef, agentRef, agent2Ref]),
    );
    // M14 single-agent degeneracy: only auto-resolve when exactly 1 agent
    const result = resolveAddressedTo(s);
    expect(result).toEqual([]);
  });
});
