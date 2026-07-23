/**
 * Framework adapter — SINGLE point of contact with @my-agent-team/framework.
 * All framework types flow through here. Nothing else in packages/agent imports framework.
 */

// Framework types re-exported for public API
export type {
  Agent,
  AgentEvent,
  AgentEventListener,
  Checkpointer,
  ContextManager,
  ContextKey,
  Logger,
  Plugin,
  RunSpan,
  Session,
} from "@my-agent-team/framework";

// Core types needed by AgentConfig
export type { ChatModel, Tool } from "@my-agent-team/core";
