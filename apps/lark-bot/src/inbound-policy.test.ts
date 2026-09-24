import { describe, expect, test } from "bun:test";
import {
  decideInbound,
  type LarkAccessConfig,
  matchesAllowlist,
  resolveGroupPolicy,
} from "./inbound-policy.js";

const cfg = (over: Partial<LarkAccessConfig> = {}): LarkAccessConfig => ({
  allowedSenders: [],
  ...over,
});

const group = (over: Partial<Parameters<typeof decideInbound>[0]> = {}) =>
  decideInbound({
    cfg: cfg(),
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_alice",
    mentionedBot: true,
    mentionAll: false,
    chatInUse: false,
    ...over,
  });

describe("matchesAllowlist", () => {
  test("an empty list denies — the flip that made 'nobody' expressible", () => {
    expect(matchesAllowlist([], "ou_alice")).toBe(false);
  });

  test("the wildcard grants everyone, explicitly", () => {
    expect(matchesAllowlist(["*"], "ou_anyone")).toBe(true);
  });

  test("ids match case-insensitively and ignore padding", () => {
    expect(matchesAllowlist([" OU_Alice "], "ou_alice")).toBe(true);
    expect(matchesAllowlist(["ou_bob"], "ou_alice")).toBe(false);
  });
});

describe("resolveGroupPolicy", () => {
  test("an explicit entry wins over the default", () => {
    const c = cfg({ groupPolicy: "open", groups: { oc_1: { policy: "disabled" } } });
    expect(resolveGroupPolicy(c, "oc_1").policy).toBe("disabled");
  });

  test("a chat with no entry falls back to the default", () => {
    expect(resolveGroupPolicy(cfg({ groupPolicy: "allowlist" }), "oc_x").policy).toBe("allowlist");
  });

  test("no default means disabled", () => {
    expect(resolveGroupPolicy(cfg(), "oc_x").policy).toBe("disabled");
  });

  test("an entry's allowlist defaults to the agent's", () => {
    const c = cfg({ allowedSenders: ["ou_owner"], groups: { oc_1: { policy: "allowlist" } } });
    expect(resolveGroupPolicy(c, "oc_1").allowFrom).toEqual(["ou_owner"]);
  });
});

describe("decideInbound — DMs", () => {
  test("a listed sender may drive the agent", () => {
    const d = decideInbound({
      cfg: cfg({ allowedSenders: ["ou_alice"] }),
      chatId: "oc_dm",
      chatType: "p2p",
      senderId: "ou_alice",
      mentionedBot: false,
      mentionAll: false,
      chatInUse: true,
    });
    expect(d).toEqual({ outcome: "answer", reason: "dm_allowed" });
  });

  test("an empty allowlist denies DMs instead of admitting everyone", () => {
    const d = decideInbound({
      cfg: cfg(),
      chatId: "oc_dm",
      chatType: "p2p",
      senderId: "ou_alice",
      mentionedBot: false,
      mentionAll: false,
      chatInUse: true,
    });
    expect(d.outcome).toBe("skip");
    expect(d.reason).toBe("dm_denied");
  });
});

describe("decideInbound — groups (L1 admission)", () => {
  test("a brand-new group with no entry and no default is not answered", () => {
    // The point of the default: being pulled into a group should not by
    // itself make the agent answer anyone who @s it.
    expect(group()).toEqual({ outcome: "skip", reason: "group_not_admitted" });
  });

  test("a group already in use keeps working after the default tightened", () => {
    expect(group({ chatInUse: true })).toEqual({ outcome: "answer", reason: "allowed" });
  });

  test("an explicit open entry admits a group even if it is new", () => {
    expect(group({ cfg: cfg({ groups: { oc_1: { policy: "open" } } }) })).toEqual({
      outcome: "answer",
      reason: "allowed",
    });
  });

  test("an explicit disabled entry beats the in-use carve-out", () => {
    const d = group({ cfg: cfg({ groups: { oc_1: { policy: "disabled" } } }), chatInUse: true });
    expect(d).toEqual({ outcome: "skip", reason: "group_not_admitted" });
  });

  test("group_policy open admits every group, bound or not", () => {
    expect(group({ cfg: cfg({ groupPolicy: "open" }) }).outcome).toBe("answer");
  });
});

describe("decideInbound — groups (L2 sender)", () => {
  test("allowlist mode rejects a sender who is not listed", () => {
    const d = group({ cfg: cfg({ groupPolicy: "allowlist", allowedSenders: ["ou_bob"] }) });
    expect(d).toEqual({ outcome: "skip", reason: "group_sender_denied" });
  });

  test("an entry can narrow a group below the agent default", () => {
    const d = group({
      cfg: cfg({
        allowedSenders: ["*"],
        groups: { oc_1: { policy: "allowlist", allowedSenders: ["ou_bob"] } },
      }),
    });
    expect(d.reason).toBe("group_sender_denied");
  });

  test("allowlist mode passes a listed sender through to the mention check", () => {
    const d = group({
      cfg: cfg({ groupPolicy: "allowlist", allowedSenders: ["ou_alice"] }),
      mentionedBot: false,
    });
    expect(d.reason).toBe("no_mention");
  });
});

describe("decideInbound — groups (L3 mention)", () => {
  const admitted = cfg({ groupPolicy: "open" });

  test("a message that did not address the bot is observed, not dropped", () => {
    // Recorded into the conversation so the agent has context, but not
    // answered: the same reply/history split openclaw makes.
    const d = group({ cfg: admitted, mentionedBot: false });
    expect(d.outcome).toBe("observe");
    expect(d.reason).toBe("no_mention");
  });

  test("require_mention can be turned off per agent", () => {
    const d = group({ cfg: { ...admitted, requireMention: false }, mentionedBot: false });
    expect(d.outcome).toBe("answer");
  });

  test("@everyone does not address the bot by default", () => {
    const d = group({ cfg: admitted, mentionedBot: false, mentionAll: true });
    expect(d.outcome).toBe("observe");
    expect(d.reason).toBe("no_mention");
  });

  test("@everyone counts only when explicitly opted in", () => {
    const d = group({
      cfg: { ...admitted, respondToMentionAll: true },
      mentionedBot: false,
      mentionAll: true,
    });
    expect(d.outcome).toBe("answer");
  });

  test("@everyone does not bypass a group that was not admitted", () => {
    // Order matters: the admission layers run before the mention layers, so
    // an opt-in for @all cannot open a chat that is closed.
    const d = group({
      cfg: cfg({ respondToMentionAll: true }),
      mentionAll: true,
      mentionedBot: false,
    });
    expect(d.reason).toBe("group_not_admitted");
  });
});
