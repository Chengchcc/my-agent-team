/** The watcher is the glue the switch introduced: the chat channel's state goes in, the card's
 *  frames come out, and the fold into `turns` is the seal. Everything else about the card has its
 *  own tests; this is the path only a real bot could otherwise check. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getRunCard, openBindings } from "../bindings-sqlite.js";
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
function chatOf(parts: unknown[], settled: boolean): unknown {
  const turn = {
    id: runId,
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
    expect(calls).toContain("updateCard");
    expect(getRunCard(db, runId)?.accumulated).toBe(text);

    await handle.update(chatOf([markdown(text)], true) as never);
    expect(calls).toContain("closeStreaming");
    expect(getRunCard(db, runId)?.status).toBe("completed");
    expect(getRunCard(db, runId)?.accumulated).toBe(text);
    handle.close();
  }, 15_000);

  test("a state that does not carry this run is a no-op", async () => {
    const calls: string[] = [];
    const handle = await watchRunCard(`${runId}-other`, "conv-watch-1", "oc_watch", {
      db,
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
