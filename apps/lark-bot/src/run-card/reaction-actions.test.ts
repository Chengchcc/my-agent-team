import { describe, expect, test } from "bun:test";
import { insertRunCard, openBindings, updateRunCard } from "../bindings-sqlite.js";
import { handleReactionLine, parseReactionLine } from "./reaction-actions.js";

function seed(runId: string, messageId: string, status = "streaming") {
  const dir = `/tmp/test-lark-reaction-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const db = openBindings("test-reaction", dir);
  insertRunCard(db, {
    runId,
    conversationId: `conv-${runId}`,
    larkChatId: "oc_reaction",
    sourceMessageId: "om_src",
  });
  updateRunCard(db, runId, { status, larkMessageId: messageId });
  return db;
}

function deps(db: ReturnType<typeof openBindings>) {
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    deps: {
      db,
      cancelRun: async (runId: string) => {
        calls.push(runId);
        return {};
      },
      log: (message: string) => logs.push(message),
    },
  };
}

const stopLine = (messageId: string, key: string) =>
  JSON.stringify({
    event_id: "ev-1",
    message_id: messageId,
    chat_id: "oc_reaction",
    operator_id: "ou_1",
    reaction_type: key,
  });

describe("reaction actions", () => {
  test("a stop reaction on a live run card cancels that run", async () => {
    const db = seed("run-r1", "om_card_1");
    const { calls, deps: d } = deps(db);
    expect(await handleReactionLine(stopLine("om_card_1", "X"), d)).toBe("stopped");
    expect(calls).toEqual(["run-r1"]);
    db.close();
  });

  test("an acknowledgement reaction never kills a run, and is logged to learn the shape", async () => {
    const db = seed("run-r2", "om_card_2");
    const { calls, logs, deps: d } = deps(db);
    expect(await handleReactionLine(stopLine("om_card_2", "THUMBSUP"), d)).toBe("ignored-reaction");
    expect(calls).toEqual([]);
    const probe = logs.find((l) => l.includes("reaction on run card"));
    expect(probe).toContain("key=THUMBSUP");
    expect(probe).toContain("runId=run-r2");
    db.close();
  });

  test("a reaction on a message that carries no live card is inert", async () => {
    const db = seed("run-r3", "om_card_3");
    const { calls, deps: d } = deps(db);
    expect(await handleReactionLine(stopLine("om_other", "X"), d)).toBe("no-live-card");
    expect(calls).toEqual([]);
    // A settled card is not a live one either.
    updateRunCard(db, "run-r3", { status: "completed" });
    expect(await handleReactionLine(stopLine("om_card_3", "X"), d)).toBe("no-live-card");
    expect(calls).toEqual([]);
    db.close();
  });

  test("an unreadable line is logged verbatim, never guessed", async () => {
    const db = seed("run-r4", "om_card_4");
    const { calls, logs, deps: d } = deps(db);
    expect(await handleReactionLine("not json at all", d)).toBe("unparsed");
    expect(logs.some((l) => l.includes("not json at all"))).toBe(true);
    expect(calls).toEqual([]);
    db.close();
  });

  test("the parser reads the plausible spellings and refuses an empty line", () => {
    expect(parseReactionLine(JSON.stringify({ messageId: "om_x", reactionType: "X" }))).toEqual({
      eventId: undefined,
      messageId: "om_x",
      chatId: undefined,
      operatorId: undefined,
      reactionKey: "X",
    });
    expect(parseReactionLine(JSON.stringify({ event_id: "e" }))).toBeNull();
    expect(parseReactionLine("{}")).toBeNull();
  });
});
