import type { Database } from "bun:sqlite";
import type { Message } from "@chengchenccc/message";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { surfaceHealthSelectSchema } from "../../infra/db/schema.js";
import {
  type ActivatedSkill,
  computeWaitIntervals,
  extractSkillsFromMessages,
  extractToolPayloadsFromOutcome,
  percentile,
  redactAndTruncate,
  type ToolPayloadSnapshot,
  type WaitInterval,
} from "./telemetry-helpers.js";
import type { SurfaceHealthRow } from "./types.js";

export interface TelemetryQueryOptions {
  readonly sinceMs?: number;
  readonly agentId?: string;
  readonly modelId?: string;
  readonly status?: string;
  readonly skill?: string;
  /** Default "production" excludes eval runs (`authorization LIKE 'eval:%'`). */
  readonly scope?: "production" | "eval" | "all";
}

export interface RunTraceNode {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly conversationId: string;
  readonly agentId: string;
  readonly status: string;
  readonly modelId: string;
  readonly authorization: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly durationMs: number | null;
  readonly activeDurationMs: number | null;
  readonly humanWaitMs: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsd: number;
  } | null;
  readonly error: string | null;
  readonly children: RunTraceNode[];
}

export interface RunTraceBundle {
  readonly rootRunId: string;
  readonly focusRunId: string;
  readonly tree: RunTraceNode;
  readonly systemPrompt: string | null;
  readonly skillRoots: string[];
  readonly skillsActivated: ActivatedSkill[];
  readonly waitIntervals: WaitInterval[];
  readonly toolPayloads: Record<string, ToolPayloadSnapshot>;
  readonly ttftSamples: Array<{ turn: number; ttftMs: number; ts: number }>;
}

function modelIdFromRef(ref: string): string {
  try {
    const parsed: unknown = JSON.parse(ref);
    if (
      parsed != null &&
      typeof parsed === "object" &&
      "modelId" in parsed &&
      typeof parsed.modelId === "string"
    ) {
      return parsed.modelId;
    }
  } catch {
    /* fall through */
  }
  return ref;
}

function errorFromOutcome(outcome: unknown): string | null {
  if (
    outcome != null &&
    typeof outcome === "object" &&
    "error" in outcome &&
    typeof outcome.error === "string"
  ) {
    return outcome.error;
  }
  return null;
}

