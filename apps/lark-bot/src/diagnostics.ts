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
  ts: number;
}

export function collectHealth(
  agentId: string,
  profileRef: string,
  watcherCounts: { conversation: number; runDelta: number },
  lastError: string | null,
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
    ts: Date.now(),
  };
}

import { createClient } from "./client.js";

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
      payload: {
        profileRef: health.profileRef,
        watchers: health.watchers,
        runStreams: health.runStreams,
        ts: health.ts,
      },
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
