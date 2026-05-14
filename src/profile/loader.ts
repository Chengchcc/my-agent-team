import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { botsConfigSchema } from './types';
import type { AgentProfile, BotConfig, BotsConfig } from './types';
import { homedir } from 'node:os';

export function resolvePath(p: string): string {
  return p.replace(/^~/, () => homedir() ?? '/root');
}

export function getBotsConfigPath(): string {
  return join(homedir() ?? '/root', '.my-agent', 'bots.yml');
}

export function loadBotsConfig(configPath?: string): BotsConfig {
  const resolvedPath = configPath ?? getBotsConfigPath();
  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Bots config not found at ${resolvedPath}. Run "my-agent bot add" first.`,
    );
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw);
  const result = botsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid bots config: ${result.error.message}`);
  }
  const config = result.data as BotsConfig;
  // Populate id from record key and apply path resolution to all profile paths
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    profile.id = profileId;
    profile.workspace = resolvePath(profile.workspace);
    profile.workingDir = resolvePath(profile.workingDir);
    if (profile.allowedRoots) {
      profile.allowedRoots = profile.allowedRoots.map((r) => resolvePath(r));
    }
  }
  return config;
}

export function getProfile(
  profileId: string,
  configPath?: string,
): AgentProfile {
  const config = loadBotsConfig(configPath);
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new Error(`Profile "${profileId}" not found in bots.yml`);
  }
  return profile;
}

export function getBot(
  larkAppId: string,
  configPath?: string,
): { config: BotConfig; profile: AgentProfile } {
  const config = loadBotsConfig(configPath);
  const bot = config.bots.find((b) => b.larkAppId === larkAppId);
  if (!bot) throw new Error(`Bot ${larkAppId} not found`);
  return { config: bot, profile: getProfile(bot.profileId, configPath) };
}

export function listProfiles(configPath?: string): AgentProfile[] {
  return Object.values(loadBotsConfig(configPath).profiles);
}
