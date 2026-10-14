import { describe, expect, test } from "bun:test";
import type { CardActionEvent, CommentEvent, NormalizedMessage } from "@larksuite/channel";
import { toCardActionLine, toCommentTrigger, toLarkMessageEvent } from "./channel-adapters.js";
import { isBotMentioned, isMentionAll } from "./event-parser.js";
import { decodeActionValue, parseCardActionLine } from "./run-card/card-actions.js";
import { topicLookupKeys, topicRootMessageId } from "./topic-routing.js";

/**
 * ADR 0044 boundary tests. The card and comment fixtures are the payloads the
 * isolated app actually delivered on 2026-10-14 (ids kept verbatim; the token
 * truncated, which this code never reads). The message fixture is modelled on
 * the SDK's declared `RawMessageEvent` shape; the live acceptance run covers it.
 */

const RAW_CARD = {
  schema: "2.0",
  event_id: "101bd7ede44919c0981b6f8c79b710f1",
  token: "c-a615493f…",
  create_time: "1791946956949038",
  event_type: "card.action.trigger",
  tenant_key: "736588c9260f175d",
  app_id: "cli_aa4459351974dd2c",
  operator: {
    tenant_key: "736588c9260f175d",
    open_id: "ou_0a7dd0893c0d537a23f8dca52175b83b",
    union_id: "on_b43e2ccf0ab80f9b0ff37935ed598862",
  },
  action: { value: { action: "stop", probe: { nested: true }, runId: "spike-run" }, tag: "button" },
  host: "im_message",
  context: {
    open_message_id: "om_x100b63db4b21dc80b051289cfc4c6bd",
    open_chat_id: "oc_0fcfb9f5401af46945f9ecb20d6e0669",
  },
};

const rawCardEvent = (over: Partial<CardActionEvent> = {}): CardActionEvent =>
  ({
    messageId: "om_x100b63db4b21dc80b051289cfc4c6bd",
    chatId: "oc_0fcfb9f5401af46945f9ecb20d6e0669",
    operator: { openId: "ou_0a7dd0893c0d537a23f8dca52175b83b" },
    action: {
      value: { action: "stop", probe: { nested: true }, runId: "spike-run" },
      tag: "button",
    },
    raw: RAW_CARD,
    ...over,
  }) as CardActionEvent;

const RAW_COMMENT = {
  schema: "2.0",
  event_id: "c0bd64c73ade4e419dc28525cf8ccbfa",
  token: "",
  create_time: "1791946459000",
  event_type: "drive.notice.comment_add_v1",
  tenant_key: "736588c9260f175d",
  app_id: "cli_aa4459351974dd2c",
  comment_id: "7696351432357728318",
  is_mentioned: false,
  notice_meta: {
    file_token: "EWvsdouioonNMSxlY95m4uIly9w",
    file_type: "docx",
    from_user_id: { open_id: "ou_0a7dd0893c0d537a23f8dca52175b83b", union_id: "on_b43e2c…" },
    from_user_type: "user",
    is_from_agent: false,
    notice_type: "add_comment",
    to_user_id: { open_id: "ou_20683aeb8c2d06d8d15fd5bab5134c33" },
  },
  reply_id: "7696351432374521914",
};

const commentEvent = (over: Partial<CommentEvent> = {}): CommentEvent =>
  ({
    fileToken: "EWvsdouioonNMSxlY95m4uIly9w",
    fileType: "docx",
    commentId: "7696351432357728318",
    replyId: "7696351432374521914",
    operator: { openId: "ou_0a7dd0893c0d537a23f8dca52175b83b" },
    mentionedBot: false,
    timestamp: 1791946459000,
    raw: RAW_COMMENT,
    ...over,
  }) as CommentEvent;

