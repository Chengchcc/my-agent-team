import type { SubAgentProfile } from '../agent/sub-agent-config';

export interface AgentProfile {
  id: string;
  workspace: string;
  model?: string | undefined;
  toolProfile: SubAgentProfile;
  workingDir: string;
  allowedRoots?: string[] | undefined;
  permissionTimeoutMs?: number | undefined;
}

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  profileId: string;
  allowedUsers?: string[] | undefined;
}

export interface BotsConfig {
  profiles: Record<string, AgentProfile>;
  bots: BotConfig[];
}
