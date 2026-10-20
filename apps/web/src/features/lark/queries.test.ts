import { describe, expect, test } from "bun:test";
import { boundChatsOf } from "./queries";

describe("boundChatsOf", () => {
  test("reads the bot's chat mirror out of the runtime view", () => {
    const chats = boundChatsOf({
      surfaces: {
        lark: {
          chats: [
            {
              chatId: "oc_a",
              chatType: "group",
              chatMode: "mention",
              conversations: 2,
              topicRootMessageId: null,
            },
          ],
        },
      },
    });
    expect(chats).toHaveLength(1);
    expect(chats[0]?.chatId).toBe("oc_a");
    expect(chats[0]?.conversations).toBe(2);
  });

  test("a missing/malformed payload reads as no chats, not a crash", () => {
    expect(boundChatsOf(undefined)).toEqual([]);
    expect(boundChatsOf({})).toEqual([]);
    expect(boundChatsOf({ surfaces: {} })).toEqual([]);
    expect(boundChatsOf({ surfaces: { lark: {} } })).toEqual([]);
    expect(boundChatsOf({ surfaces: { lark: { chats: "nope" } } })).toEqual([]);
    // Rows without a chat id are dropped: rendering an empty key would put an
    // unaddressable chat on the page.
    expect(boundChatsOf({ surfaces: { lark: { chats: [{}, { chatId: "" }, null] } } })).toEqual([]);
  });
});
