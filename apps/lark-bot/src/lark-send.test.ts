import { describe, expect, test } from "bun:test";
import { mentionsThread } from "./lark-send.js";

describe("ADR 0067: a refused thread flag must not cost the message", () => {
  test("the retry triggers only on errors that name the thread", () => {
    // The flag is what a plain group may refuse; any OTHER failure retried
    // would silently send the same message twice.
    expect(mentionsThread("reply_in_thread is not supported in this chat")).toBe(true);
    expect(mentionsThread("该会话不支持话题回复")).toBe(true);
    expect(mentionsThread("invalid param: receive_id")).toBe(false);
    expect(mentionsThread(undefined)).toBe(false);
  });
});
