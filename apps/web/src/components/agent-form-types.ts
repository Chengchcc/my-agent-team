import { z } from "zod";

export const agentFormSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required"),
  backendKind: z.string().trim().min(1, "Backend is required"),
  model: z.string().trim().min(1, "Model is required"),
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
  backendKind?: string;
  modelProvider?: string;
  modelName?: string;
  reasoningEffort?: "none" | "low" | "high" | "max";
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number | null;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
}
