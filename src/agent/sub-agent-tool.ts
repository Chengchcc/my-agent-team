// src/agent/sub-agent-tool.ts
import { nanoid } from 'nanoid';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { debugLog } from '../utils/debug';
import type { Tool, ToolImplementation } from '../types';
import type { AgentConfig } from '../types';
import type { ToolContext } from './tool-dispatch/types';
import type { AgentLoopConfig, SubAgentExitStatus } from './loop-types';
import { Agent } from './Agent';
import { ContextManager } from './context';
import type { TraceBuffer } from '../trace/trace-buffer';
import { ToolRegistry } from './tool-registry';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { getSettingsSync } from '../config';
import { RateLimitedProvider } from './rate-limiter';
import {
  SUB_AGENT_PROFILES,
  type SubAgentProfile,
  SUB_AGENT_DELIVERABLES,
  type SubAgentDeliverable,
  PROFILE_TOOLS,
  ALWAYS_EXCLUDE,
  GLOBAL_STATE_TOOLS_PREFIX,
  NANOID_LENGTH,
  MS_PER_MINUTE,
  SUB_AGENT_TIMEOUT_MS,
  DEFAULT_SUB_AGENT_TOKEN_LIMIT,
  DEFAULT_AUTO_TRIGGER_THRESHOLD,
  subAgentSemaphore,
  type SubAgentToolConfig,
  SUB_AGENT_TOOL_DEFINITION,
} from './sub-agent-config';

export { SUB_AGENT_PROFILES, type SubAgentProfile, SUB_AGENT_DELIVERABLES, type SubAgentDeliverable, type SubAgentToolConfig };

/**
 * SubAgentTool - delegate a self-contained subtask to an independent agent
 * with its own isolated context.
 *
 * Uses the existing Agent architecture - no changes needed to Agent class.
 */
export class SubAgentTool implements ToolImplementation {
  private config: SubAgentToolConfig;

  constructor(config: SubAgentToolConfig) {
    try {
      const settings = getSettingsSync();
      this.config = {
        autoTriggerThreshold: settings.subAgent.autoTriggerThreshold,
        isolation: settings.subAgent.isolation,
        worktreeRootDir: settings.subAgent.worktreeRootDir,
        ...config,
      };
    } catch {
      // If settings not loaded (e.g. in test environments), use hardcoded defaults
      this.config = {
        autoTriggerThreshold: DEFAULT_AUTO_TRIGGER_THRESHOLD,
        isolation: true,
        worktreeRootDir: '~/.my-agent/worktrees',
        ...config,
      };
    }
  }

  /**
   * Get the tool definition for function calling
   */
  getDefinition(): Tool {
    return SUB_AGENT_TOOL_DEFINITION;
  }

  get readonly(): boolean {
    return false; // conflictKey drives parallelism; sub-agent may write files
  }

  conflictKey(input: unknown): string | null {
    const params = input as Record<string, unknown>;
    const profile = (params.profile as SubAgentProfile) ?? 'read_only';
    if (profile === 'read_only') return null; // Safe to parallelize
    if (profile === 'code_editor') return 'fs:global'; // All writes serialized
    return 'agent:global'; // General profile: full serialization
  }

  /**
   * Execute the sub agent with the given task
   */
   
  // eslint-disable-next-line complexity, max-lines-per-function
  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    const goal = params.goal as string;
    const contextInfo = (params.context as string) ?? '';
    const constraints = (params.constraints as string[]) ?? [];
    const deliverable = (params.deliverable as SubAgentDeliverable) ?? 'summary';
    const outputSchema = (params.output_schema as string) ?? '';
    const profile = (params.profile as SubAgentProfile) ?? 'read_only';
    const signal = ctx.signal;

    if (!goal || typeof goal !== 'string') {
      return '<sub_agent_result status="error">Error: Missing required "goal" parameter</sub_agent_result>';
    }

    // Prevent recursion: only main agent can spawn sub_agent
    if (ctx.environment.agentType === 'sub_agent') {
      return '<sub_agent_result status="error">Error: sub_agent cannot spawn another sub_agent</sub_agent_result>';
    }

    const agentId = `sub-${nanoid(NANOID_LENGTH)}`;
    const startTime = Date.now();

