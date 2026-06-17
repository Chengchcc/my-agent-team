import type { AgentEvent, Interrupt } from "@my-agent-team/framework";
import type { EventLog } from "../event-log/index.js";
import { estimateCost, type Usage } from "./pricing.js";

// ─── Types ───

export interface LlmCallPayload {
  step: number;
  model: string;
  usage: Usage;
  latencyMs: number;
  ttftMs?: number;
  stopReason?: string;
}

export interface ToolCallPayload {
  step: number;
  id: string;
  name: string;
  latencyMs: number;
  isError: boolean;
}

export interface CallItem {
  kind: "llm" | "tool" | "interrupt";
  step: number;
  ts: number;
  // llm fields
  model?: string;
  usage?: Usage;
  latencyMs?: number;
  ttftMs?: number | null;
  costUsd?: number | null;
  stopReason?: string;
  // tool fields
  name?: string;
  isError?: boolean;
}

export interface RunInsights {
  runId: string;
  agentId: string;
  agentName: string;
  root: {
    status: string;
    startedAt: number;
    endedAt: number | null;
    totalLatencyMs: number | null;
    totalCostUsd: number | null;
    unknownCostCalls: number;
    llmCalls: number;
    toolCalls: number;
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheCreate: number;
    slowestCall?: { kind: "llm" | "tool"; step: number; name: string; latencyMs: number };
    failedCall?: { step: number; name: string };
    interruptedAt?: { step: number };
  };
  calls: CallItem[];
  toolBreakdown: Array<{ name: string; count: number; errorCount: number; totalLatencyMs: number }>;
}

export interface InsightsSummary {
  window: { from: number; to: number };
  tokenSeries: Array<{ ts: number; input: number; output: number }>;
  costByAgent: Array<{ agentId: string; agentName: string; costUsd: number | null }>;
  costByModel: Array<{ model: string; costUsd: number | null }>;
  topTools: Array<{ name: string; count: number; errorRate: number }>;
}

// ─── LLM / Tool call extraction ───

function isLlmCall(e: AgentEvent): e is { type: "llm_call"; payload: LlmCallPayload } {
  return e.type === "llm_call";
}

function isToolCall(e: AgentEvent): e is { type: "tool_call"; payload: ToolCallPayload } {
  return e.type === "tool_call";
}

function isInterrupted(e: AgentEvent): e is { type: "interrupted"; payload: Interrupt } {
  return e.type === "interrupted";
}

// ─── Aggregation ───

export interface RunInsightsDeps {
  eventLog: EventLog;
  getAgentName?: (agentId: string) => string | undefined;
}

export async function getRunInsights(
  deps: RunInsightsDeps,
  params: {
    runId: string;
    threadId: string;
    agentId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
  },
): Promise<RunInsights> {
  const { eventLog, getAgentName } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  const records = await eventLog.read({ runId: params.runId });

  const calls: CallItem[] = [];
  const toolStats = new Map<
    string,
    { count: number; errorCount: number; totalLatencyMs: number }
  >();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let totalCostUsd: number | null = 0;
  let unknownCostCalls = 0;
  let slowestCall: RunInsights["root"]["slowestCall"] | undefined;
  let failedCall: RunInsights["root"]["failedCall"] | undefined;
  let interruptedAt: RunInsights["root"]["interruptedAt"] | undefined;

  for (const rec of records) {
    const ev = rec.event;

    if (isLlmCall(ev)) {
      const p = ev.payload;
      totalInput += p.usage.input;
      totalOutput += p.usage.output;
      if (p.usage.cacheRead) totalCacheRead += p.usage.cacheRead;
      if (p.usage.cacheCreate) totalCacheCreate += p.usage.cacheCreate;

      const cost = estimateCost(p.model, p.usage);
      if (cost === null) {
        unknownCostCalls++;
      } else {
        totalCostUsd = (totalCostUsd ?? 0) + cost;
      }

      if (!slowestCall || p.latencyMs > slowestCall.latencyMs) {
        slowestCall = { kind: "llm", step: p.step, name: p.model, latencyMs: p.latencyMs };
      }

      calls.push({
        kind: "llm",
        step: p.step,
        ts: rec.ts,
        model: p.model,
        usage: p.usage,
        latencyMs: p.latencyMs,
        ttftMs: p.ttftMs ?? null,
        costUsd: cost,
        stopReason: p.stopReason,
      });
    } else if (isToolCall(ev)) {
      const p = ev.payload;
      const stats = toolStats.get(p.name) ?? { count: 0, errorCount: 0, totalLatencyMs: 0 };
      stats.count++;
      if (p.isError) stats.errorCount++;
      stats.totalLatencyMs += p.latencyMs;
      toolStats.set(p.name, stats);

      if (p.isError && !failedCall) {
        failedCall = { step: p.step, name: p.name };
      }
      if (!slowestCall || p.latencyMs > slowestCall.latencyMs) {
        slowestCall = { kind: "tool", step: p.step, name: p.name, latencyMs: p.latencyMs };
      }

      calls.push({
        kind: "tool",
        step: p.step,
        ts: rec.ts,
        name: p.name,
        latencyMs: p.latencyMs,
        isError: p.isError,
      });
    } else if (isInterrupted(ev)) {
      interruptedAt = { step: calls.length > 0 ? (calls[calls.length - 1]?.step ?? 0) : 0 };
      calls.push({ kind: "interrupt", step: interruptedAt.step, ts: rec.ts });
    }
  }

  const totalLatencyMs =
    params.startedAt != null && params.endedAt != null ? params.endedAt - params.startedAt : null;

  const toolBreakdown = Array.from(toolStats.entries())
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      errorCount: stats.errorCount,
      totalLatencyMs: stats.totalLatencyMs,
      errorRate: stats.count > 0 ? stats.errorCount / stats.count : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    runId: params.runId,
    agentId: params.agentId,
    agentName: resolveName(params.agentId),
    root: {
      status: params.status,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      totalLatencyMs,
      totalCostUsd,
      unknownCostCalls,
      llmCalls: calls.filter((c) => c.kind === "llm").length,
      toolCalls: calls.filter((c) => c.kind === "tool").length,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheCreate,
      ...(slowestCall ? { slowestCall } : {}),
      ...(failedCall ? { failedCall } : {}),
      ...(interruptedAt ? { interruptedAt } : {}),
    },
    calls,
    toolBreakdown,
  };
}

