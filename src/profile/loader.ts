import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { botsConfigSchema } from './types';
import type { AgentProfile, BotConfig, BotsConfig } from './types';
import { homedir } from 'node:os';

export function resolvePath(p: string): string {
  return p.replace(/^~/, () => homedir() ?? '/root');
}

function getBotsConfigPath(): string {
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
    profile.dataDir = resolvePath(profile.dataDir);
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

function listProfiles(configPath?: string): AgentProfile[] {
  return Object.values(loadBotsConfig(configPath).profiles);
}

const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md'] as const;

const PLACEHOLDER_MARKERS = [
  '_(customize me)_',
  '_(generation failed',
  /^# Personality\n\nI am a helpful \w+ agent\./m,
];

function isIdentityFileReady(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return false;
  return !PLACEHOLDER_MARKERS.some(marker =>
    typeof marker === 'string' ? content.includes(marker) : marker.test(content),
  );
}

export function loadProfileIdentity(profileId: string): string {
  try {
    const profile = getProfile(profileId);
    const sections: Array<{ tag: string; content: string }> = [];

    const tagMap: Record<string, string> = {
      'SOUL.md': 'soul',
      'IDENTITY.md': 'persona',
      'AGENTS.md': 'rules',
    };

    for (const filename of IDENTITY_FILES) {
      const filePath = join(profile.dataDir, filename);
      if (isIdentityFileReady(filePath)) {
        sections.push({
          tag: tagMap[filename] ?? 'unknown',
          content: readFileSync(filePath, 'utf-8').trim(),
        });
      }
    }

    if (sections.length === 0) {
      return `<agent_initialization>
You are a newly created agent with no defined identity yet. Your profile files (SOUL.md, IDENTITY.md, AGENTS.md) are empty or contain only placeholder content.

In your first interactions with the user, learn what role they expect you to play:
- What is your area of expertise?
- What is your working style?
- What are your boundaries?

Once you understand your role, tell the user "I've learned my role. You can save my identity with /restart, or I can keep it as-is for now."
</agent_initialization>`;
    }

    const blocks = sections.map(s => `<${s.tag}>\n${s.content}\n</${s.tag}>`).join('\n');
    return `<agent_identity>\n${blocks}\n</agent_identity>`;
  } catch { return ''; }
}
