import type { Database } from "bun:sqlite";
import {
  getInputCard,
  insertInputCard,
  listQueuedInputCards,
  rememberTopicKeys,
  updateInputCard,
} from "../bindings-sqlite.js";
import type { CardKitClient } from "./card-kit.js";

/** The card of a message that has to WAIT (ADR 0037 decision 2).
 *
 *  One agent-loop turn is one card, so a message arriving while the previous
 *  turn is still running gets its OWN card, saying it is queued — instead of
 *  being folded into the running turn (which is what steering did) or worse,
 *  vanishing with no trace at all.
 *
 *  The card exists before its run does. The backend queues the message as an
 *  input; when the branch goes idle, `acquireNextRun` promotes the oldest
 *  non-steer input into its own run and writes that run id back onto the input
 *  row. This module watches for exactly that and hands the card over: the same
 *  card entity continues as that run's streaming card, so the user never sees
 *  a second card appear for one message.
 *
 *  Cancelling is the cancel-the-steer semantics the user asked for: it drops
 *  THIS message only (`POST /inputs/:inputId/cancel`); the running turn is
 *  untouched. */

export interface QueuedCardDeps {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  cardClient: CardKitClient;
  /** The topic this card must answer into, and whether to reply in thread. */
  replyTo: string | null;
  replyInThread: boolean;
  /** The input was promoted: run `runId` will now execute this message. The
   *  caller starts the run card with this card ADOPTED. */
  onPromoted: (inputId: string, runId: string, cardKitId: string, larkMessageId: string) => void;
  /** Poll cadence while at least one card is queued. */
  pollMs?: number;
}

export interface QueuedCardHandle {
  inputId: string;
  /** Resolves once the queued card exists (created, sent, recorded) — or once
   *  we know it never will. Callers that need the card's ids (tests, and a
   *  future handover that starts before the first poll) await this. */
  ready: Promise<void>;
  close: () => void;
}

/** The queued frame: a title, one line of truth, and the way out. */
function queuedCardJson(inputId: string, text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "排队中" } },
    header: {
      title: { tag: "plain_text", content: "排队中" },
      template: "grey",
    },
    body: {
      elements: [
        { tag: "markdown", element_id: "queued_note", content: text },
        {
          tag: "action",
          element_id: "queued_action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "取消这条" },
              type: "default",
              behaviors: [{ type: "callback", value: { action: "cancel_input", inputId } }],
            },
          ],
        },
      ],
    },
  };
}

/** What the next poll should do, given the card's row and the input's state.
 *
 *  Pure so the decision can be tested without timers or a backend. The
 *  ambiguous case is `found: false`: promoted inputs stop being listed as
 *  pending, and so do cancelled ones — the row is what disambiguates, which is
 *  why the watcher writes `promoted` BEFORE it hands the card over. */
export function planQueuedCardStep(
  cardStatus: string,
  input: { found: boolean; runId: string | null },
): "stop" | "wait" | "promote" | "cancelled" {
  if (cardStatus !== "queued") return "stop";
  if (!input.found) return "cancelled";
  if (input.runId) return "promote";
  return "wait";
}

/** Fetch the input's current state: `runId` set means it was promoted (it is
 *  running or about to), a terminal status means it is gone for good. */
async function fetchInputState(
  deps: QueuedCardDeps,
  conversationId: string,
  inputId: string,
): Promise<{ found: boolean; runId: string | null }> {
  const headers: Record<string, string> = {};
  if (deps.backendAuthToken) headers["x-auth-token"] = deps.backendAuthToken;
  try {
    const resp = await fetch(`${deps.backendUrl}/api/conversations/${conversationId}/inputs`, {
      headers,
    });
    if (!resp.ok) return { found: true, runId: null };
    const body = (await resp.json()) as {
      inputs?: Array<{ inputId?: string; runId?: string | null }>;
    };
    const match = (body.inputs ?? []).find((i) => i.inputId === inputId);
    if (!match) return { found: false, runId: null };
    return { found: true, runId: typeof match.runId === "string" ? match.runId : null };
  } catch {
    // Unreachable backend: keep waiting, the input is durable either way.
    return { found: true, runId: null };
  }
}

