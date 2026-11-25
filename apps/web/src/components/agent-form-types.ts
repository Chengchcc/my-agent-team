import { z } from "zod";

const skillSchema = z.object({ id: z.string().trim().min(1), description: z.string().default("") });

/** The member form's validation. One schema for every surface that edits a member, so they
 *  cannot accept different members. */
export const agentFormSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required"),
  /** Which harness runs this agent: an ACP registry key (oma | omp | claude | pi). One adapter
   *  drives all of them (ADR 0040 decision 7). */
  harness: z.string().trim().min(1, "Harness is required"),
  /** The model that harness runs, in that harness's own vocabulary. "" = its own default. */
  model: z.string().trim().default(""),
  reasoningEffort: z.enum(["", "none", "low", "high", "max"]).default(""),
  permissionMode: z.enum(["ask", "auto", "deny", "yolo"]).default("ask"),
  /** As text, so an empty field is valid: "" means no limit. */
  maxSteps: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || (Number.isInteger(Number(value)) && Number(value) >= 1),
      "Max steps must be a whole number of 1 or more",
    ),
  workspacePath: z.string().trim().default(""),
  enableLark: z.enum(["off", "on"]).default("off"),
  botDisplayName: z.string().trim().default(""),
  /** ADR 0049/0050: "worker" hides lark and makes the capability card the primary identity. */
  role: z.enum(["front", "worker"]).default("front"),
  /** ADR 0048 capability card: what dispatch decisions read. */
  description: z.string().trim().default(""),
  skills: z.array(skillSchema).default([]),
  /** MCP servers and skill packs the member has mounted. */
  mcpServerIds: z.array(z.string()).default([]),
  skillPackIds: z.array(z.string()).default([]),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;
