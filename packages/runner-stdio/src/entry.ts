import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { AgentEvent } from "@my-agent-team/framework";
import type { createGenericAgent } from "@my-agent-team/harness";
import type { EventSink } from "@my-agent-team/event-log";

export interface EntryIO {
  /** Raw spec JSON string (from process.env.AGENT_SPEC by default) */
  specJson: string;
  /** Write one NDJSON line (event + '\n') */
  writeEvent: (event: AgentEvent) => void;
  /** Write a human-readable trace line to stderr */
  writeStderr: (line: string) => void;
  /** AbortSignal that fires on SIGTERM. Pass-through to agent.run. */
  signal: AbortSignal;
  /** Optional env-key for API key fallback. Defaults to 'ANTHROPIC_API_KEY'. */
  apiKeyEnv?: string;
  /** Injectable agent factory for testing. Defaults to createGenericAgent. */
  createAgent?: typeof createGenericAgent;
  /** Inject a backend-owned Database instance for the sqlite checkpointer. */
  checkpointerDb?: unknown;
  /** M9: EventSink for durable event persistence. Test injects in-memory; production self-builds from spec. */
  eventSink?: EventSink;
  /** M9: Heartbeat interval in ms. Default 5000. */
  heartbeatIntervalMs?: number;
}

/** Returns exit code: 0 = clean, 1 = any failure. */
export async function runEntry(io: EntryIO): Promise<number> {
  const { specJson, writeEvent, writeStderr, signal, apiKeyEnv, createAgent, checkpointerDb } = io;

  // 1. Parse spec
  let raw: unknown;
  try {
    raw = JSON.parse(specJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] spec parse failed: ${message}`);
    return 1;
  }

  let spec: ReturnType<typeof AgentSpecV1.parse>;
  try {
    spec = AgentSpecV1.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] spec validation failed: ${message}`);
    return 1;
  }

  // 2. Resolve apiKey
  const apiKey = spec.apiKey ?? process.env[apiKeyEnv ?? "ANTHROPIC_API_KEY"];
  if (!apiKey) {
    const err = new Error("No API key configured. Set spec.apiKey or ANTHROPIC_API_KEY env.");
    writeEvent({ type: "error", payload: { message: err.message, stack: err.stack } });
    writeStderr(`[runner-stdio] ${err.message}`);
    return 1;
  }

  // 3+4+5. Construct model + agent + run (all inside try/catch — M7 N1 fix + H6)
  try {
    writeStderr(`[runner-stdio] spec parsed, threadId=${spec.threadId}${spec.conversationId ? `, conversationId=${spec.conversationId}` : ""}`);

    const model = new AnthropicChatModel({
      apiKey,
      model: spec.model.model,
      baseUrl: spec.model.baseURL,
    });

    const factory = createAgent ?? (await import("@my-agent-team/harness")).createGenericAgent;
    const agent = await factory({
      workspace: spec.workspace,
      model,
      threadId: spec.threadId,
      permissionMode: spec.permissionMode,
      checkpointerDb: checkpointerDb as Parameters<typeof factory>[0]["checkpointerDb"],
    });

    // M9: heartbeat timer (runner entry directly writes attempt.heartbeat_at)
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let hbDb: import("bun:sqlite").Database | undefined;
    const heartbeatInterval = io.heartbeatIntervalMs ?? 5000;
    if (spec.attemptId && spec.storage?.eventLog) {
      const attemptId = spec.attemptId; // narrow for closure
      const { Database } = await import("bun:sqlite");
      hbDb = new Database(spec.storage.eventLog.path);
      heartbeatTimer = setInterval(() => {
        try {
          hbDb!.run("UPDATE attempt SET heartbeat_at = ? WHERE attempt_id = ?", [
            Date.now(),
            attemptId,
          ]);
        } catch {
          // heartbeat is best-effort; don't crash the run
        }
      }, heartbeatInterval);
    }

    // M9: EventSink — test injects in-memory, production self-builds from spec.storage.eventLog
    let sink = io.eventSink;
    if (!sink && spec.storage?.eventLog) {
      const { sqliteEventLog } = await import("@my-agent-team/event-log");
      sink = sqliteEventLog({ db: spec.storage.eventLog.path });
    }
    // Fail fast if durable mode is configured but no sink is available
    if (!sink && spec.storage?.eventLog) {
      const err = new Error("EventLog configured but failed to construct EventSink");
      writeEvent({ type: "error", payload: { message: err.message, stack: err.stack } });
      writeStderr(`[runner-stdio] ${err.message}`);
      return 1;
    }

    // M9: mode branch — run vs resume
    const stream =
      spec.mode === "resume"
        ? agent.resume(spec.resumeCommand!, { signal, maxSteps: spec.maxSteps })
        : agent.run(spec.input, { signal, maxSteps: spec.maxSteps });

    writeStderr(`[runner-stdio] agent.${spec.mode} started`);
    try {
      for await (const ev of stream) {
        if (sink) await sink.append(spec.threadId, spec.runId ?? spec.threadId, ev);
        writeEvent(ev);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (hbDb) hbDb.close();
    }
    writeStderr(`[runner-stdio] agent.${spec.mode} finished cleanly`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} failed: ${message}`);
    return 1;
  }
}
