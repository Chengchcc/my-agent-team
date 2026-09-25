import { describe, expect, test } from "bun:test";
import {
  type BuildLarkSurfaceInput,
  buildLarkSurfaceView,
  type LarkSurfaceConfig,
  type LarkSurfaceRuntime,
} from "./lark-surface.js";

const NOW = 1_800_000_000_000;

function config(over: Partial<LarkSurfaceConfig> = {}): LarkSurfaceConfig {
  return {
    enabled: false,
    appId: null,
    profileRef: null,
    botDisplayName: null,
    allowedSenders: [],
    ...over,
  };
}

function runtime(over: Partial<LarkSurfaceRuntime> = {}): LarkSurfaceRuntime {
  return { setupAvailable: true, lastSeenAt: null, lastError: null, ...over };
}

function build(over: Partial<BuildLarkSurfaceInput> = {}) {
  return buildLarkSurfaceView({
    config: config(),
    runtime: runtime(),
    setup: null,
    now: NOW,
    ...over,
  });
}

describe("buildLarkSurfaceView status ladder", () => {
  test("a disabled agent is simply not connected", () => {
    expect(build().status).toBe("not_connected");
  });

  test("a pending setup session is authorizing, not not_connected", () => {
    const view = build({
      setup: { id: "s1", status: "pending", expiresAt: NOW + 60_000 },
    });
    expect(view.status).toBe("authorizing");
    expect(view.setup.id).toBe("s1");
  });

  test("authorized with a fresh heartbeat is online", () => {
    const view = build({
      config: config({ enabled: true, profileRef: "agent:1", botDisplayName: "bot" }),
      runtime: runtime({ registryStatus: "configured", lastSeenAt: NOW - 10_000 }),
    });
    expect(view.status).toBe("online");
    expect(view.setup.issue).toBeNull();
  });

  test("prod cannot report online from the registry alone — heartbeat decides", () => {
    // ProdLarkBotRegistry answers `configured` forever (it resolves, it does
    // not supervise), so a stale heartbeat must not read as running.
    const view = build({
      config: config({ enabled: true, profileRef: "agent:1", botDisplayName: "bot" }),
      runtime: runtime({ registryStatus: "configured", lastSeenAt: NOW - 200_000 }),
    });
    expect(view.status).toBe("starting");
    expect(view.setup.issue?.code).toBe("surface_offline");
  });

  test("a stale heartbeat with no bot name blames the name, not the surface", () => {
    const view = build({
      config: config({ enabled: true, profileRef: "agent:1" }),
      runtime: runtime({ registryStatus: "configured", lastSeenAt: null }),
    });
    expect(view.setup.issue?.code).toBe("bot_name_missing");
    expect(view.groupMention.ready).toBe(false);
    expect(view.groupMention.reason).not.toBeNull();
  });

  test("a bot-reported error degrades; a registry error is error", () => {
    const enabled = config({ enabled: true, profileRef: "agent:1", botDisplayName: "bot" });
    const degraded = build({
      config: enabled,
      runtime: runtime({ lastSeenAt: NOW - 1_000, lastError: "no heartbeat" }),
    });
    expect(degraded.status).toBe("degraded");
    expect(degraded.health.lastError).toBe("no heartbeat");
    const errored = build({
      config: enabled,
      runtime: runtime({ registryStatus: "error", lastSeenAt: NOW - 1_000 }),
    });
    expect(errored.status).toBe("error");
  });
});

describe("buildLarkSurfaceView access + actions", () => {
  test("an empty allowlist is a LOCKED surface, and only the wildcard is everyone", () => {
    // The ingest denies an empty list (`matchesAllowlist`: empty -> false).
    // Reporting it as "everyone" made the view lie about a surface nobody can
    // reach - the test used to pin that lie.
    const locked = build({ config: config({ allowedSenders: [] }) });
    expect(locked.access.mode).toBe("allowlist");
    expect(locked.access.users).toEqual([]);

    const open = build({ config: config({ allowedSenders: ["*"] }) });
    expect(open.access.mode).toBe("everyone");
    // The wildcard is a rule, not a person.
    expect(open.access.users).toEqual([]);
  });

  test("group @ readiness names the missing half, or says groups are off", () => {
    const named = build({
      config: config({
        enabled: true,
        profileRef: "agent:1",
        botDisplayName: "bot",
        groupPolicy: "open",
      }),
    });
    expect(named.groupMention).toEqual({ enabled: true, ready: true, reason: null });

    const unnamed = build({ config: config({ groupPolicy: "open" }) });
    expect(unnamed.groupMention.enabled).toBe(true);
    expect(unnamed.groupMention.ready).toBe(false);
    expect(unnamed.groupMention.reason).toContain("名称");

    const p2pOnly = build({ config: config({ botDisplayName: "bot", groupPolicy: "disabled" }) });
    expect(p2pOnly.groupMention.enabled).toBe(false);
    expect(p2pOnly.groupMention.reason).toContain("私聊");
  });

  test("the brand comes from the session when it knows one", () => {
    const session = build({
      setup: { id: "s1", status: "pending", expiresAt: NOW + 1_000, brand: "lark" },
    });
    expect(session.brand).toBe("lark");
    const unknown = build({});
    expect(unknown.brand).toBe("feishu");
  });

  test("a populated allowlist is an allowlist", () => {
    const view = build({ config: config({ allowedSenders: ["ou_1", "ou_2"] }) });
    expect(view.access.mode).toBe("allowlist");
    expect(view.access.users.map((u) => u.openId)).toEqual(["ou_1", "ou_2"]);
  });

  test("actions never offer what the deployment cannot do", () => {
    const noCli = build({ runtime: runtime({ setupAvailable: false }) });
    expect(noCli.actions.canStartSetup).toBe(false);
    expect(noCli.actions.canReplaceApp).toBe(false);
    expect(noCli.setup.issue?.code).toBe("cli_missing");

    const pending = build({ setup: { id: "s1", status: "pending", expiresAt: NOW + 1_000 } });
    expect(pending.actions.canStartSetup).toBe(false);

    const online = build({
      config: config({ enabled: true, profileRef: "agent:1", botDisplayName: "bot" }),
      runtime: runtime({ lastSeenAt: NOW }),
    });
    // Only what has an entry point: enable/disable exists (PATCH), restart is
    // that same toggle composed, app-replacement has none.
    expect(online.actions).toEqual({
      canStartSetup: true,
      canDisable: true,
      canRestart: true,
      canReplaceApp: false,
    });
  });

  test("an expired session is reported as an issue with a restart action", () => {
    const view = build({ setup: { id: "s1", status: "expired", expiresAt: NOW - 1_000 } });
    expect(view.setup.status).toBe("expired");
    expect(view.setup.issue).toEqual({
      code: "setup_expired",
      title: "授权链接已失效",
      action: "restart_setup",
    });
  });

  test("enabled without a profile is an invalid authorization", () => {
    const view = build({ config: config({ enabled: true, appId: "cli_x" }) });
    expect(view.setup.issue?.code).toBe("profile_invalid");
    expect(view.status).toBe("not_connected");
  });
});
