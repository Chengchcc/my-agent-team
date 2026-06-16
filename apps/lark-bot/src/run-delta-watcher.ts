/**
 * M15.1: Run-level delta watcher for streaming Lark cards.
 * Subscribes to /api/runs/:runId/stream, aggregates text deltas,
 * throttles card updates, and handles EOF/fallback.
 */

import type { Database } from "bun:sqlite";
import { getRunStream, insertRunStream, updateRunStream } from "./bindings-sqlite.js";
import { type LarkRunCardStatus, renderLarkRunCard } from "./card-renderer.js";
import { type CardSendOk, sendCard, updateCard } from "./card-sender.js";
import { type LarkTypingReactionState, removeTypingReaction } from "./feedback-reaction.js";

// ─── SSE parsing ───

export function parseSseFrames(chunk: string): Array<{
  eventName: string;
  dataText: string;
}> {
  const frames: Array<{ eventName: string; dataText: string }> = [];
  const lines = chunk.split("\n");
  let currentEvent = "";
  let currentData = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData += currentData ? "\n" + line.slice(6) : line.slice(6);
    } else if (line === "" && currentData) {
      frames.push({ eventName: currentEvent, dataText: currentData });
      currentEvent = "";
      currentData = "";
    }
  }
  return frames;
}

export interface RawRunTextDeltaPayload {
  blockIndex: number;
  text: string;
}

export type RunStreamEvent =
  | { type: "text_delta"; runId: string; blockIndex: number; text: string }
  | { type: "unknown"; runId: string; rawType: string; raw: unknown };

export function parseRunStreamEvent(input: {
  eventName: string;
  data: unknown;
  runId: string;
}): RunStreamEvent {
  if (input.eventName === "text_delta" && typeof input.data === "object" && input.data !== null) {
    const d = input.data as RawRunTextDeltaPayload;
    if (typeof d.text === "string") {
      return {
        type: "text_delta",
        runId: input.runId,
        blockIndex: d.blockIndex ?? 0,
        text: d.text,
      };
    }
  }
  return { type: "unknown", runId: input.runId, rawType: input.eventName, raw: input.data };
}

// ─── Watcher ───

const FLUSH_INTERVAL_MS = 150;
const MAX_BUFFER_CHARS_BEFORE_FLUSH = 120;

export interface RunDeltaWatcherOptions {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  profile: string;
  larkChatId: string;
  sourceMessageId: string;
  onFallback: (runId: string, text: string) => Promise<void>;
}

export interface RunDeltaWatcherHandle {
  runId: string;
  close: () => void;
}

/**
 * Start a streaming card lifecycle for a triggered run.
 * 1. Add Typing reaction
 * 2. Send placeholder thinking card
 * 3. Subscribe to run delta stream
 * 4. Throttle card updates
 * 5. Finalize on EOF or error
 * Returns immediately — drives in background.
 */
