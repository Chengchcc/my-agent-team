import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type {
  BackendEvent,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@chengchenccc/agent-contract";
import { AcpBackend, AcpBackendError, type AcpSpawn } from "./acp-backend.js";

/** ─── In-memory transport: crossed NDJSON stream pairs ────────────────
 *  The same wiring the SDK's own tests use — the backend speaks to a fake
 *  agent built with the SDK's agent-side app, no processes, deterministic
 *  permission control. */

function streamPair(): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return { readable, writable };
}

/** What the fake agent did during a prompt — the assertions' eyes inside
 *  the other end of the wire. */
interface FakeAgentObservations {
  loadedSessionIds: string[];
  newSessionCalls: number;
  permissionOutcomes: Array<unknown>;
  elicitationOutcome: unknown;
  cancelled: boolean;
}

interface FakeAgentScript {
  /** Ask for permission mid-prompt with these options. */
  permissionOptions?: Array<{ optionId: string; name: string; kind: string }>;
  /** Send an elicitation mid-prompt. */
  elicit?: boolean;
  stopReason?: string;
}

function startFakeAgent(script: FakeAgentScript, obs: FakeAgentObservations): AcpSpawn {
  return () => {
    const backendToAgent = streamPair();
    const agentToBackend = streamPair();
    let resolveExit!: (code: number | null) => void;
    const exit = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });

    const app = acp
      .agent({ name: "fake-acp-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.new, async () => {
        obs.newSessionCalls += 1;
        return { sessionId: "sess-fake-1", configOptions: [] };
      })
      .onRequest(acp.methods.agent.session.load, async (ctx) => {
        obs.loadedSessionIds.push(ctx.params.sessionId);
        return { sessionId: ctx.params.sessionId, configOptions: [] };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        const notify = (update: unknown) =>
          ctx.client.notify(acp.methods.client.session.update, { sessionId, update } as never);
        await notify({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "pondering" },
        });
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello " },
        });
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Running tests",
          kind: "execute",
          status: "pending",
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: { ok: true },
        });
        if (script.permissionOptions) {
          const decision = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: {
              toolCallId: "call-perm-1",
              title: "run command",
              kind: "execute",
              status: "pending",
              rawInput: { command: "echo hi" },
            },
            options: script.permissionOptions as never,
          });
          obs.permissionOutcomes.push(decision.outcome);
          await notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after-permission" },
          });
        }
        if (script.elicit) {
          const answer = await ctx.client.request(acp.methods.client.elicitation.create, {
            sessionId,
            mode: "form",
            message: "pick one",
            requestedSchema: {
              type: "object",
              properties: { strategy: { type: "string", enum: ["a", "b"] } },
              required: ["strategy"],
            },
          } as never);
          obs.elicitationOutcome = answer;
        }
        return { stopReason: script.stopReason ?? "end_turn" };
      });

    void app.connect(acp.ndJsonStream(agentToBackend.writable, backendToAgent.readable));

    return {
      stream: acp.ndJsonStream(backendToAgent.writable, agentToBackend.readable),
      exit,
      kill() {
        void backendToAgent.writable.close().catch(() => {});
        void agentToBackend.writable.close().catch(() => {});
        resolveExit(null);
      },
    };
  };
}

function makeInput(overrides: Partial<BackendRunInput<"acp">["run"]> = {}): BackendRunInput<"acp"> {
  return {
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "run-1",
      model: { backendKind: "acp", modelId: "omp" },
      configRevision: 1,
      ...overrides,
    },
    workspace: { root: "/tmp/acp-fake-ws", access: "read_write" },
  };
}

async function collect(
  segment: BackendRunSegment<"acp">,
): Promise<{ events: BackendEvent<"acp">[]; outcome: BackendRunOutcome }> {
  const events: BackendEvent<"acp">[] = [];
  const reading = (async () => {
    for await (const event of segment.events) events.push(event);
  })();
  const outcome = await segment.outcome;
  await reading;
  return { events, outcome };
}

/** Read events until a predicate matches, running the drain in the
 * background — needed to react mid-run (approve a permission). */
async function waitUntil(
  segment: BackendRunSegment<"acp">,
  pred: (event: BackendEvent<"acp">) => boolean,
  sink: BackendEvent<"acp">[],
): Promise<void> {
  for await (const event of segment.events) {
    sink.push(event);
    if (pred(event)) return;
  }
}

