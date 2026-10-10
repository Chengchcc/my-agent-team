/** The watcher is the glue the switch introduced: the chat channel's state goes in, the card's
 *  frames come out, and the fold into `turns` is the seal. Everything else about the card has its
 *  own tests; this is the path only a real bot could otherwise check. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getRunCard, openBindings } from "../bindings-sqlite.js";
import { instantCardPaceClock } from "./card-pacer.js";
import { watchRunCard } from "./run-card-watcher.js";

const testDir = `/tmp/test-lark-run-watcher-${Date.now()}`;
const runId = "run-watch-1";
let db: ReturnType<typeof openBindings>;

beforeAll(() => {
  db = openBindings("test-watcher", testDir);
});

afterAll(() => {
  db?.close();
});

const markdown = (content: string) => ({ kind: "markdown", id: "t0", content });

/** A chat state whose turn is either active (streaming) or folded (settled). */
function chatOf(parts: unknown[], settled: boolean, id: string = runId): unknown {
  const turn = {
    id,
    startedAt: new Date(0).toISOString(),
    message: { text: "go", origin: { kind: "user" } },
    responseParts: parts,
    usage: undefined,
    ...(settled ? { state: "complete" } : {}),
  };
  return {
    resource: "ahp-chat:/conv-watch-1",
    title: "t",
    status: 1,
    modifiedAt: new Date(0).toISOString(),
    turns: settled ? [turn] : [],
    ...(settled ? {} : { activeTurn: turn }),
  };
}

function fakeCardClient(calls: string[]) {
  return {
    createCard: async () => ({ ok: true, cardId: "card-watch" }),
    sendCard: async () => ({ ok: true, messageId: "om_watch" }),
    updateCard: async () => {
      calls.push("updateCard");
      return { ok: true, seq: 1 };
    },
    streamElement: async () => {
      calls.push("streamElement");
      return { ok: true, seq: 1 };
    },
    closeStreaming: async () => {
      calls.push("closeStreaming");
      return { ok: true };
    },
  } as never;
}

