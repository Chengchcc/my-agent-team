import { describe, expect, test } from "bun:test";
import type {
  AgentRunSnapshot,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../store/in-memory-session-store.js";
import type { ContextBudget } from "./agent-loop.js";
import { createOmaSession } from "./agent-loop.js";
import type { CodingLoopInput } from "./loop-input.js";
import type { Plugin } from "./plugin.js";

// Title generation performs an extra ephemeral model call; keep counts
// deterministic.

const LOOP_RUN: AgentRunSnapshot<"oma"> = {
  runId: "ovf-run",
  model: { backendKind: "oma", modelId: "test-1" },
  configRevision: 1,
};
const LOOP_WS: WorkspaceBinding = { root: "/ws", access: "read_write" };
const LOOP_META = { conversationId: "c", agentId: "m", branchId: "b", productRevision: 1 };

function loopInput(message: string, history?: CodingLoopInput["history"]): CodingLoopInput {
  return {
    history: history ?? [],
    input: { inputId: "ti", message: { role: "user", text: message } },
    run: LOOP_RUN,
    workspace: LOOP_WS,
    metadata: LOOP_META,
  };
}

async function freshStore(sid: string) {
  const store = createInMemorySessionStore();
  await store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return store;
}

const charsPer4 = (m: { text?: string }): number => Math.ceil((m.text?.length ?? 0) / 4) + 4;

const bigToolPlugin: Plugin = {
  name: "test-tools",
  tools: [
    {
      name: "big",
      description: "returns a big result",
      async execute() {
        return { content: "y".repeat(4000) };
      },
    },
  ],
};

describe("agent loop context handling (oh-my-pi absorption)", () => {
  test("silent overflow (zai-style) triggers one-shot compaction and same-turn retry", async () => {
    const store = await freshStore("ovf-silent");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-silent",
      store,
      plugins: [],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 1000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          // Silent overflow: the provider accepted an oversized request.
          yield { usage: { input: 5000, output: 3, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "text", text: "truncated garbage" } };
          yield { stopReason: "end_turn" };
          return;
        }
        yield { usage: { input: 50, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "recovered" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hello"));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(events).toContain("compaction_start");
    expect(events).toContain("compaction_end");
    // The overflowed attempt was discarded pre-persistence; only the retry
    // survives in the canonical sequence.
    expect(result.messages?.at(-1)).toMatchObject({ text: "recovered" });
    expect(JSON.stringify(result.messages)).not.toContain("truncated garbage");
  });

  test("usage anchor suppresses threshold compaction when real usage is small", async () => {
    // Pre-boundary history estimates to ~2000 chars/4 tokens; the anchor
    // (call 1's real usage: 1005) plus the post-boundary delta must stay
    // under the 2800 threshold — while full per-message estimation
    // (~2062 + ~1018 for the giant tool result) would cross it.
    const history: ProjectedHistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(1000) },
    }));
    const store = await freshStore("ovf-anchor");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-anchor",
      store,
      plugins: [bigToolPlugin],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 4000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          yield { usage: { input: 1000, output: 5, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "tool_use", id: "t1", name: "big" } };
          return;
        }
        yield { usage: { input: 1200, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(events).not.toContain("compaction_start");
  });

  test("control: without usage the same shape crosses the threshold and compacts", async () => {
    const history: ProjectedHistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(1000) },
    }));
    const store = await freshStore("ovf-ctrl");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-ctrl",
      store,
      plugins: [bigToolPlugin],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 4000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          // No usage chunks: no anchor, full per-message estimation.
          yield { delta: { type: "tool_use", id: "t1", name: "big" } };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    expect(events).toContain("compaction_start");
  });

  /** The threshold fired at `limit * triggerRatio` while compactSession sized
   *  the retained tail to `limit` — so a freshly compacted branch is over the
   *  threshold BY CONSTRUCTION. An overflow recovery that left the gate open
   *  therefore compacted a SECOND time on the next iteration: re-summarizing
   *  entries the first compaction had already covered and cutting into the tail
   *  it deliberately retained.
   *
   *  Reaching that state needs a live usage anchor: without one the first
   *  iteration's estimate IS findCut's raw sum, so the threshold trigger always
   *  fires before an overflow can. Numbers below: history 6×400 chars = 624
   *  (< 700 threshold), call 1 anchors 105, the 2000-char tool result adds 509
   *  (estimate 614, still under), while the raw branch is 1133 > the 1000 limit
   *  so the overflow recovery really does cover something. */
  test("an overflow recovery does not immediately compact again", async () => {
    const midToolPlugin: Plugin = {
      name: "mid-tools",
      tools: [
        {
          name: "mid",
          description: "returns a medium result",
          async execute() {
            return { content: "y".repeat(2000) };
          },
        },
      ],
    };
    const history: ProjectedHistoryItem[] = Array.from({ length: 6 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(400) },
    }));
    const store = await freshStore("ovf-once");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-once",
      store,
      plugins: [midToolPlugin],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 1_000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          yield { usage: { input: 100, output: 5, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "tool_use", id: "t1", name: "mid" } };
          return;
        }
        if (calls === 2) {
          // Silent overflow: the provider ACCEPTED the oversized request.
          yield { usage: { input: 5000, output: 3, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "text", text: "ignored" } };
          yield { stopReason: "end_turn" };
          return;
        }
        yield { usage: { input: 800, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "recovered" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    expect(calls).toBe(3);
    // Exactly ONE compaction for the whole Run.
    expect(events.filter((t) => t === "compaction_start")).toHaveLength(1);
    const branch = await store.readBranch("ovf-once");
    expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
  });

  /** The no-progress guard must not become a permanent off-switch: compaction
   *  targets the TRIGGER, so the estimate lands under it, the gate re-arms, and
   *  a Run that grows again compacts again. (Regression found in review of an
   *  earlier version of this change set: the flag was set on an overflow
   *  recovery and never cleared, disabling proactive compaction for the rest of
   *  the Run.)
   *
   *  Numbers: limit 2000, trigger 1400. History 8x400 chars = 832 + meta +
   *  prompt, so iteration 1 is comfortably under; the 4000-char tool result
   *  takes it to ~1840 and it compacts — covering the 8 history messages and
   *  leaving a live tail of ~1020, UNDER the trigger, which is what re-arms the
   *  gate. The second tool round then takes it over again and compacting is
   *  allowed a second time. */
  test("the gate re-arms after the context is healthy again", async () => {
    const bigToolPlugin: Plugin = {
      name: "big-tools",
      tools: [
        {
          name: "big",
          description: "returns a big result",
          async execute() {
            return { content: "y".repeat(4000) };
          },
        },
      ],
    };
    const history: ProjectedHistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(400) },
    }));
    const store = await freshStore("ovf-rearm");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-rearm",
      store,
      plugins: [bigToolPlugin],
      maxSteps: 8,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: { estimate: charsPer4, limit: 2_000, triggerRatio: 0.7 },
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls <= 2) {
          // Realistic usage (it tracks the context): the anchor is the
          // provider's own accounting, so unrealistically small numbers would
          // legitimately suppress the trigger.
          yield {
            usage: { input: calls === 1 ? 900 : 1_050, output: 5, cacheRead: 0, cacheCreate: 0 },
          };
          yield { delta: { type: "tool_use", id: `t${calls}`, name: "big" } };
          return;
        }
        yield { usage: { input: 500, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    // Grow -> compact -> settle (gate re-armed) -> grow again -> compact again.
    expect(events.filter((t) => t === "compaction_start")).toHaveLength(2);
  });

  /** A resumed branch already carries a CompactionEntry. Its covered entries
   *  are no longer sent, so counting them (the pre-fix behavior) put the
   *  estimate over the threshold the moment a session was resumed and compacted
   *  again for no reason. */
  test("covered entries from an earlier compaction are not counted", async () => {
    const store = await freshStore("ovf-covered");
    const seeded = await store.appendBatch("ovf-covered", {
      entries: Array.from({ length: 8 }, (_, i) => ({
        type: "message" as const,
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        source: "prompt" as const,
        message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(1000) },
        createdAt: i,
      })),
    });
    await store.appendBatch("ovf-covered", {
      entries: [
        {
          type: "compaction",
          summary: "older conversation",
          coversEntryIds: seeded.appendedIds,
          createdAt: 100,
        },
      ],
    });

    const events: string[] = [];
    const session = createOmaSession({
      sessionId: "ovf-covered",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 1_000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        yield { usage: { input: 50, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "ok" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi"));
    expect(result.status).toBe("completed");
    // 8 covered messages ≈ 2032 estimated tokens > 700 threshold. Only the
    // prompt + summary are live.
    expect(events).not.toContain("compaction_start");
    const branch = await store.readBranch("ovf-covered");
    expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
  });

  test("steer drain emits queue_update with the drained user texts", async () => {
    const store = await freshStore("steer-drain");
    const queueEvents: Array<{ drained?: readonly string[] }> = [];
    let loopRef: ReturnType<typeof createOmaSession> | null = null;
    const gateTool = {
      name: "gate",
      description: "steers the loop mid-execution",
      execute() {
        loopRef?.steer({ inputId: "s1", message: { role: "user", text: "correction" } });
        return Promise.resolve({ ok: true });
      },
    };
    let calls = 0;
    const session = createOmaSession({
      sessionId: "steer-drain",
      store,
      plugins: [{ name: "t", tools: [gateTool] }],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "gate" } };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    loopRef = session;
    session.onEvent((e) => {
      if (e.type === "queue_update") queueEvents.push({ drained: e.drained });
    });
    const result = await session.startLoop(loopInput("go"));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    // pi's message_start(user) signal: the surface learns the steer was
    // actually injected, with its text.
    expect(queueEvents).toEqual([{ drained: ["correction"] }]);
    const snap = await store.open("steer-drain");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
  });
});
