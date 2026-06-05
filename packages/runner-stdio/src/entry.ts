import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { AgentEvent } from "@my-agent-team/framework";
import type { createGenericAgent } from "@my-agent-team/harness";

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

  // 3. Construct ChatModel
  const model = new AnthropicChatModel({
    apiKey,
    model: spec.model.model,
    baseUrl: spec.model.baseURL,
  });

  // 4+5. Construct agent + run (both inside try/catch — M7 N1 fix)
  try {
    writeStderr(`[runner-stdio] spec parsed, threadId=${spec.threadId}`);

    const factory = createAgent ?? (await import("@my-agent-team/harness")).createGenericAgent;
    const agent = await factory({
      workspace: spec.workspace,
      model,
      threadId: spec.threadId,
      permissionMode: spec.permissionMode,
      checkpointerDb: checkpointerDb as Parameters<typeof factory>[0]["checkpointerDb"],
    });

    writeStderr("[runner-stdio] agent.run started");
    for await (const ev of agent.run(spec.input, {
      signal,
      maxSteps: spec.maxSteps,
    })) {
      writeEvent(ev);
    }
    writeStderr("[runner-stdio] agent.run finished cleanly");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    writeEvent({ type: "error", payload: { message, stack } });
    writeStderr(`[runner-stdio] agent.run failed: ${message}`);
    return 1;
  }
}
