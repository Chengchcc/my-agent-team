/**
 * The Lark Surface read model (one DTO for the Web connection wizard).
 *
 * The product facts live in four places that used to be read separately:
 * the agent config (`agent.yml` cached in `agents.config`), the setup
 * manager's in-memory session, the bot registry, and the `surface_health`
 * heartbeat table (today reachable only through `/api/ops/*`). The Web
 * needs one answer to "can this agent talk to Lark right now", so this
 * module joins them — it introduces no new domain fact, only a projection.
 *
 * Pure on purpose: the caller gathers the inputs (I/O), this decides.
 */

/** What the USER understands. The internal vocabulary (`not_configured`,
 *  `profile_ref`, `registry`, setup sessions) stays behind this. */
export type LarkSurfaceStatus =
  | "not_connected"
  | "authorizing"
  | "starting"
  | "online"
  | "degraded"
  | "error";

/** How the bot decides whom to answer. `everyone` is the honest name for
 *  the legacy empty `allowed_senders` — the code treated `[]` as "allow all"
 *  (lark-bot ingest), which the UI never said out loud. Naming it makes the
 *  current behaviour visible instead of hiding it behind an empty list. */
export type LarkAccessMode = "owner_only" | "allowlist" | "chat_members" | "everyone";

export type LarkSetupIssueCode =
  | "setup_failed"
  | "cli_missing"
  | "setup_expired"
  | "profile_invalid"
  | "bot_name_missing"
  | "surface_offline";

export interface LarkSetupIssue {
  code: LarkSetupIssueCode;
  title: string;
  action: string;
}

export interface LarkSurfaceView {
  status: LarkSurfaceStatus;
  brand: "feishu" | "lark";
  botDisplayName: string | null;
  access: {
    mode: LarkAccessMode;
    users: Array<{ openId: string; name: string | null }>;
  };
  groupMention: {
    enabled: boolean;
    ready: boolean;
    reason: string | null;
  };
  setup: {
    id: string | null;
    status: "pending" | "completed" | "failed" | "expired" | "cancelled" | null;
    expiresAt: number | null;
    /** The authorization link the CLI printed, when there is one. */
    url: string | null;
    issue: LarkSetupIssue | null;
  };
  health: {
    lastSeenAt: number | null;
    lastError: string | null;
    pendingDeliveries: number;
  };
  actions: {
    canStartSetup: boolean;
    canRestart: boolean;
    canDisable: boolean;
    canReplaceApp: boolean;
  };
}

/** Config half — read from the agent row by the route. */
export interface LarkSurfaceConfig {
  enabled: boolean;
  appId: string | null;
  profileRef: string | null;
  botDisplayName: string | null;
  allowedSenders: readonly string[];
  /** Whether groups are listened to at all (`disabled` = p2p only). */
  groupPolicy?: "open" | "allowlist" | "disabled";
}

/** Runtime half — gathered by the composition root (registry + heartbeat). */
export interface LarkSurfaceRuntime {
  /** Registry status, or undefined when no registry is wired (prod keeps no
   *  process table: it resolves, it does not spawn). */
  registryStatus?: string;
  /** Heartbeat: the only real liveness signal. In prod the registry answers
   *  `configured` forever, so "online" must come from here. */
  lastSeenAt?: number | null;
  lastError?: string | null;
  /** Deliveries the bot is still holding for this agent, when reported. */
  pendingDeliveries?: number;
  /** Whether `POST .../lark/setup` can run in this deployment at all. */
  setupAvailable: boolean;
}

export interface LarkSetupFacts {
  id: string;
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  expiresAt: number;
  /** The brand the session was authorized against, when the manager knows it. */
  brand?: "feishu" | "lark";
  /** Why a failed session failed, for the wizard to show instead of silence. */
  error?: string | null;
  /** The authorization link, once the CLI has printed it. It arrives minutes
   *  after the session starts, so it cannot be carried by the POST response -
   *  a reload would lose it while the session is still live on the server. */
  url?: string | null;
}

export interface BuildLarkSurfaceInput {
  config: LarkSurfaceConfig;
  runtime: LarkSurfaceRuntime;
  setup: LarkSetupFacts | null;
  now: number;
}

/** A heartbeat older than this means the bot is not actually up: the
 *  lark-bot posts every 30s, so three missed beats is a real outage. */
const STALE_HEARTBEAT_MS = 95_000;

