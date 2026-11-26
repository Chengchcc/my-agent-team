/** What the Channels page may say about one PA's Lark bot. Four facts, each
 *  read from its own source and none inferred from another: the configuration
 *  (the agent's `lark` block), the deployment (nothing in the product reports
 *  it), the process (the provisioner's registry status) and the connection
 *  (the surface view and its heartbeat). Pure: rows in, facts out. */
import { connectionStatus, type StatusLook } from "@/lib/status";

/** The agent fields the page reads. A structural subset of the agent's `lark` block. */
export interface ChannelConfig {
  readonly enabled: boolean;
  readonly appId: string | null;
  readonly profileRef: string | null;
  /** The provisioner's word about the process: `not_configured`, `configured`,
   *  `running`, `degraded` or `error`. */
  readonly status: string;
}

/** The surface view's fields the page reads (`GET /api/agents/:id/lark`). */
export interface ChannelSurface {
  readonly status: string;
  readonly setup: { readonly issue: { readonly code: string } | null };
  readonly health: {
    readonly lastSeenAt: number | null;
    readonly lastError: string | null;
  };
  readonly actions: { readonly canStartSetup: boolean };
}

/** The process, as the registry reports it. `configured` means enabled with an
 *  app, and no process state exposed: that is "not reported", never "running". */
export function runningLook(registryStatus: string): StatusLook {
  switch (registryStatus) {
    case "running":
      return { label: "running", shape: "●", tone: "live" };
    case "degraded":
      return { label: "needs attention", shape: "◐", tone: "warn" };
    case "error":
      return { label: "failed", shape: "×", tone: "err" };
    case "configured":
      return { label: "not reported", shape: "○", tone: "muted" };
    default:
      return { label: "off", shape: "○", tone: "muted" };
  }
}

/** The connection, as the surface view reports it. A bot that was never
 *  connected is not a failure to connect, so it reads in the neutral tone. */
export function connectionLook(surface: ChannelSurface | null): StatusLook {
  if (surface === null) return { label: "not available", shape: "○", tone: "muted" };
  switch (surface.status) {
    case "online":
      return connectionStatus("open");
    case "starting":
      return connectionStatus("connecting");
    case "not_connected":
      return { label: "not connected", shape: "○", tone: "muted" };
    default:
      return connectionStatus(surface.status);
  }
}

/** The switch the person set, and nothing else: an enabled switch does not
 *  mean the bot is up. */
export function configurationLook(config: ChannelConfig): StatusLook {
  if (!config.enabled) return { label: "disabled", shape: "○", tone: "muted" };
  return { label: "enabled", shape: "●", tone: "ok" };
}

/** Whether an app or a credential profile stands behind the switch. */
export function hasApp(config: ChannelConfig): boolean {
  const app = config.appId !== null && config.appId !== "";
  const profile = config.profileRef !== null && config.profileRef !== "";
  return app || profile;
}

export interface ChannelActions {
  /** Turning a bot on needs an app behind the switch. It does not need a stored
   *  profile: the backend writes `agent:<id>` when a PA is first enabled. */
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  /** The setup wizard can start: no session is waiting, and the bot is not online. */
  readonly canSetUp: boolean;
}

export function channelActions(
  config: ChannelConfig,
  surface: ChannelSurface | null,
): ChannelActions {
  // A bot with no app behind it can only come up in the error state, so the
  // switch is offered once an app or a profile stands behind it.
  const ready = hasApp(config);
  const enabled = config.enabled;
  const online = surface !== null && surface.status === "online";
  const allowed = surface?.actions.canStartSetup === true;
  return {
    canEnable: !enabled && ready,
    canDisable: enabled,
    canSetUp: allowed && !online,
  };
}

// ─── Add-bot form helpers (mirroring apps/backend/src/features/lark-bot/setup-guidance.ts) ───

export type LarkBrand = "feishu" | "lark";
export type LarkAccessMode = "everyone" | "selected" | "nobody";
export type LarkGroupPolicy = "disabled" | "open" | "allowlist";

export const LARK_REQUIRED_EVENTS = [
  "im.message.receive_v1",
  "card.action.trigger",
  "drive.notice.comment_add_v1",
] as const;

export const LARK_REQUIRED_SCOPES = [
  "docs:doc",
  "docs:document.comment:read",
  "docs:document.comment:create",
  "docs:document.subscription",
  "docs:document.subscription:read",
  "docs:event:subscribe",
  "drive:drive",
  "drive:file",
] as const;

/** One-click Feishu/Lark console URL that requests the scopes `apps/lark-bot` needs. */
export function buildLarkScopeApplyUrl(appId: string, brand: LarkBrand): string | null {
  const id = appId.trim();
  if (!id) return null;
  const host = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  return `${host}/page/scope-apply?clientID=${encodeURIComponent(id)}&scopes=${encodeURIComponent(LARK_REQUIRED_SCOPES.join(","))}`;
}

/** Convert UI DM access selection into the `agent.yml` `lark.allowed_senders` list. */
export function parseAllowedSenders(accessMode: LarkAccessMode, sendersText: string): string[] {
  if (accessMode === "everyone") return ["*"];
  if (accessMode === "nobody") return [];
  return sendersText
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Assemble the exact `lark` body consumed by POST /api/agents and PATCH /api/agents/:id. */
export function buildLarkBotPayload(input: {
  enabled: boolean;
  brand: LarkBrand;
  appId?: string;
  appSecret?: string;
  botDisplayName: string;
  webUrl: string;
  accessMode: LarkAccessMode;
  sendersText: string;
  groupPolicy: LarkGroupPolicy;
  requireMention: boolean;
  respondToMentionAll: boolean;
}) {
  const appId = input.appId?.trim();
  const appSecret = input.appSecret?.trim();
  const botDisplayName = input.botDisplayName.trim();
  const webUrl = input.webUrl.trim();
  return {
    enabled: input.enabled,
    ...(input.enabled && appId && appSecret ? { brand: input.brand, appId, appSecret } : {}),
    ...(botDisplayName ? { botDisplayName } : {}),
    ...(webUrl ? { webUrl } : {}),
    allowedSenders: parseAllowedSenders(input.accessMode, input.sendersText),
    groupPolicy: input.groupPolicy,
    requireMention: input.requireMention,
    respondToMentionAll: input.respondToMentionAll,
  };
}
