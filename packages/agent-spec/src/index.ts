import { z } from "zod";

/** Wire-format schema version. Bump only on breaking changes. */
export const CURRENT_SCHEMA_VERSION = "1" as const;

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

    /** Execution mode. Defaults to 'run'. */
    mode: z.enum(["run", "resume"]).default("run"),

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
