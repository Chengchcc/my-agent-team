import type { CheckpointEvent } from "@my-agent-team/framework";
import type { CheckpointEventsStore } from "./checkpoint-events-store.js";
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
  spanId: string;
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

// ─── LLM / Tool call extraction (from checkpoint_events model_end / tool_end) ───

function isModelEnd(
  e: CheckpointEvent,
): e is CheckpointEvent & { type: "model_end"; model: string; latencyMs: number } {
  return e.type === "model_end";
}

function isToolEnd(
  e: CheckpointEvent,
): e is CheckpointEvent & { type: "tool_end"; name: string; durationMs: number } {
  return e.type === "tool_end";
}

function isInterrupt(e: CheckpointEvent): e is CheckpointEvent & { type: "interrupt" } {
  return e.type === "interrupt";
}

function toLlmPayload(e: CheckpointEvent & { type: "model_end" }): LlmCallPayload {
  return {
    step: e.step,
    model: e.model,
    usage: {
      input: e.usage?.input ?? 0,
      output: e.usage?.output ?? 0,
    },
    latencyMs: e.latencyMs,
    ttftMs: e.ttftMs,
    stopReason: e.stopReason,
  };
}

function toToolPayload(e: CheckpointEvent & { type: "tool_end" }): ToolCallPayload {
  return {
    step: e.step,
    id: "",
    name: e.name,
    latencyMs: e.durationMs,
    isError: e.isError,
  };
}

// ─── Aggregation ───

export interface RunInsightsDeps {
  eventLog?: unknown; // deprecated, kept for backward compat until PR-4
  checkpointEventsStore?: CheckpointEventsStore;
  getAgentName?: (agentId: string) => string | undefined;
}

export async function getRunInsights(
  deps: RunInsightsDeps,
  params: {
    spanId: string;
    sessionId: string;
    agentId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
  },
): Promise<RunInsights> {
  const { checkpointEventsStore, getAgentName } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  // Read execution facts from checkpoint_events
  const events = checkpointEventsStore?.readBySpan(params.sessionId, params.spanId) ?? [];

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

  for (const ev of events) {
    if (isModelEnd(ev)) {
      const p = toLlmPayload(ev);
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
        ts: ev.ts,
        model: p.model,
        usage: p.usage,
        latencyMs: p.latencyMs,
        ttftMs: p.ttftMs ?? null,
        costUsd: cost,
        stopReason: p.stopReason,
      });
    } else if (isToolEnd(ev)) {
      const p = toToolPayload(ev);
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
        ts: ev.ts,
        name: p.name,
        latencyMs: p.latencyMs,
        isError: p.isError,
      });
    } else if (isInterrupt(ev)) {
      interruptedAt = { step: calls.length > 0 ? (calls[calls.length - 1]?.step ?? 0) : 0 };
      calls.push({ kind: "interrupt", step: interruptedAt.step, ts: ev.ts });
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
    spanId: params.spanId,
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
  eventLog?: unknown; // deprecated, kept for backward compat until PR-4
  checkpointEventsStore?: CheckpointEventsStore;
  getAgentName?: (agentId: string) => string | undefined;
  /** Pre-resolved spanId (spanId) → agentId mapping (from run table, scoped to time window). */
  runAgentMap?: Map<string, string>;
}

export async function getInsightsSummary(
  deps: InsightsSummaryDeps,
  range: { from: number; to: number },
): Promise<InsightsSummary> {
  const { checkpointEventsStore, getAgentName, runAgentMap } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  // Read all execution facts in the time window from checkpoint_events
  const events = checkpointEventsStore?.readWindow(range.from, range.to) ?? [];

  // Bucket by hour
  const tokenBuckets = new Map<number, { input: number; output: number }>();
  const costByAgent = new Map<string, number | null>();
  const costByModel = new Map<string, number | null>();
  const toolCounts = new Map<string, { count: number; errors: number }>();

  for (const ev of events) {
    if (ev.ts < range.from || ev.ts > range.to) continue;

    if (isModelEnd(ev)) {
      const p = toLlmPayload(ev);
      const hour = Math.floor(ev.ts / 3_600_000) * 3_600_000;
      const bucket = tokenBuckets.get(hour) ?? { input: 0, output: 0 };
      bucket.input += p.usage.input;
      bucket.output += p.usage.output;
      tokenBuckets.set(hour, bucket);

      const cost = estimateCost(p.model, p.usage);
      if (cost !== null) {
        const prevModel = costByModel.get(p.model);
        costByModel.set(p.model, (prevModel ?? 0) + cost);
      }

      // Per-agent cost (use pre-resolved spanId→agentId map)
      if (runAgentMap && ev.spanId) {
        const agentId = runAgentMap.get(ev.spanId);
        if (agentId) {
          if (cost !== null) {
            const prevAgent = costByAgent.get(agentId);
            costByAgent.set(agentId, (prevAgent ?? 0) + cost);
          }
        }
      }
    } else if (isToolEnd(ev)) {
      const p = toToolPayload(ev);
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
