import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

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
  | { type: "run_end"; reason: "complete" | "aborted" | "maxSteps"; ts: number }
  // M14.6: Emitted by runLoop when beforeStop vetoes stop and force-continues the loop.
  // Additional audit events (plan_injected / verify_round / verify_exhausted) would need
  // emit sites crossing the runner/framework boundary — not wired yet. Add only when a
  // real Checkpointer-backed emit site exists.
  | { type: "force_continue"; reason: string; attempt: number; ts: number };

export interface Checkpointer {
  load(threadId: string): Promise<Message[] | null>;
  save(threadId: string, messages: readonly Message[]): Promise<void>;

  saveInterrupt?(threadId: string, state: InterruptState): Promise<void>;
  consumeInterrupt?(threadId: string): Promise<InterruptState | null>;

  /**
   * @deprecated 内部审计用途，UX 投影一律走 EventLog。
   * 保留调用点不动；新部署可跳过 Tier 3。
   */
  appendEvent?(threadId: string, event: CheckpointEvent): Promise<void>;
  /**
   * @deprecated 内部审计用途，UX 投影一律走 EventLog。
   */
  readEvents?(threadId: string): AsyncIterable<CheckpointEvent>;

  /** Delete all data for a thread. Idempotent — no-op if thread doesn't exist. */
  deleteThread?(threadId: string): Promise<void>;
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
