import { z } from "zod";

/** Wire-format schema version. Bump only on breaking changes. */
export const CURRENT_SCHEMA_VERSION = "1" as const;

export const AgentSpecV1 = z.object({
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
});

export type AgentSpec = z.infer<typeof AgentSpecV1>;
