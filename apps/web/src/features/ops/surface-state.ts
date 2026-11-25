/** A surface's connection, as its heartbeat tells it. The lark-bot posts every
 *  30 seconds; the backend treats three missed beats as an outage
 *  (`agent/lark-surface.ts`), and so does this: a row left "running" by a bot
 *  that stopped reporting must not read as connected. */

import { connectionStatus, type StatusLook } from "@/lib/status";

export const STALE_HEARTBEAT_MS = 95_000;

export function surfaceConnection(
  status: string,
  lastSeenAt: number | null,
  now: number,
): StatusLook {
  if (lastSeenAt === null) return { label: "never reported", shape: "○", tone: "muted" };
  if (now - lastSeenAt > STALE_HEARTBEAT_MS) {
    return { label: "disconnected", shape: "×", tone: "err" };
  }
  return connectionStatus(status);
}