describe("card actions survive the transport swap", () => {
  test("a real click becomes the same line the pipeline already parses", () => {
    const parsed = parseCardActionLine(toCardActionLine(rawCardEvent()));
    expect(parsed).not.toBeNull();
    // The dedup key lives at raw.event_id - the field lark-cli used to give us.
    expect(parsed?.eventId).toBe("101bd7ede44919c0981b6f8c79b710f1");
    expect(parsed?.messageId).toBe("om_x100b63db4b21dc80b051289cfc4c6bd");
    expect(parsed?.chatId).toBe("oc_0fcfb9f5401af46945f9ecb20d6e0669");
    expect(parsed?.operatorId).toBe("ou_0a7dd0893c0d537a23f8dca52175b83b");
    expect(parsed?.actionTag).toBe("button");
    // The decoded identity is what the run controls act on, extra fields and all.
    expect(decodeActionValue(parsed?.actionValue ?? "")).toEqual({
      action: "stop",
      runId: "spike-run",
    });
    // A plain button carries neither a form value nor a name.
    expect(parsed?.actionName).toBeUndefined();
    expect(parsed?.formValue).toBeUndefined();
  });

  test("a form submit keeps its name and flattens its fields", () => {
    const parsed = parseCardActionLine(
      toCardActionLine(
        rawCardEvent({
          action: {
            tag: "form_submit",
            name: "ask_submit",
            value: {
              runId: "run-form",
              callId: "call-form",
              questionId: "q-form",
              action: "answer_ask",
            },
            formValue: { answer: "用 release 分支", pick: "a", nums: 2, multi: ["x", "y"] },
          } as CardActionEvent["action"],
        }),
      ),
    );
    expect(parsed?.actionName).toBe("ask_submit");
    expect(parsed?.formValue).toEqual({
      answer: "用 release 分支",
      pick: "a",
      nums: "2",
      multi: "x,y",
    });
    expect(decodeActionValue(parsed?.actionValue ?? "")).toEqual({
      action: "answer_ask",
      runId: "run-form",
      callId: "call-form",
      questionId: "q-form",
      selectedValue: "",
    });
  });

  test("without raw.event_id the dedup key is deterministic, never empty", () => {
    const line = toCardActionLine(rawCardEvent({ raw: undefined }));
    const first = parseCardActionLine(line)?.eventId ?? "";
    const second =
      parseCardActionLine(toCardActionLine(rawCardEvent({ raw: undefined })))?.eventId ?? "";
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});

describe("messages keep the shared contract's shape", () => {
  const rawMessage = {
    sender: {
      sender_id: { open_id: "ou_0a7dd0893c0d537a23f8dca52175b83b" },
      sender_type: "user",
      tenant_key: "736588c9260f175d",
    },
    message: {
      message_id: "om_x100b63daf2195ca50cad751bd94e261",
      root_id: "om_root",
      create_time: "1791946479000",
      chat_id: "oc_0fcfb9f5401af46945f9ecb20d6e0669",
      thread_id: "omt_abc",
      chat_type: "p2p",
      message_type: "text",
      content: '{"text":"hi"}',
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "oma2 CLI" }],
    },
  };

  const normalized = (over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
    ({
      messageId: "om_x100b63daf2195ca50cad751bd94e261",
      chatId: "oc_0fcfb9f5401af46945f9ecb20d6e0669",
      chatType: "p2p",
      senderId: "ou_0a7dd0893c0d537a23f8dca52175b83b",
      senderType: "user",
      content: "hi",
      rawContentType: "text",
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "oma2 CLI" }],
      mentionAll: false,
      mentionedBot: true,
      createTime: 1791946479000,
      threadId: "omt_abc",
      rootId: "om_root",
      resources: [],
      raw: rawMessage,
      ...over,
    }) as NormalizedMessage;

  test("thread context, mentions and the mention gate all carry over", () => {
    const event = toLarkMessageEvent(normalized());
    expect(event).not.toBeNull();
    expect(event?.thread_id).toBe("omt_abc");
    expect(event?.root_id).toBe("om_root");
    expect(event?.sender_type).toBe("user");
    expect(event?.mentions).toEqual([{ id: "ou_bot", key: "@_user_1", name: "oma2 CLI" }]);
    // The group gate matches by display name (event-parser), so a lost name
    // would silently stop the bot answering where it must be @-ed.
    expect(isBotMentioned(event!, "oma2 CLI")).toBe(true);
    expect(isBotMentioned(event!, "someone else")).toBe(false);
    expect(isMentionAll(event!)).toBe(false);
    expect(topicLookupKeys(event!)).toEqual(["omt_abc", "om_root"]);
    expect(topicRootMessageId(event!)).toBe("om_root");
  });

  test("a message without raw still satisfies the contract", () => {
    const event = toLarkMessageEvent(
      normalized({ raw: undefined, threadId: undefined, rootId: undefined }),
    );
    expect(event?.event_id).toBe("om_x100b63daf2195ca50cad751bd94e261");
    expect(event?.thread_id).toBeUndefined();
    expect(topicLookupKeys(event!)).toEqual([]);
    // No topic context: the answer's reply target is the message itself.
    expect(topicRootMessageId(event!)).toBe("om_x100b63daf2195ca50cad751bd94e261");
  });

  test("a payload the shared schema rejects is dropped, not guessed at", () => {
    expect(toLarkMessageEvent(normalized({ senderId: "" }))).toBeNull();
  });
});

describe("comment events become triggers", () => {
  test("the real notice yields the thread identity and the gate flag", () => {
    const trigger = toCommentTrigger(commentEvent());
    expect(trigger).toEqual({
      fileToken: "EWvsdouioonNMSxlY95m4uIly9w",
      fileType: "docx",
      commentId: "7696351432357728318",
      replyId: "7696351432374521914",
      operatorOpenId: "ou_0a7dd0893c0d537a23f8dca52175b83b",
      mentionedBot: false,
      fromAgent: false,
      eventId: "c0bd64c73ade4e419dc28525cf8ccbfa",
    });
  });

  test("a notice the platform marks agent-originated says so", () => {
    const trigger = toCommentTrigger(
      commentEvent({
        raw: { ...RAW_COMMENT, notice_meta: { ...RAW_COMMENT.notice_meta, is_from_agent: true } },
      }),
    );
    expect(trigger?.fromAgent).toBe(true);
    expect(toCommentTrigger(commentEvent())?.fromAgent).toBe(false);
  });

  test("without a file token there is no thread to bind", () => {
    expect(toCommentTrigger(commentEvent({ fileToken: "" }))).toBeNull();
    expect(toCommentTrigger(commentEvent({ commentId: "" }))).toBeNull();
  });

  test("the trigger id falls back to the thread identity", () => {
    const trigger = toCommentTrigger(commentEvent({ raw: undefined }));
    expect(trigger?.eventId).toBe("EWvsdouioonNMSxlY95m4uIly9w:7696351432357728318");
  });
});
