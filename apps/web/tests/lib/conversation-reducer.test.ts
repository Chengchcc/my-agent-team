import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "../../src/lib/api";
import type { UiMessage } from "../../src/lib/conversation-reducer";
import {
  type Action,
  type ConvState,
  groupTurns,
  initialState,
  isConclusionMessage,
  reducer,
  type SenderRef,
} from "../../src/lib/conversation-reducer";
import { type BlockLike, collectToolResults } from "../../src/lib/render-blocks";

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
    expect(s.roster.__system__).toEqual({
      memberId: "__system__",
      kind: "system",
    });
    expect(s.roster[a1]?.displayName).toBe("AgentX");
    expect(s.roster[viewer]?.kind).toBe("human");
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
    const selfMsgs = s.messages.filter((m) => m.sender.memberId === viewer);
    expect(selfMsgs).toHaveLength(1);
    expect(selfMsgs[0]?.id).toBe("s-2");
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
    expect(s.messages[1]?.sender.kind).toBe("agent");
  });

  // ─── Draft cleared by authoritative ─────────────────────

  test("delta → same-agent ledger message does NOT clear draft while running (incremental projection flicker prevention)", () => {
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
    // Draft persists because phase is still "running" — clearing now
    // would cause flicker from incremental projection.
    expect(s.draft).not.toBeNull();
    expect(s.draft?.text).toBe("Hello world");
    expect(s.messages.filter((m) => m.sender.memberId === a1)).toHaveLength(1);
  });

  test("self message preserves draft while running (not cleared until done)", () => {
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
    // Draft persists while run is still running (phase is "running")
    expect(s.draft).not.toBeNull();
    expect(s.draft?.text).toBe("thinking...");
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
    expect(init.draft?.agentMemberId).toBe(a1);

    const s = reducer(init, {
      type: "ledger/message",
      seq: 10,
      senderMemberId: a2,
      content: "AgentY finished first",
    });
    // A1's draft should survive because the authoritative was from A2
    expect(s.draft).not.toBeNull();
    expect(s.draft?.agentMemberId).toBe(a1);
    expect(s.draft?.text).toBe("AgentX thinking...");
    // Both messages present
    expect(s.messages.filter((m) => m.sender.memberId === a2)).toHaveLength(1);
  });

  test("multi-agent: A's draft persists while running, cleared on done", () => {
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
    // During running: draft persists (incremental projection guard)
    const running = reducer(init, {
      type: "ledger/message",
      seq: 5,
      senderMemberId: a1,
      content: "A done",
    });
    expect(running.draft).not.toBeNull();
    expect(running.draft?.text).toBe("A working");
    // After done: draft is cleared
    const done = reducer(running, { type: "run/done" });
    const cleared = reducer(done, {
      type: "ledger/message",
      seq: 5,
      senderMemberId: a1,
      content: "A done",
    });
    expect(cleared.draft).toBeNull();
  });

  // ─── member.joined / member.left ────────────────────────

  test("member.joined updates roster and drops system notice", () => {
    const s = runWithBootstrap({
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
    });
    expect(s.roster[a2]?.displayName).toBe("AgentY");
    expect(s.messages.filter((m) => m.sender.kind === "system")).toHaveLength(1);
    const sysMsg = s.messages.find((m) => m.sender.kind === "system");
    expect(typeof sysMsg?.content).toBe("string");
    expect(sysMsg?.content as string).toContain("加入");
    expect(sysMsg?.content as string).toContain("AgentY");
  });

  test("member.left updates roster and drops system notice", () => {
    const s = run(bootstrap(viewer, [viewerRef, agentRef, agent2Ref]), {
      type: "ledger/member",
      seq: 5,
      kind: "member.left",
      payload: {
        members: [
          { memberId: viewer, kind: "human", displayName: "Me" },
          { memberId: a1, kind: "agent", displayName: "AgentX" },
        ],
      },
    });
    const sysMsg = s.messages.find((m) => m.sender.kind === "system");
    expect(typeof sysMsg?.content).toBe("string");
    expect(sysMsg?.content as string).toContain("离开");
    // A2 is no longer in roster payload, but we keep last-known roster
    // (ledger/member does full replace of payload members)
    expect(s.roster[a1]?.displayName).toBe("AgentX");
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
    const s = runWithBootstrap({
      type: "ledger/message",
      seq: 7,
      senderMemberId: "ghost-unknown",
      content: "mystery",
    });
    const msg = s.messages.find((m) => m.id === "s-7");
    expect(msg).not.toBeNull();
    expect(msg?.sender.memberId).toBe("ghost-unknown");
    expect(msg?.sender.kind).toBe("agent");
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
    expect(s.draft?.tools).toHaveLength(1);
    expect(s.draft?.tools[0]?.name).toBe("read");
  });

  test("toolStart before first text_delta creates a minimal draft", () => {
    const s = runWithBootstrap(
      {
        type: "run/started",
        runId: "r1",
        agentMemberId: a1,
      },
      { type: "stream/toolStart", id: "t1", name: "bash" },
    );
    expect(s.draft).not.toBeNull();
    expect(s.draft?.agentMemberId).toBe(a1);
    expect(s.draft?.runId).toBe("r1");
    expect(s.draft?.text).toBe("");
    expect(s.draft?.tools).toHaveLength(1);
    expect(s.draft?.tools[0]?.name).toBe("bash");
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
      const agents = Object.values(s.roster).filter((m) => m.kind === "agent");
      return agents.length === 1 ? [agents[0]!.memberId] : [];
    }
    const s = run(bootstrap());
    expect(resolveAddressedTo(s)).toEqual([a1]);
  });

  test("resolveAddressedTo returns empty for multi-agent roster", () => {
    function resolveAddressedTo(s: ConvState): string[] {
      const agents = Object.values(s.roster).filter((m) => m.kind === "agent");
      return agents.length === 1 ? [agents[0]!.memberId] : [];
    }
    const s = run(bootstrap(viewer, [viewerRef, agentRef, agent2Ref]));
    // M14 single-agent degeneracy: only auto-resolve when exactly 1 agent
    const result = resolveAddressedTo(s);
    expect(result).toEqual([]);
  });

  // ─── { text } unwrap (ledger Conversation Projection backfill compat) ──────

  test("agent message with { text } content is unwrapped to string", () => {
    const s = runWithBootstrap({
      type: "ledger/message",
      seq: 3,
      senderMemberId: a1,
      content: { text: "hello from agent" },
    });
    const msg = s.messages.find((m) => m.sender.memberId === a1);
    expect(msg).not.toBeNull();
    expect(typeof msg?.content).toBe("string");
    expect(msg?.content).toBe("hello from agent");
  });

  // ─── M15.1 { blocks, runId } envelope unwrap (Bug 1 fix) ──

  test("{ blocks, runId } envelope is unwrapped to ContentBlock array", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "hi" }];
    const s = runWithBootstrap({
      type: "ledger/message",
      seq: 4,
      senderMemberId: a1,
      content: { blocks, runId: "r1" },
    });
    const msg = s.messages.find((m) => m.id === "s-4");
    expect(msg).not.toBeNull();
    expect(Array.isArray(msg?.content)).toBe(true);
    const content = msg?.content as ContentBlock[];
    expect(content[0]?.type).toBe("text");
    expect((content[0] as { text: string }).text).toBe("hi");
  });

  test("{ text, runId } envelope is unwrapped to string", () => {
    const s = runWithBootstrap({
      type: "ledger/message",
      seq: 5,
      senderMemberId: a1,
      content: { text: "hi from agent", runId: "r2" },
    });
    const msg = s.messages.find((m) => m.id === "s-5");
    expect(msg).not.toBeNull();
    expect(typeof msg?.content).toBe("string");
    expect(msg?.content).toBe("hi from agent");
  });
});

