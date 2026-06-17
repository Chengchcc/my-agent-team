import { z } from "zod";

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

/** Canonical agent spec type — points to the current production schema (V2). */
export type AgentSpec = z.infer<typeof AgentSpecV2>;
