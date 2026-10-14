import { describe, expect, test } from "bun:test";
import { LARK_REQUIRED_EVENTS, LARK_REQUIRED_SCOPES, larkSetupGuidance } from "./setup-guidance.js";

describe("console guidance for a freshly created app (ADR 0044)", () => {
  test("names all three events — dropping one silently kills a lane", () => {
    // Measured: with no subscription nothing is pushed at all; the three are
    // messages, card clicks and comment notices, one per inbound path.
    expect([...LARK_REQUIRED_EVENTS]).toEqual([
      "im.message.receive_v1",
      "card.action.trigger",
      "drive.notice.comment_add_v1",
    ]);
  });

  test("builds a scope-apply link that carries the app id and every scope", () => {
    const guidance = larkSetupGuidance("cli_aa4459351974dd2c", "feishu");
    expect(guidance.scopeApplyUrl).toBe(
      `https://open.feishu.cn/page/scope-apply?clientID=cli_aa4459351974dd2c&scopes=${encodeURIComponent(
        [...LARK_REQUIRED_SCOPES].join(","),
      )}`,
    );
    // The comment lane's own scopes must be on the list: subscribing a document
    // and answering a thread are what the feature is.
    const scopes = guidance.scopeApplyUrl ?? "";
    expect(decodeURIComponent(scopes)).toContain("docs:document.subscription");
    expect(decodeURIComponent(scopes)).toContain("docs:document.comment:create");
    expect(decodeURIComponent(scopes)).toContain("docs:event:subscribe");
  });

  test("lark-brand apps point at the larksuite console", () => {
    expect(larkSetupGuidance("cli_x", "lark").scopeApplyUrl).toContain("open.larksuite.com");
  });

  test("no app id yet — no invented URL", () => {
    // The wizard has not finished; a link with an empty clientID would be a
    // dead end that looks like an instruction.
    expect(larkSetupGuidance(null, "feishu").scopeApplyUrl).toBeNull();
    expect(larkSetupGuidance("", "feishu").scopeApplyUrl).toBeNull();
  });
});
