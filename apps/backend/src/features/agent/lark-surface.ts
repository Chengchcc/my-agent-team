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

  const authorized = config.enabled && config.profileRef !== null;
  const heartbeatFresh =
    runtime.lastSeenAt !== null &&
    runtime.lastSeenAt !== undefined &&
    now - runtime.lastSeenAt < STALE_HEARTBEAT_MS;
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

  return {
    status,
    brand: "feishu",
    botDisplayName: groupName,
    access: {
      // Legacy mapping, named in the type so the UI can show it: an empty
      // list meant "allow everyone" in the lark-bot ingest, which the UI
      // never said out loud. Non-empty is a plain allowlist.
      mode: config.allowedSenders.length === 0 ? "everyone" : "allowlist",
      users: config.allowedSenders.map((openId) => ({ openId, name: null })),
    },
    groupMention: {
      // @ detection is always attempted; it can only work with a name, and
      // the failure mode is silent (the bot starts, group @ does nothing).
      enabled: true,
      ready: groupName !== null,
      reason: groupName === null ? "未设置机器人名称，群聊里 @ 不会触发" : null,
    },
    setup: {
      id: setup?.id ?? null,
      status: setup?.status ?? null,
      expiresAt: setup?.expiresAt ?? null,
      issue,
    },
    health: {
      lastSeenAt: runtime.lastSeenAt ?? null,
      lastError: runtime.lastError ?? null,
      pendingDeliveries: runtime.pendingDeliveries ?? 0,
    },
    actions: {
      canStartSetup: runtime.setupAvailable && !awaitingAuthorization,
      canRestart: authorized,
      canDisable: authorized,
      canReplaceApp: runtime.setupAvailable,
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
  if (!input.runtime.setupAvailable) {
    return { code: "cli_missing", title: "未安装 Lark CLI", action: "install_cli" };
  }
  if (input.config.enabled && input.config.profileRef === null) {
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
