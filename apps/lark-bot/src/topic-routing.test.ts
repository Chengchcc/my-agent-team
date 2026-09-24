import { describe, expect, test } from "bun:test";
import type { LarkMessageEvent } from "./event-parser.js";
import {
  replyInThreadFor,
  topicKeysToRemember,
  topicLookupKeys,
  topicRootMessageId,
} from "./topic-routing.js";

/** Shapes copied from live events (2026-09-24) — see ADR 0037. */
function ev(overrides: Partial<LarkMessageEvent>): LarkMessageEvent {
  return {
    type: "im.message.receive_v1",
    event_id: "evt",
    timestamp: "0",
    id: "om_self",
    message_id: "om_self",
    create_time: "0",
    chat_id: "oc_chat",
    chat_type: "group",
    message_type: "text",
    sender_id: "ou_user",
    content: "hi",
    ...overrides,
  } as LarkMessageEvent;
}

describe("topic routing keys (ADR 0037)", () => {
  test("topic chat: a top-level message opens the topic its own thread names", () => {
    const event = ev({ thread_id: "omt_topic" });
    expect(topicLookupKeys(event)).toEqual(["omt_topic"]);
    // Remember both the thread (how later messages are recognised) and the
    // message itself (the only thing the reply API can target).
    expect(topicKeysToRemember(event)).toEqual(["omt_topic", "om_self"]);
    expect(topicRootMessageId(event)).toBe("om_self");
  });

  test("topic chat: a reply resolves by the topic thread and answers to its root", () => {
    const event = ev({ thread_id: "omt_topic", root_id: "om_first", reply_to: "om_first" });
    expect(topicLookupKeys(event)).toEqual(["omt_topic", "om_first"]);
    expect(topicKeysToRemember(event)).toEqual(["omt_topic", "om_first"]);
    expect(topicRootMessageId(event)).toBe("om_first");
  });

  test("p2p: a bare message opens a topic under its own id", () => {
    const event = ev({ chat_type: "p2p" });
    expect(topicLookupKeys(event)).toEqual([]);
    expect(topicKeysToRemember(event)).toEqual(["om_self"]);
  });

  test("p2p: a bare message roots its own topic on the user's message", () => {
    // The answer replies to THAT message in-thread; that reply creates the
    // topic, so the message the answer hangs off is the user's, not ours.
    const event = ev({ chat_type: "p2p" });
    expect(topicRootMessageId(event)).toBe("om_self");
  });

  test("reply in thread: required in a topic chat, accepted in p2p", () => {
    expect(replyInThreadFor("topic")).toBe(true);
    // Probed live: a thread reply in p2p returns a thread_id — it is the only
    // thing that gives a p2p chat a visible topic.
    expect(replyInThreadFor("p2p")).toBe(true);
    // Unknown mode answers in thread: the flag is what creates the topic, and
    // the surfaces that accept it are the ones we serve.
    expect(replyInThreadFor(null)).toBe(true);
    // A plain group has no topic to join.
    expect(replyInThreadFor("group")).toBe(false);
  });

  test("p2p: the first reply to our card carries only root_id, and is taught its thread later", () => {
    // Measured: the first reply has no thread_id, the NEXT one has one Lark
    // assigned; both carry root_id = our card's message id. Two keys, one
    // conversation — which is exactly what the mapping table is for.
    const first = ev({ chat_type: "p2p", root_id: "om_card", reply_to: "om_card" });
    expect(topicLookupKeys(first)).toEqual(["om_card"]);
    expect(topicRootMessageId(first)).toBe("om_card");

    const second = ev({
      chat_type: "p2p",
      thread_id: "omt_chain",
      root_id: "om_card",
      reply_to: "om_card",
    });
    expect(topicLookupKeys(second)).toEqual(["omt_chain", "om_card"]);
    expect(topicKeysToRemember(second)).toEqual(["omt_chain", "om_card"]);
  });
});