export function watchRunDelta(
  runId: string,
  conversationId: string,
  reactionState: LarkTypingReactionState | null,
  opts: RunDeltaWatcherOptions,
): RunDeltaWatcherHandle {
  const { db, backendUrl, backendAuthToken, profile, larkChatId, sourceMessageId } = opts;
  let aborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const drive = async () => {
    if (aborted) return;

    const now = Date.now();
    let accumulated = "";
    let pendingChars = 0;
    let lastFlushAt = now;
    let larkMessageId: string | null = null;
    let cardUpdateFailed = 0;

    // Check if this run already has a record (restart recovery)
    const existing = getRunStream(db, runId);
    if (existing) {
      accumulated = existing.accumulated;
      larkMessageId = existing.larkMessageId;
      cardUpdateFailed = existing.cardUpdateFailed;
      // If already done/error, don't restart
      if (existing.status === "done" || existing.status === "error") return;
    }

    // Persist starting record
    if (!existing) {
      insertRunStream(db, {
        runId,
        larkChatId,
        conversationId,
        larkMessageId: null,
        sourceMessageId,
        typingReactionId: reactionState?.reactionId ?? null,
        typingStatus: reactionState?.status ?? "none",
        status: "starting",
        accumulated: "",
        cardSendFailed: 0,
        cardUpdateFailed: 0,
        finalLedgerSeq: null,
        lastError: null,
        completeFromLedger: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Clean up Typing reaction on any terminal path (done/error/fallback)
    const cleanupReaction = async () => {
      if (reactionState && reactionState.status === "active") {
        await removeTypingReaction(profile, reactionState);
      }
    };

    // ── Send placeholder card ──
    if (!larkMessageId) {
      const thinkingCard = renderLarkRunCard({
        runId,
        conversationId,
        title: "思考中",
        status: "thinking",
        content: "",
        updatedAt: now,
      });

      const idempotencyKey = `${conversationId}:${runId}:card`;
      const result = await sendCard({
        profile,
        chatId: larkChatId,
        card: thinkingCard,
        idempotencyKey,
      });

      if (!result.ok) {
        updateRunStream(db, runId, {
          status: "fallback_text",
          cardSendFailed: 1,
          lastError: result.error,
        });
        await cleanupReaction();
        return;
      }

      larkMessageId = (result as CardSendOk).messageId;
      updateRunStream(db, runId, { larkMessageId, status: "starting" });
    }

    // ── Connect to run delta stream ──
    const url = `${backendUrl}/api/runs/${runId}/stream`;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (backendAuthToken) headers["x-auth-token"] = backendAuthToken;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok || !resp.body) {
        // Stream not available — fall back to ledger text
        updateRunStream(db, runId, {
          status: "fallback_text",
          lastError: `stream unavailable: ${resp.status}`,
        });
        await cleanupReaction();
        return;
      }

      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData += currentData ? "\n" + line.slice(6) : line.slice(6);
          } else if (line === "" && currentData) {
            let parsedData: unknown;
            try {
              parsedData = JSON.parse(currentData);
            } catch {
              parsedData = currentData;
            }

            const ev = parseRunStreamEvent({
              eventName: currentEvent,
              data: parsedData,
              runId,
            });

            if (ev.type === "text_delta") {
              accumulated += ev.text;
              pendingChars += ev.text.length;

              // Persist accumulated to survive restart
              updateRunStream(db, runId, { accumulated, status: "streaming" });

              // Throttle card updates
              if (
                Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS ||
                pendingChars >= MAX_BUFFER_CHARS_BEFORE_FLUSH
              ) {
                const card = renderLarkRunCard({
                  runId,
                  conversationId,
                  title: "流式回复",
                  status: "streaming",
                  content: accumulated,
                  updatedAt: Date.now(),
                });
                const result = await updateCard({ profile, messageId: larkMessageId!, card });
                if (!result.ok) {
                  cardUpdateFailed = 1;
                  updateRunStream(db, runId, { cardUpdateFailed: 1, lastError: result.error });
                }
                lastFlushAt = Date.now();
                pendingChars = 0;
              }
            }
            // Unknown events are silently ignored

            currentEvent = "";
            currentData = "";
          }
        }
      }

      // ── EOF: Query run metadata to determine final status ──
      let finalStatus: LarkRunCardStatus = "fallback_text";
      let errorMsg: string | undefined;

      try {
        const metaResp = await fetch(`${backendUrl}/api/runs/${runId}`, {
          headers: { "x-auth-token": backendAuthToken ?? "" },
        });
        if (metaResp.ok) {
          const meta = (await metaResp.json()) as { status: string };
          if (meta.status === "succeeded") {
            finalStatus = "done";
          } else if (meta.status === "failed" || meta.status === "cancelled") {
            finalStatus = "error";
            errorMsg = `run ${meta.status}`;
          } else {
            // Still running? Reconnect
            scheduleReconnect(2000);
            return;
          }
        }
      } catch {
        // Can't reach backend — fallback to ledger text path
        finalStatus = "fallback_text";
      }

      if (finalStatus === "done" || finalStatus === "error") {
        const card = renderLarkRunCard({
          runId,
          conversationId,
          title: finalStatus === "done" ? "已完成" : "回复中断",
          status: finalStatus,
          content: accumulated,
          error: errorMsg,
          updatedAt: Date.now(),
        });
        await updateCard({ profile, messageId: larkMessageId!, card }).catch(() => {
          cardUpdateFailed = 1;
        });
        updateRunStream(db, runId, {
          status: finalStatus,
          cardUpdateFailed,
          accumulated,
          lastError: errorMsg ?? null,
        });
        await cleanupReaction();
      }
    } catch (err) {
      updateRunStream(db, runId, {
        status: "fallback_text",
        lastError: err instanceof Error ? err.message : String(err),
      });
      await cleanupReaction();
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

  function scheduleReconnect(delayMs: number) {
    if (aborted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void drive();
    }, delayMs);
  }

  // Start driving
  void drive();

  return {
    runId,
    close: () => {
      aborted = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    },
  };
}