// ─── Summary aggregation (cross-run, for Overview charts) ───

export interface InsightsSummaryDeps {
  eventLog: EventLog;
  getAgentName?: (agentId: string) => string | undefined;
  /** Pre-resolved runId → agentId mapping (from run table, scoped to time window). */
  runAgentMap?: Map<string, string>;
}

export async function getInsightsSummary(
  deps: InsightsSummaryDeps,
  range: { from: number; to: number },
): Promise<InsightsSummary> {
  const { eventLog, getAgentName, runAgentMap } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  // Read events only for runs in the time window (scoped by caller)
  const allRecords = [];
  if (runAgentMap && runAgentMap.size > 0) {
    for (const runId of runAgentMap.keys()) {
      const recs = await eventLog.read({ runId, limit: 5000 });
      allRecords.push(...recs);
    }
  } else {
    allRecords.push(...(await eventLog.read({ limit: 5000 })));
  }

  // Bucket by hour
  const tokenBuckets = new Map<number, { input: number; output: number }>();
  const costByAgent = new Map<string, number | null>();
  const costByModel = new Map<string, number | null>();
  const toolCounts = new Map<string, { count: number; errors: number }>();

  for (const rec of allRecords) {
    if (rec.ts < range.from || rec.ts > range.to) continue;

    const ev = rec.event;
    if (isLlmCall(ev)) {
      const p = ev.payload;
      const hour = Math.floor(rec.ts / 3_600_000) * 3_600_000;
      const bucket = tokenBuckets.get(hour) ?? { input: 0, output: 0 };
      bucket.input += p.usage.input;
      bucket.output += p.usage.output;
      tokenBuckets.set(hour, bucket);

      const cost = estimateCost(p.model, p.usage);
      if (cost !== null) {
        const prevModel = costByModel.get(p.model);
        costByModel.set(p.model, (prevModel ?? 0) + cost);
      }

      // Per-agent cost (use pre-resolved run→agent map)
      if (runAgentMap) {
        const agentId = runAgentMap.get(rec.runId);
        if (agentId) {
          if (cost !== null) {
            const prevAgent = costByAgent.get(agentId);
            costByAgent.set(agentId, (prevAgent ?? 0) + cost);
          }
        }
      }
    } else if (isToolCall(ev)) {
      const p = ev.payload;
      const stats = toolCounts.get(p.name) ?? { count: 0, errors: 0 };
      stats.count++;
      if (p.isError) stats.errors++;
      toolCounts.set(p.name, stats);
    }
  }

  return {
    window: { from: range.from, to: range.to },
    tokenSeries: Array.from(tokenBuckets.entries())
      .map(([ts, v]) => ({ ts, ...v }))
      .sort((a, b) => a.ts - b.ts),
    costByAgent: Array.from(costByAgent.entries())
      .map(([agentId, costUsd]) => ({ agentId, agentName: resolveName(agentId), costUsd }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    costByModel: Array.from(costByModel.entries())
      .map(([model, costUsd]) => ({ model, costUsd }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    topTools: Array.from(toolCounts.entries())
      .map(([name, { count, errors }]) => ({
        name,
        count,
        errorRate: count > 0 ? errors / count : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}