    // --- Set up filesystem isolation directory (for code_editor / general profiles) ---
    let isolatedCwd: string | undefined;
    if (profile === 'code_editor' || profile === 'general') {
      if (this.config.isolation && this.config.worktreeRootDir) {
        const home = process.env.HOME || '/root';
        const resolved = this.config.worktreeRootDir.replace(/^~/, () => home);
        isolatedCwd = `${resolved}/sub-${agentId}`;
        try { mkdirSync(isolatedCwd, { recursive: true }); } catch { /* may exist */ }
      } else if (this.config.isolation) {
        isolatedCwd = mkdtempSync('/tmp/sub-agent-');
      }
    }

    // ── All synchronous setup (no I/O) before semaphore ──

    // Build filtered tool registry using profile-based allowlist
    const subToolRegistry = new ToolRegistry();
    const mainTools = this.config.mainToolRegistry.getAllDefinitions();
    const allowedSet = this.config.allowedTools
      ? new Set(this.config.allowedTools)
      : null;
    const profileSet = PROFILE_TOOLS[profile];
    // empty profileSet (general) means "allow all non-excluded"
    const useProfileFilter = profileSet.length > 0;

    for (const toolDef of mainTools) {
      // Always exclude recursion and dangerous tools
      if (ALWAYS_EXCLUDE.has(toolDef.name)) continue;
      // Exclude global-state tools
      if (toolDef.name.startsWith(GLOBAL_STATE_TOOLS_PREFIX)) continue;
      // If explicit allowedTools, filter to only those
      if (allowedSet && !allowedSet.has(toolDef.name)) continue;
      // Profile-based filtering
      if (useProfileFilter && !profileSet.includes(toolDef.name)) continue;

      const impl = this.config.mainToolRegistry.get(toolDef.name);
      if (impl) {
        // Force cwd isolation for bash tool
        if (toolDef.name === 'bash' && isolatedCwd) {
          subToolRegistry.register({
            getDefinition: () => toolDef,
            execute: (p: Record<string, unknown>, c: Parameters<typeof impl.execute>[1]) =>
              impl.execute({ ...p, cwd: isolatedCwd }, c),
          });
        } else {
          subToolRegistry.register({
            getDefinition: () => toolDef,
            execute: (p, c) => impl.execute(p, c),
          });
        }
      }
    }

    // Build system prompt (middleware handles project_rules/user_preferences/skill_catalog injection)
    const tokenLimit = this.config.tokenLimit ?? DEFAULT_SUB_AGENT_TOKEN_LIMIT;

    const systemPromptSections = [
      'You are a focused sub-agent executing a specific task with your own independent context.',
      'Complete the task and return a clear, structured result. Do NOT ask the user questions.',
      `<environment>\n  cwd: ${ctx.environment.cwd}\n</environment>`,
    ];
    const systemPrompt = systemPromptSections.filter(Boolean).join('\n\n');

    const parentTraceRunId =
      (ctx.agentContext.metadata?._traceBuffer as TraceBuffer | undefined)?.runId;

    const subContextManager = new ContextManager({
      tokenLimit,
      defaultSystemPrompt: systemPrompt,
      ...(parentTraceRunId ? { initialMetadata: { _parentTraceRunId: parentTraceRunId } } : {}),
    });
    subContextManager.setSystemPrompt(systemPrompt);

    // Build structured task message
    const constraintsXml = constraints.length > 0
      ? `\n<constraints>\n${constraints.map(c => `- ${c}`).join('\n')}\n</constraints>`
      : '';
    const schemaXml = outputSchema
      ? `\n<output_schema>\n${outputSchema}\n</output_schema>`
      : '';
    const userMessage = `<task>
<goal>${goal}</goal>
<context>${contextInfo || 'none'}</context>${constraintsXml}
<deliverable type="${deliverable}">${schemaXml}
</deliverable>
</task>`;

    // Create sub agent config
    const subAgentConfig: AgentConfig = {
      ...this.config.mainAgentConfig,
      tokenLimit,
    };

    // Use provided provider or inherit from main, wrapped with rate limiting + log prefix
    const rawProvider = this.config.provider ?? this.config.mainProvider;
    const provider = new RateLimitedProvider(rawProvider, { prefix: agentId });

