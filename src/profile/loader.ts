import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgentProfile, BotsConfig } from './types';
import { homedir } from 'node:os';

const agentProfileSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  model: z.string().optional(),
  toolProfile: z.enum(['read_only', 'code_editor', 'general']),
  workingDir: z.string(),
  allowedRoots: z.array(z.string()).optional(),
  permissionTimeoutMs: z.number().optional(),
});

const botsConfigSchema = z.object({
  profiles: z.record(agentProfileSchema),
  bots: z.array(z.object({
    larkAppId: z.string(),
    larkAppSecret: z.string(),
    profileId: z.string(),
    allowedUsers: z.array(z.string()).optional(),
  })),
});

export function resolvePath(p: string): string {
  return p.replace(/^~/, () => homedir() ?? '/root');
}

export function getBotsConfigPath(): string {
  return join(homedir() ?? '/root', '.my-agent', 'bots.yml');
}

export function loadBotsConfig(): BotsConfig {
  const configPath = getBotsConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Bots config not found at ${configPath}. Run "my-agent bot add" first.`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  const result = botsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid bots config: ${result.error.message}`);
  }
  return result.data;
}

export function getProfile(profileId: string): AgentProfile {
  const config = loadBotsConfig();
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new Error(`Profile "${profileId}" not found in bots.yml`);
  }
  return profile;
}

export function getBot(larkAppId: string) {
  const config = loadBotsConfig();
  const bot = config.bots.find(b => b.larkAppId === larkAppId);
  if (!bot) throw new Error(`Bot ${larkAppId} not found`);
  return { config: bot, profile: getProfile(bot.profileId) };
}

export function listProfiles(): AgentProfile[] {
  return Object.values(loadBotsConfig().profiles);
}
