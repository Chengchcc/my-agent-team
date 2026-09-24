import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInputCard, openBindings } from "../bindings-sqlite.js";
import type { CardKitClient } from "./card-kit.js";
import { markQueuedCardCancelled, planQueuedCardStep, startQueuedCard } from "./queued-card.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    configurable: true,
    writable: true,
  });
});

/** The inputs endpoint, as the promotion poll reads it. */
function serveInputs(runId: string | null): void {
  Object.defineProperty(globalThis, "fetch", {
    value: () =>
      Promise.resolve(
        new Response(JSON.stringify({ inputs: [{ inputId: "in_1", runId }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    configurable: true,
    writable: true,
  });
}

/** Records what the queued card asks the platform to do, and hands back the
 *  signals a test can await instead of sleeping through the poll interval. */
function fakeCardClient(): {
  client: CardKitClient;
  cards: Array<Record<string, unknown>>;
  sends: Array<{ cardId: string; replyTo?: string | null }>;
  updates: Array<{ cardId: string; card: Record<string, unknown> }>;
  /** Resolves on the first card replacement (cancelled frame, etc). */
  replaced: Promise<void>;
} {
  const cards: Array<Record<string, unknown>> = [];
  const sends: Array<{ cardId: string; replyTo?: string | null }> = [];
  const updates: Array<{ cardId: string; card: Record<string, unknown> }> = [];
  const replaced = Promise.withResolvers<void>();
  const client = {
    createCard: async (card: Record<string, unknown>) => {
      cards.push(card);
      return { ok: true as const, cardId: `card_${cards.length}` };
    },
    sendCard: async (_chatId: string, cardId: string, opts?: { replyTo?: string | null }) => {
      sends.push({ cardId, replyTo: opts?.replyTo });
      return { ok: true as const, messageId: `om_card_${sends.length}`, threadId: "omt_topic" };
    },
    updateCard: async (cardId: string, card: Record<string, unknown>) => {
      updates.push({ cardId, card });
      replaced.resolve();
      return { ok: true as const };
    },
  } as unknown as CardKitClient;
  return { client, cards, sends, updates, replaced: replaced.promise };
}

async function withDb(fn: (db: ReturnType<typeof openBindings>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lark-queued-card-"));
  const db = openBindings("test-agent", dir);
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("queued card step (pure)", () => {
  test("wait / promote / cancelled / stop", () => {
    expect(planQueuedCardStep("queued", { found: true, runId: null })).toBe("wait");
    expect(planQueuedCardStep("queued", { found: true, runId: "run-1" })).toBe("promote");
    // Promoted inputs and cancelled ones both stop being listed: the row is
    // what tells the two apart.
    expect(planQueuedCardStep("queued", { found: false })).toBe("cancelled");
    expect(planQueuedCardStep("cancelled", { found: false })).toBe("stop");
    expect(planQueuedCardStep("promoted", { found: true, runId: "run-1" })).toBe("stop");
  });
});

describe("queued card (ADR 0037: one turn = one card)", () => {
  test("a waiting message gets its own card, in the topic, with a cancel", async () => {
    await withDb(async (db) => {
      const fake = fakeCardClient();
      serveInputs(null);
      const handle = startQueuedCard("in_1", "conv_1", "oc_1", {
        db,
        backendUrl: "http://backend",
        backendAuthToken: null,
        cardClient: fake.client,
        replyTo: "om_root",
        replyInThread: true,
        onPromoted: () => {
          throw new Error("nothing is running this input yet");
        },
      });
      await handle.ready;
      handle.close();

      const card = JSON.stringify(fake.cards[0]);
      expect(card).toContain("排队中");
      expect(card).toContain("cancel_input");
      expect(card).toContain("in_1");
      // It lands in the topic (so it sits where the conversation is), and its
      // ids are on the row for the handover.
      expect(fake.sends[0]!.replyTo).toBe("om_root");
      const record = getInputCard(db, "in_1");
      expect(record?.status).toBe("queued");
      expect(record?.cardKitId).toBe("card_1");
      // The card's own message (and the thread it created) are topic keys:
      // replying to it must reach this conversation.
      const keys = db
        .query("SELECT topic_key FROM topic_binding WHERE conversation_id = 'conv_1'")
        .all() as Array<{ topic_key: string }>;
      expect(keys.map((k) => k.topic_key).sort()).toEqual(["om_card_1", "omt_topic"]);
    });
  });

  test("promotion hands the SAME card to the run (no second card)", async () => {
    await withDb(async (db) => {
      const fake = fakeCardClient();
      serveInputs("run_promoted");
      const promoted = Promise.withResolvers<{
        inputId: string;
        runId: string;
        cardKitId: string;
      }>();
      const handle = startQueuedCard("in_1", "conv_1", "oc_1", {
        db,
        backendUrl: "http://backend",
        backendAuthToken: null,
        cardClient: fake.client,
        replyTo: "om_root",
        replyInThread: true,
        pollMs: 1,
        onPromoted: (inputId, runId, cardKitId) =>
          promoted.resolve({ inputId, runId, cardKitId: cardKitId as string }),
      });
      expect(await promoted.promise).toEqual({
        inputId: "in_1",
        runId: "run_promoted",
        cardKitId: "card_1",
      });
      handle.close();

      expect(getInputCard(db, "in_1")?.status).toBe("promoted");
      // Exactly one card was ever created and sent: the user never sees a
      // second card appear for one message.
      expect(fake.cards).toHaveLength(1);
      expect(fake.sends).toHaveLength(1);
    });
  });

  test("cancelling redraws that card only — it never touches the running turn", async () => {
    await withDb(async (db) => {
      const fake = fakeCardClient();
      serveInputs(null);
      const handle = startQueuedCard("in_1", "conv_1", "oc_1", {
        db,
        backendUrl: "http://backend",
        backendAuthToken: null,
        cardClient: fake.client,
        replyTo: null,
        replyInThread: false,
        onPromoted: () => undefined,
      });
      await handle.ready;
      handle.close();

      await markQueuedCardCancelled({ db, cardClient: fake.client }, "in_1");
      expect(getInputCard(db, "in_1")?.status).toBe("cancelled");
      expect(JSON.stringify(fake.updates.at(-1)?.card)).toContain("已取消");
      // A second cancel is a no-op: the row is already terminal.
      await markQueuedCardCancelled({ db, cardClient: fake.client }, "in_1");
      expect(fake.updates).toHaveLength(1);
    });
  });
});
