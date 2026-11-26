import { describe, expect, test } from "bun:test";
import {
  buildLarkBotPayload,
  buildLarkScopeApplyUrl,
  type ChannelConfig,
  type ChannelSurface,
  channelActions,
  configurationLook,
  connectionLook,
  hasApp,
  parseAllowedSenders,
  runningLook,
} from "./channel-facts";

const OFF: ChannelConfig = {
  enabled: true,
  appId: "cli_app",
  profileRef: "agent:default",
  status: "not_configured",
};

function surface(status: string, actions: { canStartSetup?: boolean } = {}): ChannelSurface {
  return {
    status,
    setup: { issue: null },
    health: { lastSeenAt: null, lastError: null },
    actions: { canStartSetup: actions.canStartSetup ?? true },
  };
}

describe("runningLook", () => {
  test("says what the registry says, and no more", () => {
    expect(runningLook("running")).toMatchObject({ label: "running", tone: "live" });
    expect(runningLook("degraded")).toMatchObject({ tone: "warn" });
    expect(runningLook("error")).toMatchObject({ tone: "err" });
    // Enabled with an app, but no process state: not a claim that it runs.
    expect(runningLook("configured")).toMatchObject({ label: "not reported", tone: "muted" });
    expect(runningLook("not_configured")).toMatchObject({ label: "off", tone: "muted" });
  });
});

describe("connectionLook", () => {
  test("the surface view's states, in the status vocabulary", () => {
    expect(connectionLook(surface("online"))).toMatchObject({ label: "connected", tone: "ok" });
    expect(connectionLook(surface("starting"))).toMatchObject({ label: "connecting" });
    expect(connectionLook(surface("authorizing"))).toMatchObject({ label: "authorizing" });
    expect(connectionLook(surface("degraded"))).toMatchObject({ tone: "warn" });
    expect(connectionLook(surface("error"))).toMatchObject({ tone: "err" });
  });

  test("never connected is not a failure; no view is not available", () => {
    expect(connectionLook(surface("not_connected"))).toMatchObject({ tone: "muted" });
    expect(connectionLook(null)).toMatchObject({ label: "not available" });
  });
});

describe("configuration and actions", () => {
  test("the switch is its own fact", () => {
    expect(configurationLook(OFF)).toMatchObject({ label: "enabled" });
    expect(configurationLook({ ...OFF, enabled: false })).toMatchObject({
      label: "disabled",
      tone: "muted",
    });
    expect(hasApp(OFF)).toBeTruthy();
    expect(hasApp({ ...OFF, appId: null, profileRef: "" })).toBeFalsy();
  });

  test("enable needs an app; disable needs the switch on; setup needs the surface's leave", () => {
    const disabled = { ...OFF, enabled: false };
    expect(channelActions(disabled, surface("not_connected"))).toEqual({
      canEnable: true,
      canDisable: false,
      canSetUp: true,
    });
    // A PA that was never enabled has no stored profile yet: the backend
    // writes one when the switch is turned on, so the app is what matters.
    expect(
      channelActions({ ...disabled, profileRef: null }, surface("not_connected")).canEnable,
    ).toBeTruthy();
    const noProfile = { ...disabled, profileRef: null, appId: null };
    expect(channelActions(noProfile, surface("not_connected"))).toEqual({
      canEnable: false,
      canDisable: false,
      canSetUp: true,
    });
    expect(channelActions(OFF, surface("online")).canDisable).toBeTruthy();
    expect(channelActions(OFF, surface("online")).canSetUp).toBeFalsy();
    expect(
      channelActions(OFF, surface("not_connected", { canStartSetup: false })).canSetUp,
    ).toBeFalsy();
    expect(channelActions(disabled, null).canSetUp).toBeFalsy();
  });
});

describe("lark-bot setup payload helpers", () => {
  test("buildLarkScopeApplyUrl selects feishu vs lark host and omits empty appId", () => {
    expect(buildLarkScopeApplyUrl("  ", "feishu")).toBeNull();
    expect(buildLarkScopeApplyUrl("cli_123", "feishu")).toContain(
      "https://open.feishu.cn/page/scope-apply?clientID=cli_123&scopes=",
    );
    expect(buildLarkScopeApplyUrl("cli_456", "lark")).toContain(
      "https://open.larksuite.com/page/scope-apply?clientID=cli_456&scopes=",
    );
  });

  test("parseAllowedSenders preserves explicit wildcard vs deny-all semantics", () => {
    expect(parseAllowedSenders("everyone", "ou_1")).toEqual(["*"]);
    expect(parseAllowedSenders("nobody", "ou_1")).toEqual([]);
    expect(parseAllowedSenders("selected", "ou_1, ou_2\nou_3")).toEqual(["ou_1", "ou_2", "ou_3"]);
  });

  test("buildLarkBotPayload attaches credentials and brand only when enabled with appId+appSecret", () => {
    const direct = buildLarkBotPayload({
      enabled: true,
      brand: "lark",
      appId: " cli_abc ",
      appSecret: " sec_xyz ",
      botDisplayName: " Research Bot ",
      webUrl: " https://ops.example.com ",
      accessMode: "selected",
      sendersText: "ou_1",
      groupPolicy: "allowlist",
      requireMention: true,
      respondToMentionAll: false,
    });
    expect(direct).toEqual({
      enabled: true,
      brand: "lark",
      appId: "cli_abc",
      appSecret: "sec_xyz",
      botDisplayName: "Research Bot",
      webUrl: "https://ops.example.com",
      allowedSenders: ["ou_1"],
      groupPolicy: "allowlist",
      requireMention: true,
      respondToMentionAll: false,
    });

    const qr = buildLarkBotPayload({
      enabled: false,
      brand: "feishu",
      appId: "cli_ignored",
      appSecret: "sec_ignored",
      botDisplayName: "",
      webUrl: "",
      accessMode: "everyone",
      sendersText: "",
      groupPolicy: "disabled",
      requireMention: true,
      respondToMentionAll: false,
    });
    expect(qr).toEqual({
      enabled: false,
      allowedSenders: ["*"],
      groupPolicy: "disabled",
      requireMention: true,
      respondToMentionAll: false,
    });
  });
});
