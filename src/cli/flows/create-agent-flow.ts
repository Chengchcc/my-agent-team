/* eslint-disable no-console -- CLI interactive flow output */

import { createPrompts } from '../prompts/prompt-runner';
import type { CliRuntimeContext } from '../cli-types';
import { createAgent } from '../../application/usecases/create-agent';
import { validateAgent } from '../../application/usecases/validate-agent';
import { createAgentPaths, ensureAgentPaths } from '../../infrastructure/paths/agent-paths';
import { atomicWrite } from '../../shared/atomic-write';
import { runIdentityFlow } from './identity-flow';
import { runLarkFlow } from './lark-flow';
import chalk from 'chalk';

export async function runCreateAgentFlow(ctx: CliRuntimeContext): Promise<void> {
  const prompts = createPrompts();

  if (!ctx.agentStore || !ctx.paths) {
    prompts.cancel('CLI runtime not fully initialized — missing agentStore or paths');
  }

  const store = ctx.agentStore!;
  const agentsRoot = ctx.paths!.agentsRoot;

  prompts.intro('my-agent — create new agent');

  // Step 1: agent_id
  const agentId = await prompts.text({
    message: 'Agent ID (slug, e.g. "code-helper"):',
    validate: (v) => {
      if (!v || !/^[a-z][a-z0-9-]{0,31}$/.test(v)) {
        return 'Must be lowercase slug: a-z, 0-9, hyphens, max 32 chars';
      }
      if (v === 'default') return "'default' is reserved";
      return undefined;
    },
  });

  // Step 2: display_name
  const displayName = await prompts.text({
    message: 'Display name:',
    defaultValue: agentId,
    validate: (v) => v?.trim() ? undefined : 'Required',
  });

  const errors = validateAgent(agentId, displayName);
  if (errors.length > 0) {
    prompts.fail(
      'Validation failed',
      errors.map(e => `${e.field}: ${e.message}`).join('\n  '),
    )
  }

  // Check for existing agent dir
  const paths = createAgentPaths(agentsRoot, agentId);
  const { existsSync } = await import('node:fs');
  const { default: fs } = await import('node:fs/promises');
  if (existsSync(paths.agentDir) && !(await store.exists(agentId))) {
    const ok = await prompts.confirm({
      message: `Directory ${paths.agentDir} exists but not in registry. Delete and recreate?`,
    });
    if (ok) {
      await fs.rm(paths.agentDir, { recursive: true, force: true });
    }
  }

  // Check for existing agent in store
  if (await store.exists(agentId)) {
    prompts.fail(`Agent '${agentId}' already exists.`, 'Pick a different ID or remove the existing one.')
  }

  // Step 3: identity mode
  const identityMode = await prompts.select({
    message: 'Identity mode:',
    options: [
      { value: 'questionnaire', label: 'M1 — Questionnaire', hint: 'answer structured questions' },
      { value: 'llm_oneshot', label: 'M2 — One-shot LLM', hint: 'describe what you want' },
      { value: 'deferred', label: 'M3 — Deferred', hint: 'set up through conversation later' },
    ],
  }) as 'questionnaire' | 'llm_oneshot' | 'deferred';

  // Step 4: identity flow
  if (identityMode === 'llm_oneshot') {
    prompts.fail(
      'LLM one-shot identity requires a running daemon (provider not available).',
      'Use questionnaire mode, or start the daemon first: my-agent daemon start',
    )
  }

  const identity = await runIdentityFlow(prompts, identityMode, {
    provider: undefined,
    defaults: {},
  });

  // Step 5: Lark config
  const wantLark = await prompts.confirm({
    message: 'Configure Lark Bot?',
    initialValue: false,
  });
  let larkConfig = null;
  if (wantLark) {
    const larkResult = await runLarkFlow(prompts, { smokeCheck: 'ask' });
    larkConfig = larkResult.config;
  }

  // Step 6: default agent
  const isDefault = await prompts.confirm({
    message: 'Set as default agent?',
    initialValue: !(await store.getDefault()),
  });

  // Step 7: create
  await prompts.withSpinner('Creating agent...', async () => {
    await ensureAgentPaths(paths);
    await atomicWrite(paths.identity.file, identity.identityMd);
    if (identity.bootstrapMd) {
      await atomicWrite(paths.identity.bootstrap, identity.bootstrapMd);
    }

    const { record } = createAgent({
      agentId,
      displayName,
      identityMode,
      larkConfig,
      isDefault,
      now: Date.now(),
      agentsRoot,
    });

    await store.create(record);
  });

  // Step 8: outro
  prompts.outro(`Agent '${agentId}' created`);
  console.log(chalk.gray('  Start daemon: ') + chalk.bold(`my-agent daemon start -a ${agentId}`));
  if (!larkConfig) {
    console.log(chalk.gray('  Bind Lark later: ') + chalk.bold(`my-agent agent lark set -a ${agentId}`));
  }
}
