/**
 * Framework adapter — hides @my-agent-team/framework imports.
 * Re-exports framework types under agent-local names for public API.
 * Backend callers import from @my-agent-team/agent, not framework.
 */

export type {
  Agent,
  AgentEvent,
  AgentEventListener,
  ContextKey,
  Plugin,
  RunSpan,
} from "@my-agent-team/framework";
