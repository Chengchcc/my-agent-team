import type { Database } from "bun:sqlite";
import { extractText } from "@chengchenccc/message";
import { z } from "zod";
import {
  getRunCard,
  insertRunCard,
  rememberTopicKeys,
  setTopicRoot,
  updateRunCard,
} from "../bindings-sqlite.js";
import { larkIdempotencyKey } from "../lark-idempotency.js";
import { swapAckReaction } from "./ack-reaction.js";
import type { CardKitClient } from "./card-kit.js";
import { renderCard } from "./card-renderer.js";
import {
  applyRunEvent,
  initialRunCardState,
  type PendingActionState,
  pendingActionFromBackend,
  type RunCardState,
} from "./card-state.js";
import { createCardUpdater } from "./card-updater.js";

/**
 * ADR 0031: the streaming card lifecycle for one Agent Run.
 * Consumes the Run SSE (transient) and drives a CardKit card entity:
 * create (+ streaming_mode) → send the card_id reference → stream the
 * cumulative text into the output element (the client renders appends with
 * a typewriter) → terminal full-card replace sealed from the canonical
 * assistant text. Failures never affect the run; a failed seal falls back
 * to sending the final text.
 */

const FLUSH_INTERVAL_MS = 150;
const MAX_BUFFER_CHARS_BEFORE_FLUSH = 120;
const SEAL_RETRY_DELAYS_MS = [200, 500, 1000];
/** "OnIt" = the ack while the run is live; the terminal swap to "DONE" lives
 *  in ack-reaction.ts. Verified against the live API: `Hold` is rejected
 *  (231001), `OnIt` and `DONE` are accepted. */
const ACK_EMOJI = "OnIt";

export interface RunCardWatcherOptions {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  /** CardKit client — the direct-HTTPS hot path (never spawns lark-cli). */
  cardClient: CardKitClient;
  webUrl: string | null;
  /** Plain-text send for the seal fallback (lark-cli; rare by design). */
  sendText: (
    chatId: string,
    text: string,
    idempotencyKey: string,
    reply: { replyTo?: string | null; replyInThread?: boolean },
  ) => Promise<void>;
  /** The user's message that started this run — the one the acknowledgement
   *  reaction goes on. Absent for runs nobody typed (workflow dispatch). */
  sourceMessageId?: string | null;
  /** The TOPIC's root message this card answers into (ADR 0037), and whether
   *  the chat is a topic chat (only those accept `reply_in_thread`). */
  replyTo?: string | null;
  replyInThread?: boolean;
  /** Adopt an EXISTING card instead of creating one: the message waited behind
   *  a running turn, its queued card is already in the topic, and that same
   *  card must now stream this run (ADR 0037 decision 2 — one message, one
   *  card). The first flush replaces the queued frame with the run frame. */
  adopt?: { cardKitId: string; larkMessageId: string };
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
  return state.output.length > 0 || state.completedTools.length > 0 ? "streaming" : "creating";
}

/** Pending durable actions for one run (durable approvals/asks v1): the
 *  restart recovery reads the same record the live event wrote. */
async function fetchPendingActions(
  backendUrl: string,
  token: string | null,
  runId: string,
): Promise<PendingActionState | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["x-auth-token"] = token;
  const resp = await fetch(`${backendUrl}/api/agent-runs/${runId}`, { headers });
  if (!resp.ok) return null;
  const body = z
    .object({
      pendingActions: z
        .array(
          z.object({
            kind: z.string(),
            status: z.string(),
            payload: z.record(z.string(), z.unknown()),
          }),
        )
        .nullable()
        .optional(),
    })
    .catch({ pendingActions: [] })
    .parse(await resp.json());
  const record = (body.pendingActions ?? []).find((a) => a.status === "pending");
  if (!record) return null;
  return pendingActionFromBackend(record.kind, record.payload);
}

async function fetchRunOutcome(
  backendUrl: string,
  token: string | null,
  runId: string,
): Promise<OutcomeMessageLike[] | null | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["x-auth-token"] = token;
  const resp = await fetch(`${backendUrl}/api/agent-runs/${runId}`, { headers });
  if (!resp.ok) return null;
  const body = z
    .object({
      run: z
        .object({
          terminalResult: z
            .object({ messages: z.array(z.unknown()).nullable().optional() })
            .nullable()
            .optional(),
        })
        .optional(),
    })
    .parse(await resp.json());
  return body.run?.terminalResult?.messages as OutcomeMessageLike[] | undefined;
}

