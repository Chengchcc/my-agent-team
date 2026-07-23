import type { ToolUseBlock, ToolResultBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { RunState } from "./run-state.js";

export interface AgentContext {
  sessionId: string;
  spanId?: string;
  signal?: AbortSignal;
  state: RunState;
}

export interface BeforeToolResult {
  skip?: boolean;
  input?: unknown;
  result?: string;
  isError?: boolean;
}

export type StopDecision = { continue: true; reason: string } | { continue: false };

export interface AgentHooks {
  "before:run"?: (
    ctx: AgentContext,
    input: { text: string },
  ) => { text: string } | void | Promise<{ text: string } | void>;

  "before:model"?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => Message[] | Promise<Message[]>;

  "after:model"?: (
    ctx: AgentContext,
    messages: readonly Message[],
    usage: { input: number; output: number },
  ) => void | Promise<void>;

  "before:tool"?: (
    ctx: AgentContext,
    call: { id: string; name: string; input: unknown },
  ) => BeforeToolResult | void | Promise<BeforeToolResult | void>;

  "after:tool"?: (
    ctx: AgentContext,
    call: { id: string; name: string; input: unknown },
    result: { content: string; isError?: boolean },
  ) => void | Promise<void>;

  "after:turn"?: (ctx: AgentContext, messages: readonly Message[]) => void | Promise<void>;

  "before:stop"?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => StopDecision | void | Promise<StopDecision | void>;
}