describe("AcpBackend against an in-memory fake agent", () => {
  test("happy path: stream events, completed outcome, sessionId as cliSessionRef", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    const segment = await backend.execute(makeInput());
    const { events, outcome } = await collect(segment);

    expect(events.map((e) => e.type)).toEqual([
      "thinking_delta",
      "text_delta",
      "native_tool_started",
      "native_tool_completed",
    ]);
    expect(events[1]).toEqual({ type: "text_delta", text: "hello " });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.messages).toEqual([{ role: "assistant", text: "hello " }]);
      expect(outcome.cliSessionRef).toBe("sess-fake-1");
    }
    expect(obs.newSessionCalls).toBe(1);
    await backend.dispose();
  });

  test("permission allow: resolveApproval picks the agent's allow_once optionId", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent(
        {
          permissionOptions: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
        obs,
      ),
    });
    const segment = await backend.execute(makeInput());
    const seen: BackendEvent<"acp">[] = [];
    await waitUntil(segment, (e) => e.type === "approval_requested", seen);
    const approval = seen.find((e) => e.type === "approval_requested");
    expect(approval).toMatchObject({
      type: "approval_requested",
      payload: {
        callId: "call-perm-1",
        toolName: "run command",
        input: { command: "echo hi" },
      },
    });
    if (approval?.type === "approval_requested") {
      expect(approval.payload.deadlineAt).toBeGreaterThan(Date.now());
    }
    await backend.resolveApproval("run-1", "call-perm-1", "allow");
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      // Chunks join into one message: v1 has no boundary marker.
      expect(outcome.messages).toEqual([{ role: "assistant", text: "hello after-permission" }]);
    }
    // The response echoed the AGENT's optionId, picked by kind.
    expect(obs.permissionOutcomes).toEqual([{ outcome: "selected", optionId: "allow-once" }]);
    await backend.dispose();
  });

  test("permission deny maps to reject_once", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent(
        {
          permissionOptions: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
        obs,
      ),
    });
    const segment = await backend.execute(makeInput());
    const seen: BackendEvent<"acp">[] = [];
    await waitUntil(segment, (e) => e.type === "approval_requested", seen);
    await backend.resolveApproval("run-1", "call-perm-1", "deny");
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("completed");
    expect(obs.permissionOutcomes).toEqual([{ outcome: "selected", optionId: "reject-once" }]);
    await backend.dispose();
  });

  test("resolveApproval for an unknown call rejects (the 409 source)", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    const segment = await backend.execute(makeInput());
    await expect(backend.resolveApproval("run-1", "nope", "allow")).rejects.toBeInstanceOf(
      AcpBackendError,
    );
    await collect(segment);
    await backend.dispose();
  });

  test("fail-closed: an unanswered permission denies at the deadline", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({
      approvalTimeoutMs: 80,
      spawnImpl: startFakeAgent(
        {
          permissionOptions: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
        obs,
      ),
    });
    const segment = await backend.execute(makeInput());
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("completed");
    expect(obs.permissionOutcomes).toEqual([{ outcome: "selected", optionId: "reject-once" }]);
    await backend.dispose();
  }, 10_000);

  test("stop(): held permissions answer cancelled, outcome aborted", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent(
        {
          permissionOptions: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
        obs,
      ),
    });
    const segment = await backend.execute(makeInput());
    const seen: BackendEvent<"acp">[] = [];
    await waitUntil(segment, (e) => e.type === "approval_requested", seen);
    await segment.stop();
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("aborted");
    // The cancel reaches the wire best-effort: stop() closes the transport
    // immediately after, so the (dying) agent may never observe it — same
    // as the oma adapter, where the deny races the child's death. What
    // matters is OUR side never leaves the promise dangling.
    await backend.dispose();
  }, 10_000);

  test("resume: a cliSessionRef routes through session/load", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    const segment = await backend.execute(makeInput({ cliSessionRef: "sess-fake-1" }));
    const { outcome } = await collect(segment);
    expect(obs.loadedSessionIds).toEqual(["sess-fake-1"]);
    expect(obs.newSessionCalls).toBe(0);
    expect(outcome.status).toBe("completed");
    await backend.dispose();
  });

  test("agent-cancelled turn settles aborted", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent({ stopReason: "cancelled" }, obs),
    });
    const segment = await backend.execute(makeInput());
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("aborted");
    await backend.dispose();
  });

  test("inbound elicitation is declined (documented P1 behavior)", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({ elicit: true }, obs) });
    const segment = await backend.execute(makeInput());
    const { outcome } = await collect(segment);
    expect(obs.elicitationOutcome).toEqual({ action: "decline" });
    expect(outcome.status).toBe("completed");
    await backend.dispose();
  });

  test("steer rejects explicitly (queue as follow-up, the omp precedent)", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    await expect(
      backend.steer("run-1", { inputId: "in-2", message: { role: "user", text: "wait" } }),
    ).rejects.toBeInstanceOf(AcpBackendError);
    await backend.dispose();
  });

  test("duplicate runId conflicts", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      cancelled: false,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    const first = await backend.execute(makeInput());
    await expect(backend.execute(makeInput())).rejects.toBeInstanceOf(AcpBackendError);
    await collect(first);
    await backend.dispose();
  });
});
