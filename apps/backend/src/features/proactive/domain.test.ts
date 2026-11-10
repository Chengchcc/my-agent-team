import { describe, expect, test } from "bun:test";
import type { AmbientRule } from "../agent/agent-config.js";
import { frameAmbientInput, matchAmbientRule } from "./domain.js";

function rule(over: Partial<AmbientRule> = {}): AmbientRule {
  return {
    id: "r1",
    chats: [],
    senders: [],
    keyword: "deploy",
    mode: "record",
    instruction: "",
    ...over,
  };
}

describe("matchAmbientRule — scoping", () => {
  const input = {
    chatId: "oc_chat1",
    senderMemberId: "human:lark:ou_alice",
    text: "deploy failed again",
  };

  test("an unscoped rule matches on keyword alone", () => {
    expect(matchAmbientRule([rule()], input)?.id).toBe("r1");
  });

  test("a chat-scoped rule stays silent in other chats", () => {
    const scoped = rule({ chats: ["oc_other"] });
    expect(matchAmbientRule([scoped], input)).toBeNull();
  });

  test("a chat-scoped rule fires in its own chat", () => {
    const scoped = rule({ chats: ["oc_chat1"] });
    expect(matchAmbientRule([scoped], input)?.id).toBe("r1");
  });

  test("a sender-scoped rule accepts the open_id behind the member label", () => {
    // Config vocabulary is the open_id (like allowed_senders); the observe
    // seam carries the `human:lark:<open_id>` member label. Matching must
    // bridge the prefix, or every sender-scoped rule is dead on arrival.
    const scoped = rule({ senders: ["ou_alice"] });
    expect(matchAmbientRule([scoped], input)?.id).toBe("r1");
  });

  test("a sender-scoped rule also accepts the full member label", () => {
    const scoped = rule({ senders: ["human:lark:ou_alice"] });
    expect(matchAmbientRule([scoped], input)?.id).toBe("r1");
  });

  test("a sender-scoped rule stays silent for someone else", () => {
    const scoped = rule({ senders: ["ou_bob"] });
    expect(matchAmbientRule([scoped], input)).toBeNull();
  });

  test("first match wins: a narrow rule listed first beats a broad one", () => {
    const narrow = rule({ id: "narrow", keyword: "deploy failed" });
    const broad = rule({ id: "broad", keyword: "deploy" });
    expect(matchAmbientRule([narrow, broad], input)?.id).toBe("narrow");
    expect(matchAmbientRule([broad, narrow], input)?.id).toBe("broad");
  });

  test("keyword matching is case-insensitive on both sides", () => {
    expect(matchAmbientRule([rule({ keyword: "DEPLOY" })], input)?.id).toBe("r1");
    expect(matchAmbientRule([rule()], { ...input, text: "DEPLOY failed" })?.id).toBe("r1");
  });

  test("no rules, no match, no surprise", () => {
    expect(matchAmbientRule([], input)).toBeNull();
    expect(matchAmbientRule([rule({ keyword: "nothing-like-this" })], input)).toBeNull();
  });
});

describe("frameAmbientInput", () => {
  test("the agent sees the instruction AND the verbatim message", () => {
    const framed = frameAmbientInput(
      rule({ id: "alarm", mode: "act", instruction: "去查部署失败的原因并回报" }),
      "deploy failed again",
    );
    expect(framed).toContain("去查部署失败的原因并回报");
    expect(framed).toContain("deploy failed again");
    expect(framed).toContain("alarm");
  });
});
