import type { ChatModel, Tool } from "@my-agent-team/core";
import type {
  Agent,
  AgentEvent,
  Checkpointer,
  ContextManager,
  Logger,
  Plugin,
} from "@my-agent-team/framework";
import { createAgent } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { CompactionResult } from "./compaction.js";
import { compactThread } from "./compaction.js";

// ─── Types ───────────────────────────────────────────────

export type ThinkingLevel = "low" | "medium" | "high";

export interface RetrySettings {
  maxAttempts: number;
  backoffMs: number;
}

export interface CompactionSettings {
  autoCompact?: boolean;
  triggerAtTokens?: number;
  keepRecent?: number;
}

export interface AgentSessionConfig {
  // framework passthrough
  model: ChatModel;
  threadId?: string;
  tools?: Tool[];
  plugins?: Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;

  // session layer
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  maxSteps?: number;
  retry?: RetrySettings;
  compaction?: CompactionSettings;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export type AgentState =
  | "idle"
  | "running"
  | "compacting"
  | "retrying"
  | "waiting"
  | "done"
  | "error";

export interface ContextUsage {
  totalTokens?: number;
  messageCount: number;
}

// Session-level events — extends AgentEvent with session lifecycle
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: Message[]; willRetry: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | {
      type: "compaction_start";
      reason: "manual" | "threshold" | "overflow";
    }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: CompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    };

export type SessionEventListener = (event: AgentSessionEvent) => void;

// ─── AgentSession ────────────────────────────────────────

export class AgentSession {
  #agent: Agent | null = null;
  #config: AgentSessionConfig;
  #state: AgentState = "idle";
  #subscribers = new Set<SessionEventListener>();
  #abortController: AbortController | null = null;
  #steeringQueue: string[] = [];
  #followUpQueue: string[] = [];
  #lastError: string | null = null;
  #retryCount = 0;
  #unsubAgent: (() => void) | null = null;

