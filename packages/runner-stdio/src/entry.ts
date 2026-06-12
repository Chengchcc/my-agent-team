import type { Database as SqliteDatabase } from "bun:sqlite";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { EventSink } from "@my-agent-team/event-log";
import type { AgentEvent } from "@my-agent-team/framework";
import type { createGenericAgent } from "@my-agent-team/harness";
import { reflectionGuidance, verificationGuidance } from "@my-agent-team/harness";

export interface EntryIO {
  /** Raw spec JSON string (from process.env.AGENT_SPEC by default) */
  specJson: string;
  /** Write one NDJSON line (event + '\n'). Durable events go to EventLog via sink. */
  writeEvent: (event: AgentEvent) => void;
  /** Write a text_delta line to stdout only — never persisted to EventLog. */
  writeDelta?: (delta: { blockIndex: number; text: string }) => void;
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

  // Self-build checkpointer from spec.storage.checkpointer.path when not injected.
  let cpDb: unknown = checkpointerDb;
  let cpDbSelfBuilt = false;
  // M11: heartbeat DB (opened later, closed uniformly at end)
  let hbDb: SqliteDatabase | undefined;

  // 3+4+5. Construct model + agent + run
  try {
    writeStderr(
      `[runner-stdio] spec parsed, threadId=${spec.threadId}${spec.conversationId ? `, conversationId=${spec.conversationId}` : ""}`,
    );

    const model = new AnthropicChatModel({
      apiKey,
      model: spec.model.model,
      baseUrl: spec.model.baseURL || process.env.ANTHROPIC_BASE_URL,
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

    // M11: Progress heartbeat — open DB connection for throttled heartbeat writes
    const heartbeatInterval = io.heartbeatIntervalMs ?? 5000;
    let lastHeartbeat = 0;
    if (spec.attemptId && spec.storage?.eventLog) {
      const { Database } = await import("bun:sqlite");
      hbDb = new Database(spec.storage.eventLog.path);
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
      // FIX: close resources before early return
      if (cpDbSelfBuilt && cpDb) (cpDb as SqliteDatabase).close();
      if (hbDb) hbDb.close();
      return 1;
    }

    // M14.3: Three-way mode branch — run / resume / reflect.
    // Reflect loads main-thread history then forks to a temp thread so
    // reflection output is checkpoint-isolated from the main conversation.
    let runAgent = agent;
    let runInput = spec.input;
    let isReflect = false;
    if (spec.mode === "reflect") {
      runAgent = agent.fork(undefined, `reflect:${spec.threadId}`);
      runInput = reflectionGuidance();
      isReflect = true;
    }

    // M14.6: Default maxForceContinues=3 for task runs, 0 for reflect/cold-review to exempt.
    const maxForce = isReflect ? 0 : undefined; // undefined → framework default (3)
    const stream =
      spec.mode === "resume"
        ? agent.resume(spec.resumeCommand!, {
            signal,
            maxSteps: spec.maxSteps,
            stream: true,
            maxForceContinues: maxForce,
          })
        : runAgent.run(runInput, {
            signal,
            maxSteps: spec.maxSteps,
            stream: true,
            maxForceContinues: maxForce,
          });

    // Helper: route events from an agent stream (stdout + EventSink + heartbeat)
    async function routeEvents(src: AsyncIterable<AgentEvent>): Promise<void> {
      for await (const ev of src) {
        if (ev.type === "text_delta") {
          io.writeDelta?.({ blockIndex: ev.payload.blockIndex, text: ev.payload.text });
        } else if (ev.type === "tool_start" || ev.type === "tool_end") {
          writeEvent(ev);
        } else {
          if (sink) {
            await sink.append(spec.threadId, spec.runId ?? spec.threadId, ev);
          } else {
            writeEvent(ev);
          }
          await tryHeartbeat();
        }
      }
    }

    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} started`);
    await routeEvents(stream);
    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} finished cleanly`);

    // M14.6: Cold verification loop — only for normal runs (not reflect/resume)
    if (!isReflect && spec.mode !== "resume" && spec.mode !== "reflect") {
      const maxVerifyRounds = 2;
      let rounds = 0;
      while (rounds < maxVerifyRounds) {
        const evalAgent = agent.fork(undefined, `verify:${spec.threadId}`);
        let verdict: { complete: boolean; missing: string } | null = null;
        try {
          // Collect all events from the cold-review run, extract text from last message
          let allText = "";
          for await (const ev of evalAgent.run(verificationGuidance(), {
            signal,
            maxSteps: spec.maxSteps,
            maxForceContinues: 0, // exempt cold review from stop gate
          })) {
            if (ev.type === "message") {
              const content = ev.payload.content;
              if (typeof content === "string") {
                allText += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text") {
                    allText += (block as { text: string }).text;
                  }
                }
              }
            }
          }
          // Parse verdict JSON from the response
          const jsonMatch = allText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed.complete === "boolean") {
              verdict = parsed;
            }
          }
        } catch {
          // fail-open: break on any error
          break;
        }
        if (!verdict || verdict.complete) break;
        // Guard: missing must be a non-empty actionable string
        if (!verdict.missing || typeof verdict.missing !== "string" || !verdict.missing.trim()) {
          break; // good-enough — the model said incomplete but gave no actionable gap
        }
        rounds++;
        writeStderr(`[runner-stdio] cold verify round ${rounds}: incomplete, re-running`);
        // Gap回流: re-run main agent with missing items
        await routeEvents(
          agent.run(verdict.missing, {
            signal,
            maxSteps: spec.maxSteps,
            maxForceContinues: maxForce, // task run: enable stop gate
          }),
        );
      }
    }

    // M14.3: Reflection (same fork pattern, exempt from stop gate)
    // M14.6: Only run inline reflection for normal task runs (not resume/reflect)
    if (!isReflect && spec.mode !== "resume" && spec.mode !== "reflect") {
      const reflectAgent = agent.fork(undefined, `reflect:${spec.threadId}`);
      await routeEvents(
        reflectAgent.run(reflectionGuidance(), {
          signal,
          maxSteps: spec.maxSteps,
          maxForceContinues: 0, // exempt reflection from stop gate
        }),
      );
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] agent.${spec.mode ?? "run"} failed: ${message}`);
    return 1;
  } finally {
    // M11: Always close DB connections (covers success, error, and early-return paths)
    if (hbDb) {
      hbDb.close();
      hbDb = undefined;
    }
    if (cpDbSelfBuilt && cpDb) (cpDb as SqliteDatabase).close();
  }
}
