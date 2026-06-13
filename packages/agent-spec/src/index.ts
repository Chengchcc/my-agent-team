import { z } from "zod";

/** AgentSpec V1 schema version. */
export const AGENT_SPEC_V1_VERSION = "1" as const;
/** @deprecated Use AGENT_SPEC_V1_VERSION. */
export const CURRENT_SCHEMA_VERSION = AGENT_SPEC_V1_VERSION;

export const AgentSpecV1 = z
  .object({
    /** Must equal CURRENT_SCHEMA_VERSION. Runner hard-fails on mismatch. */
    schemaVersion: z.literal("1"),

    /** Workspace path as seen by the runner process (may be sandbox-internal /workspace). */
    workspace: z.string().min(1),

    /** Thread identifier. Same threadId across runs reuses checkpointer history. */
    threadId: z.string().min(1),

    /** Model configuration. */
    model: z.object({
      provider: z.literal("anthropic"),
      model: z.string().min(1),
      baseURL: z.string().url().optional(),
    }),

    /** API key. Optional — runner falls back to ANTHROPIC_API_KEY env. */
    apiKey: z.string().optional(),

    /** Permission mode. Defaults to 'ask' on the harness side. M8 enforces. */
    permissionMode: z.enum(["ask", "auto", "deny"]).optional(),

    /** Max steps for this run. Forwarded to agent.run({ maxSteps }). */
    maxSteps: z.number().int().positive().optional(),

    /** Single-shot user input for this run. */
    input: z.string(),

    // ─── M9 durable run fields ──────────────────────────────────────

    /** Logical run identifier, issued by backend, shared across interrupt/resume attempts. */
    runId: z.string().min(1).optional(),

    /** Physical attempt identifier, issued by backend, for heartbeat row targeting. */
    attemptId: z.string().min(1).optional(),

    /** Execution mode. 'reflect' = post-run reflection run (input filled by runner via reflectionGuidance()). */
    mode: z.enum(["run", "resume", "reflect"]).default("run"),

    /** Snapshot: BOOTSTRAP.md existed BEFORE the main run started. Set by backend; runner no longer self-detects. */
    isGenesis: z.boolean().optional(),

    /** Resume payload. Required when mode='resume'. */
    resumeCommand: z
      .object({
        approved: z.boolean(),
        message: z.string().optional(),
      })
      .optional(),

    /** Storage connection configuration. eventLog is backend-issued (converged); checkpointer can be heterogeneous. */
    storage: z
      .object({
        eventLog: z
          .object({
            kind: z.literal("sqlite"),
            path: z.string().min(1),
          })
          .optional(),
        checkpointer: z
          .object({
            kind: z.enum(["sqlite", "memory"]),
            path: z.string().optional(),
          })
          .optional(),
      })
      .optional(),

    // ─── M10 conversation fields ────────────────────────────────────

    /** Conversation identifier — the aggregate dimension. Absent = legacy single-thread mode. */
    conversationId: z.string().min(1).optional(),

    /** Member identifier of the agent member this run belongs to (= the agent that was @-ed). */
    senderMemberId: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "resume" && !v.resumeCommand) {
      ctx.addIssue({
        code: "custom",
        message: "resumeCommand is required when mode is 'resume'",
        path: ["resumeCommand"],
      });
    }
    if (v.senderMemberId && !v.conversationId) {
      ctx.addIssue({
        code: "custom",
        message: "conversationId is required when senderMemberId is present",
        path: ["conversationId"],
      });
    }
  });

export type AgentSpec = z.infer<typeof AgentSpecV1>;

// ─── AgentSpec v2 (M14.7) — runner-daemon start payload ──────────────

// ─── Common fields shared by all AgentSpecV2 modes ─────────────────

const V2Common = {
  schemaVersion: z.literal("2"),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  model: z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    baseURL: z.string().url().optional(),
  }),
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  conversationId: z.string().min(1).optional(),
  senderMemberId: z.string().min(1).optional(),
};

export const AgentSpecV2 = z.discriminatedUnion("mode", [
  z.object({ ...V2Common, mode: z.literal("run"), input: z.string() }),
  z.object({
    ...V2Common,
    mode: z.literal("resume"),
    resumeCommand: z.object({ approved: z.boolean(), message: z.string().optional() }),
  }),
  z.object({
    ...V2Common,
    mode: z.literal("reflect"),
    input: z.string(),
    parentRunId: z.string().min(1),
  }),
]);

export type AgentSpecV2 = z.infer<typeof AgentSpecV2>;
export type AgentSpecV2Run = Extract<AgentSpecV2, { mode: "run" }>;
export type AgentSpecV2Resume = Extract<AgentSpecV2, { mode: "resume" }>;
export type AgentSpecV2Reflect = Extract<AgentSpecV2, { mode: "reflect" }>;
