import type { ChatModel, Tool } from "@my-agent-team/core";
import type {
  Agent,
  AgentEvent,
  Checkpointer,
  ContextManager,
  FollowUpQueue,
  Logger,
  Plugin,
  SteeringQueue,
} from "@my-agent-team/framework";
import { createAgent } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
import type { CompactionResult } from "./compaction.js";
import { compactThread } from "./compaction.js";

// ─── Types ───────────────────────────────────────────────

export interface RetrySettings {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs?: number;
}

export interface CompactionSettings {
  autoCompact?: boolean;
  triggerAtTokens?: number;
  keepRecent?: number;
}

export interface AgentSessionConfig {
  // framework passthrough
  model: ChatModel;
  /** @deprecated use sessionId instead */
  threadId?: string;
  /** Persistent memory line key. Same as threadId, renamed. */
  sessionId?: string;
  tools?: Tool[];
  plugins?: Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;

  // session layer
  systemPrompt?: string;
  maxSteps?: number;
  retry?: RetrySettings;
  compaction?: CompactionSettings;
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

export type SessionEventListener = (event: AgentEvent) => void;

// ─── AgentSession ────────────────────────────────────────

export class AgentSession {
  #agent: Agent | null = null;
  #config: AgentSessionConfig;
  #state: AgentState = "idle";
  #subscribers = new Set<SessionEventListener>();
  #abortController: AbortController | null = null;
  #lastError: string | null = null;
  #retryCount = 0;
  #steeringBuf: Message[] = [];
  #followUpBuf: Message[] = [];