// ─── M14.5: isConclusionMessage ──────────────────────────

describe("M14.5 isConclusionMessage", () => {
  function msg(content: UiMessage["content"]): UiMessage {
    return { id: "m1", sender: { memberId: "a", kind: "agent" }, content };
  }

  test("string content with text → conclusion", () => {
    expect(isConclusionMessage(msg("hello"))).toBe(true);
  });

  test("empty string → not conclusion", () => {
    expect(isConclusionMessage(msg(""))).toBe(false);
    expect(isConclusionMessage(msg("   "))).toBe(false);
  });

  test("text block without tool_use → conclusion", () => {
    expect(
      isConclusionMessage(msg([{ type: "text", text: "here is the result" }] as ContentBlock[])),
    ).toBe(true);
  });

  test("text + tool_use in same message → NOT conclusion (side-talk then call)", () => {
    expect(
      isConclusionMessage(
        msg([
          { type: "text", text: "Let me check that" },
          { type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } },
        ] as ContentBlock[]),
      ),
    ).toBe(false);
  });

  test("tool_use without text → NOT conclusion", () => {
    expect(
      isConclusionMessage(
        msg([{ type: "tool_use", id: "t1", name: "bash", input: {} }] as ContentBlock[]),
      ),
    ).toBe(false);
  });

  test("tool_result-only → NOT conclusion", () => {
    expect(
      isConclusionMessage(
        msg([{ type: "tool_result", tool_use_id: "t1", content: "ok" }] as ContentBlock[]),
      ),
    ).toBe(false);
  });
});

