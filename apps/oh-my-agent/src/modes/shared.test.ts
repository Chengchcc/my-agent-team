import { describe, expect, test } from "bun:test";
import { seedTranscript } from "./shared.js";

describe("seedTranscript (resume run seed)", () => {
  const u = (text: string) => ({ role: "user", text });
  const a = (text: string) => ({ role: "assistant", text });

  test("a trailing unanswered user run is dropped from the seed", () => {
    // The audit shape: [..., assistant, user "继续"] — the user typed, then
    // quit before any assistant persist. Seeding it would replay a ghost
    // instruction ahead of the user's next input.
    const seed = seedTranscript([u("first"), a("answer"), u("继续")]);
    expect(seed?.map((e) => e.message.role)).toEqual(["user", "assistant"]);
    // Entry ids stay dense over the dropped tail (they index the SEED, not
    // the file).
    expect(seed?.map((e) => e.productEntryId)).toEqual(["session:0", "session:1"]);
  });

  test("a whole trailing run of user messages is dropped", () => {
    const seed = seedTranscript([a("answer"), u("a"), u("b")]);
    expect(seed?.map((e) => e.message.role)).toEqual(["assistant"]);
  });

  test("an answered tail is kept verbatim", () => {
    const seed = seedTranscript([u("q"), a("a")]);
    expect(seed?.map((e) => e.message.role)).toEqual(["user", "assistant"]);
    expect(seed?.[1]?.message.text).toBe("a");
  });

  test("a transcript that is ONLY unanswered user messages seeds nothing", () => {
    expect(seedTranscript([u("hello")])).toBeUndefined();
    expect(seedTranscript([])).toBeUndefined();
  });
});
