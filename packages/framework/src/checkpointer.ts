import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";

export class InterruptSignal extends Error {
  constructor(
    public readonly reason: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`Interrupted: ${reason}`);
    this.name = "InterruptSignal";
  }
}

export interface InterruptState {
  pendingTool: { call: ToolUseBlock; reason: string };
  ts: number;
  meta?: Record<string, unknown>;
}

export type CheckpointEvent =
  | { type: "user_input"; content: string; ts: number }
  | { type: "model_start"; messageCount: number; ts: number }
  | {
      type: "model_end";
      blocks: ContentBlock[];
      usage?: { input: number; output: number };
      ts: number;
    }
  | { type: "tool_start"; call: ToolUseBlock; ts: number }
  | {
      type: "tool_end";
      result: ToolResultBlock;
      durationMs: number;
      ts: number;
    }
  | { type: "interrupt"; pendingTool: ToolUseBlock; reason: string; ts: number }
  | { type: "resume"; ts: number }
  | { type: "run_end"; reason: "complete" | "aborted" | "maxSteps"; ts: number };

export interface Checkpointer {
  load(threadId: string): Promise<Message[] | null>;
  save(threadId: string, messages: readonly Message[]): Promise<void>;

  saveInterrupt?(threadId: string, state: InterruptState): Promise<void>;
  consumeInterrupt?(threadId: string): Promise<InterruptState | null>;

  appendEvent?(threadId: string, event: CheckpointEvent): Promise<void>;
  readEvents?(threadId: string): AsyncIterable<CheckpointEvent>;
}

export function validateCheckpointer(cp: Checkpointer): void {
  const hasAppend = typeof cp.appendEvent === "function";
  const hasRead = typeof cp.readEvents === "function";
  if (hasAppend !== hasRead) {
    throw new Error(
      "Checkpointer event capability is partial: " +
        `appendEvent=${hasAppend}, readEvents=${hasRead}. ` +
        "Both must be implemented or both omitted.",
    );
  }
  const hasSaveInt = typeof cp.saveInterrupt === "function";
  const hasConsumeInt = typeof cp.consumeInterrupt === "function";
  if (hasSaveInt !== hasConsumeInt) {
    throw new Error(
      "Checkpointer interrupt capability is partial: " +
        `saveInterrupt=${hasSaveInt}, consumeInterrupt=${hasConsumeInt}. ` +
        "Both must be implemented or both omitted.",
    );
  }
}