  #steering: SteeringQueue = {
    drain: () => {
      const items = this.#steeringBuf.splice(0);
      if (items.length) this.#emitQueueUpdate();
      return items;
    },
  };
  #followUp: FollowUpQueue = {
    drain: () => {
      const items = this.#followUpBuf.splice(0);
      if (items.length) this.#emitQueueUpdate();
      return items;
    },
  };

  #emitQueueUpdate() {
    this.#emit({
      type: "queue_update",
      steering: this.#steeringBuf.map((m) => m.text ?? ""),
      followUp: this.#followUpBuf.map((m) => m.text ?? ""),
    });
  }

  #unsubAgent: (() => void) | null = null;

  constructor(config: AgentSessionConfig) {
    this.#config = {
      maxSteps: 50,
      retry: { maxAttempts: 3, backoffMs: 2000, maxBackoffMs: 30_000 },
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

  async prompt(text: string, opts?: { signal?: AbortSignal; spanId?: string }): Promise<void> {
    if (this.#state === "running" || this.#state === "retrying" || this.#state === "compacting") {
      this.steer(text);
      return;
    }

    // Initialize agent on first prompt
    if (!this.#agent) {
      await this.#initAgent();
    }

    const inputMessages: Message[] = [{ role: "user", text }];
    await this.#runLoop(inputMessages, opts);
  }

  async continue(opts?: { signal?: AbortSignal; spanId?: string }): Promise<void> {
    if (!this.#agent) throw new Error("Agent not initialized — call prompt() first");
    await this.#runLoop(undefined, opts);
  }

  async resume(
    cmd: { approved: boolean; message?: string },
    opts?: { signal?: AbortSignal; spanId?: string },
  ): Promise<void> {
    if (!this.#agent) throw new Error("Agent not initialized");
    this.#state = "running";
    this.#abortController = new AbortController();
    const signal = this.#combineSignal(opts?.signal);
    try {
      for await (const _ of this.#agent.resume(cmd, { signal, spanId: opts?.spanId })) {
        // events handled by agent subscriber
      }
    } catch (err) {
      this.#handleError(err);
    } finally {
      this.#abortController = null;
    }
  }

  abort(): void {
    this.#abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    while (
      this.#state === "running" ||
      this.#state === "compacting" ||
      this.#state === "retrying" ||
      this.#state === "waiting"
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
    this.#steeringBuf.length = 0;
    this.#followUpBuf.length = 0;
  }

  // ─── Runtime interventions ───────────────────────────

  steer(text: string): void {
    if (this.#state !== "running" && this.#state !== "retrying" && this.#state !== "compacting") {
      throw new Error("steer requires an in-flight run; call prompt() first");
    }
    this.#steeringBuf.push({ role: "user", text });
    this.#emitQueueUpdate();
  }

  followUp(text: string): void {
    if (!this.#agent)
      throw new Error("followUp requires an initialized agent; call prompt() first");
    this.#followUpBuf.push({ role: "user", text });
    this.#emitQueueUpdate();
  }

  // ─── Configuration ───────────────────────────────────

  setModel(model: ChatModel): void {
    this.#config.model = model;
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
      const { messages, result } = await compactThread({
        model: this.#config.model,
        checkpointer: this.#config.checkpointer,
        threadId: this.#agent.thread.id,
        keepRecent: this.#config.compaction?.keepRecent,
        customInstructions,
      });

      // Persist compacted messages
      await this.#config.checkpointer.save(this.#agent.thread.id, messages);
      this.#agent.thread.messages.splice(0, this.#agent.thread.messages.length, ...messages);

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
      threadId: this.#config.sessionId ?? this.#config.threadId,
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

  async #runLoop(
    inputMessages?: Message[],
    opts?: { signal?: AbortSignal; spanId?: string },
  ): Promise<void> {
    if (!this.#agent) return;

    this.#state = "running";
    this.#retryCount = 0;
    this.#lastError = null;
    this.#abortController = new AbortController();
    const signal = this.#combineSignal(opts?.signal);

    try {
      while (true) {
        try {
          if (inputMessages) {
            const generator = this.#agent.run(inputMessages[0]?.text ?? "", {
              signal,
              stream: true,
              maxSteps: this.#config.maxSteps,
              steering: this.#steering,
              followUp: this.#followUp,
              spanId: opts?.spanId,
            });
            for await (const _ of generator) {
              // events handled by agent subscriber → #handleAgentEvent
            }
          } else {
            const generator = this.#agent.continue({
              signal,
              stream: true,
              maxSteps: this.#config.maxSteps,
              steering: this.#steering,
              followUp: this.#followUp,
              spanId: opts?.spanId,
            });
            for await (const _ of generator) {
              // events handled by agent subscriber → #handleAgentEvent
            }
          }

          // Normal completion (no error thrown)
          this.#state = "done";
          this.#emit({
            type: "agent_end",
            messages: this.#agent.thread.messages.slice(),
            willRetry: false,
            status: "succeeded",
          });
          if (this.#retryCount > 0) {
            this.#emit({ type: "auto_retry_end", success: true, attempt: this.#retryCount });
          }
          break;
        } catch (err) {
          this.#handleError(err);
          inputMessages = undefined;

          // Apply retry with exponential backoff (same logic for both
          // thrown errors and #lastError set by handleError).
          if (
            !this.#abortController?.signal.aborted &&
            this.#lastError &&
            this.#retryCount < (this.#config.retry?.maxAttempts ?? 3)
          ) {
            this.#retryCount++;
            this.#state = "retrying";
            const base = this.#config.retry?.backoffMs ?? 2000;
            const cap = this.#config.retry?.maxBackoffMs ?? 30_000;
            const delayMs = Math.min(cap, base * 2 ** (this.#retryCount - 1));
            this.#emit({
              type: "auto_retry_start",
              attempt: this.#retryCount,
              maxAttempts: this.#config.retry?.maxAttempts ?? 3,
              delayMs,
              errorMessage: this.#lastError,
            });
            await new Promise((r) => setTimeout(r, delayMs));
            this.#lastError = null;
            continue;
          }

          // Exhausted retries or user abort — emit final error and break
          const aborted = this.#abortController?.signal.aborted ?? false;
          const finalStatus: "succeeded" | "error" | "interrupted" = aborted
            ? "interrupted"
            : this.#lastError
              ? "error"
              : "succeeded";
          this.#state = aborted || this.#lastError ? "error" : "done";

          this.#emit({
            type: "agent_end",
            messages: this.#agent.thread.messages.slice(),
            willRetry: false,
            status: finalStatus,
            errorMessage: this.#lastError ?? undefined,
          });

          this.#emit({
            type: "auto_retry_end",
            success: false,
            attempt: this.#retryCount,
            finalError: this.#lastError ?? "unknown",
          });
          break;
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

  #emit(event: AgentEvent): void {
    for (const sub of this.#subscribers) {
      try {
        sub(event);
      } catch {
        // best-effort
      }
    }
  }
}