describe("the run card watches the chat channel", () => {
  test("a folded turn seals the card with its text", async () => {
    const calls: string[] = [];
    const text = "x".repeat(200);
    const handle = await watchRunCard(runId, "conv-watch-1", "oc_watch", {
      db,
      // Nothing here should reach the backend: the seal's canonical-text retry fails fast on a
      // closed port and the card falls back to what the state carried.
      cardPaceClock: instantCardPaceClock,
      backendUrl: "http://127.0.0.1:1",
      backendAuthToken: null,
      cardClient: fakeCardClient(calls),
      webUrl: null,
      sourceMessageId: null,
      replyTo: null,
      replyInThread: false,
      sendText: async () => {
        calls.push("sendText");
      },
    });

    // A long body flushes on the buffer rule rather than waiting for the 150ms pacing.
    await handle.update(chatOf([markdown(text)], false) as never);
    // The lane adds async hops before the first replace lands.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain("updateCard");
    expect(getRunCard(db, runId)?.accumulated).toBe(text);

    await handle.update(chatOf([markdown(text)], true) as never);
    expect(calls).toContain("closeStreaming");
    expect(getRunCard(db, runId)?.status).toBe("completed");
    expect(getRunCard(db, runId)?.accumulated).toBe(text);
    handle.close();
  }, 15_000);

  test("a rate-limited seal waits for the card instead of sending a second message", async () => {
    // #87: congestion (230020) used to be read as "this card cannot be
    // replaced", so the answer went out as a plain message while the card kept
    // occupying the topic — the user read the same answer twice.
    const calls: string[] = [];
    let updateAttempts = 0;
    const congested = {
      createCard: async () => ({ ok: true, cardId: "card-rl" }),
      sendCard: async () => ({ ok: true, messageId: "om_rl" }),
      updateCard: async () => {
        updateAttempts += 1;
        if (updateAttempts <= 3) {
          return { ok: false, error: "code 230020: chat rate limit", retryable: true };
        }
        calls.push("updateCard");
        return { ok: true };
      },
      streamElement: async () => ({ ok: true }),
      closeStreaming: async () => {
        calls.push("closeStreaming");
        return { ok: true };
      },
    } as never;
    const handle = await watchRunCard("run-rl", "conv-watch-1", "oc_watch", {
      db,
      cardPaceClock: instantCardPaceClock,
      backendUrl: "http://127.0.0.1:1",
      backendAuthToken: null,
      cardClient: congested,
      webUrl: null,
      sourceMessageId: null,
      replyTo: null,
      replyInThread: false,
      // Outlives the first replace call's own retries (3 attempts, 500ms
      // doubling) so the seal is seen waiting rather than giving up.
      sealCongestionBudgetMs: 10_000,
      sendText: async () => {
        calls.push("sendText");
      },
    });

    await handle.update(chatOf([markdown("y".repeat(200))], false, "run-rl") as never);
    await handle.update(chatOf([markdown("y".repeat(200))], true, "run-rl") as never);
    expect(calls).not.toContain("sendText");
    expect(getRunCard(db, "run-rl")?.status).toBe("completed");
    handle.close();
  }, 20_000);

  test("a card that cannot be replaced at all still falls back to text", async () => {
    // The fallback is for a broken card, and it must survive the congestion fix.
    const calls: string[] = [];
    const broken = {
      createCard: async () => ({ ok: true, cardId: "card-broken" }),
      sendCard: async () => ({ ok: true, messageId: "om_broken" }),
      updateCard: async () => {
        return { ok: false, error: "code 300313: element not found", retryable: false };
      },
      streamElement: async () => ({ ok: true }),
      closeStreaming: async () => ({ ok: true }),
    } as never;
    const handle = await watchRunCard("run-broken", "conv-watch-1", "oc_watch", {
      db,
      cardPaceClock: instantCardPaceClock,
      backendUrl: "http://127.0.0.1:1",
      backendAuthToken: null,
      cardClient: broken,
      webUrl: null,
      sourceMessageId: null,
      replyTo: null,
      replyInThread: false,
      sendText: async () => {
        calls.push("sendText");
      },
    });

    await handle.update(chatOf([markdown("y".repeat(200))], false, "run-broken") as never);
    await handle.update(chatOf([markdown("y".repeat(200))], true, "run-broken") as never);
    expect(calls).toContain("sendText");
    expect(getRunCard(db, "run-broken")?.status).toBe("fallback_text");
    handle.close();
  }, 20_000);

  test("the seal waits for an in-flight stream push, so sequences arrive in order", async () => {
    // #87: the seal's full-card replace runs outside the flush controller. If it
    // raced an in-flight element update, the platform could see a LOWER
    // sequence after a higher one and reject it (300317), degrading the card
    // and sending the answer as a second, plain message.
    const calls: string[] = [];
    let releaseStream: (() => void) | null = null;
    const ordered = {
      createCard: async () => ({ ok: true, cardId: "card-order" }),
      sendCard: async () => ({ ok: true, messageId: "om_order" }),
      updateCard: async () => {
        calls.push("updateCard");
        return { ok: true };
      },
      streamElement: async () => {
        calls.push("stream:start");
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        calls.push("stream:end");
        return { ok: true };
      },
      closeStreaming: async () => ({ ok: true }),
    } as never;
    const handle = await watchRunCard("run-order", "conv-order", "oc_order", {
      db,
      cardPaceClock: instantCardPaceClock,
      backendUrl: "http://127.0.0.1:1",
      backendAuthToken: null,
      cardClient: ordered,
      webUrl: null,
      sourceMessageId: null,
      replyTo: null,
      replyInThread: false,
      sendText: async () => {
        calls.push("sendText");
      },
    });

    // Flush 1 (frame change) takes the full-replace path and completes. A beat
    // past the flush interval: update() does not await the flush it requests
    // (single-flight), so an immediate second update would just coalesce into
    // this replace instead of taking the element path.
    await handle.update(chatOf([markdown("a".repeat(400))], false, "run-order") as never);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c === "updateCard").length).toBe(1);

    // Flush 2 (same frame, new output) takes the element path and HANGS there.
    const streaming = handle.update(
      chatOf([markdown("b".repeat(400))], false, "run-order") as never,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain("stream:start");
    expect(calls).not.toContain("stream:end");

    // While the push is still in flight, the run settles: the seal must drain
    // it before sending its own replace, or the platform sees a LOWER sequence
    // after a higher one (300317).
    const settling = handle.update(chatOf([markdown("b".repeat(400))], true, "run-order") as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c === "updateCard").length).toBe(1);
    expect(calls).not.toContain("stream:end");

    releaseStream?.();
    await Promise.all([streaming, settling]);
    expect(calls.filter((c) => c === "updateCard").length).toBe(2);
    expect(calls.lastIndexOf("updateCard")).toBeGreaterThan(calls.indexOf("stream:end"));
    expect(getRunCard(db, "run-order")?.status).toBe("completed");
    handle.close();
  }, 20_000);

  test("a state that does not carry this run is a no-op", async () => {
    const calls: string[] = [];
    const handle = await watchRunCard(`${runId}-other`, "conv-watch-1", "oc_watch", {
      db,
      cardPaceClock: instantCardPaceClock,
      backendUrl: "http://127.0.0.1:1",
      backendAuthToken: null,
      cardClient: fakeCardClient(calls),
      webUrl: null,
      sourceMessageId: null,
      replyTo: null,
      replyInThread: false,
      sendText: async () => {},
    });
    // The state carries `run-watch-1`; this card watches another run, so nothing changes.
    await handle.update(chatOf([markdown("hello")], false) as never);
    expect(getRunCard(db, `${runId}-other`)?.accumulated ?? "").toBe("");
    handle.close();
  }, 15_000);
});
