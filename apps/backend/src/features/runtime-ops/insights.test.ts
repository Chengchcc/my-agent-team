import { describe, expect, test } from "bun:test";
import type { CheckpointEventRow } from "../../../test-helpers/mock-deps.js";
import { fakeCheckpointEventsStore } from "../../../test-helpers/mock-deps.js";
import type { CheckpointEventsStore } from "./checkpoint-events-store.js";
import { getInsightsSummary, getRunInsights } from "./insights.js";

/** Build a flat CheckpointEventRow: { ...event, spanId, sessionId, ts }. */
function row(
  sessionId: string,
  spanId: string,
  event: Record<string, unknown>,
  ts?: number,
): CheckpointEventRow {
  return {
    ...event,
    sessionId,
    spanId,
    ts: ts ?? (event.ts as number) ?? Date.now(),
  } as CheckpointEventRow;
}

describe("getRunInsights", () => {
  test("returns empty calls for run with no llm/tool events", async () => {
    const store = fakeCheckpointEventsStore();

    const result = await getRunInsights(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      {
        spanId: "run1",
        sessionId: "thread1",
        agentId: "agent1",
        status: "done",
        startedAt: 1000,
        endedAt: 5000,
      },
    );

    expect(result.calls).toHaveLength(0);
    expect(result.root.llmCalls).toBe(0);
    expect(result.root.toolCalls).toBe(0);
    expect(result.root.totalLatencyMs).toBe(4000);
  });

  test("aggregates llm_call events", async () => {
    const store = fakeCheckpointEventsStore([
      row("t1", "run1", {
        type: "model_end",
        blocks: [{ type: "text", text: "hi" }],
        usage: { input: 1000, output: 200 },
        model: "claude-sonnet-4",
        step: 0,
        latencyMs: 1500,
        ttftMs: 300,
        ts: 2000,
      }),
      row("t1", "run1", {
        type: "model_end",
        blocks: [{ type: "text", text: "there" }],
        usage: { input: 2000, output: 500 },
        model: "claude-sonnet-4",
        step: 1,
        latencyMs: 2500,
        ts: 4500,
      }),
    ]);

    const result = await getRunInsights(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      {
        spanId: "run1",
        sessionId: "t1",
        agentId: "a1",
        status: "done",
        startedAt: 1000,
        endedAt: 5000,
      },
    );

    expect(result.root.llmCalls).toBe(2);
    expect(result.root.toolCalls).toBe(0);
    expect(result.root.totalInput).toBe(3000);
    expect(result.root.totalOutput).toBe(700);
    expect(result.root.slowestCall).toEqual({
      kind: "llm",
      step: 1,
      name: "claude-sonnet-4",
      latencyMs: 2500,
    });
    expect(result.calls).toHaveLength(2);
  });

  test("aggregates tool_call events with errors", async () => {
    const store = fakeCheckpointEventsStore([
      row("t1", "run2", {
        type: "tool_end",
        result: { type: "tool_result", tool_use_id: "t1", content: "ok" },
        durationMs: 100,
        step: 0,
        name: "read_file",
        isError: false,
        ts: 1500,
      }),
      row("t1", "run2", {
        type: "tool_end",
        result: { type: "tool_result", tool_use_id: "t2", content: "err", is_error: true },
        durationMs: 300,
        step: 0,
        name: "edit_file",
        isError: true,
        ts: 1800,
      }),
      row("t1", "run2", {
        type: "tool_end",
        result: { type: "tool_result", tool_use_id: "t3", content: "ok" },
        durationMs: 80,
        step: 1,
        name: "read_file",
        isError: false,
        ts: 2000,
      }),
    ]);

    const result = await getRunInsights(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      {
        spanId: "run2",
        sessionId: "t1",
        agentId: "a1",
        status: "interrupted",
        startedAt: 1000,
        endedAt: 5000,
      },
    );

    expect(result.root.toolCalls).toBe(3);
    expect(result.root.llmCalls).toBe(0);
    expect(result.root.failedCall).toEqual({ step: 0, name: "edit_file" });
    expect(result.root.slowestCall?.name).toBe("edit_file");
    expect(result.root.slowestCall?.latencyMs).toBe(300);
    expect(result.toolBreakdown).toHaveLength(2);
    expect(result.toolBreakdown.find((t) => t.name === "read_file")?.count).toBe(2);
    expect(result.toolBreakdown.find((t) => t.name === "edit_file")?.errorCount).toBe(1);
  });

  test("detects interrupted event", async () => {
    const store = fakeCheckpointEventsStore([
      row("t1", "run3", {
        type: "model_end",
        blocks: [{ type: "text", text: "ok" }],
        usage: { input: 100, output: 50 },
        model: "claude-sonnet-4",
        step: 0,
        latencyMs: 500,
        ts: 1500,
      }),
      row("t1", "run3", {
        type: "tool_end",
        result: { type: "tool_result", tool_use_id: "t1", content: "err", is_error: true },
        durationMs: 2000,
        step: 0,
        name: "ask",
        isError: true,
        ts: 3500,
      }),
      row("t1", "run3", {
        type: "interrupt",
        pendingTool: { type: "tool_use", id: "t1", name: "ask", input: {} },
        reason: "needs approval",
        ts: 3500,
      }),
    ]);

    const result = await getRunInsights(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      {
        spanId: "run3",
        sessionId: "t1",
        agentId: "a1",
        status: "running",
        startedAt: 1000,
        endedAt: null,
      },
    );

    expect(result.root.interruptedAt).toBeDefined();
    expect(result.root.interruptedAt?.step).toBe(0);
    expect(result.calls.some((c) => c.kind === "interrupt")).toBe(true);
  });

  test("marks cost null for unknown model", async () => {
    const store = fakeCheckpointEventsStore([
      row("t1", "run4", {
        type: "model_end",
        blocks: [{ type: "text", text: "ok" }],
        usage: { input: 1000, output: 200 },
        model: "unknown",
        step: 0,
        latencyMs: 500,
        ts: 1500,
      }),
    ]);

    const result = await getRunInsights(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      {
        spanId: "run4",
        sessionId: "t1",
        agentId: "a1",
        status: "done",
        startedAt: 1000,
        endedAt: 2000,
      },
    );

    expect(result.root.totalCostUsd).toBe(0);
    expect(result.root.unknownCostCalls).toBe(1);
  });

  test("resolves agent name", async () => {
    const store = fakeCheckpointEventsStore();

    const result = await getRunInsights(
      {
        checkpointEventsStore: store as unknown as CheckpointEventsStore,
        getAgentName: (id: string) => (id === "a1" ? "My Agent" : undefined),
      },
      {
        spanId: "run5",
        sessionId: "t1",
        agentId: "a1",
        status: "done",
        startedAt: 1000,
        endedAt: 2000,
      },
    );

    expect(result.agentName).toBe("My Agent");
  });
});