export function startQueuedCard(
  inputId: string,
  conversationId: string,
  larkChatId: string,
  deps: QueuedCardDeps,
): QueuedCardHandle {
  const { db, cardClient } = deps;
  let cardKitId: string | null = null;
  let larkMessageId: string | null = null;
  let closed = false;
  let timer: Timer | undefined;

  async function ensureCard(): Promise<boolean> {
    if (cardKitId) return true;
    insertInputCard(db, { inputId, conversationId, larkChatId, now: Date.now() });
    const created = await cardClient.createCard(
      queuedCardJson(inputId, "上一轮还在跑，这条消息在排队。到它时会用这张卡片回答。"),
    );
    if (!created.ok) {
      updateInputCard(db, inputId, { status: "cancelled", lastError: created.error });
      return false;
    }
    cardKitId = created.cardId;
    const sent = await cardClient.sendCard(larkChatId, cardKitId, {
      replyTo: deps.replyTo,
      replyInThread: deps.replyInThread,
    });
    if (!sent.ok) {
      updateInputCard(db, inputId, { status: "cancelled", lastError: sent.error });
      return false;
    }
    larkMessageId = sent.messageId;
    // Registered exactly like a run card's: the user can reply to THIS card
    // while it waits, and that reply must land in the same conversation.
    const keys = sent.threadId ? [sent.messageId, sent.threadId] : [sent.messageId];
    rememberTopicKeys(db, larkChatId, conversationId, keys, Date.now());
    updateInputCard(db, inputId, { cardKitId, larkMessageId });
    return true;
  }

  async function tick(): Promise<void> {
    if (closed) return;
    const record = getInputCard(db, inputId);
    if (!record) return;
    const state = await fetchInputState(deps, conversationId, inputId);
    switch (planQueuedCardStep(record.status, state)) {
      case "stop":
        // Cancelled from elsewhere (the cancel callback, the /stop path):
        // whoever cancelled it redrew the card. Just stop watching.
        return;
      case "cancelled":
        updateInputCard(db, inputId, { status: "cancelled" });
        return;
      case "promote":
        // Written BEFORE the handover: the run card reads the row, and the
        // input may already have dropped out of the pending list by then.
        updateInputCard(db, inputId, { status: "promoted" });
        deps.onPromoted(inputId, state.runId ?? "", cardKitId ?? "", larkMessageId ?? "");
        return;
      case "wait":
        schedule();
        return;
    }
  }

  function schedule(): void {
    if (closed) return;
    timer = setTimeout(() => {
      void tick().catch(() => undefined);
    }, deps.pollMs ?? 2000);
  }

  const ready = Promise.withResolvers<void>();
  void (async () => {
    const ok = await ensureCard();
    ready.resolve();
    if (ok) schedule();
  })();

  return {
    inputId,
    ready: ready.promise,
    close: () => {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Redraw a queued card as cancelled (called by the cancel callback). */
export async function markQueuedCardCancelled(
  deps: Pick<QueuedCardDeps, "db" | "cardClient">,
  inputId: string,
): Promise<void> {
  const record = getInputCard(deps.db, inputId);
  if (!record?.cardKitId || record.status !== "queued") return;
  await deps.cardClient.updateCard(
    record.cardKitId,
    queuedCardJson(inputId, "已取消。这条消息不会再被执行，正在跑的那一轮不受影响。"),
    1,
  );
  updateInputCard(deps.db, inputId, { status: "cancelled" });
}

/** Queued cards still waiting, for restart recovery. */
export function liveQueuedInputCards(db: Database): string[] {
  return listQueuedInputCards(db).map((r) => r.inputId);
}
