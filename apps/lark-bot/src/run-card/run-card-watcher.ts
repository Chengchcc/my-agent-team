import type { Database } from "bun:sqlite";
import { extractText } from "@chengchenccc/message";
import { getRunCard, insertRunCard, updateRunCard } from "../bindings-sqlite.js";
import { createCardFlushController } from "./card-flush.js";
import { renderRunCard } from "./card-renderer.js";
import { sendCard, updateCard } from "./card-sender.js";
import { applyRunEvent, initialRunCardState, type RunCardState } from "./card-state.js";

/**
 * ADR 0031: the streaming card lifecycle for one Agent Run.
 * Consumes the Run SSE (transient), throttles card PATCHes through the
 * single-flight flush controller, and seals the terminal card from the
 * canonical assistant text (GET run detail — the same outcome messages
 * the ledger commit is built from). Card send/update failures never
 * affect the run; a failed seal falls back to sending the final text.
 */

const FLUSH_INTERVAL_MS = 150;
const MAX_BUFFER_CHARS_BEFORE_FLUSH = 120;
const SEAL_RETRY_DELAYS_MS = [200, 500, 1000];

export interface RunCardWatcherOptions {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  profile: string;
  webUrl: string | null;
  /** Plain-text send for the seal fallback. Throws on failure. */
  sendText: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
}

export interface RunCardWatcherHandle {
  runId: string;
  close: () => void;
}

interface OutcomeMessageLike {
  role?: string;
  text?: string | null;
  blocks?: ReadonlyArray<{ type: string; text?: string }> | null;
}

/** Last assistant message that actually carries text — mirrors the
 * backend's finalAnswerMessage (execution-input.ts), the same source the
 * canonical ledger commit is built from. */
export function finalAnswerText(messages: OutcomeMessageLike[] | null | undefined): string | null {
  for (const m of [...(messages ?? [])].reverse()) {
    if (m.role !== "assistant") continue;
    const text = extractText(m).trim();
    if (text !== "") return text;
  }
  return null;
}

function rowStatus(state: RunCardState): string {
  if (state.terminal) return state.terminal.status;
  if (state.waiting) return "waiting";
  return state.output.length > 0 || state.toolCount > 0 ? "streaming" : "creating";
}

async function fetchRunOutcome(
  backendUrl: string,
  token: string | null,
  runId: string,
): Promise<{ messages?: OutcomeMessageLike[] } | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["x-auth-token"] = token;
  const resp = await fetch(`${backendUrl}/api/agent-runs/${runId}`, { headers });
  if (!resp.ok) return null;
  const body = (await resp.json()) as {
    run?: { terminalResult?: { messages?: OutcomeMessageLike[] } | null };
  };
  return body.run?.terminalResult ?? null;
}