  constructor(config: AgentSessionConfig) {
    this.#config = {
      maxSteps: 50,
      retry: { maxAttempts: 3, backoffMs: 2000 },
      compaction: {
        autoCompact: true,
        triggerAtTokens: 100_000,
        keepRecent: 10,
      },
      ...config,
    };
  }

  // ─── Public getters ──────────────────────────────────

  get state(): AgentState {
    return this.#state;
  }

  get isStreaming(): boolean {
    return this.#state === "running";
  }

  // ─── Lifecycle ───────────────────────────────────────

  async prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.#state === "running") {
      this.#followUpQueue.push(text);
      this.#emit({
        type: "queue_update",
        steering: [...this.#steeringQueue],
        followUp: [...this.#followUpQueue],
      });
      return;
    }

    // Initialize agent on first prompt
    if (!this.#agent) {
      await this.#initAgent();
    }

    const inputMessages: Message[] = [{ role: "user", text }];
    await this.#runLoop(inputMessages, opts);
  }

  async continue(opts?: { signal?: AbortSignal }): Promise<void> {
    if (!this.#agent) throw new Error("Agent not initialized — call prompt() first");
    await this.#runLoop(undefined, opts);
  }

  async resume(
    cmd: { approved: boolean; message?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#agent) throw new Error("Agent not initialized");
    const signal = this.#combineSignal(opts?.signal);
    try {
      for await (const _ of this.#agent.resume(cmd, { signal })) {
        // events handled by agent subscriber
      }
    } catch (err) {
      this.#handleError(err);
    }
  }

  abort(): void {
    this.#abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    while (
      this.#state === "running" ||
      this.#state === "compacting" ||
      this.#state === "retrying"
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  dispose(): void {
    this.#unsubAgent?.();
    this.#subscribers.clear();
    this.#abortController?.abort();
    this.#agent = null;
    this.#state = "idle";
  }

  // ─── Runtime interventions ───────────────────────────

  steer(text: string): void {
    this.#steeringQueue.push(text);
  }

  followUp(text: string): void {
    this.#followUpQueue.push(text);
  }

  // ─── Configuration ───────────────────────────────────

  setModel(model: ChatModel): void {
    this.#config.model = model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.#config.thinkingLevel = level;
  }

  setActiveTools(_toolNames: string[]): void {
    // Future: reconfigure agent tools at runtime
  }

  getAllTools(): ToolInfo[] {
    // Tools are on the agent config — introspection deferred to future
    return [];
  }

  // ─── Maintenance ─────────────────────────────────────

  async compact(customInstructions?: string): Promise<CompactionResult> {
    if (!this.#agent) throw new Error("Agent not initialized");
    if (!this.#config.checkpointer) {
      throw new Error("Checkpointer required for compaction");
    }

    this.#state = "compacting";
    this.#emit({ type: "compaction_start", reason: "manual" });

    try {
      const { result } = await compactThread({
        model: this.#config.model,
        checkpointer: this.#config.checkpointer,
        threadId: this.#agent.thread.id,
        keepRecent: this.#config.compaction?.keepRecent,
        customInstructions,
      });

      this.#emit({
        type: "compaction_end",
        reason: "manual",
        result,
        aborted: false,
        willRetry: false,
      });

      this.#state = "idle";
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.#state = "error";
      this.#emit({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
        errorMessage,
      });
      throw err;
    }
  }

  getContextUsage(): ContextUsage | undefined {
    if (!this.#agent) return undefined;
    return {
      messageCount: this.#agent.thread.messages.length,
    };
  }

  // ─── Events ──────────────────────────────────────────

  subscribe(listener: SessionEventListener): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  // ─── Private ─────────────────────────────────────────

  async #initAgent(): Promise<void> {
    this.#agent = await createAgent({
      model: this.#config.model,
      threadId: this.#config.threadId,
      tools: this.#config.tools,
      plugins: this.#config.plugins,
      checkpointer: this.#config.checkpointer,
      contextManager: this.#config.contextManager,
      logger: this.#config.logger,
      systemPrompt: this.#config.systemPrompt,
    });
    this.#unsubAgent = this.#agent.subscribe((event) => this.#handleAgentEvent(event));
  }

  #handleAgentEvent(event: AgentEvent): void {
    if (event.type === "message") {
      const payload = event.payload;
      if (payload.state === "done" || payload.state === "error") {
        this.#state = payload.state === "done" ? "done" : "error";
      } else if (payload.state === "waiting") {
        this.#state = "waiting";
      }
    }
    // Pass through all agent events to session subscribers
    this.#emit(event);
  }

  async #runLoop(inputMessages?: Message[], opts?: { signal?: AbortSignal }): Promise<void> {
    if (!this.#agent) return;

    this.#state = "running";
    this.#retryCount = 0;
    this.#abortController = new AbortController();
    const signal = this.#combineSignal(opts?.signal);

    try {
      while (true) {
        try {
          if (inputMessages) {
            const generator = this.#agent.run(inputMessages[0]?.text ?? "", {
              signal,
              maxSteps: this.#config.maxSteps,
            });
            for await (const _ of generator) {
              // events handled by agent subscriber → #handleAgentEvent
            }
          } else {
            const generator = this.#agent.continue({
              signal,
              maxSteps: this.#config.maxSteps,
            });
            for await (const _ of generator) {
              // events handled by agent subscriber → #handleAgentEvent
            }
          }

          // Check if we need to retry
          if (this.#lastError && this.#retryCount < (this.#config.retry?.maxAttempts ?? 3)) {
            this.#retryCount++;
            this.#state = "retrying";
            const delayMs = (this.#config.retry?.backoffMs ?? 2000) * 2 ** (this.#retryCount - 1);
            this.#emit({
              type: "auto_retry_start",
              attempt: this.#retryCount,
              maxAttempts: this.#config.retry?.maxAttempts ?? 3,
              delayMs,
              errorMessage: this.#lastError,
            });
            await new Promise((r) => setTimeout(r, delayMs));
            this.#lastError = null;
            inputMessages = undefined;
            continue;
          }

          this.#emit({
            type: "agent_end",
            messages: this.#agent.thread.messages.slice(),
            willRetry: false,
          });

          if (this.#lastError) {
            this.#state = "error";
            this.#emit({
              type: "auto_retry_end",
              success: false,
              attempt: this.#retryCount,
              finalError: this.#lastError,
            });
          } else {
            this.#state = "done";
            if (this.#retryCount > 0) {
              this.#emit({
                type: "auto_retry_end",
                success: true,
                attempt: this.#retryCount,
              });
            }
          }
          break;
        } catch (err) {
          this.#handleError(err);
          inputMessages = undefined;
          // continue the retry loop
        }
      }
    } finally {
      this.#abortController = null;
    }
  }

  #handleError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.#lastError = msg;
    if (msg.includes("abort") || msg.includes("AbortError")) {
      this.#state = "done";
    }
  }

  #combineSignal(external?: AbortSignal): AbortSignal | undefined {
    if (!external && !this.#abortController) return undefined;
    if (!external) return this.#abortController?.signal;
    if (!this.#abortController) return external;
    const combined = new AbortController();
    external.addEventListener("abort", () => combined.abort(external.reason));
    this.#abortController.signal.addEventListener("abort", () =>
      combined.abort(this.#abortController!.signal.reason),
    );
    return combined.signal;
  }

  #emit(event: AgentSessionEvent): void {
    for (const sub of this.#subscribers) {
      try {
        sub(event);
      } catch {
        // best-effort
      }
    }
  }
}
