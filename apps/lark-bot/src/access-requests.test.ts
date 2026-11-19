import { describe, expect, test } from "bun:test";
import {
  ownerDecidedText,
  ownerNoticeText,
  parseOwnerCommand,
  requesterPendingText,
} from "./access-requests.js";

describe("owner access commands (ADR 0067)", () => {
  test("approve and deny carry the open_id", () => {
    expect(parseOwnerCommand("/approve ou_abc123")).toEqual({
      kind: "approve",
      openId: "ou_abc123",
    });
    expect(parseOwnerCommand("/deny ou_abc123")).toEqual({ kind: "deny", openId: "ou_abc123" });
    // Phones add spaces and capitals.
    expect(parseOwnerCommand("  /APPROVE   ou_abc123  ")).toEqual({
      kind: "approve",
      openId: "ou_abc123",
    });
  });

  test("a sentence containing a command is not a command", () => {
    // The operator talking to the agent must never be read as a grant.
    expect(parseOwnerCommand("请 /approve ou_abc123 一下")).toBeNull();
    expect(parseOwnerCommand("/approve")).toBeNull();
    expect(parseOwnerCommand("/approve ou_abc123 extra")).toBeNull();
  });

  test("a malformed open_id is rejected instead of written into the allowlist", () => {
    // An id that cannot match a real sender would sit in the list forever.
    expect(parseOwnerCommand("/approve someone")).toBeNull();
    expect(parseOwnerCommand("/approve ou_")).toBeNull();
  });
});

describe("the texts both sides see", () => {
  test("the requester learns they are waiting, not ignored", () => {
    expect(requesterPendingText()).toContain("申请");
  });

  test("the operator's notice carries the exact reply to send", () => {
    const text = ownerNoticeText({ displayName: "Ada", openId: "ou_x", created: true });
    expect(text).toContain("/approve ou_x");
    expect(text).toContain("/deny ou_x");
    expect(text).toContain("Ada");
    // A repeat while pending says so instead of pretending it is new.
    expect(ownerNoticeText({ displayName: "Ada", openId: "ou_x", created: false })).toContain(
      "等待",
    );
  });

  test("the operator's confirmation names what happened", () => {
    expect(ownerDecidedText({ openId: "ou_x", approve: true })).toContain("批准");
    expect(ownerDecidedText({ openId: "ou_x", approve: false })).toContain("拒绝");
  });
});