// ─── M14.5: collectToolResults (cross-message pairing) ───

describe("M14.5 collectToolResults", () => {
  test("collects tool_result into map keyed by tool_use_id", () => {
    const map = collectToolResults([
      { type: "tool_result", tool_use_id: "t1", content: "result-a" },
      { type: "tool_result", tool_use_id: "t2", content: "result-b", is_error: true },
    ] as BlockLike[]);
    expect(map.get("t1")?.content).toBe("result-a");
    expect(map.get("t1")?.isError).toBeUndefined();
    expect(map.get("t2")?.content).toBe("result-b");
    expect(map.get("t2")?.isError).toBe(true);
  });

  test("appends to existing map (cross-message aggregation)", () => {
    const map = new Map<string, { content: string; isError?: boolean }>();
    collectToolResults(
      [{ type: "tool_result", tool_use_id: "t1", content: "first" }] as BlockLike[],
      map,
    );
    collectToolResults(
      [{ type: "tool_result", tool_use_id: "t2", content: "second" }] as BlockLike[],
      map,
    );
    expect(map.size).toBe(2);
    expect(map.get("t1")?.content).toBe("first");
    expect(map.get("t2")?.content).toBe("second");
  });

  test("skips blocks without tool_use_id", () => {
    const map = collectToolResults([
      { type: "text", text: "hello" },
      { type: "tool_result" }, // missing tool_use_id
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ] as BlockLike[]);
    expect(map.size).toBe(1);
  });
});

// ─── M14.5: groupTurns ───────────────────────────────────