export async function watchRunCard(
  runId: string,
  conversationId: string,
  larkChatId: string,
  opts: RunCardWatcherOptions,
): Promise<RunCardWatcherHandle> {
  const { db, backendUrl, backendAuthToken, cardClient, webUrl, sendText, sourceMessageId } = opts;
  const replyTo = opts.replyTo ?? null;
  const replyInThread = opts.replyInThread === true;
  let aborted = false;
  let reconnectTimer: Timer | undefined;
  let abortController: AbortController | null = null;

  const meta = { runId, startedAt: Date.now(), webUrl };

  // Restart recovery: reuse the row (card entity, sequence, output).
  const existing = getRunCard(db, runId);
  if (existing && !["creating", "streaming", "waiting"].includes(existing.status)) {
    return { runId, close: () => {} };
  }
  if (!existing) {
    insertRunCard(db, { runId, conversationId, larkChatId, sourceMessageId: null });
    if (opts.adopt) {
      updateRunCard(db, runId, {
        cardKitId: opts.adopt.cardKitId,
        larkMessageId: opts.adopt.larkMessageId,
      });
    }
  }
  let state: RunCardState;
  if (existing) {
    state = {
      ...initialRunCardState(),
      phase: "streaming",
      output: existing.accumulated,
    };
    // Durable actions (durable approvals/asks v1): the live event that set
    // the buttons fired before we died, so replay will never re-derive them.
    // The backend kept the record; re-seed the card's pending action from it
    // BEFORE the first render. Failure leaves the card text-only (today's
    // behavior), never blocks the restore.
    const pending = await fetchPendingActions(backendUrl, backendAuthToken, runId).catch(
      () => null,
    );
    if (pending) {
      state.pendingAction = pending;
      state.waiting = pending.kind;
    }
  } else {
    state = initialRunCardState();
  }
  // Feishu has no typing indicator, so the bot acknowledges the message with
  // a reaction while the card is being produced (openclaw does the same). The
  // id is persisted because the terminal step has to take the reaction back —
  // including after a restart mid-run.
  let ackReactionId = existing?.ackReactionId ?? null;
  /** In flight so the terminal step can wait for it: a fast run can finish
   *  before the acknowledgement lands, and retracting a reaction that has not
   *  been created yet would leave it orphaned on the user's message. */
  let ackPending: Promise<void> | null = null;
  if (!ackReactionId && sourceMessageId) {
    const target = sourceMessageId;
    ackPending = (async () => {
      const acked = await cardClient.addReaction(target, ACK_EMOJI);
      if (acked.ok) {
        ackReactionId = acked.reactionId;
        updateRunCard(db, runId, { ackReactionId: acked.reactionId, sourceMessageId: target });
      } else {
        // Best effort: a missing acknowledgement is cosmetic and must never
        // stop the card from being produced.
        updateRunCard(db, runId, { lastError: `ackReaction: ${acked.error}` });
      }
    })();
  }

  let cardKitId = existing?.cardKitId ?? opts.adopt?.cardKitId ?? null;
  let larkMessageId = existing?.larkMessageId ?? opts.adopt?.larkMessageId ?? null;
  let seq = existing?.cardSeq ?? 0;

  const persist = () => {
    updateRunCard(db, runId, {
      status: rowStatus(state),
      accumulated: state.output,
      toolCount: state.completedTools.length,
      larkMessageId,
      cardKitId,
      cardSeq: seq,
    });
  };

  /** Painting (element streams, full replaces, caches) lives in
   *  card-updater.ts; the watcher keeps lifecycle only. */
  const getState = (): RunCardState => state;
  const updater = createCardUpdater({
    cardClient,
    db,
    runId,
    meta,
    getState,
    getCardId: () => cardKitId,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    onPersist: persist,
  });

  let pendingChars = 0;
  let lastFlushAt = Date.now();

  const maybeFlush = (textLength: number) => {
    pendingChars += textLength;
    const intervalElapsed = Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS;
    const bufferFull = pendingChars >= MAX_BUFFER_CHARS_BEFORE_FLUSH;
    if (intervalElapsed || bufferFull) {
      lastFlushAt = Date.now();
      pendingChars = 0;
      updater.request();
    }
  };

  // Status ticker: the elapsed line must tick every second even while the
  // model thinks or a tool runs (no deltas arrive then). The flush skips
  // unchanged elements, so a tick with no new text costs one cheap status
  // PUT — well within CardKit's streaming design point.
  const STATUS_TICK_MS = 1000;
  let statusTimer: Timer | undefined;
  const stopTicker = () => {
    clearInterval(statusTimer);
    statusTimer = undefined;
  };
  statusTimer = setInterval(() => {
    if (aborted || state.terminal) {
      stopTicker();
      return;
    }
    updater.request();
  }, STATUS_TICK_MS);

  async function sendFinalText(text: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendText(larkChatId, text, larkIdempotencyKey(conversationId, runId, "seal"), {
          replyTo,
          replyInThread,
        });
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Terminal feedback: take the acknowledgement back and leave a DONE.
   *  Best effort — the card is already the source of truth by now. */
  async function leaveTerminalReaction(): Promise<void> {
    if (!sourceMessageId) return;
    if (ackPending) await ackPending;
    const outcome = await swapAckReaction(cardClient, {
      messageId: sourceMessageId,
      ackReactionId,
    });
    if (ackReactionId !== null) {
      ackReactionId = null;
      updateRunCard(db, runId, { ackReactionId: null });
    }
    if (outcome.error) updateRunCard(db, runId, { lastError: outcome.error });
  }

  /** Terminal seal (ADR 0031 §3): full-card replace with canonical text. */
  async function seal(): Promise<void> {
    stopTicker();
    // The terminal status event can beat the ledger commit by a beat —
    // retry the run detail briefly before giving up on the canonical text.
    let finalText: string | null = null;
    for (const delay of SEAL_RETRY_DELAYS_MS) {
      const outcome = await fetchRunOutcome(backendUrl, backendAuthToken, runId).catch(() => null);
      finalText = finalAnswerText(outcome);
      if (finalText !== null) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    const content = finalText ?? state.output;
    state = { ...state, output: content };

    let sealed = false;
    if (cardKitId) {
      for (let attempt = 0; attempt < 3 && !sealed; attempt++) {
        sealed = await updater.replaceNow(state);
        if (!sealed) await new Promise((r2) => setTimeout(r2, 500 * 2 ** attempt));
      }
    }
    if (sealed) {
      // Close streaming mode so the client leaves the streaming view and
      // renders the frozen terminal card (reference: setCardStreamingMode).
      seq += 1;
      const closed = await cardClient.closeStreaming(cardKitId!, seq);
      if (!closed.ok) {
        // Non-fatal: the content is already terminal; the mode also
        // self-closes on the platform's streaming timeout.
        updateRunCard(db, runId, { lastError: `closeStreaming: ${closed.error}` });
      }
      updateRunCard(db, runId, {
        status: state.terminal?.status ?? "completed",
        accumulated: content,
      });
      return;
    }
    // Card unreplaceable: the final answer must still reach the user.
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

    // ── Create the card entity + send its message reference ──
    if (!cardKitId) {
      const created = await cardClient.createCard(renderCard(state, meta));
      if (!created.ok) {
        // Hand the run back to the text bridge; it delivers the final row.
        updateRunCard(db, runId, {
          status: "fallback_text",
          cardSendFailed: 1,
          lastError: created.error,
        });
        return;
      }
      cardKitId = created.cardId;
      const sent = await cardClient.sendCard(larkChatId, cardKitId, { replyTo, replyInThread });
      if (!sent.ok) {
        updateRunCard(db, runId, {
          status: "fallback_text",
          cardSendFailed: 1,
          lastError: sent.error,
        });
        return;
      }
      larkMessageId = sent.messageId;
      // Our own message is a topic key too: the user may reply to the CARD
      // rather than to their question, and that reply carries the card's id as
      // `root_id` (measured). Recording it here is what makes "reply to the
      // bot's card to keep talking" resolve to this same conversation.
      // Both the message and the topic it landed in resolve back here: the
      // user's next reply carries whichever the platform gives us (`root_id`
      // for a chain, `thread_id` once a thread exists).
      const keys = sent.threadId ? [sent.messageId, sent.threadId] : [sent.messageId];
      rememberTopicKeys(db, larkChatId, conversationId, keys, Date.now());
      // Fallback for a send with no reply target at all (a run nobody typed,
      // or a legacy conversation with no recorded root): the card we just
      // posted is then the thing a reply will hang off.
      if (replyTo === null) setTopicRoot(db, conversationId, sent.messageId);
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
            await updater.finish();
            await seal();
            await leaveTerminalReaction();
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
              const ev: { type?: string } = JSON.parse(currentData);
              if (ev?.type) {
                const before = state;
                state = applyRunEvent(state, ev as never);
                if (state !== before) {
                  if (state.terminal) {
                    await updater.finish();
                    await seal();
                    await leaveTerminalReaction();
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
      stopTicker();
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      abortController?.abort();
    },
  };
}
