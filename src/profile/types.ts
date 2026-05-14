import { z } from 'zod';
import { SUB_AGENT_PROFILES } from '../agent/sub-agent-config';

/**
 * Schema for validating a single agent profile in bots.yml.
 * The `id` field is NOT in the schema — it is populated from the record key
 * by loadBotsConfig().
 */
export const agentProfileSchema = z.object({
  /** Directory for profile data: AGENTS.md, SOUL.md, memory.db, sessions/ */
  dataDir: z.string(),
  model: z.string().optional(),
  toolProfile: z.enum(SUB_AGENT_PROFILES),
  /** Working directory — where the agent runs bash and edits files */
  workingDir: z.string(),
  allowedRoots: z.array(z.string()).optional(),
  permissionTimeoutMs: z.number().optional(),
});

/** Full agent profile: schema fields + id populated from the record key. */
export interface AgentProfile extends z.infer<typeof agentProfileSchema> {
  id: string;
}

export const botConfigSchema = z.object({
  larkAppId: z.string(),
  larkAppSecret: z.string(),
  profileId: z.string(),
  allowedUsers: z.array(z.string()).optional(),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

export const botsConfigSchema = z.object({
  profiles: z.record(agentProfileSchema),
  bots: z.array(botConfigSchema),
});

/**
 * Full bots config after load-time processing:
 * profiles have their `id` populated from the record key.
 */
export interface BotsConfig {
  profiles: Record<string, AgentProfile>;
  bots: BotConfig[];
}
