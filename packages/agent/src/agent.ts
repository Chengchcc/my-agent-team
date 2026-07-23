import type { AgentEventListener } from "@my-agent-team/framework";
import { AgentSession as HarnessAgent, type SessionConfig } from "@my-agent-team/harness";
import type { AgentConfig, AgentState } from "./agent-options.js";
import type { CompactionResult } from "./compaction.js";

/**
 * Agent class — lifecycle facade wrapping the existing AgentSession.
 * Phase 2 target: own the lifecycle directly. For now, delegates to harness.
 */
export class Agent {
  readonly #session: HarnessAgent;

  constructor(config: AgentConfig) {
    this.#session = new HarnessAgent(config as SessionConfig);
  }

  get sessionId(): string | undefined {
    return this.#session.sessionId;
  }
  get state(): AgentState {
    return this.#session.state as AgentState;
  }

  async prompt(
    input: string,
    opts?: { signal?: AbortSignal; spanId?: string; origin?: unknown },
  ): Promise<void> {
    await this.#session.prompt(input, opts);
  }

  async continue(opts?: {
    signal?: AbortSignal;
    spanId?: string;
    origin?: unknown;
  }): Promise<void> {
    await this.#session.continue(opts);
  }

  async resume(
    command: { approved: boolean; message?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.#session.resume(command, opts);
  }

  abort(): void {
    this.#session.abort();
  }
  dispose(): void {
    this.#session.dispose();
  }

  async waitForIdle(): Promise<void> {
    await this.#session.waitForIdle();
  }

  steer(input: string): void {
    this.#session.steer(input);
  }
  followUp(input: string): void {
    this.#session.followUp(input);
  }

  async compact(instructions?: string): Promise<CompactionResult> {
    return this.#session.compact(instructions) as Promise<CompactionResult>;
  }

  getContextUsage(): { messageCount: number } | undefined {
    return this.#session.getContextUsage();
  }

  async getUsage(): Promise<number> {
    return this.#session.getUsage();
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.#session.subscribe(listener);
  }
}
