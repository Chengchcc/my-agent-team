import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type {
  BackendEvent,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@chengchenccc/agent-contract";
import {
  AcpBackend,
  AcpBackendError,
  type AcpMcpProvider,
  type AcpSpawn,
  createNodeSpawn,
} from "./acp-backend.js";

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
  /** Replies to the mcp/message probes (one entry per probe). */
  mcpReplies?: unknown[];
  /** Errors from those probes (binding failures reject). */
  mcpErrors?: unknown[];
}

interface FakeAgentScript {
  /** Ask for permission mid-prompt with these options. */
  permissionOptions?: Array<{ optionId: string; name: string; kind: string }>;
  /** Send an elicitation mid-prompt. */
  elicit?: boolean;
  stopReason?: string;
  /** Close the connection right after asking for permission (the agent
   *  died mid-request: the held ACP promise must not outlive the run). */
  dieAfterPermission?: boolean;
  /** Capture every session/new params object (adopt-declaration tests). */
  newSessionParams?: unknown[];
  /** Capture the spawn env (allowlist passthrough tests). */
  spawnEnv?: (Readonly<Record<string, string | undefined>> | undefined)[];
  /** Advertise `agentCapabilities.mcpCapabilities.acp` on initialize. */
  acpMcp?: boolean;
  /** Send these `mcp/message` requests during the prompt. */
  mcpProbes?: Array<{ serverId: string; method: string; params?: unknown }>;
}

