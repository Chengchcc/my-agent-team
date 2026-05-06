import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from './constants';
import { settingsSchema } from './schema';
import { defaultSettings } from './defaults';
import type { Settings } from './types';

/**
 * Expand ~ to user home directory in paths
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Deep merge two configuration objects: user config overrides defaults
 */

function mergeSection<T>(defaults: T | undefined, user: T): T {
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    return { ...defaults, ...user };
  }
  return user;
}

export function mergeConfigs(defaults: Partial<Settings>, user: Partial<Settings>): Partial<Settings> {
  const result: Partial<Settings> = { ...defaults };

  if (user.llm) result.llm = mergeSection(defaults.llm, user.llm);
  if (user.context) result.context = mergeSection(defaults.context, user.context);
  if (user.memory) result.memory = mergeSection(defaults.memory, user.memory);
  if (user.skills) result.skills = mergeSection(defaults.skills, user.skills);
  if (user.subAgent) result.subAgent = mergeSection(defaults.subAgent, user.subAgent);
  if (user.debug) result.debug = mergeSection(defaults.debug, user.debug);

  if (user.tui) {
    result.tui = {
      history: mergeSection(defaults.tui?.history, user.tui.history),
      sessions: mergeSection(defaults.tui?.sessions, user.tui.sessions),
    } as Settings['tui'];
  }

  if (user.security) {
    result.security = {
      allowedRoots: user.security.allowedRoots ?? defaults.security?.allowedRoots,
    } as Settings['security'];
  }

  if (user.mcp) {
    const servers = user.mcp.servers ?? defaults.mcp?.servers;
    result.mcp = defaults.mcp
      ? { ...defaults.mcp, ...user.mcp, ...(servers ? { servers } : {}) }
      : { ...user.mcp };
  }

  if (user.trace) {
    result.trace = defaults.trace
      ? {
          ...defaults.trace,
          ...user.trace,
          redaction: mergeSection(defaults.trace.redaction, user.trace.redaction),
          nudge: mergeSection(defaults.trace.nudge, user.trace.nudge),
        }
      : { ...user.trace };
  }

  return result;
}

/**
 * Load and parse a single YAML config file
 */
async function loadConfigFile(filePath: string): Promise<Partial<Settings> | null> {
  try {
    await fs.access(filePath);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = yaml.load(content) as Partial<Settings>;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Find config files in order of priority:
 * 1. ./settings.yml (project-level)
 * 2. ~/.my-agent/settings.yml (user-level)
 */
function getConfigPaths(): string[] {
  const projectConfig = path.join(process.cwd(), CONFIG_FILE_NAME);
  const userConfig = path.join(os.homedir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  return [projectConfig, userConfig];
}

/**
 * Expand all tilde paths in the final config
 */
function expandAllPaths(settings: Settings): Settings {
  settings.memory.globalBaseDir = expandTilde(settings.memory.globalBaseDir);
  settings.tui.history.filePath = expandTilde(settings.tui.history.filePath);
  settings.tui.sessions.dir = expandTilde(settings.tui.sessions.dir);
  settings.subAgent.worktreeRootDir = expandTilde(settings.subAgent.worktreeRootDir);
  settings.security.allowedRoots = settings.security.allowedRoots.map(
    root => expandTilde(root)
  );
  // Resolve allowed roots to absolute paths
  settings.security.allowedRoots = settings.security.allowedRoots.map(
    root => path.resolve(root)
  );
  return settings;
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(settings: Settings): Settings {
  // MODEL env var overrides model
  if (process.env.MODEL) {
    settings.llm.model = process.env.MODEL;
  }

  // API keys / auth tokens from environment
  // For Volces Ark, ANTHROPIC_AUTH_TOKEN is used instead of ANTHROPIC_API_KEY
  if (settings.llm.provider === 'claude') {
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      settings.llm.apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
    } else if (process.env.ANTHROPIC_API_KEY) {
      settings.llm.apiKey = process.env.ANTHROPIC_API_KEY;
    }
  }
  if (settings.llm.provider === 'openai' && process.env.OPENAI_API_KEY) {
    settings.llm.apiKey = process.env.OPENAI_API_KEY;
  }

  // Base URLs from environment
  if (settings.llm.provider === 'claude' && process.env.ANTHROPIC_BASE_URL) {
    settings.llm.baseURL = process.env.ANTHROPIC_BASE_URL;
  }
  if (settings.llm.provider === 'openai' && process.env.OPENAI_BASE_URL) {
    settings.llm.baseURL = process.env.OPENAI_BASE_URL;
  }

  // Debug from command line (--debug) is handled earlier, but env can also set it
  if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
    settings.debug.enabled = true;
  }

  return settings;
}

/**
 * Load the complete configuration with all layers and validation
 */
export async function loadSettings(): Promise<Settings> {
  let current: Partial<Settings> = {};
  const configPaths = getConfigPaths();

  // Load and merge from highest priority (project) to lowest (user)
  for (const configPath of configPaths) {
    const loaded = await loadConfigFile(configPath);
    if (loaded) {
      current = mergeConfigs(current, loaded);
    }
  }

  // Merge with defaults
  let settings = mergeConfigs(defaultSettings, current) as Settings;

  // Expand ~ in paths
  settings = expandAllPaths(settings);

  // Apply environment variable overrides (highest priority)
  settings = applyEnvOverrides(settings);

  // Validate with Zod
  const result = settingsSchema.safeParse(settings);
  if (!result.success) {
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }

  return result.data as Settings;
}
