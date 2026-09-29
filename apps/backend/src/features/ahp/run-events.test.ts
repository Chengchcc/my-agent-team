import { describe, expect, test } from "bun:test";
import { createChatActionTranslator } from "./run-events.js";

describe("run events to chat actions", () => {
  test("the first delta opens its part, later ones only append", () => {
    const translator = createChatActionTranslator();
    const first = translator.translate("run-1", { type: "text_delta", payload: { text: "He" } });
    expect(first.map((a) => String(a.type))).toEqual(["chat/responsePart", "chat/delta"]);
    const second = translator.translate("run-1", { type: "text_delta", payload: { text: "llo" } });
    expect(second.map((a) => String(a.type))).toEqual(["chat/delta"]);
    // Same part id the projection uses, so the streamed part and the final one are one object.
    expect(second[0]).toMatchObject({ partId: "run-1:text:0", content: "llo" });
  });

  test("thinking opens a reasoning part and uses the reasoning action", () => {
    const translator = createChatActionTranslator();
    const actions = translator.translate("run-2", {
      type: "thinking_delta",
      payload: { text: "hmm" },
    });
    expect(actions.map((a) => String(a.type))).toEqual(["chat/responsePart", "chat/reasoning"]);
    expect(actions[0]).toMatchObject({ part: { kind: "reasoning", id: "run-2:reasoning:0" } });
  });

  test("events a chat channel does not carry produce nothing", () => {
    const translator = createChatActionTranslator();
    expect(translator.translate("run-3", { type: "stream_rule_triggered" })).toEqual([]);
    expect(translator.translate("run-3", { type: "text_delta", payload: { text: "" } })).toEqual(
      [],
    );
  });

  test("a dropped run starts fresh instead of appending to its old part", () => {
    const translator = createChatActionTranslator();
    translator.translate("run-4", { type: "text_delta", payload: { text: "a" } });
    translator.drop("run-4");
    const again = translator.translate("run-4", { type: "text_delta", payload: { text: "b" } });
    expect(again.map((a) => String(a.type))).toEqual(["chat/responsePart", "chat/delta"]);
  });
});