export function watchRunCard(
  runId: string,
  conversationId: string,
  larkChatId: string,
  opts: RunCardWatcherOptions,
): RunCardWatcherHandle {
  const { db, backendUrl, backendAuthToken, profile, webUrl, sendText } = opts;
  let aborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | null = null;

  const meta = { runId, startedAt: Date.now(), webUrl };

  // Restart recovery: reuse the row (accumulated output, card message id).
  const existing = getRunCard(db, runId);
  if (existing && !["creating", "streaming", "waiting"].includes(existing.status)) {
    return { runId, close: () => {} };
  }
  if (!existing) {
    insertRunCard(db, { runId, conversationId, larkChatId, sourceMessageId: null });
  }
  let state: RunCardState = existing
    ? {
        ...initialRunCardState(),
        phase: "running",
        output: existing.accumulated,
        toolCount: existing.toolCount,
      }
    : initialRunCardState();
  let larkMessageId = existing?.larkMessageId ?? null;

  const persist = () => {
    updateRunCard(db, runId, {
      status: rowStatus(state),
      accumulated: state.output,
      toolCount: state.toolCount,
      larkMessageId,
    });
  };

  const flush = createCardFlushController(async () => {
    if (!larkMessageId || state.terminal) return;
    const result = await updateCard({
      profile,
      messageId: larkMessageId,
      card: renderRunCard(state, meta),
    });
    if (!result.ok) {
      // Non-fatal (ADR 0031 §2): the next delta re-flushes.
      updateRunCard(db, runId, { cardUpdateFailed: 1, lastError: result.error });
    }
    persist();
  });

  let pendingChars = 0;
  let lastFlushAt = Date.now();

  const maybeFlush = (textLength: number) => {
    pendingChars += textLength;
    if (
      Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS ||
      pendingChars >= MAX_BUFFER_CHARS_BEFORE_FLUSH
    ) {
      lastFlushAt = Date.now();
      pendingChars = 0;
      flush.request();
    }
  };

  async function sendFinalText(text: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendText(larkChatId, text, `${conversationId}:${runId}:seal`);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Terminal seal (ADR 0031 §3): canonical text in-card; text fallback. */
  async function seal(): Promise<void> {
    // The terminal status event can beat the ledger commit by a beat —
    // retry the run detail briefly before giving up on the canonical text.
    let finalText: string | null = null;
    for (const delay of SEAL_RETRY_DELAYS_MS) {
      const outcome = await fetchRunOutcome(backendUrl, backendAuthToken, runId).catch(() => null);
      finalText = finalAnswerText(outcome?.messages);
      if (finalText !== null) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    const content = finalText ?? state.output;
    state = { ...state, output: content };

    let sealed = false;
    if (larkMessageId) {
      for (let attempt = 0; attempt < 3 && !sealed; attempt++) {
        const result = await updateCard({
          profile,
          messageId: larkMessageId,
          card: renderRunCard(state, meta),
        });
        if (result.ok) sealed = true;
        else await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    if (sealed) {
      updateRunCard(db, runId, {
        status: state.terminal?.status ?? "completed",
        accumulated: content,
      });
      return;
    }
    // Card unpatchable: the final answer must still reach the user.
    try {
      await sendFinalText(content);
      updateRunCard(db, runId, {
        status: "fallback_text",
        accumulated: content,
        cardUpdateFailed: 1,
      });
    } catch (err) {
      updateRunCard(db, runId, {
        status: "failed",
        accumulated: content,
        cardUpdateFailed: 1,
        lastError: `seal fallback failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function scheduleReconnect(delayMs: number) {
    if (aborted) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void drive();
    }, delayMs);
  }

  const drive = async () => {
    if (aborted) return;

    // ── Placeholder card (idempotent by conversationId:runId:card) ──
    if (!larkMessageId) {
      const result = await sendCard({
        profile,
        chatId: larkChatId,
        card: renderRunCard(state, meta),
        idempotencyKey: `${conversationId}:${runId}:card`,
      });
      if (!result.ok) {
        // Hand the run back to the text bridge; it delivers the final row.
        updateRunCard(db, runId, {
          status: "fallback_text",
          cardSendFailed: 1,
          lastError: result.error,
        });
        return;
      }
      larkMessageId = result.messageId;
      persist();
    }

    abortController = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (backendAuthToken) headers["x-auth-token"] = backendAuthToken;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const resp = await fetch(`${backendUrl}/api/agent-runs/${runId}/events`, {
        headers,
        signal: abortController.signal,
      });
      if (!resp.ok || !resp.body) {
        scheduleReconnect(5000);
        return;
      }
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) {
          // Stream ends only after the run settled (late-subscription
          // semantics); if we somehow missed the terminal event, fetch the
          // run once to decide instead of looping forever.
          const outcome = await fetchRunOutcome(backendUrl, backendAuthToken, runId).catch(
            () => null,
          );
          if (outcome || state.terminal) {
            if (!state.terminal) {
              state = applyRunEvent(state, { type: "status", status: "completed" });
            }
            await flush.finish();
            await seal();
          } else {
            scheduleReconnect(2000);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            currentData += currentData ? `\n${line.slice(6)}` : line.slice(6);
          } else if (line === "" && currentData) {
            try {
              const ev = JSON.parse(currentData) as { type?: string };
              if (ev?.type) {
                const before = state;
                state = applyRunEvent(state, ev as never);
                if (state !== before) {
                  if (state.terminal) {
                    await flush.finish();
                    await seal();
                    return;
                  }
                  maybeFlush(state.output.length - before.output.length);
                }
              }
            } catch {
              /* malformed frame — skip, never reconnect-loop on it */
            }
            currentData = "";
          }
        }
      }
    } catch (err) {
      if (!aborted) {
        console.error(
          `[run-card] stream error for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        scheduleReconnect(5000);
      }
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* cleanup */
        }
        try {
          reader.releaseLock();
        } catch {
          /* cleanup */
        }
      }
    }
  };

  void drive();

  return {
    runId,
    close: () => {
      aborted = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      abortController?.abort();
    },
  };
}
