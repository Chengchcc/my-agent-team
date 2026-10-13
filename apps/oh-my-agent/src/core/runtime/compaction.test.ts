import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../store/in-memory-session-store.js";
import { readBranchMessages } from "./agent-loop-run.js";
import type { ContextSummarizer } from "./agent-loop-types.js";
import { compactSession, latestCompaction } from "./compaction.js";

async function setup(messages: Array<Record<string, unknown>>) {
  const store = createInMemorySessionStore();
  const sid = `compaction-${Math.random().toString(36).slice(2, 8)}`;
  await store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.appendBatch(sid, { entries: messages });
  return { store, sid };
}

describe("compactSession", () => {
  test("cut does not split assistant tool_use from its tool_result", async () => {
    // 5 messages; raw 60% cut = 3, which would cover [m1, m2, assistant(tool_use)]
    // and leave an orphan tool_result.
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "assistant",
        source: "assistant",
        message: {
          role: "assistant",
          text: "",
          blocks: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
        },
        createdAt: 3,
      },
      {
        type: "message",
        role: "tool",
        source: "tool_result",
        message: {
          role: "tool",
          text: "{}",
          blocks: [{ type: "tool_result", tool_use_id: "tc-1", content: "{}" }],
        },
        createdAt: 4,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "tail" },
        createdAt: 5,
      },
    ]);

    const result = await compactSession(store, sid, async (texts) => `[sum:${texts.length}]`);

    // Cut must have moved before the assistant: only m1+m2 covered
    expect(result.coveredIds).toHaveLength(2);
    const branch = await store.readBranch(sid);
    const uncovered = branch.filter((e) => !result.coveredIds.includes(e.entryId));
    const sources = uncovered.map((e) => (e as { source?: string }).source);
    // assistant tool_use and tool_result both survive
    expect(sources).toContain("assistant");
    expect(sources).toContain("tool_result");
    expect(sources).toContain("prompt"); // tail
  });

  test("cut can cover a complete tool pair when the boundary is after it", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "assistant",
        source: "assistant",
        message: {
          role: "assistant",
          text: "",
          blocks: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
        },
        createdAt: 2,
      },
      {
        type: "message",
        role: "tool",
        source: "tool_result",
        message: {
          role: "tool",
          text: "{}",
          blocks: [{ type: "tool_result", tool_use_id: "tc-1", content: "{}" }],
        },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 4,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 5,
      },
    ]);

    const result = await compactSession(store, sid, async (texts) => `[sum:${texts.length}]`);
    // Raw cut 3 lands exactly after the tool_result; no adjustment needed
    expect(result.coveredIds).toHaveLength(3);
  });

  test("under budget is a no-op: no summarizer call, no entry", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    let summarizerCalls = 0;
    const budget = {
      estimate: () => 1, // 4 messages * 1 = 4 tokens
      limit: 10, // under limit -> no compaction
    };
    const result = await compactSession(
      store,
      sid,
      async () => {
        summarizerCalls++;
        return "sum";
      },
      undefined,
      budget,
    );
    expect(summarizerCalls).toBe(0);
    expect(result.coveredIds).toHaveLength(0);
    const branch = await store.readBranch(sid);
    expect(branch.some((e) => e.type === "compaction")).toBe(false);
  });

  test("over budget cuts by tokens and records diagnostics", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    const budget = {
      estimate: () => 3, // 4 messages * 3 = 12 tokens
      limit: 9, // over limit -> compact until retained <= 9
    };
    const result = await compactSession(
      store,
      sid,
      async (msgs) => `[sum:${msgs.length}]`,
      undefined,
      budget,
    );
    // Cover oldest until remaining <= 9: cover 1 msg (12-3=9 <= 9)
    expect(result.coveredIds).toHaveLength(1);
    const branch = await store.readBranch(sid);
    const comp = branch.find((e) => e.type === "compaction") as {
      tokensBefore?: number;
      retainedEntryIds?: readonly string[];
    };
    expect(comp).toBeTruthy();
    expect(comp.tokensBefore).toBe(12);
    expect(comp.retainedEntryIds?.length).toBe(3);
  });

  /** A single entry bigger than the whole budget drove the cut to
   *  messages.length, covering every message — and the summary went with them,
   *  because it was prepended to the SURVIVORS. The model then saw a system
   *  prompt and nothing else. */
  test("an oversized newest message is never covered", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    // Every message (3) is over the limit (2): the raw cut runs to the end.
    const budget = { estimate: () => 3, limit: 2 };
    const result = await compactSession(
      store,
      sid,
      async (msgs) => `[sum:${msgs.length}]`,
      undefined,
      budget,
    );
    expect(result.coveredIds).toHaveLength(3);

    const sent = await readBranchMessages(store, sid);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toBe("[Context summary: [sum:3]]");
    expect(sent[1]?.text).toBe("m4");
  });

  /** Defense in depth: even if a CompactionEntry covers the whole branch (an
   *  older file, a hand-built store), the summary must still be sent. */
  test("a compaction covering every message still sends the summary", async () => {
    const store = createInMemorySessionStore();
    const sid = "compaction-all-covered";
    await store.create({
      sessionId: sid,
      backendKind: "oma",
      workspaceRoot: "/ws",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const appended = await store.appendBatch(sid, {
      entries: [
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "m1" },
          createdAt: 1,
        },
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "m2" },
          createdAt: 2,
        },
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "m3" },
          createdAt: 3,
        },
      ],
    });
    await store.appendBatch(sid, {
      entries: [
        {
          type: "compaction",
          summary: "everything so far",
          coversEntryIds: appended.appendedIds,
          createdAt: 4,
        },
      ],
    });

    const sent = await readBranchMessages(store, sid);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("[Context summary: everything so far]");
  });

  /** The no-progress guard, which is what lets the loop trigger compaction
   *  purely on the budget: a cut that would cover only already-covered entries
   *  buys nothing, and without this it would append an identical
   *  CompactionEntry (plus a summarizer call) on every iteration. */
  test("a cut that covers nothing new is a no-op, not a duplicate entry", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    // Over budget, so the cut reaches past the first two messages.
    const budget = { estimate: () => 3, limit: 8 };
    let calls = 0;
    const first = await compactSession(
      store,
      sid,
      async (msgs) => {
        calls++;
        return `[sum:${msgs.length}]`;
      },
      undefined,
      budget,
    );
    expect(first.coveredIds.length).toBeGreaterThan(0);
    expect(calls).toBe(1);

    // Same budget, same branch: the second run would re-cover the same ids.
    const again = await compactSession(
      store,
      sid,
      async () => {
        calls++;
        return "second";
      },
      undefined,
      budget,
    );
    expect(again.coveredIds).toHaveLength(0);
    expect(calls).toBe(1); // the summarizer was not called a second time
    const branch = await store.readBranch(sid);
    expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
  });
});

