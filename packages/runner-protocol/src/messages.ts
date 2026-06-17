import type { AgentEvent } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { RuntimeTraceContext } from "@my-agent-team/runtime-observability";

export type HostToRunner =
  | {
      type: "start";
      runId: string;
      spec: Record<string, unknown>;
      reflect?: boolean;
      /** Messages already projected into the backend checkpointer by broadcastMessage().
       *  The daemon seeds its own checkpointer with these before creating the agent,
       *  so conversation context is visible to checkpointer.load(). */
      preloadedMessages?: readonly Message[];
      /** M15.1: Surface context for injecting surface-specific extra tools.
       *  Only set for Lark-triggered main runs; stripped for reflect. */
      surfaceContext?: {
        surface: "lark" | "web" | "cli";
        conversationId: string;
        runId: string;
        capabilities: Array<"start_new_conversation">;
      };
      /** M16: Trace context propagated from backend to runner daemon. */
      trace?: RuntimeTraceContext;
    }
  | { type: "abort"; runId: string }
  | { type: "run_finalized"; runId: string };

export type RunnerToHost =
  | {
      type: "run_started";
      runId: string;
      parentRunId: string;
      threadId: string;
      kind: "reflect";
      spec: Record<string, unknown>;
    }
  | { type: "event"; runId: string; event: AgentEvent }
  | { type: "heartbeat"; runId: string }
  | {
      type: "run_done";
      runId: string;
      status: "succeeded" | "error" | "aborted";
      wantsReflect?: boolean;
      error?: string;
    }
  | {
      /** M16: Daemon-level health signal sent every 10s, even when idle. */
      type: "daemon_health";
      agentId: string;
      uptimeMs: number;
      activeRunIds: string[];
      checkpointer: { kind: "sqlite"; ok: boolean; lastError?: string };
      workspace: { ok: boolean; lastError?: string };
      ts: number;
    };

export type ProtocolMessage = HostToRunner | RunnerToHost;

// ─── M17.3: Wire codec — zod schemas for runtime validation ──

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
  z.object({ type: z.literal("event"), runId: z.string(), event: z.object({}).passthrough() }),
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
    checkpointer: z.object({ kind: z.literal("sqlite"), ok: z.boolean(), lastError: z.string().optional() }),
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
    preloadedMessages: z.array(z.object({}).passthrough()).optional(),
    surfaceContext: z
      .object({
        surface: z.enum(["lark", "web", "cli"]),
        conversationId: z.string(),
        runId: z.string(),
        capabilities: z.array(z.literal("start_new_conversation")),
      })
      .optional(),
    trace: z.object({}).passthrough().optional(),
  }),
  z.object({ type: z.literal("abort"), runId: z.string() }),
  z.object({ type: z.literal("run_finalized"), runId: z.string() }),
]);

/** Parse a runner→host frame from NDJSON, throwing on invalid shape. */
export function parseRunnerToHost(raw: unknown): RunnerToHost {
  return runnerToHostSchema.parse(raw) as RunnerToHost;
}

/** Parse a host→runner frame from NDJSON, throwing on invalid shape. */
export function parseHostToRunner(raw: unknown): HostToRunner {
  return hostToRunnerSchema.parse(raw) as HostToRunner;
}