function startFakeAgent(script: FakeAgentScript, obs: FakeAgentObservations): AcpSpawn {
  return ({ env }) => {
    script.spawnEnv?.push(env);
    const backendToAgent = streamPair();
    const agentToBackend = streamPair();
    let resolveExit!: (code: number | null) => void;
    const exit = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });

    const die = () => {
      void backendToAgent.writable.close().catch(() => {});
      void agentToBackend.writable.close().catch(() => {});
      resolveExit(null);
    };
    const app = acp
      .agent({ name: "fake-acp-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: script.acpMcp ? { mcpCapabilities: { acp: true } } : {},
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.new, async (ctx) => {
        obs.newSessionCalls += 1;
        script.newSessionParams?.push(ctx.params);
        return { sessionId: "sess-fake-1", configOptions: [] };
      })
      .onRequest(acp.methods.agent.session.load, async (ctx) => {
        obs.loadedSessionIds.push(ctx.params.sessionId);
        return { sessionId: ctx.params.sessionId, configOptions: [] };
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        for (const probe of script.mcpProbes ?? []) {
          try {
            const reply = await ctx.client.request("mcp/message", {
              serverId: probe.serverId,
              requestId: "probe-1",
              method: probe.method,
              params: probe.params ?? {},
            } as never);
            obs.mcpReplies?.push(reply);
          } catch (err) {
            obs.mcpErrors?.push(err);
          }
        }
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
        if (script.dieAfterPermission) {
          die();
          return { stopReason: "end_turn" };
        }
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
      // Canonical sequence (ADR 0017): assistant text, the tool call as its own
      // assistant message, the result as a `tool` message.
      expect(outcome.messages).toEqual([
        { role: "assistant", text: "hello " },
        {
          role: "assistant",
          blocks: [{ type: "tool_use", id: "call-1", name: "Running tests", input: {} }],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: '{"ok":true}',
              is_error: false,
            },
          ],
        },
      ]);
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
        toolName: "execute",
        reason: "run command",
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
      // The tool facts stay, and text that arrives after them is its own
      // message: joining every chunk into one string merged turns that the
      // ledger should keep apart.
      expect(outcome.messages).toEqual([
        { role: "assistant", text: "hello " },
        {
          role: "assistant",
          blocks: [{ type: "tool_use", id: "call-1", name: "Running tests", input: {} }],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: '{"ok":true}',
              is_error: false,
            },
          ],
        },
        { role: "assistant", text: "after-permission" },
      ]);
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
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({ elicit: true }, obs) });
    const segment = await backend.execute(makeInput());
    const { outcome } = await collect(segment);
    expect(obs.elicitationOutcome).toEqual({ action: "decline" });
    expect(outcome.status).toBe("completed");
    await backend.dispose();
  });

  test("run terminal clears held permissions: a connection that dies mid-request leaves nothing dangling", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const backend = new AcpBackend({
      approvalTimeoutMs: 60_000,
      spawnImpl: startFakeAgent(
        {
          permissionOptions: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          dieAfterPermission: true,
        },
        obs,
      ),
    });
    const segment = await backend.execute(makeInput());
    const { outcome } = await collect(segment);
    // The connection died with the request in flight: the run settles
    // failed (not a 60s hang on the fail-closed timer)...
    expect(outcome.status).toBe("failed");
    // ...and the held entry is gone, so a late click maps to not_found
    // (the execution service turns that into the honest 409 + timeout row).
    await expect(backend.resolveApproval("run-1", "call-perm-1", "allow")).rejects.toBeInstanceOf(
      AcpBackendError,
    );
    await backend.dispose();
  }, 10_000);

  test("steer rejects explicitly (queue as follow-up, the omp precedent)", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    await expect(
      backend.steer("run-1", { inputId: "in-2", message: { role: "user", text: "wait" } }),
    ).rejects.toBeInstanceOf(AcpBackendError);
    await backend.dispose();
  });

  test("a resume dispatch without a session ref declares adopt-last-interrupted", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const newSessionParams: unknown[] = [];
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent({ newSessionParams }, obs),
    });
    const input = makeInput();
    const segment = await backend.execute({
      ...input,
      resume: {
        decisions: [{ callId: "call-parked", kind: "approval", response: { decision: "allow" } }],
      },
    });
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("completed");
    // ADR 0038 kill-mid-run gap: with no cliSessionRef the agent is asked to
    // adopt its own interrupted predecessor, and the decisions ride along.
    expect(newSessionParams).toEqual([
      {
        cwd: "/tmp/acp-fake-ws",
        mcpServers: [],
        _meta: {
          "my-agent-team/resume": {
            adopt: "last-interrupted",
            decisions: [
              { callId: "call-parked", kind: "approval", response: { decision: "allow" } },
            ],
          },
        },
      },
    ]);
    await backend.dispose();
  }, 10_000);

  test("a fresh dispatch declares nothing extra on session/new", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const newSessionParams: unknown[] = [];
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({ newSessionParams }, obs) });
    const segment = await backend.execute(makeInput());
    await collect(segment);
    expect(newSessionParams).toEqual([{ cwd: "/tmp/acp-fake-ws", mcpServers: [] }]);
    await backend.dispose();
  });

  test("the run's MCP allowlists reach the child env", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const spawnEnv: (Readonly<Record<string, string | undefined>> | undefined)[] = [];
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({ spawnEnv }, obs) });
    const input = makeInput();
    const segment = await backend.execute({
      ...input,
      productToolsToken: "tok-123",
      mcpExpandableVars: ["PRODUCT_TOOLS_RUN_TOKEN"],
      consentedMcpTools: ["mcp__product-tools__history_recent"],
    });
    await collect(segment);
    // Without these the child refuses ${PRODUCT_TOOLS_RUN_TOKEN} in the
    // workspace .mcp.json and product tools never mount (live 2026-09-29).
    expect(spawnEnv[0]).toMatchObject({
      PRODUCT_TOOLS_RUN_TOKEN: "tok-123",
      // The env-list encoding is comma-joined, not JSON (agent-contract's
      // encodeEnvList, the same channel the oma adapter uses).
      OMA_MCP_EXPANDABLE_VARS: "PRODUCT_TOOLS_RUN_TOKEN",
      OMA_CONSENTED_MCP_TOOLS: "mcp__product-tools__history_recent",
    });
    await backend.dispose();
  });

  test("a missing agent binary fails the run, not the process", async () => {
    // Regression (live 2026-09-29): Bun reports spawn ENOENT through the
    // child's `error` event; with no listener it became an uncaught
    // exception that killed the whole backend during dispatch.
    const backend = new AcpBackend({ spawnImpl: createNodeSpawn(50) });
    const input = makeInput();
    const segment = await backend.execute({
      ...input,
      run: { ...input.run, model: { backendKind: "acp", modelId: "definitely-not-a-binary" } },
    });
    const { outcome } = await collect(segment);
    expect(outcome.status).toBe("failed");
    await backend.dispose();
  }, 10_000);

  test("duplicate runId conflicts", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const backend = new AcpBackend({ spawnImpl: startFakeAgent({}, obs) });
    const first = await backend.execute(makeInput());
    await expect(backend.execute(makeInput())).rejects.toBeInstanceOf(AcpBackendError);
    await collect(first);
    await backend.dispose();
  });
});

