export interface LarkBotHealth {
  agentId: string;
  profileRef: string;
  status: "running" | "degraded" | "error";
  watchers: { conversation: number; runDelta: number };
  /** run_stream table deleted — daemon removed, AgentSession runs in-process. API compat stub. */
  runStreams: {
    starting: number;
    streaming: number;
    done: number;
    error: number;
    fallbackText: number;
    cardSendFailed: number;
    cardUpdateFailed: number;
  };
  lastError: string | null;
  /** Deliveries the bot is still holding (non-terminal `message_delivery`
   *  rows). A flat number so the backend's heartbeat flattener lifts it into
   *  `counters.pendingDeliveries`, which the Lark surface view reads. */
  pendingDeliveries: number;
  ts: number;
}

export function collectHealth(
  agentId: string,
  profileRef: string,
  watcherCounts: { conversation: number; runDelta: number },
  lastError: string | null,
  pendingDeliveries: number,
): LarkBotHealth {
  return {
    agentId,
    profileRef,
    status: lastError ? "degraded" : "running",
    watchers: watcherCounts,
    runStreams: {
      starting: 0,
      streaming: 0,
      done: 0,
      error: 0,
      fallbackText: 0,
      cardSendFailed: 0,
      cardUpdateFailed: 0,
    },
    lastError,
    pendingDeliveries,
    ts: Date.now(),
  };
}

import { createClient } from "./client.js";

/** The heartbeat body's payload: an explicit whitelist.
 *
 *  A field added to `LarkBotHealth` does NOT reach the backend unless it is
 *  listed here — which is exactly how `pendingDeliveries` was silently absent
 *  while the surface view read it as 0. Exported so a test can pin the list
 *  without an HTTP double. The backend flattens top-level numbers into
 *  `counters`, so a scalar here becomes `counters.<name>` there. */
export function heartbeatPayload(health: LarkBotHealth): Record<string, unknown> {
  return {
    profileRef: health.profileRef,
    watchers: health.watchers,
    runStreams: health.runStreams,
    pendingDeliveries: health.pendingDeliveries,
    ts: health.ts,
  };
}

export async function postHeartbeat(
  health: LarkBotHealth,
  backendUrl: string,
  backendAuthToken: string | null,
): Promise<void> {
  const client = createClient(backendUrl, backendAuthToken);

  try {
    const { error } = await client.api.internal.surfaces.lark.heartbeat.post({
      agentId: health.agentId,
      status: health.status,
      payload: heartbeatPayload(health),
      lastError: health.lastError ?? undefined,
    });
    if (error) {
      console.error(`[lark-bot] heartbeat POST failed: ${JSON.stringify(error)}`);
    }
  } catch (err) {
    console.error(
      `[lark-bot] heartbeat POST error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
