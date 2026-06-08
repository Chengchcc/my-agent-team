import { existsSync } from "node:fs";
import path from "node:path";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { AgentEvent } from "@my-agent-team/framework";
import type { createGenericAgent } from "@my-agent-team/harness";
import { reflectionGuidance } from "@my-agent-team/harness";
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
  /** M11: Heartbeat throttle interval in ms. Heartbeat writes at most once per this interval. Default 5000. */
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

  // P0-1: Self-build checkpointer from spec.storage.checkpointer.path when not injected (production path).
  let cpDb: unknown = checkpointerDb;
  let cpDbSelfBuilt = false;

  // 3+4+5. Construct model + agent + run (all inside try/catch — M7 N1 fix + H6)
  try {
    writeStderr(`[runner-stdio] spec parsed, threadId=${spec.threadId}${spec.conversationId ? `, conversationId=${spec.conversationId}` : ""}`);

    const model = new AnthropicChatModel({
      apiKey,
      model: spec.model.model,
      baseUrl: spec.model.baseURL,
    });

    if (!cpDb && spec.storage?.checkpointer?.kind === "sqlite" && spec.storage.checkpointer.path) {
      const { Database } = await import("bun:sqlite");
      cpDb = new Database(spec.storage.checkpointer.path);
      cpDbSelfBuilt = true;
    }

    const factory = createAgent ?? (await import("@my-agent-team/harness")).createGenericAgent;
    const agent = await factory({
      workspace: spec.workspace,
      model,
      threadId: spec.threadId,
      permissionMode: spec.permissionMode,
      checkpointerDb: cpDb as Parameters<typeof factory>[0]["checkpointerDb"],
    });

    // M11: Snapshot BOOTSTRAP.md existence BEFORE first run (genesis guard for reflect)
    const bootPath = path.join(spec.workspace, "BOOTSTRAP.md");
    const isGenesis = existsSync(bootPath);

    // M11: Progress heartbeat — open DB connection for throttled heartbeat writes
    let hbDb: import("bun:sqlite").Database | undefined;
    const heartbeatInterval = io.heartbeatIntervalMs ?? 5000;
    let lastHeartbeat = 0;
    if (spec.attemptId && spec.storage?.eventLog) {
      const attemptId = spec.attemptId; // narrow for closure
      const { Database } = await import("bun:sqlite");
      hbDb = new Database(spec.storage.eventLog.path);
      lastHeartbeat = 0;
    }

    async function tryHeartbeat(): Promise<void> {
      if (!hbDb || !spec.attemptId) return;
      const now = Date.now();
      if (now - lastHeartbeat < heartbeatInterval) return;
      lastHeartbeat = now;
      try {
        hbDb.run("UPDATE attempt SET heartbeat_at = ? WHERE attempt_id = ?", [now, spec.attemptId]);
      } catch {
        // heartbeat is best-effort; don't crash the run
      }
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

    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} started`);
    try {
      for await (const ev of stream) {
        if (sink) await sink.append(spec.threadId, spec.runId ?? spec.threadId, ev);
        writeEvent(ev);
        // M11: progress heartbeat after each event
        await tryHeartbeat();
      }
    } finally {
      // M11: close heartbeat DB before reflection or exit
      if (hbDb) { hbDb.close(); hbDb = undefined; }
    }

    // M11 Growth: reflect after normal run (non-genesis, non-resume)
    if (!isGenesis && spec.mode !== "resume") {
      writeStderr("[runner-stdio] running reflection turn");
      const reflectStream = agent.run(reflectionGuidance(), { signal, maxSteps: spec.maxSteps });
      try {
        for await (const ev of reflectStream) {
          if (sink) await sink.append(spec.threadId, spec.runId ?? spec.threadId, ev);
          writeEvent(ev);
        }
      } catch {
        // Reflection is best-effort; don't fail the run
        writeStderr("[runner-stdio] reflection turn failed (non-fatal)");
      }
    }

    if (cpDbSelfBuilt && cpDb) (cpDb as import("bun:sqlite").Database).close();
    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} finished cleanly`);
    return 0;
  } catch (err) {
    if (cpDbSelfBuilt && cpDb) (cpDb as import("bun:sqlite").Database).close();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} failed: ${message}`);
    return 1;
  }
}
