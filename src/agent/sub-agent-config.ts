// Sub-agent configuration, types, constants, and concurrency control.

import type { Provider, AgentConfig, AgentHooks } from '../types';
import type { AgentEvent, AgentLoopConfig } from './loop-types';
import type { ToolRegistry } from './tool-registry';

/** Sub-agent execution profile controlling tool access and parallelism. */
export const SUB_AGENT_PROFILES = ['read_only', 'code_editor', 'general'] as const;
export type SubAgentProfile = (typeof SUB_AGENT_PROFILES)[number];
/** Agent-level alias for tool profiles, usable outside sub-agent context. */
export type AgentToolProfile = SubAgentProfile;

/** Deliverable format for sub-agent output. */
export const SUB_AGENT_DELIVERABLES = ['summary', 'file_list', 'code_patch', 'structured_json'] as const;
export type SubAgentDeliverable = (typeof SUB_AGENT_DELIVERABLES)[number];


/** Tool allowlists per profile. */
const PROFILE_TOOLS: Record<SubAgentProfile, string[]> = {
  read_only: ['read', 'grep', 'glob', 'ls'],
  code_editor: ['read', 'grep', 'glob', 'ls', 'text_editor', 'bash'],
  general: [], // empty = all non-excluded (no profile filter applied)
};

/** Tools always excluded from sub-agents regardless of profile. */
const ALWAYS_EXCLUDE = new Set(['sub_agent', 'ask_user_question']);

/** Tools excluded because they use global module-level state. */
const GLOBAL_STATE_TOOLS_PREFIX = 'Task';

/** Maximum concurrent sub-agents (sempahore-based). */
const MAX_CONCURRENT_SUB_AGENTS = 3;
export const NANOID_LENGTH = 6;
export const MS_PER_MINUTE = 60_000;
export const SUB_AGENT_TIMEOUT_MS = 300_000; // 5 min in ms
export const DEFAULT_SUB_AGENT_TOKEN_LIMIT = 50_000;
export const DEFAULT_AUTO_TRIGGER_THRESHOLD = 5;

/**
 * Simple promise-based semaphore for limiting concurrent sub-agent execution.
 */
class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

export const subAgentSemaphore = new Semaphore(MAX_CONCURRENT_SUB_AGENTS);

/**
 * Configuration for SubAgentTool
 */
export interface SubAgentToolConfig {
  /** The main agent's provider - sub agent inherits this if not overridden */
  mainProvider: Provider;
  /** The main agent's tool registry - used as base for filtered registry */
  mainToolRegistry: ToolRegistry;
  /** Main agent's config - token limit is used as base */
  mainAgentConfig: AgentConfig;
  /** List of allowed tools for sub agent - if empty, inherits all except sub_agent */
  allowedTools?: string[];
  /** Override the provider for this sub agent */
  provider?: Provider;
  /** Override loop configuration */
  loopConfig?: Partial<AgentLoopConfig>;
  /** Custom system prompt template */
  systemPromptTemplate?: string;
  /** Callback for bubbling events up to UI */
  onEvent?: (agentId: string, event: AgentEvent) => void;
  /** Maximum token limit for sub agent context (default: 50000) */
  tokenLimit?: number;
  /** AbortSignal from the main agent's execution - propagated to sub agent */
  signal?: AbortSignal;
  /** Auto trigger threshold for sub agent (default from settings) */
  autoTriggerThreshold?: number;
  /** Isolation mode for sub agent (default from settings) */
  isolation?: boolean;
  /** Worktree root directory for sub agent (default from settings) */
  worktreeRootDir?: string;
  /** Inherited hooks from main agent (e.g. beforeModel for memory/skills/todo) */
  hooks?: Partial<Pick<AgentHooks, 'beforeModel'>>;
}

// Re-export PROFILE_TOOLS for internal use in sub-agent-tool
export { PROFILE_TOOLS };
export { ALWAYS_EXCLUDE };
export { GLOBAL_STATE_TOOLS_PREFIX };

import type { Tool } from '../types';

export const SUB_AGENT_TOOL_DEFINITION: Tool = {
  name: 'sub_agent',
  description: `Delegate a self-contained subtask to an independent agent with its own isolated context.

USE when:
- The subtask needs to read/process many files but the caller only needs a summary
- The subtask requires different expertise (analysis vs coding vs testing)
- Running the subtask inline would bloat the current context with intermediate outputs

DO NOT USE when:
- A single tool call (bash/text_editor) can accomplish the task
- You need to interactively refine the result with the user
- The subtask depends on information only available in the current conversation

PROFILES:
- read_only: Only read/analysis tools. Safe to run in parallel with other sub-agents.
- code_editor: Read + write tools. Filesystem writes are serialized.
- general: All non-dangerous tools. Default if not specified.`,
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The precise objective in one sentence.',
      },
      context: {
        type: 'string',
        description: 'Relevant findings, files already inspected, or information the sub-agent needs.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific constraints the sub-agent must follow (e.g. "do not edit files", "use only grep").',
      },
      deliverable: {
        type: 'string',
        enum: ['summary', 'file_list', 'code_patch', 'structured_json'],
        description: 'Expected output format. summary=free text, file_list=list of file paths, code_patch=diff/patch, structured_json=JSON matching output_schema.',
      },
      output_schema: {
        type: 'string',
        description: 'JSON schema for the output when deliverable=structured_json.',
      },
      profile: {
        type: 'string',
        enum: ['read_only', 'code_editor', 'general'],
        description: 'Execution profile controlling tool access. Default: read_only (safest, can parallelize).',
      },
    },
    required: ['goal', 'deliverable'],
  },
};