describe("MCP over ACP (ADR 0039: the connection carries the servers)", () => {
  const provider = (over: Partial<AcpMcpProvider> = {}): AcpMcpProvider => ({
    name: "product-tools",
    serverId: "product-tools",
    listTools: () => ({ tools: [{ name: "todo_write", description: "list", inputSchema: {} }] }),
    call: async () => ({ content: "done" }),
    ...over,
  });

  test("a declared capability gets the provider named in session/new", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const newSessionParams: unknown[] = [];
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent({ acpMcp: true, newSessionParams }, obs),
      acpMcpProvider: provider(),
    });
    const { outcome } = await collect(await backend.execute(makeInput()));
    expect(outcome.status).toBe("completed");
    expect(newSessionParams).toEqual([
      {
        cwd: "/tmp/acp-fake-ws",
        mcpServers: [{ type: "acp", name: "product-tools", serverId: "product-tools" }],
      },
    ]);
    await backend.dispose();
  }, 10_000);

  test("no declaration, no provider (the workspace rail stays)", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
    };
    const newSessionParams: unknown[] = [];
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent({ newSessionParams }, obs),
      acpMcpProvider: provider(),
    });
    await collect(await backend.execute(makeInput()));
    expect(newSessionParams).toEqual([{ cwd: "/tmp/acp-fake-ws", mcpServers: [] }]);
    await backend.dispose();
  }, 10_000);

  test("tools/list and tools/call are answered from the provider", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      mcpReplies: [],
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent(
        {
          acpMcp: true,
          mcpProbes: [
            { serverId: "product-tools", method: "tools/list" },
            {
              serverId: "product-tools",
              method: "tools/call",
              params: { name: "todo_write", arguments: { items: [] } },
            },
            { serverId: "product-tools", method: "nope" },
          ],
        },
        obs,
      ),
      acpMcpProvider: provider({
        call: async (req) => {
          calls.push(req as unknown as Record<string, unknown>);
          return { content: "done" };
        },
      }),
    });
    const input = makeInput();
    const { outcome } = await collect(
      await backend.execute({
        ...input,
        metadata: { conversationId: "conv-1", agentId: "agent-1" },
      }),
    );
    expect(outcome.status).toBe("completed");
    // The inner MCP outcome rides the outer ACP success (RFCD): a
    // tools/list reply is a tool list, a tools/call reply is MCP content.
    // The visible envelope (SDK passthrough for a custom method) is the
    // RFCD's outer result carrying the inner outcome; oma's client reads
    // `.result.result` off the same shape.
    expect(obs.mcpReplies?.[0]).toEqual({
      result: { result: { tools: [{ name: "todo_write", description: "list", inputSchema: {} }] } },
    });
    expect(obs.mcpReplies?.[1]).toEqual({
      result: { result: { content: [{ type: "text", text: "done" }] } },
    });
    // An unsupported inner method is an MCP-level error, not a transport one.
    expect(obs.mcpReplies?.[2]).toEqual({
      result: { result: { error: { code: -32601, message: "unsupported MCP method nope" } } },
    });
    expect(calls[0]).toMatchObject({
      caller: { runId: "run-1", agentId: "agent-1" },
      name: "todo_write",
      args: { items: [] },
    });
    await backend.dispose();
  }, 10_000);

  test("a message for another server is an ACP binding failure", async () => {
    const obs: FakeAgentObservations = {
      loadedSessionIds: [],
      newSessionCalls: 0,
      permissionOutcomes: [],
      elicitationOutcome: undefined,
      mcpErrors: [],
    };
    const backend = new AcpBackend({
      spawnImpl: startFakeAgent(
        { acpMcp: true, mcpProbes: [{ serverId: "someone-else", method: "tools/list" }] },
        obs,
      ),
      acpMcpProvider: provider(),
    });
    await collect(await backend.execute(makeInput()));
    const err = obs.mcpErrors?.[0] as { code?: number; message?: string } | undefined;
    expect(err?.code).toBe(-32602);
    expect(err?.message).toContain("unknown MCP connection");
    await backend.dispose();
  }, 10_000);
});
