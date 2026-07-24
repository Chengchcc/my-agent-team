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
  ) => { text: string } | undefined | Promise<{ text: string } | undefined>;

  "before:model"?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => readonly Message[] | Promise<readonly Message[]>;

  "after:model"?: (
    ctx: AgentContext,
    messages: readonly Message[],
    usage: { input: number; output: number },
  ) => void | Promise<void>;

  "before:tool"?: (
    ctx: AgentContext,
    call: { id: string; name: string; input: unknown },
  ) => BeforeToolResult | undefined | Promise<BeforeToolResult | undefined>;

  "after:tool"?: (
    ctx: AgentContext,
    call: { id: string; name: string; input: unknown },
    result: { content: string; isError?: boolean },
  ) => void | Promise<void>;

  "after:turn"?: (ctx: AgentContext, messages: readonly Message[]) => void | Promise<void>;

  "before:stop"?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => StopDecision | undefined | Promise<StopDecision | undefined>;
}
