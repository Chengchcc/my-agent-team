import { describe, expect, test } from "bun:test";
import { inMemoryEventLog } from "@my-agent-team/event-log";
import { getInsightsSummary, getRunInsights } from "./insights.js";

describe("getRunInsights", () => {
  test("returns empty calls for run with no llm/tool events", async () => {
    const eventLog = inMemoryEventLog();
    await eventLog.append("thread1", "run1", {
      type: "message",
      payload: { role: "user", content: "hi" },
    });

    const result = await getRunInsights(
      { eventLog },
      {
        runId: "run1",
        threadId: "thread1",
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
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "run1", {
      type: "llm_call",
      payload: {
        step: 0,
        model: "claude-sonnet-4",
        usage: { input: 1000, output: 200 },
        latencyMs: 1500,
        ttftMs: 300,
      },
    });

    await eventLog.append("t1", "run1", {
      type: "llm_call",
      payload: {
        step: 1,
        model: "claude-sonnet-4",
        usage: { input: 2000, output: 500 },
        latencyMs: 2500,
      },
    });

    const result = await getRunInsights(
      { eventLog },
      {
        runId: "run1",
        threadId: "t1",
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
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "run2", {
      type: "tool_call",
      payload: { step: 0, id: "t1", name: "read_file", latencyMs: 100, isError: false },
    });
    await eventLog.append("t1", "run2", {
      type: "tool_call",
      payload: { step: 0, id: "t2", name: "edit_file", latencyMs: 300, isError: true },
    });
    await eventLog.append("t1", "run2", {
      type: "tool_call",
      payload: { step: 1, id: "t3", name: "read_file", latencyMs: 80, isError: false },
    });

    const result = await getRunInsights(
      { eventLog },
      {
        runId: "run2",
        threadId: "t1",
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
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "run3", {
      type: "llm_call",
      payload: {
        step: 0,
        model: "claude-sonnet-4",
        usage: { input: 100, output: 50 },
        latencyMs: 500,
      },
    });
    await eventLog.append("t1", "run3", {
      type: "tool_call",
      payload: { step: 0, id: "t1", name: "ask", latencyMs: 2000, isError: true },
    });
    await eventLog.append("t1", "run3", {
      type: "interrupted",
      payload: { reason: "needs approval" },
    });

    const result = await getRunInsights(
      { eventLog },
      {
        runId: "run3",
        threadId: "t1",
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
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "run4", {
      type: "llm_call",
      payload: { step: 0, model: "unknown", usage: { input: 1000, output: 200 }, latencyMs: 500 },
    });

    const result = await getRunInsights(
      { eventLog },
      {
        runId: "run4",
        threadId: "t1",
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
    const eventLog = inMemoryEventLog();

    const result = await getRunInsights(
      { eventLog, getAgentName: (id) => (id === "a1" ? "My Agent" : undefined) },
      {
        runId: "run5",
        threadId: "t1",
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
    const eventLog = inMemoryEventLog();
    const hour1 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

    await eventLog.append("t1", "r1", {
      type: "llm_call",
      payload: {
        step: 0,
        model: "claude-sonnet-4",
        usage: { input: 1000, output: 500 },
        latencyMs: 500,
      },
    });

    const result = await getInsightsSummary(
      { eventLog },
      { from: hour1 - 3_600_000, to: hour1 + 3_600_000 * 2 },
    );

    expect(result.tokenSeries.length).toBeGreaterThan(0);
    const bucket = result.tokenSeries.find((b) => b.ts === hour1);
    expect(bucket).toBeDefined();
    expect(bucket?.input).toBe(1000);
    expect(bucket?.output).toBe(500);
  });

  test("aggregates cost by model", async () => {
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "r1", {
      type: "llm_call",
      payload: {
        step: 0,
        model: "claude-sonnet-4",
        usage: { input: 10000, output: 1000 },
        latencyMs: 500,
      },
    });
    await eventLog.append("t1", "r2", {
      type: "llm_call",
      payload: {
        step: 0,
        model: "claude-haiku-4-5",
        usage: { input: 10000, output: 1000 },
        latencyMs: 500,
      },
    });

    const result = await getInsightsSummary({ eventLog }, { from: 0, to: Date.now() + 86_400_000 });

    expect(result.costByModel).toHaveLength(2);
    const sonnet = result.costByModel.find((m) => m.model === "claude-sonnet-4");
    // (10k * 3 + 1k * 15) / 1M = 0.045
    expect(sonnet?.costUsd).toBeCloseTo(0.045, 6);
  });

  test("tracks top tools", async () => {
    const eventLog = inMemoryEventLog();

    await eventLog.append("t1", "r1", {
      type: "tool_call",
      payload: { step: 0, id: "a", name: "read_file", latencyMs: 100, isError: false },
    });
    await eventLog.append("t1", "r1", {
      type: "tool_call",
      payload: { step: 0, id: "b", name: "read_file", latencyMs: 100, isError: false },
    });
    await eventLog.append("t1", "r1", {
      type: "tool_call",
      payload: { step: 0, id: "c", name: "edit_file", latencyMs: 100, isError: true },
    });

    const result = await getInsightsSummary({ eventLog }, { from: 0, to: Date.now() + 86_400_000 });

    expect(result.topTools).toHaveLength(2);
    const read = result.topTools.find((t) => t.name === "read_file");
    expect(read?.count).toBe(2);
    expect(read?.errorRate).toBe(0);
    const edit = result.topTools.find((t) => t.name === "edit_file");
    expect(edit?.count).toBe(1);
    expect(edit?.errorRate).toBe(1);
  });
});
