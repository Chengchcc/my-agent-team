// src/daemon/cli-commands.ts
// CLI management commands: interactive bot setup wizard + daemon lifecycle.
// Uses @clack/prompts for fancy TUI + Zod for input validation.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import { z } from 'zod';
import * as p from '@clack/prompts';

// ── User-facing output ────────────────────────────────────────────────────

const { log } = {
  log: (msg: string): void => { process.stdout.write(msg + '\n'); },
};

// ── Validation schemas ────────────────────────────────────────────────────

const MIN_SECRET_LENGTH = 8;
const larkAppIdSchema = z.string().regex(/^cli_[\w]+$/, 'Lark App ID should start with "cli_"');
const larkSecretSchema = z.string().min(MIN_SECRET_LENGTH, `App Secret should be at least ${MIN_SECRET_LENGTH} characters`);
const profileNameSchema = z.string().regex(/^[\w-]+$/, 'Profile name: letters, numbers, hyphens, underscores only');

// ── Helpers ──────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.replace(/^~/, () => homedir() ?? '/root');
}

function getConfigPath(): string {
  const configDir = join(homedir() ?? '/root', '.my-agent');
  mkdirSync(configDir, { recursive: true });
  return join(configDir, 'bots.yml');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadConfig(): any {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* start fresh */ }
  }
  return { profiles: {}, bots: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveConfig(config: any): void {
  writeFileSync(getConfigPath(), stringifyYaml(config), 'utf-8');
}

function loadExistingProfiles(): Record<string, { dataDir: string; toolProfile: string; workingDir: string; model?: string }> {
  return loadConfig().profiles ?? {};
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

async function createProfileInteractive(): Promise<string | null> {

  const nameResult = await p.text({
    message: 'Profile name:',
    placeholder: 'backend-expert',
    validate: (v) => {
      if (!v) return 'Profile name is required.';
      const parsed = profileNameSchema.safeParse(v);
      if (!parsed.success) return parsed.error.issues[0]!.message;
      const existing = loadExistingProfiles();
      if (existing[v]) return `Profile "${v}" already exists.`;
      return undefined;
    },
  });
  if (p.isCancel(nameResult)) return null;

  const roleResult = await p.text({
    message: 'Role description:',
    placeholder: '后端架构师，负责 API 设计、数据库优化',
  });
  if (p.isCancel(roleResult)) return null;

  const defaultWd = expandHome(`~/.my-agent/profiles/${nameResult.trim()}/workspace`);

  const workingDirResult = await p.text({
    message: 'Working directory:',
    placeholder: defaultWd,
    initialValue: defaultWd,
  });
  if (p.isCancel(workingDirResult)) return null;

  const toolResult = await p.select({
    message: 'Tool profile:',
    options: [
      { value: 'read_only', label: 'read_only — read, grep, glob, ls' },
      { value: 'code_editor', label: 'code_editor — + text_editor, bash' },
      { value: 'general', label: 'general — all tools' },
    ],
    initialValue: 'code_editor' as const,
  });
  if (p.isCancel(toolResult)) return null;
  const toolProfile = toolResult as 'read_only' | 'code_editor' | 'general';

  const modelResult = await p.text({
    message: 'Model (enter for default):',
    placeholder: 'using global default',
  });
  if (p.isCancel(modelResult)) return null;
  const model = modelResult.trim() || undefined;

  const profileName = nameResult.trim();
  const workingDir = workingDirResult.trim() || defaultWd;
  const roleText = roleResult.trim() || 'AI assistant';

  // Create workspace directory and identity files
  const wsPath = expandHome(`~/.my-agent/profiles/${profileName}`);
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(join(wsPath, 'sessions'), { recursive: true });
  mkdirSync(workingDir, { recursive: true });

  // Initialize identity files
  const initMethod = await p.select({
    message: 'How to initialize SOUL.md & IDENTITY.md?',
    options: [
      { value: 'ai', label: '✨ Auto-generate with AI (from role description)' },
      { value: 'minimal', label: '📝 Use minimal template' },
      { value: 'skip', label: '⏭️  Skip — I\'ll write them myself' },
    ],
    initialValue: 'ai' as const,
  });
  if (p.isCancel(initMethod)) return null;

  if (initMethod === 'ai') {
    const s = p.spinner();
    s.start('Generating personality with AI...');
    const generated = await generateIdentity(roleText, profileName, toolProfile);
    writeFileSync(join(wsPath, 'SOUL.md'), generated.soul, 'utf-8');
    writeFileSync(join(wsPath, 'IDENTITY.md'), generated.identity, 'utf-8');
    writeFileSync(join(wsPath, 'AGENTS.md'), generated.agents, 'utf-8');
    s.stop('✨ Personality generated');
  } else if (initMethod === 'minimal') {
    writeFileSync(join(wsPath, 'AGENTS.md'), `# ${profileName}\n\n${roleText}\n`, 'utf-8');
    writeFileSync(join(wsPath, 'SOUL.md'), `# Personality\n\nI am a helpful ${profileName} agent. My focus: ${roleText}\n`, 'utf-8');
    writeFileSync(join(wsPath, 'IDENTITY.md'), `# Identity\n\n- Name: ${profileName}\n- Role: ${roleText}\n`, 'utf-8');
  } else {
    // Skip — create empty files with a note
    writeFileSync(join(wsPath, 'AGENTS.md'), `# ${profileName}\n\n_(customize me)_\n`, 'utf-8');
    writeFileSync(join(wsPath, 'SOUL.md'), `# Personality\n\n_(customize me — edit this file to define my personality, tone, and boundaries)_\n`, 'utf-8');
    writeFileSync(join(wsPath, 'IDENTITY.md'), `# Identity\n\n- Name: ${profileName}\n- Role: _(customize me)_\n`, 'utf-8');
  }

  // Save profile config
  const config = loadConfig();
  config.profiles = config.profiles ?? {};
  config.profiles[profileName] = {
    dataDir: `~/.my-agent/profiles/${profileName}`,
    toolProfile,
    workingDir,
    ...(model ? { model } : {}),
    permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
  };
  saveConfig(config);

  log(`\n✅ Profile "${profileName}" created at ${wsPath}`);
  if (initMethod === 'skip') log('   Edit SOUL.md and IDENTITY.md to customize personality\n');
  return profileName;
}

// ── AI Identity Generation ───────────────────────────────────────────────

async function generateIdentity(
  role: string,
  profileName: string,
  toolProfile: string,
): Promise<{ soul: string; identity: string; agents: string }> {
  const { createProviderFromEnv } = await import('../runtime-providers');
  const { Agent } = await import('../agent/Agent');
  const { ContextManager } = await import('../agent/context');
  const { ToolRegistry } = await import('../agent/tool-registry');
  const { DEFAULT_LOOP_CONFIG } = await import('../agent/loop-types');

  const provider = createProviderFromEnv({});

  const contextManager = new ContextManager({
    tokenLimit: 100_000,
    defaultSystemPrompt: 'You design AI agent personalities. Be concrete and specific.',
  });

  const agent = new Agent({
    provider,
    contextManager,
    config: { tokenLimit: 100_000 },
    toolRegistry: new ToolRegistry(),
  });

  const prompt = [
    'Generate personality files for an AI agent. Role: ' + role,
    'Profile name: ' + profileName,
    'Tool access: ' + toolProfile,
    '',
    'Output exactly three sections separated by "---" markers:',
    '',
    '---SOUL---',
    'Philosophy, values, communication tone, boundaries (15-25 lines)',
    '',
    '---IDENTITY---',
    'Name, emoji, role description, expertise bullet points (10-15 lines)',
    '',
    '---AGENTS---',
    'Operating rules, task handling, error approach, memory usage (10-20 lines)',
    '',
    'Respond in Chinese unless the role is in English. Be concrete.',
  ].join('\n');

  let text = '';
  try {
    for await (const event of agent.runAgentLoop(
      { role: 'user', content: prompt },
      { ...DEFAULT_LOOP_CONFIG, maxTurns: 1, timeoutMs: 60_000 },
    )) {
      if (event.type === 'text_delta') {
        text += event.delta;
      }
    }
  } catch {
    // Fallback to minimal template on error
  }

  const soulMatch = text.match(/---SOUL---\n([\s\S]*?)(?=---)/);
  const identityMatch = text.match(/---IDENTITY---\n([\s\S]*?)(?=---)/);
  const agentsMatch = text.match(/---AGENTS---\n([\s\S]*)/);

  const extract = (match: RegExpMatchArray | null): string => {
    if (!match?.[1]) return '_(generation failed — please edit this file)_\n';
    return match[1].trim() + '\n';
  };

  return {
    soul: `# Soul\n\n${extract(soulMatch)}`,
    identity: `# Identity\n\n${extract(identityMatch)}`,
    agents: `# ${profileName}\n\n${extract(agentsMatch)}`,
  };
}

// ── Bot Setup ─────────────────────────────────────────────────────────────

export async function botSetup(): Promise<void> {
  p.intro('🤖 my-agent Bot Setup');

  // Step 1: Lark credentials with validation
  const appIdResult = await p.text({
    message: 'Lark App ID:',
    placeholder: 'cli_xxxxxxxxxxxx',
    validate: (v) => {
      if (!v) return 'App ID is required.';
      return larkAppIdSchema.safeParse(v).success ? undefined : 'Should start with "cli_"';
    },
  });
  if (p.isCancel(appIdResult)) { p.cancel('Setup cancelled.'); return; }
  const larkAppId = appIdResult.trim();

  const secretResult = await p.text({
    message: 'Lark App Secret:',
    placeholder: '••••••••••••••••',
    validate: (v) => {
      if (!v) return 'App Secret is required.';
      return larkSecretSchema.safeParse(v).success ? undefined : 'Too short (min 8 characters)';
    },
  });
  if (p.isCancel(secretResult)) { p.cancel('Setup cancelled.'); return; }
  const larkAppSecret = secretResult.trim();

  // Step 2: Choose profile — existing or new
  const existingProfiles = loadExistingProfiles();
  const profileIds = Object.keys(existingProfiles);

  let profileId: string;
  const CREATE_NEW = '__create_new__';

  if (profileIds.length === 0) {
    log('\nNo existing profiles. Let\'s create one.\n');
    const created = await createProfileInteractive();
    if (!created) { p.cancel('Setup cancelled.'); return; }
    profileId = created;
  } else {
    const options = [
      ...profileIds.map((id) => {
        const pr = existingProfiles[id]!;
        return { value: id, label: `${id}  (${pr.toolProfile}, ${pr.workingDir})` };
      }),
      { value: CREATE_NEW, label: '✨ Create new profile' },
    ];

    const choice = await p.select({
      message: 'Select profile for this bot:',
      options,
      initialValue: options[options.length - 1]!.value,
    });
    if (p.isCancel(choice)) { p.cancel('Setup cancelled.'); return; }

    if (choice === CREATE_NEW) {
      const created = await createProfileInteractive();
      if (!created) { p.cancel('Setup cancelled.'); return; }
      profileId = created;
    } else {
      profileId = choice as string;
    }
  }

  // Step 3: Allowed users
  const allowedResult = await p.text({
    message: 'Allowed users (comma-separated, optional):',
    placeholder: 'alice@example.com, bob@example.com',
  });
  if (p.isCancel(allowedResult)) { p.cancel('Setup cancelled.'); return; }
  const allowedUsers = allowedResult.trim()
    ? allowedResult.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  // Step 4: Write bot config (replace existing bot with same larkAppId)
  const config = loadConfig();
  config.bots = (config.bots ?? []).filter(
    (b: { larkAppId: string }) => b.larkAppId !== larkAppId,
  );
  config.bots.push({
    larkAppId,
    larkAppSecret,
    profileId,
    ...(allowedUsers ? { allowedUsers } : {}),
  });
  saveConfig(config);

  p.outro(`Bot "${larkAppId}" → profile "${profileId}" configured.
Next: my-agent daemon start ${profileId}`);
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────

export async function daemonStart(profileName: string): Promise<void> {
  const s = p.spinner();
  s.start(`Starting daemon for profile "${profileName}"...`);
  const proc = spawn('bun', ['run', 'bin/my-agent-daemon.ts', profileName], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
    detached: true,
  });
  proc.unref();
  s.stop(`Daemon PID: ${proc.pid}`);
}

export async function daemonStop(profileName: string): Promise<void> {
  const s = p.spinner();
  s.start(`Stopping daemon "${profileName}"...`);
  const daemonDir = join(homedir() ?? '/root', '.my-agent', 'data');
  const pidFile = join(daemonDir, `${profileName}.pid`);
  if (!existsSync(pidFile)) {
    s.stop(`No PID file for "${profileName}" — daemon may not be running.`);
    return;
  }
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    s.stop(`Sent SIGTERM to "${profileName}" (PID ${pid})`);
  } catch {
    s.stop(`Failed to signal PID ${pid}. It may already be stopped.`);
  }
}

export async function daemonList(): Promise<void> {
  const daemonDir = join(homedir() ?? '/root', '.my-agent', 'data');
  if (!existsSync(daemonDir)) {
    log('No daemon data directory. No daemons running.');
    return;
  }
  const pidFiles = readdirSync(daemonDir).filter(f => f.endsWith('.pid'));
  if (pidFiles.length === 0) {
    log('No running daemons found.');
    return;
  }

  log('\nRunning daemons:\n');
  for (const pf of pidFiles) {
    try {
      const pid = readFileSync(join(daemonDir, pf), 'utf-8').trim();
      log(`  ${pf.replace('.pid', '')}  PID: ${pid}`);
    } catch {
      log(`  ${pf.replace('.pid', '')}`);
    }
  }
  log('');
}