export function buildLarkSurfaceView(input: BuildLarkSurfaceInput): LarkSurfaceView {
  const { config, runtime, setup, now } = input;

  const heartbeatFresh =
    runtime.lastSeenAt !== null &&
    runtime.lastSeenAt !== undefined &&
    now - runtime.lastSeenAt < STALE_HEARTBEAT_MS;
  // A bot that is beating is authorized, whatever `profile_ref` says: a bot
  // started with an explicit profile never writes one back to the agent row,
  // and calling that "not connected" is a lie the user can see through.
  const authorized = config.enabled && (config.profileRef !== null || heartbeatFresh);
  const awaitingAuthorization = setup !== null && setup.status === "pending";

  const status = deriveStatus({
    authorized,
    awaitingAuthorization,
    registryStatus: runtime.registryStatus,
    heartbeatFresh,
    lastError: runtime.lastError ?? null,
  });

  const issue = deriveIssue({
    runtime,
    setup,
    config,
    authorized,
    heartbeatFresh,
    status,
    now,
  });

  const groupName = config.botDisplayName;

  const groupsListened = config.groupPolicy !== "disabled";
  const mentionReady = groupsListened && groupName !== null;

  return {
    status,
    // No brand is persisted per agent yet: the provisioner authorizes new
    // sessions against feishu, and a session that knows its brand is the only
    // honest source. Hardcoding "feishu" regardless was a guess.
    brand: setup?.brand ?? "feishu",
    botDisplayName: groupName,
    access: {
      // `matchesAllowlist` (lark-bot inbound-policy) DENIES an empty list, so
      // an empty allowlist is a locked surface, not an open one; only the
      // wildcard grants everyone. This used to say the opposite and the UI
      // believed it.
      mode: config.allowedSenders.includes("*") ? "everyone" : "allowlist",
      users: config.allowedSenders
        .filter((id) => id !== "*")
        .map((openId) => ({ openId, name: null })),
    },
    groupMention: {
      // Group @ needs BOTH a policy that listens in groups and a name that
      // matches the bot's; either one missing is a silent failure, so both
      // are reported instead of asserting "enabled".
      enabled: groupsListened,
      ready: mentionReady,
      reason: groupsListened
        ? groupName === null
          ? "未设置机器人名称，群聊里 @ 不会触发"
          : null
        : "群聊已禁用（group_policy=disabled），只能在私聊使用",
    },
    setup: {
      id: setup?.id ?? null,
      status: setup?.status ?? null,
      expiresAt: setup?.expiresAt ?? null,
      url: setup?.url ?? null,
      issue,
    },
    health: {
      lastSeenAt: runtime.lastSeenAt ?? null,
      lastError: runtime.lastError ?? null,
      pendingDeliveries: runtime.pendingDeliveries ?? 0,
    },
    actions: {
      canStartSetup: runtime.setupAvailable && !awaitingAuthorization,
      // Only actions with a real entry point are advertised: `enabled: false`
      // via PATCH stops the bot, but there is no restart endpoint and no HTTP
      // path that accepts an appId/appSecret pair (`larkProfileInit` is
      // internal). Promising them made the DTO a wish list.
      canDisable: authorized,
      // Restart is a COMPOSED capability here: toggling `enabled` off then on
      // runs the same stop/start lifecycle the registry owns, so it is real.
      canRestart: authorized,
      // Replacing the bot's app has no HTTP entry point yet (`larkProfileInit`
      // is internal and the settings route refuses secret-shaped keys).
      canReplaceApp: false,
    },
  };
}

function deriveStatus(input: {
  authorized: boolean;
  awaitingAuthorization: boolean;
  registryStatus?: string;
  heartbeatFresh: boolean;
  lastError: string | null;
}): LarkSurfaceStatus {
  if (!input.authorized) {
    // An in-flight setup session is the only reason "未连接" is not the
    // whole truth: the user is mid-authorization.
    return input.awaitingAuthorization ? "authorizing" : "not_connected";
  }
  if (input.registryStatus === "error") return "error";
  if (input.lastError !== null) return "degraded";
  if (input.heartbeatFresh) return "online";
  // Authorized but no fresh beat: the process may still be coming up (the
  // wizard's verify step) or it may be dead. Both are "starting" to the
  // user, and the issue field says which.
  return "starting";
}

function deriveIssue(input: {
  runtime: LarkSurfaceRuntime;
  setup: LarkSetupFacts | null;
  config: LarkSurfaceConfig;
  authorized: boolean;
  heartbeatFresh: boolean;
  status: LarkSurfaceStatus;
  now: number;
}): LarkSetupIssue | null {
  if (input.setup?.status === "expired") {
    return { code: "setup_expired", title: "授权链接已失效", action: "restart_setup" };
  }
  // A failed session used to fall through every branch: the wizard showed
  // "not connected" with no reason at all, which is the one thing a failure
  // must never do.
  if (input.setup?.status === "failed") {
    const reason = input.setup.error?.trim();
    return {
      code: "setup_failed",
      title: reason ? `授权未能完成：${reason.slice(0, 140)}` : "授权未能完成",
      action: "restart_setup",
    };
  }
  if (!input.runtime.setupAvailable) {
    return { code: "cli_missing", title: "未安装 Lark CLI", action: "install_cli" };
  }
  if (input.config.enabled && input.config.profileRef === null && !input.heartbeatFresh) {
    return { code: "profile_invalid", title: "机器人授权失效", action: "reconnect" };
  }
  // Enabled, authorized, but nobody is listening — and only a fresh start
  // fixes it. Distinguish a bot that never came up from a named-but-nameless
  // configuration problem, because the fixes differ.
  if (input.authorized && !input.heartbeatFresh) {
    if (input.config.botDisplayName === null) {
      return { code: "bot_name_missing", title: "未设置群聊机器人名称", action: "set_bot_name" };
    }
    return { code: "surface_offline", title: "机器人尚未上线", action: "restart_surface" };
  }
  return null;
}
