import type { Database } from "bun:sqlite";
import { getAllRunStreams } from "./bindings-sqlite.js";

export interface LarkBotHealth {
  agentId: string;
  profileRef: string;
  status: "running" | "degraded" | "error";
  watchers: { conversation: number; runDelta: number };
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
  db: Database,
  watcherCounts: { conversation: number; runDelta: number },
  lastError: string | null,
): LarkBotHealth {
  const allStreams = getAllRunStreams(db);
  const runStreams = {
    starting: 0,
    streaming: 0,
    done: 0,
    error: 0,
    fallbackText: 0,
    cardSendFailed: 0,
    cardUpdateFailed: 0,
  };

  for (const s of allStreams) {
    if (s.status === "starting") runStreams.starting++;
    else if (s.status === "streaming") runStreams.streaming++;
    else if (s.status === "done") runStreams.done++;
    else if (s.status === "error") runStreams.error++;
    else if (s.status === "fallback_text") runStreams.fallbackText++;
    if (s.cardSendFailed) runStreams.cardSendFailed++;
    if (s.cardUpdateFailed) runStreams.cardUpdateFailed++;
  }

  const degraded =
    runStreams.cardSendFailed > 0 ||
    runStreams.cardUpdateFailed > 0 ||
    lastError !== null;
  const hasError = runStreams.error > 0;

  return {
    agentId,
    profileRef,
    status: hasError ? "error" : degraded ? "degraded" : "running",
    watchers: watcherCounts,
    runStreams,
    lastError,
    ts: Date.now(),
  };
}

export async function postHeartbeat(
  health: LarkBotHealth,
  backendUrl: string,
  backendAuthToken: string | null,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backendAuthToken) headers["x-auth-token"] = backendAuthToken;

  try {
    const res = await fetch(
      `${backendUrl}/api/internal/surfaces/lark/heartbeat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(health),
      },
    );
    if (!res.ok) {
      console.error(`[lark-bot] heartbeat POST failed: ${res.status}`);
    }
  } catch (err) {
    console.error(
      `[lark-bot] heartbeat POST error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