describe("M14.5 groupTurns", () => {
  const sender: UiMessage["sender"] = { memberId: "ag-x", kind: "agent", displayName: "X" };
  const human: UiMessage["sender"] = { memberId: "h1", kind: "human", displayName: "Me" };

  function m(id: string, overrides?: Partial<Pick<UiMessage, "sender" | "content">>): UiMessage {
    return {
      id,
      sender: overrides?.sender ?? sender,
      content: overrides?.content ?? "text",
    };
  }

  test("human + pure text agent → single + turn (no rounds, only conclusion)", () => {
    const segs = groupTurns([
      m("1", { sender: human, content: "query" }),
      m("2", { content: "answer" }),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.kind).toBe("single");
    expect(segs[1]?.kind).toBe("turn");
    const turn = segs[1] as Extract<(typeof segs)[number], { kind: "turn" }>;
    expect(turn.rounds).toHaveLength(0);
    expect(turn.conclusion?.id).toBe("2");
  });

  test("agent with 2 tool rounds + conclusion → rounds=4, conclusion=last text", () => {
    const msgs: UiMessage[] = [
      m("1", {
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] as ContentBlock[],
      }),
      m("2", {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] as ContentBlock[],
      }),
      m("3", {
        content: [{ type: "tool_use", id: "t2", name: "summarize", input: {} }] as ContentBlock[],
      }),
      m("4", {
        content: [{ type: "tool_result", tool_use_id: "t2", content: "summary" }] as ContentBlock[],
      }),
      m("5", { content: "All done" }),
    ];
    const segs = groupTurns(msgs);
    expect(segs).toHaveLength(1);
    const turn = segs[0] as Extract<(typeof segs)[number], { kind: "turn" }>;
    expect(turn.kind).toBe("turn");
    expect(turn.rounds).toHaveLength(4);
    expect(turn.conclusion?.id).toBe("5");
  });

  test("text + tool_use same message → that message is a round, not conclusion", () => {
    const msgs: UiMessage[] = [
      m("1", {
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "t1", name: "lookup", input: {} },
        ] as ContentBlock[],
      }),
      m("2", {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] as ContentBlock[],
      }),
      m("3", { content: "Done" }),
    ];
    const segs = groupTurns(msgs);
    const turn = segs[0] as Extract<(typeof segs)[number], { kind: "turn" }>;
    expect(turn.rounds).toHaveLength(2); // m1 (text+tool_use) + m2 (tool_result)
    expect(turn.conclusion?.id).toBe("3");
  });

  test("interrupted turn (last msg still has tool_use) → conclusion=null", () => {
    const msgs: UiMessage[] = [
      m("1", {
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "t1", name: "lookup", input: {} },
        ] as ContentBlock[],
      }),
      m("2", {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] as ContentBlock[],
      }),
      m("3", {
        content: [{ type: "tool_use", id: "t2", name: "summarize", input: {} }] as ContentBlock[],
      }),
    ];
    const segs = groupTurns(msgs);
    const turn = segs[0] as Extract<(typeof segs)[number], { kind: "turn" }>;
    expect(turn.rounds).toHaveLength(3);
    expect(turn.conclusion).toBeNull();
  });

  test("two different agents → two separate turns", () => {
    const x = { memberId: "ag-x", kind: "agent" as const };
    const y = { memberId: "ag-y", kind: "agent" as const };
    const msgs: UiMessage[] = [
      m("1", { sender: x, content: "X done" }),
      m("2", { sender: y, content: "Y done" }),
    ];
    const segs = groupTurns(msgs);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.kind).toBe("turn");
    expect(segs[1]?.kind).toBe("turn");
    expect((segs[0] as Extract<(typeof segs)[number], { kind: "turn" }>).sender.memberId).toBe(
      "ag-x",
    );
    expect((segs[1] as Extract<(typeof segs)[number], { kind: "turn" }>).sender.memberId).toBe(
      "ag-y",
    );
  });

  test("human interleaved between agent messages → breaks the turn", () => {
    const msgs: UiMessage[] = [
      m("1", { content: "A1" }),
      m("2", { sender: human, content: "human says" }),
      m("3", { content: "A2" }),
    ];
    const segs = groupTurns(msgs);
    expect(segs).toHaveLength(3); // turn, single, turn
    expect(segs[0]?.kind).toBe("turn");
    expect(segs[1]?.kind).toBe("single");
    expect(segs[2]?.kind).toBe("turn");
  });

  test("tool_result cross-message: collected from rounds (regression for completed tool_result rendering)", () => {
    // Simulate what ReasoningTrace does: aggregate tool_results from all rounds
    const msgs: UiMessage[] = [
      m("1", {
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] as ContentBlock[],
      }),
      m("2", {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result-data" },
        ] as ContentBlock[],
      }),
      m("3", { content: "Conclusion" }),
    ];
    const segs = groupTurns(msgs);
    const turn = segs[0] as Extract<(typeof segs)[number], { kind: "turn" }>;

    // Cross-message collection (same as ReasoningTrace)
    const resultMap = new Map<string, { content: string; isError?: boolean }>();
    for (const round of turn.rounds) {
      if (Array.isArray(round.content)) {
        collectToolResults(round.content as BlockLike[], resultMap);
      }
    }
    expect(resultMap.get("t1")?.content).toBe("result-data");
  });
});