    // Create the sub agent with inherited hooks (memory, skills, todo)
    const subAgent = new Agent({
      provider,
      contextManager: subContextManager,
      config: subAgentConfig,
      toolRegistry: subToolRegistry,
      ...(this.config.hooks ? { hooks: this.config.hooks } : {}),
    });

    // Default loop config with tighter constraints
    const defaultSubLoopConfig: Partial<AgentLoopConfig> = {
      maxTurns: 15,
      timeoutMs: SUB_AGENT_TIMEOUT_MS, // 5 minutes default timeout
    };

    const loopConfig: AgentLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      ...defaultSubLoopConfig,
      ...this.config.loopConfig,
    };

    // ── Semaphore guards only the agent loop execution ──

    try {
      await subAgentSemaphore.acquire();

      // Per-sub-agent abort controller (propagates from parent signal)
      const childAC = new AbortController();
      const onParentAbort = () => childAC.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });

      // Bubble start event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_start',
          agentId,
          task: goal,
          turnIndex: 0,
        });
      }

      let finalTotalTurns = 0;
      let finalSummary = '';
      let exitStatus: SubAgentExitStatus = 'success';

      // Run agent loop with child abort signal
      try {
        for await (const event of subAgent.runAgentLoop(
          { role: 'user', content: userMessage },
          loopConfig,
          { signal: childAC.signal },
        )) {
          // Bubble the event if callback exists
          if (this.config.onEvent) {
            this.config.onEvent(agentId, {
              type: 'sub_agent_event',
              agentId,
              event,
              turnIndex: event.turnIndex,
            });
          }

          // Track the completion reason from agent_done
          if (event.type === 'agent_done') {
            finalTotalTurns = event.totalTurns;

            if (event.reason === 'max_turns_reached') {
              exitStatus = 'max_turns';
            } else if (event.reason === 'error' && event.error) {
              finalSummary = event.error.message;
              exitStatus = signal.aborted ? 'aborted' : 'error';
            }

            if (!finalSummary) {
              const finalCtx = subAgent.getContext();
              for (let i = finalCtx.messages.length - 1; i >= 0; i--) {
                const msg = finalCtx.messages[i];
                if (msg && msg.role === 'assistant' && msg.content) {
                  finalSummary = msg.content;
                  break;
                }
              }
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onParentAbort);
      }

      const durationMs = Date.now() - startTime;

      // Determine exit status and summary
      if (!finalSummary) {
        if (signal.aborted) {
          exitStatus = 'aborted';
          finalSummary = 'Sub-agent aborted by main agent.';
        } else if (durationMs >= loopConfig.timeoutMs) {
          exitStatus = 'timeout';
          finalSummary = `Sub-agent timed out after ${loopConfig.timeoutMs / MS_PER_MINUTE} minutes.`;
        } else if (exitStatus === 'max_turns') {
          finalSummary = `Sub-agent reached maximum ${loopConfig.maxTurns} turns.`;
        } else {
          finalSummary = `Sub-agent completed ${finalTotalTurns} turns but produced no summary.`;
        }
      }

      // Bubble done event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: finalSummary,
          totalTurns: finalTotalTurns,
          durationMs,
          isError: exitStatus !== 'success',
          exitStatus,
          turnIndex: 0,
        });
      }

      // Return machine-readable wrapped result
      return `<sub_agent_result agent_id="${agentId}" turns="${finalTotalTurns}" duration_ms="${durationMs}" status="${exitStatus}">
${finalSummary}
</sub_agent_result>`;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);

      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: errorMessage,
          totalTurns: 0,
          durationMs,
          isError: true,
          error: errorObj,
          exitStatus: 'error',
          turnIndex: 0,
        });
      }

      return `<sub_agent_result agent_id="${agentId}" turns="0" duration_ms="${durationMs}" status="error">
Error: ${errorMessage}
</sub_agent_result>`;
    } finally {
      // Clean up temp isolation directory if we created one
      if (isolatedCwd && isolatedCwd.startsWith('/tmp/sub-agent-')) {
        try { rmSync(isolatedCwd, { recursive: true, force: true }); } catch { debugLog(`[sub-agent] failed to clean up temp dir: ${isolatedCwd}`); }
      }
      subAgentSemaphore.release();
    }
  }
}