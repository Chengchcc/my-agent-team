import { z } from "zod";

export const agentFormSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required"),
  /** Which harness runs this agent: an ACP registry key (oma | omp | claude | pi).
   *  One adapter drives all of them (ADR 0040 decision 7), so this is the only
   *  "who runs it" field the form has. */
  harness: z.string().trim().min(1, "Harness is required"),
  /** The model that harness runs, in that harness's own vocabulary.
   *  "" = the harness's own default. */
  model: z.string().trim().default(""),
  reasoningEffort: z.enum(["", "none", "low", "high", "max"]).default(""),
  permissionMode: z.enum(["ask", "auto", "deny"]).default("ask"),
  maxSteps: z.string().trim().default(""),
  workspacePath: z.string().trim().default(""),
  enableLark: z.boolean().default(false),
  botDisplayName: z.string().trim().default(""),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

/** What the create page's chat may propose for an agent that does not exist
 *  yet. Deliberately narrower than AgentRow: a draft must never carry another
 *  agent's identity, workspacePath or lark credentials into the form. */
export interface AgentDraft {
  name?: string;
  harness?: string;
  model?: string;
  reasoningEffort?: "none" | "low" | "high" | "max";
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number | null;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
}
