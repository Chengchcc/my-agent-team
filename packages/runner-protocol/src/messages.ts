// ─── M17.3: Runner frame codecs — zod schemas are the single source of truth ──

import { z } from "zod";

const runnerToHostSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_started"),
    runId: z.string(),
    parentRunId: z.string(),
    threadId: z.string(),
    kind: z.literal("reflect"),
    spec: z.record(z.unknown()),
  }),
  z.object({ type: z.literal("event"), runId: z.string(), event: z.unknown() }),
  z.object({ type: z.literal("heartbeat"), runId: z.string() }),
  z.object({
    type: z.literal("run_done"),
    runId: z.string(),
    status: z.enum(["succeeded", "error", "aborted"]),
    wantsReflect: z.boolean().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("daemon_health"),
    agentId: z.string(),
    uptimeMs: z.number(),
    activeRunIds: z.array(z.string()),
    checkpointer: z.object({
      kind: z.literal("sqlite"),
      ok: z.boolean(),
      lastError: z.string().optional(),
    }),
    workspace: z.object({ ok: z.boolean(), lastError: z.string().optional() }),
    ts: z.number(),
  }),
]);

const hostToRunnerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    runId: z.string(),
    spec: z.record(z.unknown()),
    reflect: z.boolean().optional(),
    preloadedMessages: z.array(z.unknown()).optional(),
    surfaceContext: z
      .object({
        surface: z.enum(["lark", "web", "cli", "orchestrator"]),
        conversationId: z.string(),
        runId: z.string(),
        capabilities: z.array(z.enum(["start_new_conversation", "submit_deliverable"])),
        issue: z.object({ issueId: z.string(), fromStatus: z.string() }).optional(),
      })
      .optional(),
    trace: z.unknown().optional(),
  }),
  z.object({ type: z.literal("abort"), runId: z.string() }),
  z.object({ type: z.literal("run_finalized"), runId: z.string() }),
]);

// M17.3: Types derived from zod schemas — schema is the single source of truth.
// Previously these were hand-written TS unions that could drift from the schemas.
export type HostToRunner = z.infer<typeof hostToRunnerSchema>;
export type RunnerToHost = z.infer<typeof runnerToHostSchema>;
export type ProtocolMessage = HostToRunner | RunnerToHost;

/** Parse a runner→host frame from NDJSON, throwing on invalid shape. */
export function parseRunnerToHost(raw: unknown): RunnerToHost {
  return runnerToHostSchema.parse(raw) as RunnerToHost;
}

/** Parse a host→runner frame from NDJSON, throwing on invalid shape. */
export function parseHostToRunner(raw: unknown): HostToRunner {
  return hostToRunnerSchema.parse(raw) as HostToRunner;
}
