import { describe, expect, test } from "bun:test";
import { chatNameOf, chatsNeedingName, rememberChatName } from "./chat-names";

describe("chat name cache", () => {
  test("names are looked up once and then served from the cache", () => {
    expect(chatNameOf("oc_a")).toBeNull();
    expect(chatsNeedingName(["oc_a"])).toEqual(["oc_a"]);
    rememberChatName("oc_a", "Release crew");
    expect(chatNameOf("oc_a")).toBe("Release crew");
    expect(chatsNeedingName(["oc_a"])).toEqual([]);
  });

  test("a failed lookup is cached too, so the beat does not retry it forever", () => {
    rememberChatName("oc_b", null);
    expect(chatNameOf("oc_b")).toBeNull();
    expect(chatsNeedingName(["oc_b"])).toEqual([]);
  });
});