describe("getInsightsSummary", () => {
  test("buckets llm calls into hourly token series", async () => {
    const hour1 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const store = fakeCheckpointEventsStore([
      row(
        "t1",
        "r1",
        {
          type: "model_end",
          blocks: [{ type: "text", text: "ok" }],
          usage: { input: 1000, output: 500 },
          model: "claude-sonnet-4",
          step: 0,
          latencyMs: 500,
          ts: hour1 + 1000,
        },
        hour1 + 1000,
      ),
    ]);

    const result = await getInsightsSummary(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      { from: hour1 - 3_600_000, to: hour1 + 3_600_000 * 2 },
    );

    expect(result.tokenSeries.length).toBeGreaterThan(0);
    const bucket = result.tokenSeries.find((b) => b.ts === hour1);
    expect(bucket).toBeDefined();
    expect(bucket?.input).toBe(1000);
    expect(bucket?.output).toBe(500);
  });

  test("aggregates cost by model", async () => {
    const now = Date.now();
    const store = fakeCheckpointEventsStore([
      row(
        "t1",
        "r1",
        {
          type: "model_end",
          blocks: [{ type: "text", text: "ok" }],
          usage: { input: 10000, output: 1000 },
          model: "claude-sonnet-4",
          step: 0,
          latencyMs: 500,
          ts: now,
        },
        now,
      ),
      row(
        "t1",
        "r2",
        {
          type: "model_end",
          blocks: [{ type: "text", text: "ok" }],
          usage: { input: 10000, output: 1000 },
          model: "claude-haiku-4-5",
          step: 0,
          latencyMs: 500,
          ts: now + 1000,
        },
        now + 1000,
      ),
    ]);

    const result = await getInsightsSummary(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      { from: 0, to: Date.now() + 86_400_000 },
    );

    expect(result.costByModel).toHaveLength(2);
    const sonnet = result.costByModel.find((m) => m.model === "claude-sonnet-4");
    // (10k * 3 + 1k * 15) / 1M = 0.045
    expect(sonnet?.costUsd).toBeCloseTo(0.045, 6);
  });

  test("tracks top tools", async () => {
    const now = Date.now();
    const store = fakeCheckpointEventsStore([
      row(
        "t1",
        "r1",
        {
          type: "tool_end",
          result: { type: "tool_result", tool_use_id: "a", content: "ok" },
          durationMs: 100,
          step: 0,
          name: "read_file",
          isError: false,
          ts: now,
        },
        now,
      ),
      row(
        "t1",
        "r1",
        {
          type: "tool_end",
          result: { type: "tool_result", tool_use_id: "b", content: "ok" },
          durationMs: 100,
          step: 0,
          name: "read_file",
          isError: false,
          ts: now + 1,
        },
        now + 1,
      ),
      row(
        "t1",
        "r1",
        {
          type: "tool_end",
          result: { type: "tool_result", tool_use_id: "c", content: "err", is_error: true },
          durationMs: 100,
          step: 0,
          name: "edit_file",
          isError: true,
          ts: now + 2,
        },
        now + 2,
      ),
    ]);

    const result = await getInsightsSummary(
      { checkpointEventsStore: store as unknown as CheckpointEventsStore },
      { from: 0, to: Date.now() + 86_400_000 },
    );

    expect(result.topTools).toHaveLength(2);
    const read = result.topTools.find((t) => t.name === "read_file");
    expect(read?.count).toBe(2);
    expect(read?.errorRate).toBe(0);
    const edit = result.topTools.find((t) => t.name === "edit_file");
    expect(edit?.count).toBe(1);
    expect(edit?.errorRate).toBe(1);
  });
});