function usageFromOutcome(outcome: unknown): RunTraceNode["usage"] {
  if (
    outcome == null ||
    typeof outcome !== "object" ||
    !("usage" in outcome) ||
    outcome.usage == null ||
    typeof outcome.usage !== "object"
  ) {
    return null;
  }
  const u = outcome.usage as Record<string, unknown>;
  return {
    inputTokens: Number(u.inputTokens ?? 0),
    outputTokens: Number(u.outputTokens ?? 0),
    cacheReadTokens: Number(u.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(u.cacheWriteTokens ?? 0),
    costUsd: Number(u.costUsd ?? 0),
  };
}

function cacheHitRateOf(inputTokens: number, cacheReadTokens: number): number | null {
  const denom = inputTokens + cacheReadTokens;
  return denom > 0 ? cacheReadTokens / denom : null;
}

function failureCause(error: string | null, status: string): string {
  const text = `${status} ${error ?? ""}`.toLowerCase();
  if (
    status === "timeout" ||
    text.includes("timeout") ||
    text.includes("max steps") ||
    text.includes("stale")
  ) {
    return "timeout";
  }
  if (
    text.includes("schema") ||
    text.includes("validation") ||
    text.includes("invalid json") ||
    text.includes("json.parse")
  ) {
    return "schema";
  }
  if (
    text.includes("permission") ||
    text.includes("denied") ||
    text.includes("forbidden") ||
    text.includes("not allowed")
  ) {
    return "permission";
  }
  if (
    text.includes("network") ||
    text.includes("connection") ||
    text.includes("fetch failed") ||
    text.includes("enotfound")
  ) {
    return "network";
  }
  return "other";
}

function safeJsonParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Surface-health audit store (Lark heartbeats) + ADR 0085 run telemetry &
 *  trace queries over `agent_run`, `agent_run_event`, `pending_action`, and
 *  `product_tool_call`. */
export class RuntimeOpsStore {
  #d: ReturnType<typeof drizzle<typeof schema>>;
  #db: Database;

  constructor(db: Database) {
    this.#d = drizzle(db, { schema, casing: "snake_case" });
    this.#db = db;
  }

  // ─── surface_health ───

  upsertSurfaceHealth(input: {
    agentId: string;
    surface: string;
    status: string;
    payload: Record<string, unknown>;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#d
      .insert(schema.surfaceHealth)
      .values({
        agentId: input.agentId,
        surface: input.surface,
        status: input.status,
        lastSeenAt: now,
        payload: JSON.stringify(input.payload),
        lastError: input.lastError ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.surfaceHealth.agentId, schema.surfaceHealth.surface],
        set: {
          status: input.status,
          lastSeenAt: now,
          payload: JSON.stringify(input.payload),
          lastError: input.lastError ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  getSurfaceHealth(agentId: string, surface: string): SurfaceHealthRow | undefined {
    const row = this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(
        and(eq(schema.surfaceHealth.agentId, agentId), eq(schema.surfaceHealth.surface, surface)),
      )
      .get();
    return row ? surfaceHealthSelectSchema.parse(row) : undefined;
  }

  getSurfaceHealthsForAgent(agentId: string): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(eq(schema.surfaceHealth.agentId, agentId))
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }

  listSurfaceHealths(): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .orderBy(schema.surfaceHealth.agentId, schema.surfaceHealth.surface)
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }

  // ─── agent_run_event (run telemetry) ───

  appendRunEvent(runId: string, type: string, data: Record<string, unknown>): void {
    this.#d
      .insert(schema.agentRunEvent)
      .values({ runId, type, data: JSON.stringify(data), ts: Date.now() })
      .run();
  }

  listRunEvents(
    runId: string,
    limit = 500,
  ): Array<{
    seq: number;
    type: string;
    data: Record<string, unknown>;
    ts: number;
  }> {
    return this.#d
      .select()
      .from(schema.agentRunEvent)
      .where(eq(schema.agentRunEvent.runId, runId))
      .orderBy(schema.agentRunEvent.seq)
      .limit(limit)
      .all()
      .map((r) => ({
        seq: r.seq,
        type: r.type,
        data: (safeJsonParse(r.data) as Record<string, unknown> | null) ?? {},
        ts: r.ts,
      }));
  }

  #waitMsForRuns(
    runs: ReadonlyArray<{ runId: string; createdAt: number; terminalAt: number | null }>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (runs.length === 0) return out;
    const placeholders = runs.map(() => "?").join(",");
    const rows = this.#db
      .query(
        `SELECT action_id AS actionId, run_id AS runId, kind, created_at AS createdAt,
                resolved_at AS resolvedAt, owner
           FROM pending_action
          WHERE run_id IN (${placeholders})`,
      )
      .all(...runs.map((r) => r.runId)) as Array<{
      actionId: string;
      runId: string;
      kind: string;
      createdAt: number;
      resolvedAt: number | null;
      owner: string | null;
    }>;
    const byRun = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byRun.get(row.runId) ?? [];
      list.push(row);
      byRun.set(row.runId, list);
    }
    const now = Date.now();
    for (const r of runs) {
      const actions = byRun.get(r.runId);
      if (!actions || actions.length === 0) {
        out.set(r.runId, 0);
        continue;
      }
      const { totalWaitMs } = computeWaitIntervals(actions, r.createdAt, r.terminalAt ?? now);
      out.set(r.runId, totalWaitMs);
    }
    return out;
  }

  /** ADR 0085 D2/D3: Aggregate run telemetry with Cache hit rate, P50/P95
   *  active durations (stripping HITL human wait), TTFT, Tool stats, Skill
   *  activations, and behavioral quality signals. Accepts either a numeric
   *  `sinceMs` (legacy) or a `TelemetryQueryOptions` object. */
  telemetrySummary(input?: number | TelemetryQueryOptions) {
    const opts: TelemetryQueryOptions =
      typeof input === "number" ? { sinceMs: input } : (input ?? {});
    const since = opts.sinceMs ?? Date.now() - 86_400_000;
    const scope = opts.scope ?? "production";

    const whereParts: string[] = ["ar.created_at >= ?"];
    const args: (string | number)[] = [since];
    if (scope === "production") {
      whereParts.push("(ar.authorization IS NULL OR ar.authorization NOT LIKE 'eval:%')");
    } else if (scope === "eval") {
      whereParts.push("ar.authorization LIKE 'eval:%'");
    }
    if (opts.agentId) {
      whereParts.push("ar.agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.status) {
      whereParts.push("ar.status = ?");
      args.push(opts.status);
    }
    if (opts.skill) {
      whereParts.push(
        `EXISTS (SELECT 1 FROM agent_run_event se WHERE se.run_id = ar.run_id AND se.type = 'skill_activated' AND json_extract(se.data, '$.skillName') = ?)`,
      );
      args.push(opts.skill);
    }
    const whereClause = whereParts.join(" AND ");

    const rawRuns = this.#db
      .query(
        `SELECT ar.run_id AS runId,
                ar.agent_id AS agentId,
                ar.status,
                ar.model_ref AS modelRef,
                ar.created_at AS createdAt,
                ar.terminal_at AS terminalAt,
                ar.terminal_result AS terminalResult
           FROM agent_run ar
          WHERE ${whereClause}
          ORDER BY ar.created_at DESC`,
      )
      .all(...args) as Array<{
      runId: string;
      agentId: string;
      status: string;
      modelRef: string;
      createdAt: number;
      terminalAt: number | null;
      terminalResult: string | null;
    }>;

    const runs = opts.modelId
      ? rawRuns.filter((r) => modelIdFromRef(r.modelRef) === opts.modelId)
      : rawRuns;

    const waitByRun = this.#waitMsForRuns(runs);
    const runIds = runs.map((r) => r.runId);
    const runIdSet = new Set(runIds);

    // Fetch all telemetry events for the matched runs in chunks (SQLite variable limit safe).
    const eventsByRun = new Map<
      string,
      Array<{ seq: number; type: string; data: Record<string, unknown>; ts: number }>
    >();
    const CHUNK = 400;
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const slice = runIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const evRows = this.#db
        .query(
          `SELECT run_id AS runId, seq, type, data, ts
             FROM agent_run_event
            WHERE run_id IN (${placeholders})
            ORDER BY seq ASC`,
        )
        .all(...slice) as Array<{
        runId: string;
        seq: number;
        type: string;
        data: string;
        ts: number;
      }>;
      for (const ev of evRows) {
        const list = eventsByRun.get(ev.runId) ?? [];
        list.push({
          seq: ev.seq,
          type: ev.type,
          data: (safeJsonParse(ev.data) as Record<string, unknown> | null) ?? {},
          ts: ev.ts,
        });
        eventsByRun.set(ev.runId, list);
      }
    }

    // Product tool calls for matched runs (also folded into toolStats).
    const productToolRows: Array<{
      runId: string;
      toolName: string;
      status: string;
      createdAt: number;
      completedAt: number | null;
    }> = [];
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const slice = runIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const rows = this.#db
        .query(
          `SELECT run_id AS runId, tool_name AS toolName, status,
                  created_at AS createdAt, completed_at AS completedAt
             FROM product_tool_call
            WHERE run_id IN (${placeholders})`,
        )
        .all(...slice) as typeof productToolRows;
      productToolRows.push(...rows);
    }

    // Core totals + breakdowns
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCostUsd = 0;
    let totalToolCalls = 0;
    let totalHumanWaitMs = 0;
    const rawDurations: number[] = [];
    const activeDurations: number[] = [];
    const ttftValues: number[] = [];

    const byAgentMap = new Map<
      string,
      {
        runs: number;
        completed: number;
        failed: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        durations: number[];
      }
    >();
    const byModelMap = new Map<
      string,
      {
        runs: number;
        completed: number;
        failed: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        activeDurations: number[];
      }
    >();
    const costByHourMap = new Map<number, { costUsd: number; tokens: number }>();
    const costByModelHourMap = new Map<
      string,
      { hour: number; modelId: string; costUsd: number; tokens: number }
    >();
    const failureCauseMap = new Map<string, number>();
    const failures: Array<{
      runId: string;
      agentId: string;
      status: string;
      modelId: string;
      createdAt: number;
      durationMs: number | null;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
    }> = [];

    const toolAgg = new Map<string, { calls: number; errors: number; durations: number[] }>();
    const skillAgg = new Map<
      string,
      {
        activations: number;
        runIds: Set<string>;
        completed: number;
        failed: number;
        durations: number[];
      }
    >();
    const qualitySignals = {
      unaskedQuestion: 0,
      irreversibleUnasked: 0,
      statusQuestionDispatched: 0,
      unroutedWork: 0,
      answerCorrected: 0,
      total: 0,
    };

    const recentRows: Array<{
      runId: string;
      status: string;
      modelId: string;
      createdAt: number;
      durationMs: number | null;
      activeDurationMs: number | null;
      humanWaitMs: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
    }> = [];

    for (const r of runs) {
      const outcome = safeJsonParse(r.terminalResult);
      const usage = usageFromOutcome(outcome);
      const error = errorFromOutcome(outcome);
      const modelId = modelIdFromRef(r.modelRef);
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const cacheReadTokens = usage?.cacheReadTokens ?? 0;
      const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
      const costUsd = usage?.costUsd ?? 0;
      const rawDurationMs = r.terminalAt != null ? Math.max(0, r.terminalAt - r.createdAt) : null;
      const humanWaitMs = waitByRun.get(r.runId) ?? 0;
      const activeDurationMs =
        rawDurationMs != null ? Math.max(0, rawDurationMs - humanWaitMs) : null;

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCacheReadTokens += cacheReadTokens;
      totalCacheWriteTokens += cacheWriteTokens;
      totalCostUsd += costUsd;
      totalHumanWaitMs += humanWaitMs;
      if (rawDurationMs != null) rawDurations.push(rawDurationMs);
      if (activeDurationMs != null) activeDurations.push(activeDurationMs);

      const isCompleted = r.status === "completed";
      const isFailed = r.status === "failed" || r.status === "aborted" || r.status === "timeout";

      // byAgent
      const ag = byAgentMap.get(r.agentId) ?? {
        runs: 0,
        completed: 0,
        failed: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durations: [],
      };
      ag.runs++;
      if (isCompleted) ag.completed++;
      if (isFailed) ag.failed++;
      ag.costUsd += costUsd;
      ag.inputTokens += inputTokens;
      ag.outputTokens += outputTokens;
      ag.cacheReadTokens += cacheReadTokens;
      if (activeDurationMs != null) ag.durations.push(activeDurationMs);
      byAgentMap.set(r.agentId, ag);

      // byModel
      const mod = byModelMap.get(modelId) ?? {
        runs: 0,
        completed: 0,
        failed: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        activeDurations: [],
      };
      mod.runs++;
      if (isCompleted) mod.completed++;
      if (isFailed) mod.failed++;
      mod.costUsd += costUsd;
      mod.inputTokens += inputTokens;
      mod.outputTokens += outputTokens;
      mod.cacheReadTokens += cacheReadTokens;
      mod.cacheWriteTokens += cacheWriteTokens;
      if (activeDurationMs != null) mod.activeDurations.push(activeDurationMs);
      byModelMap.set(modelId, mod);

      // hourly
      const hour = Math.floor(r.createdAt / 3_600_000) * 3_600_000;
      const h = costByHourMap.get(hour) ?? { costUsd: 0, tokens: 0 };
      h.costUsd += costUsd;
      h.tokens += inputTokens + outputTokens;
      costByHourMap.set(hour, h);

      const mhKey = `${hour}|${modelId}`;
      const mh = costByModelHourMap.get(mhKey) ?? { hour, modelId, costUsd: 0, tokens: 0 };
      mh.costUsd += costUsd;
      mh.tokens += inputTokens + outputTokens;
      costByModelHourMap.set(mhKey, mh);

      // failures + failure causes
      if (isFailed) {
        const cause = failureCause(error, r.status);
        failureCauseMap.set(cause, (failureCauseMap.get(cause) ?? 0) + 1);
        if (failures.length < 20) {
          failures.push({
            runId: r.runId,
            agentId: r.agentId,
            status: r.status,
            modelId,
            createdAt: r.createdAt,
            durationMs: rawDurationMs,
            inputTokens,
            outputTokens,
            error,
          });
        }
      }

      // Per-run events: tool calls, TTFT, skills, quality signals
      const events = eventsByRun.get(r.runId) ?? [];
      let runToolCalls = 0;
      const openTools = new Map<string, { name: string; start: number }>();
      const skillsSeenInRun = new Set<string>();
      for (const ev of events) {
        if (ev.type === "native_tool_started") {
          runToolCalls++;
          totalToolCalls++;
          const toolName = String(ev.data.toolName ?? "unknown");
          const callId = typeof ev.data.callId === "string" ? ev.data.callId : "";
          const entry = toolAgg.get(toolName) ?? { calls: 0, errors: 0, durations: [] };
          entry.calls++;
          toolAgg.set(toolName, entry);
          if (callId) openTools.set(callId, { name: toolName, start: ev.ts });
        } else if (ev.type === "native_tool_completed") {
          const callId = typeof ev.data.callId === "string" ? ev.data.callId : "";
          const opened = callId ? openTools.get(callId) : undefined;
          const toolName = opened?.name ?? String(ev.data.toolName ?? "unknown");
          const entry = toolAgg.get(toolName) ?? { calls: 0, errors: 0, durations: [] };
          const result = ev.data.result as Record<string, unknown> | undefined;
          if (result?.isError === true) entry.errors++;
          if (opened) {
            entry.durations.push(Math.max(0, ev.ts - opened.start));
            openTools.delete(callId);
          }
          toolAgg.set(toolName, entry);
        } else if (ev.type === "llm_turn_started") {
          const ttft = Number(ev.data.ttftMs);
          if (Number.isFinite(ttft) && ttft >= 0) ttftValues.push(ttft);
        } else if (ev.type === "skill_activated") {
          const skillName = typeof ev.data.skillName === "string" ? ev.data.skillName.trim() : "";
          if (skillName) {
            const sk = skillAgg.get(skillName) ?? {
              activations: 0,
              runIds: new Set<string>(),
              completed: 0,
              failed: 0,
              durations: [],
            };
            sk.activations++;
            if (!skillsSeenInRun.has(skillName)) {
              skillsSeenInRun.add(skillName);
              sk.runIds.add(r.runId);
              if (isCompleted) sk.completed++;
              if (isFailed) sk.failed++;
              if (activeDurationMs != null) sk.durations.push(activeDurationMs);
            }
            skillAgg.set(skillName, sk);
          }
        } else if (ev.type === "unasked_question") {
          qualitySignals.unaskedQuestion++;
          qualitySignals.total++;
        } else if (ev.type === "irreversible_unasked") {
          qualitySignals.irreversibleUnasked++;
          qualitySignals.total++;
        } else if (ev.type === "status_question_dispatched") {
          qualitySignals.statusQuestionDispatched++;
          qualitySignals.total++;
        } else if (ev.type === "unrouted_work") {
          qualitySignals.unroutedWork++;
          qualitySignals.total++;
        } else if (ev.type === "answer_corrected") {
          qualitySignals.answerCorrected++;
          qualitySignals.total++;
        }
      }

      if (recentRows.length < 50) {
        recentRows.push({
          runId: r.runId,
          status: r.status,
          modelId,
          createdAt: r.createdAt,
          durationMs: rawDurationMs,
          activeDurationMs,
          humanWaitMs,
          toolCalls: runToolCalls,
          inputTokens,
          outputTokens,
          cacheReadTokens,
        });
      }
    }

    // Fold product_tool_call rows into toolStats (MCP product tools).
    for (const pt of productToolRows) {
      if (!runIdSet.has(pt.runId)) continue;
      const key = `product:${pt.toolName}`;
      const entry = toolAgg.get(key) ?? { calls: 0, errors: 0, durations: [] };
      entry.calls++;
      if (pt.status === "failed" || pt.status === "error") entry.errors++;
      if (pt.completedAt != null && pt.completedAt >= pt.createdAt) {
        entry.durations.push(pt.completedAt - pt.createdAt);
      }
      toolAgg.set(key, entry);
    }

    // 7-day trend (respects scope & agent/model/status filters, always covers last 7d or wider window)
    const since7 = Math.min(since, Date.now() - 7 * 86_400_000);
    const trendWhereParts: string[] = ["ar.created_at >= ?"];
    const trendArgs: (string | number)[] = [since7];
    if (scope === "production") {
      trendWhereParts.push("(ar.authorization IS NULL OR ar.authorization NOT LIKE 'eval:%')");
    } else if (scope === "eval") {
      trendWhereParts.push("ar.authorization LIKE 'eval:%'");
    }
    if (opts.agentId) {
      trendWhereParts.push("ar.agent_id = ?");
      trendArgs.push(opts.agentId);
    }
    const trendRaw = this.#db
      .query(
        `SELECT ar.run_id AS runId,
                ar.status,
                ar.model_ref AS modelRef,
                ar.created_at AS createdAt,
                ar.terminal_at AS terminalAt
           FROM agent_run ar
          WHERE ${trendWhereParts.join(" AND ")}`,
      )
      .all(...trendArgs) as Array<{
      runId: string;
      status: string;
      modelRef: string;
      createdAt: number;
      terminalAt: number | null;
    }>;
    const trendRuns = opts.modelId
      ? trendRaw.filter((r) => modelIdFromRef(r.modelRef) === opts.modelId)
      : trendRaw;
    const trendWait = this.#waitMsForRuns(trendRuns);
    const dayMap = new Map<
      number,
      { runs: number; completed: number; failed: number; durations: number[] }
    >();
    for (const tr of trendRuns) {
      const dayStart = Math.floor(tr.createdAt / 86_400_000) * 86_400_000;
      const d = dayMap.get(dayStart) ?? { runs: 0, completed: 0, failed: 0, durations: [] };
      d.runs++;
      if (tr.status === "completed") d.completed++;
      if (tr.status === "failed" || tr.status === "aborted" || tr.status === "timeout") d.failed++;
      if (tr.terminalAt != null) {
        const active = Math.max(0, tr.terminalAt - tr.createdAt - (trendWait.get(tr.runId) ?? 0));
        d.durations.push(active);
      }
      dayMap.set(dayStart, d);
    }
    const sortedDays = [...dayMap.entries()].sort((a, b) => a[0] - b[0]);

    const avgRawDurationMs =
      rawDurations.length > 0
        ? rawDurations.reduce((sum, v) => sum + v, 0) / rawDurations.length
        : 0;
    const avgActiveDurationMs =
      activeDurations.length > 0
        ? activeDurations.reduce((sum, v) => sum + v, 0) / activeDurations.length
        : 0;

    return {
      since,
      runs: runs.length,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      cacheHitRate: cacheHitRateOf(totalInputTokens, totalCacheReadTokens),
      costUsd: totalCostUsd,
      toolCalls: totalToolCalls,
      avgDurationMs: avgRawDurationMs,
      avgActiveDurationMs,
      p50DurationMs: percentile(activeDurations, 50),
      p95DurationMs: percentile(activeDurations, 95),
      totalHumanWaitMs,
      p50TtftMs: percentile(ttftValues, 50),
      p95TtftMs: percentile(ttftValues, 95),
      byAgent: [...byAgentMap.entries()]
        .map(([agentId, b]) => {
          const terminal = b.completed + b.failed;
          return {
            agentId,
            runs: b.runs,
            completed: b.completed,
            failed: b.failed,
            successRate: terminal > 0 ? b.completed / terminal : null,
            costUsd: b.costUsd,
            tokens: b.inputTokens + b.outputTokens,
            cacheReadTokens: b.cacheReadTokens,
            cacheHitRate: cacheHitRateOf(b.inputTokens, b.cacheReadTokens),
            avgDurationMs:
              b.durations.length > 0
                ? Math.round(b.durations.reduce((s, v) => s + v, 0) / b.durations.length)
                : null,
          };
        })
        .sort((a, b) => b.failed - a.failed || b.runs - a.runs),
      failures,
      costByHour: [...costByHourMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, h]) => ({ hour, costUsd: h.costUsd, tokens: h.tokens })),
      costByModelHour: [...costByModelHourMap.values()].sort((a, b) => a.hour - b.hour),
      byModel: [...byModelMap.entries()]
        .map(([modelId, m]) => ({
          modelId,
          runs: m.runs,
          completed: m.completed,
          failed: m.failed,
          costUsd: m.costUsd,
          tokens: m.inputTokens + m.outputTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          cacheHitRate: cacheHitRateOf(m.inputTokens, m.cacheReadTokens),
          p95DurationMs: percentile(m.activeDurations, 95),
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      successRateByDay: sortedDays.map(([dayStart, d]) => {
        const terminal = d.completed + d.failed;
        return {
          dayStart,
          runs: d.runs,
          completed: d.completed,
          failed: d.failed,
          successRate: terminal > 0 ? d.completed / terminal : null,
        };
      }),
      durationByDay: sortedDays.map(([dayStart, d]) => ({
        dayStart,
        runs: d.runs,
        avgDurationMs:
          d.durations.length > 0
            ? Math.round(d.durations.reduce((s, v) => s + v, 0) / d.durations.length)
            : null,
        p95DurationMs: percentile(d.durations, 95),
      })),
      failureCauses: [...failureCauseMap.entries()]
        .map(([cause, count]) => ({ cause, count }))
        .sort((a, b) => b.count - a.count),
      toolStats: [...toolAgg.entries()]
        .map(([toolName, t]) => ({
          toolName,
          calls: t.calls,
          errors: t.errors,
          errorRate: t.calls > 0 ? t.errors / t.calls : 0,
          avgMs:
            t.durations.length > 0
              ? Math.round(t.durations.reduce((s, v) => s + v, 0) / t.durations.length)
              : null,
          p50Ms: percentile(t.durations, 50),
          p95Ms: percentile(t.durations, 95),
        }))
        .sort((a, b) => b.calls - a.calls),
      skillStats: [...skillAgg.entries()]
        .map(([skillName, sk]) => {
          const terminal = sk.completed + sk.failed;
          return {
            skillName,
            activations: sk.activations,
            runs: sk.runIds.size,
            completed: sk.completed,
            failed: sk.failed,
            successRate: terminal > 0 ? sk.completed / terminal : null,
            avgDurationMs:
              sk.durations.length > 0
                ? Math.round(sk.durations.reduce((s, v) => s + v, 0) / sk.durations.length)
                : null,
          };
        })
        .sort((a, b) => b.activations - a.activations),
      qualitySignals,
      spinningRuns: recentRows
        .filter(
          (r) =>
            r.toolCalls >= 8 &&
            r.durationMs != null &&
            r.durationMs >= 60_000 &&
            r.outputTokens <= 20,
        )
        .slice(0, 10)
        .map((r) => ({
          runId: r.runId,
          status: r.status,
          modelId: r.modelId,
          toolCalls: r.toolCalls,
          durationMs: r.durationMs,
          outputTokens: r.outputTokens,
        })),
      recent: recentRows,
    };
  }

  /** ADR 0085 D3: Full trace bundle for a single run — recursive dispatch tree
   *  from its root run, human wait intervals, sanitized tool I/O payloads,
   *  frozen prompt/skills snapshot, and TTFT samples. */
  getRunTrace(runId: string): RunTraceBundle | null {
    type RunRow = {
      runId: string;
      parentRunId: string | null;
      conversationId: string;
      agentId: string;
      status: string;
      modelRef: string;
      authorization: string | null;
      systemPrompt: string | null;
      skillRoots: string | null;
      terminalResult: string | null;
      createdAt: number;
      terminalAt: number | null;
    };

    const loadRun = (id: string): RunRow | undefined =>
      this.#db
        .query(
          `SELECT run_id AS runId, parent_run_id AS parentRunId,
                  conversation_id AS conversationId, agent_id AS agentId,
                  status, model_ref AS modelRef, authorization,
                  system_prompt AS systemPrompt, skill_roots AS skillRoots,
                  terminal_result AS terminalResult, created_at AS createdAt,
                  terminal_at AS terminalAt
             FROM agent_run WHERE run_id = ?`,
        )
        .get(id) as RunRow | undefined;

    const focus = loadRun(runId);
    if (!focus) return null;

    // Walk up parent_run_id to root (capped at 20 hops to prevent cycles).
    let root = focus;
    const visitedUp = new Set<string>([root.runId]);
    for (let hop = 0; hop < 20 && root.parentRunId; hop++) {
      if (visitedUp.has(root.parentRunId)) break;
      const parent = loadRun(root.parentRunId);
      if (!parent) break;
      visitedUp.add(parent.runId);
      root = parent;
    }

    // BFS downward from root (capped at 200 nodes).
    const allRows = new Map<string, RunRow>([[root.runId, root]]);
    const childrenMap = new Map<string, RunRow[]>();
    const queue: string[] = [root.runId];
    while (queue.length > 0 && allRows.size < 200) {
      const parentId = queue.shift()!;
      const kids = this.#db
        .query(
          `SELECT run_id AS runId, parent_run_id AS parentRunId,
                  conversation_id AS conversationId, agent_id AS agentId,
                  status, model_ref AS modelRef, authorization,
                  system_prompt AS systemPrompt, skill_roots AS skillRoots,
                  terminal_result AS terminalResult, created_at AS createdAt,
                  terminal_at AS terminalAt
             FROM agent_run
            WHERE parent_run_id = ?
            ORDER BY created_at ASC`,
        )
        .all(parentId) as RunRow[];
      childrenMap.set(parentId, kids);
      for (const kid of kids) {
        if (!allRows.has(kid.runId)) {
          allRows.set(kid.runId, kid);
          queue.push(kid.runId);
        }
      }
    }

    const waitByRun = this.#waitMsForRuns([...allRows.values()]);

    const toNode = (row: RunRow, seen = new Set<string>()): RunTraceNode => {
      seen.add(row.runId);
      const outcome = safeJsonParse(row.terminalResult);
      const durationMs =
        row.terminalAt != null ? Math.max(0, row.terminalAt - row.createdAt) : null;
      const humanWaitMs = waitByRun.get(row.runId) ?? 0;
      const activeDurationMs = durationMs != null ? Math.max(0, durationMs - humanWaitMs) : null;
      const kids = (childrenMap.get(row.runId) ?? [])
        .filter((k) => !seen.has(k.runId))
        .map((k) => toNode(k, seen));
      return {
        runId: row.runId,
        parentRunId: row.parentRunId,
        conversationId: row.conversationId,
        agentId: row.agentId,
        status: row.status,
        modelId: modelIdFromRef(row.modelRef),
        authorization: row.authorization,
        createdAt: row.createdAt,
        terminalAt: row.terminalAt,
        durationMs,
        activeDurationMs,
        humanWaitMs,
        usage: usageFromOutcome(outcome),
        error: errorFromOutcome(outcome),
        children: kids,
      };
    };

    const focusOutcome = safeJsonParse(focus.terminalResult);
    const focusEvents = this.listRunEvents(runId, 1000);

    // Wait intervals for focus run from pending_action
    const actionRows = this.#db
      .query(
        `SELECT action_id AS actionId, kind, created_at AS createdAt,
                resolved_at AS resolvedAt, owner
           FROM pending_action
          WHERE run_id = ?
          ORDER BY created_at ASC`,
      )
      .all(runId) as Array<{
      actionId: string;
      kind: string;
      createdAt: number;
      resolvedAt: number | null;
      owner: string | null;
    }>;
    const { intervals: waitIntervals } = computeWaitIntervals(
      actionRows,
      focus.createdAt,
      focus.terminalAt ?? Date.now(),
    );

    // Tool payloads from outcome.messages + product_tool_call
    const toolPayloads: Record<string, ToolPayloadSnapshot> = {
      ...extractToolPayloadsFromOutcome(focusOutcome),
    };
    const ptRows = this.#db
      .query(
        `SELECT call_id AS callId, tool_name AS toolName, result, error, status
           FROM product_tool_call
          WHERE run_id = ?`,
      )
      .all(runId) as Array<{
      callId: string;
      toolName: string;
      result: string | null;
      error: string | null;
      status: string;
    }>;
    for (const pt of ptRows) {
      if (!pt.callId) continue;
      const existing = toolPayloads[pt.callId];
      toolPayloads[pt.callId] = {
        input: existing?.input,
        output: pt.error
          ? redactAndTruncate(pt.error, 2048)
          : pt.result
            ? redactAndTruncate(safeJsonParse(pt.result) ?? pt.result, 2048)
            : existing?.output,
        isError:
          pt.status === "failed" || pt.status === "error" || Boolean(pt.error) || existing?.isError,
      };
    }

    // Activated skills: union of skill_activated events + outcome message scan
    const skillMap = new Map<string, ActivatedSkill>();
    for (const ev of focusEvents) {
      if (ev.type === "skill_activated" && typeof ev.data.skillName === "string") {
        skillMap.set(ev.data.skillName, {
          skillName: ev.data.skillName,
          path: typeof ev.data.path === "string" ? ev.data.path : "",
        });
      }
    }
    const outcomeMessages =
      focusOutcome && typeof focusOutcome === "object" && "messages" in focusOutcome
        ? ((focusOutcome as { messages?: unknown }).messages as readonly Message[] | undefined)
        : undefined;
    for (const sk of extractSkillsFromMessages(outcomeMessages)) {
      if (!skillMap.has(sk.skillName)) skillMap.set(sk.skillName, sk);
    }

    // TTFT samples
    const ttftSamples: Array<{ turn: number; ttftMs: number; ts: number }> = [];
    for (const ev of focusEvents) {
      if (ev.type === "llm_turn_started") {
        const ttftMs = Number(ev.data.ttftMs);
        if (Number.isFinite(ttftMs) && ttftMs >= 0) {
          ttftSamples.push({ turn: Number(ev.data.turn ?? ttftSamples.length), ttftMs, ts: ev.ts });
        }
      }
    }

    const parsedSkillRoots = safeJsonParse(focus.skillRoots);
    const skillRoots = Array.isArray(parsedSkillRoots)
      ? parsedSkillRoots.filter((s): s is string => typeof s === "string")
      : [];

    return {
      rootRunId: root.runId,
      focusRunId: runId,
      tree: toNode(root),
      systemPrompt: focus.systemPrompt ?? null,
      skillRoots,
      skillsActivated: [...skillMap.values()],
      waitIntervals,
      toolPayloads,
      ttftSamples,
    };
  }
}
