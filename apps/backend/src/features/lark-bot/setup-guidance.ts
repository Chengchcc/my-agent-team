/**
 * ADR 0044 decision 7: swapping the inbound event layer to the official SDK
 * adds three prerequisites that live in the Feishu developer console, not in
 * this repo. Getting any of them wrong looks exactly like "the bot is silent",
 * so the surface has to be able to say what is missing instead of leaving
 * someone to guess.
 *
 * All three were measured on an isolated app on 2026-10-14:
 *  - without the app-level event subscriptions, nothing is ever pushed;
 *  - an app created by `lark-cli config init --new` starts with NO scopes, and
 *    the first API call fails with `99991672 app_scope_not_applied`, whose error
 *    payload carries `missing_scopes` and a ready-made `console_url`.
 */

/** The events this bot needs, by their platform names. Missing any one of them
 *  is silent: no messages, no card clicks, or no comment notices. */
export const LARK_REQUIRED_EVENTS = [
  "im.message.receive_v1",
  "card.action.trigger",
  "drive.notice.comment_add_v1",
] as const;

/** Scopes the comment lane needs (read the thread, answer it, subscribe the
 *  document) plus the document/drive access the rest of the surface uses. */
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

export interface LarkSetupGuidance {
  /** Platform event names to add under 事件与回调 → 事件订阅. */
  events: readonly string[];
  /** Scopes to grant; the URL below is the one-click way. */
  scopes: readonly string[];
  /** The console's scope-apply page for THIS app (open, grant, done). */
  scopeApplyUrl: string | null;
}

/** The one place that knows how those console URLs are shaped. `null` when the
 *  agent has no app id yet — the wizard has not finished, so there is nothing to
 *  point at, and inventing a URL would be worse than saying nothing. */
export function larkSetupGuidance(
  appId: string | null,
  brand: "feishu" | "lark" | string | null,
): LarkSetupGuidance {
  const host = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const scopes = [...LARK_REQUIRED_SCOPES];
  return {
    events: [...LARK_REQUIRED_EVENTS],
    scopes,
    scopeApplyUrl: appId
      ? `${host}/page/scope-apply?clientID=${encodeURIComponent(appId)}&scopes=${encodeURIComponent(scopes.join(","))}`
      : null,
  };
}