describe("compaction input budget", () => {
  /** n plain user messages, m1..mn (no tool pairs, so the cut is untouched). */
  function chat(n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
      type: "message",
      role: "user",
      source: "prompt",
      message: { role: "user", text: `m${i + 1}` },
      createdAt: i + 1,
    }));
  }

  function recorder(): {
    calls: Array<{ texts: string[]; previous?: string }>;
    summarize: ContextSummarizer;
  } {
    const calls: Array<{ texts: string[]; previous?: string }> = [];
    const summarize: ContextSummarizer = async (messages, _signal, opts) => {
      calls.push({
        texts: messages.map((m) => m.text ?? ""),
        ...(opts?.previousSummary ? { previous: opts.previousSummary } : {}),
      });
      return `sum-${calls.length}`;
    };
    return { calls, summarize };
  }

  test("a later compaction reads only the new interval, not the whole prefix", async () => {
    const { store, sid } = await setup(chat(10));
    const rec = recorder();

    // No budget: the cut is floor(len * 0.6) => 6 of 10 messages.
    const first = await compactSession(store, sid, rec.summarize);
    expect(first.coveredIds).toHaveLength(6);
    expect(rec.calls[0]?.texts).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(rec.calls[0]?.previous).toBeUndefined();

    await store.appendBatch(sid, { entries: chat(14).slice(10) });

    const second = await compactSession(store, sid, rec.summarize);
    // 8 of 14 covered — but only the 2 the first pass had not covered are read,
    // so the summarizer input grows with the NEW work, never with the
    // conversation length.
    expect(second.coveredIds).toHaveLength(8);
    expect(rec.calls[1]?.texts).toEqual(["m7", "m8"]);
    expect(rec.calls[1]?.previous).toBe("sum-1");

    // Coverage stays cumulative: the rebuild filters by the LATEST compaction
    // alone, so ids missing here would come back to the model as raw messages.
    expect(latestCompaction(await store.readBranch(sid))?.coveredIds.size).toBe(8);

    const sent = await readBranchMessages(store, sid);
    expect(sent).toHaveLength(7); // the summary plus m9..m14
    expect(sent[0]?.text).toBe("[Context summary: sum-2]");
    expect(sent.slice(1).map((m) => m.text)).toEqual(["m9", "m10", "m11", "m12", "m13", "m14"]);
  });
});
