/** ACP mode (ADR 0039 decision 4, P2): oma speaks the Agent Client
 *  Protocol on stdio — the standard face any ACP client (Zed, acpx, our
 *  own adapter-acp) can drive. One prompt = one Run = one prompt response;
 *  the wire stays v1 and every extension uses the v2 extensibility shapes
 *  (underscore methods, `_meta`, capability advertising at initialize).
 *
 *  Reuses the RPC mode's proven machinery: session-file truth
 *  (load/append/parked markers), cwd-based skills and system prompt, the
 *  plugin assembly, and the approval parking pattern — only the protocol
 *  changes. oma-private loop events (delegation, mcp mounts, queue drains)
 *  ride `_oma/update` custom notifications per the ADR's extension-vehicle
 *  rule; steer is exposed under the ecosystem's agreed `_session/steering`
 *  convention, advertised via `InitializeResponse._meta.steering.supported`. */

import { Readable, Writable } from "node:stream";
import type { RequestPermissionResponse, Usage as SdkUsage } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import { adaptMcpTool } from "@chengchenccc/adapter-mcp";
import type { ModelRuntime } from "@chengchenccc/ai";
import { type Message, MessageSchema } from "@chengchenccc/message";
import { assemblePluginRuntime, type PluginMcpConfig } from "../../core/plugins/plugin-resolve.js";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  approvalTimeoutMs,
} from "../../core/runtime/approval.js";
import type { BackendRunOutcome } from "../../core/runtime/contract/index.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import type { Plugin } from "../../core/runtime/plugin.js";
import { buildSystemPrompt, readMemorySummary } from "../../core/runtime/prompts.js";
import {
  appendParkedTurnMarker,
  appendSessionMessages,
  findInterruptedSession,
  loadLastParkedTurn,
  loadSessionMessages,
  newSessionId,
  sessionDirFor,
  withoutOrphanToolResults,
} from "../../core/session/session-file.js";
import { persistSessionTurn } from "../../core/session/session-loop.js";
import {
  readWorkspaceSystemPrompt,
  scanWorkspaceSkillRoots,
} from "../../core/settings/workspace-context.js";
import type { RunEventEnvelope } from "../../protocol/index.js";

export interface AcpModeOptions {
  /** The assembled model runtime (main.ts registers built-in providers,
   *  same object every other mode gets). */
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id; absent = the first available model
   *  (same default the TUI/one-shot paths use). */
  model?: string;
  /** The ACP byte stream; defaults to process stdio (tests inject an
   *  in-memory pair). */
  stream?: ReturnType<typeof acp.ndJsonStream>;
  log?: (line: string) => void;
}

export interface AcpModeController {
  readonly promise: Promise<number>;
  /** Abort the live run (SIGINT/SIGTERM path): the prompt settles
   *  cancelled, parked approvals deny, the mode exits. */
  stop(): void;
}

/** Everything one session carries across prompts. */
/** A client-declared MCP server carried over the ACP connection itself
 *  (RFCD "MCP-over-ACP"; the SDK's McpServerAcp declaration shape). */
interface AcpMcpServerDeclaration {
  readonly name: string;
  readonly serverId: string;
}

interface AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly acpMcpServers: readonly AcpMcpServerDeclaration[];
  /** Decisions read off a session/load's `_meta` (ADR 0039
   *  extension-vehicle rule 2): the NEXT prompt completes the parked turn
   *  with them pre-supplied — the ACP shape of ADR 0038's resume. */
  resumeDecisions: readonly ResumeDecision[] | null;
  /** The model this session runs, chosen by the client through the
   *  `model` config option. null = the mode's own resolution (explicit
   *  --model, else the first available catalog entry). */
  model: string | null;
}

interface ResumeDecision {
  readonly callId: string;
  readonly kind: "approval" | "ask";
  readonly response: Record<string, unknown>;
}

interface LiveRun {
  readonly runtime: OmaRuntime;
  readonly sessionId: string;
  readonly pendingApprovals: Map<string, (d: ApprovalDecision) => void>;
}

export function runAcpMode(opts: AcpModeOptions): AcpModeController {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sessions = new Map<string, AcpSession>();
  let live: LiveRun | null = null;
  let resolveExit: ((code: number) => void) | null = null;
  const promise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const modelRuntime = opts.modelRuntime;

  const app = acp
    .agent({ name: "oma" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        // MCP-over-ACP (RFCD): servers declared {type:"acp"} in session/new
        // are consumed through mcp/message instead of a separate transport.
        mcpCapabilities: { acp: true },
      },
      authMethods: [],
      // v2 extensibility shapes on the v1 wire (ADR 0039 decision 4): the
      // ecosystem's agreed steering convention, advertised so clients
      // check instead of guess.
      _meta: { steering: { supported: true } },
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const cwd = ctx.params.cwd;
      const meta = (ctx.params as { _meta?: Record<string, unknown> | null })._meta;
      const resumeMeta = readResumeMeta(meta);
      // ADR 0038 kill-mid-run gap: a resume dispatch with no session
      // reference asks us to adopt the newest interrupted parked session in
      // this cwd — the RPC mode's findInterruptedSession, declared over the
      // extension vehicle (ADR 0039 rule 2) instead of guessed.
      let sessionId = newSessionId();
      if (resumeMeta?.adopt === "last-interrupted") {
        const sessionDir = process.env.OMA_SESSION_DIR ?? sessionDirFor(cwd);
        const adopted = findInterruptedSession(sessionDir);
        if (adopted) {
          sessionId = adopted;
          log(`[acp] adopted interrupted session ${adopted}`);
        }
      }
      sessions.set(sessionId, {
        sessionId,
        cwd,
        acpMcpServers: readAcpMcpServers(ctx.params.mcpServers),
        resumeDecisions: resumeMeta?.decisions ?? null,
        model: null,
      });
      return {
        sessionId,
        configOptions: modelConfigOptions(await modelRuntime.getCatalog(), null, opts.model),
      };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const meta = (ctx.params as { _meta?: Record<string, unknown> | null })._meta;
      sessions.set(ctx.params.sessionId, {
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd ?? process.cwd(),
        acpMcpServers: readAcpMcpServers(ctx.params.mcpServers),
        resumeDecisions: readResumeDecisions(meta),
        model: null,
      });
      return {
        sessionId: ctx.params.sessionId,
        configOptions: modelConfigOptions(await modelRuntime.getCatalog(), null, opts.model),
      };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw acp.RequestError.invalidParams(
          { sessionId: ctx.params.sessionId },
          `unknown session ${ctx.params.sessionId}`,
        );
      }
      if (ctx.params.configId !== MODEL_CONFIG_ID) {
        throw acp.RequestError.invalidParams(
          { configId: ctx.params.configId },
          `unknown config option '${ctx.params.configId}'`,
        );
      }
      const catalog = await modelRuntime.getCatalog();
      const value = String(ctx.params.value ?? "");
      // Refuse an id the catalog does not serve. The client checks the
      // currentValue that comes back, so silently keeping the old model would
      // only be discovered by the human wondering why the run ignored them.
      if (!catalog.models.some((m) => `${m.providerId}/${m.modelId}` === value)) {
        // A protocol error, not a plain throw: the client must be able to
        // tell "you asked for something I do not serve" from a crash.
        throw acp.RequestError.invalidParams(
          { configId: MODEL_CONFIG_ID, value },
          `model not found in catalog: ${value}`,
        );
      }
      session.model = value;
      return { configOptions: modelConfigOptions(catalog, session.model, opts.model) };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw acp.RequestError.invalidParams(undefined, `unknown session: ${ctx.params.sessionId}`);
      }
      if (live) {
        throw acp.RequestError.invalidParams(undefined, "a prompt is already running");
      }
      return runPrompt(session, promptText(ctx.params.prompt), ctx.client);
    })
    .onRequest(STEER_METHOD, parseSteerParams, async (ctx) => {
      if (!live || live.sessionId !== ctx.params.sessionId) {
        throw acp.RequestError.invalidParams(
          undefined,
          `no live run to steer (session ${ctx.params.sessionId})`,
        );
      }
      await live.runtime.steer({
        inputId: `acp-steer-${Date.now()}`,
        message: { role: "user", text: ctx.params.text },
      } as never);
      return { accepted: true };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      if (!live || live.sessionId !== ctx.params.sessionId) return;
      releaseParkedApprovals();
      void live.runtime.stop().catch(() => {});
    });

  void app.connect(opts.stream ?? processStream());

  return {
    promise,
    stop() {
      releaseParkedApprovals();
      if (live) void live.runtime.stop().catch(() => {});
      resolveExit?.(0);
    },
  };

  function releaseParkedApprovals(): void {
    if (!live) return;
    for (const settle of [...live.pendingApprovals.values()]) {
      settle({ decision: "deny", reason: "run stopped by the client" });
    }
    live.pendingApprovals.clear();
  }

  /** One prompt = one Run. Mirrors the RPC mode's acceptExecute/driveOutcome
   *  pair, collapsed: the ACP prompt REQUEST resolves when the outcome is
   *  ready (streamed updates ride notifications meanwhile). */
  async function runPrompt(
    session: AcpSession,
    text: string,
    client: acp.AgentContext,
  ): Promise<{ stopReason: "end_turn" | "cancelled"; usage?: SdkUsage }> {
    const sessionDir = process.env.OMA_SESSION_DIR ?? sessionDirFor(session.cwd);
    const resume = session.resumeDecisions;
    session.resumeDecisions = null;
    const loaded = withoutOrphanToolResults(loadSessionMessages(session.sessionId, sessionDir));
    const transcript: { productEntryId: string; message: Message }[] = [];
    for (const [i, message] of loaded.entries()) {
      try {
        transcript.push({
          productEntryId: `session:${i}`,
          message: MessageSchema.parse(message) as Message,
        });
      } catch {
        log(`[acp] skipping malformed session line ${i}`);
      }
    }
    // ADR 0038 parked-turn completion: the interrupted assistant(tool_use)
    // becomes part of this run's transcript; its calls settle from the
    // replayed decisions instead of re-running the turn.
    const parkedTurn = resume ? loadLastParkedTurn(session.sessionId, sessionDir) : null;
    let resumedAssistant: Message | null = null;
    if (resume && parkedTurn?.interrupted) {
      try {
        const parkedMessage = MessageSchema.parse(parkedTurn.message) as Message;
        transcript.push({
          productEntryId: `session:${transcript.length}`,
          message: parkedMessage,
        });
        if (!loaded.some((m) => m.id === parkedMessage.id)) {
          appendSessionMessages(session.sessionId, session.cwd, [parkedMessage], sessionDir);
          resumedAssistant = parkedMessage;
        }
      } catch {
        log("[acp] malformed parked-turn marker: ignoring");
      }
    }
    const persistedIds = new Set(
      transcript.map((t) => t.message.id).filter((id): id is string => id != null),
    );
    const promptMessage: Message = { role: "user", text };
    const seedIndex = transcript.findIndex((t) => t.message.id === promptMessage.id);

    const cwdSkills = scanWorkspaceSkillRoots(session.cwd);
    const cwdPrompt = readWorkspaceSystemPrompt(session.cwd);
    const pluginRt = await assemblePluginRuntime(session.cwd, "rpc");
    for (const warning of pluginRt.warnings) log(`[acp] plugin: ${warning}`);
    // MCP-over-ACP servers ride the plugin seam: tools fetched over
    // mcp/message, executed over mcp/message, adapted with the same
    // mcp__<server>__<tool> naming every other mount uses.
    const acpMcpTools = await fetchAcpMcpTools(client, session, log);
    const workspaceMcpServers = withoutAcpDeclaredServers(
      pluginRt.mcpServers,
      new Set(session.acpMcpServers.map((server) => server.name)),
    );
    const preSupplied = resumeApprovals(resume);
    const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
    const catalog = await modelRuntime.getCatalog();
    // Same resolution the CLI's one-shot path uses: explicit id wins, else
    // the first available entry; the canonical id is provider/model.
    // The session's model wins over the mode's: that is what the client chose
    // through the `model` config option.
    const requested = session.model ?? opts.model;
    const modelEntry = requested
      ? catalog.models.find((m) => `${m.providerId}/${m.modelId}` === requested)
      : catalog.models.find((m) => m.available !== false);
    if (!modelEntry) {
      throw new Error(
        requested
          ? `model not found in catalog: ${requested}`
          : "no available model in the catalog (check provider credentials)",
      );
    }
    const modelId = `${modelEntry.providerId}/${modelEntry.modelId}`;
    const runtime = await createOmaRuntime({
      runId: `acp-${session.sessionId}`,
      modelId,
      approvalHandler: (req) =>
        preSupplied.has(req.callId)
          ? Promise.resolve(preSupplied.get(req.callId)!)
          : acpApproval(client, session, req, pendingApprovals),
      workspaceRoot: session.cwd,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: cwdSkills,
      // The ACP model of permissions: the client is the human surface, so
      // high-risk tools ask (via request_permission) instead of running an
      // auto classifier against nobody.
      permissionMode: "ask",
      todoScope: session.sessionId,
      ...(pluginRt.plugins.length || workspaceMcpServers.length || acpMcpTools.length
        ? {
            pluginComponents: {
              plugins: [
                ...pluginRt.plugins,
                ...(acpMcpTools.length > 0
                  ? [{ name: "acp-mcp", tools: acpMcpTools } as unknown as Plugin]
                  : []),
              ],
              mcpServers: workspaceMcpServers,
            },
          }
        : {}),
      sessionTranscript: transcript.length > 0 ? transcript : undefined,
      onPersistMessages: (messages) => {
        const fresh = messages.filter((m) => !m.id || !persistedIds.has(m.id));
        for (const m of fresh) if (m.id) persistedIds.add(m.id);
        if (fresh.length > 0) {
          appendSessionMessages(session.sessionId, session.cwd, fresh, sessionDir);
        }
      },
      onParkedTurn: (message) => appendParkedTurnMarker(session.sessionId, message, sessionDir),
      onEvent: (envelope) => {
        for (const mapped of mapWireEvent(envelope)) {
          // Standard kinds ride session/update; oma-private state rides the
          // `_oma/update` custom notification (ADR 0039 rule 3) — a private
          // blob inside session/update would fail the client's schema.
          const [method, params] =
            "update" in mapped
              ? [
                  acp.methods.client.session.update,
                  { sessionId: session.sessionId, update: mapped.update },
                ]
              : [OMA_UPDATE_METHOD, { sessionId: session.sessionId, event: mapped.oma }];
          void client.notify(method, params as never).catch(() => {});
        }
      },
    });
    live = { runtime, sessionId: session.sessionId, pendingApprovals };

    const input = {
      input: {
        inputId: `acp-in-${session.sessionId}-${Date.now()}`,
        ...(seedIndex >= 0 ? { productEntryId: `session:${seedIndex}` } : {}),
        message: promptMessage,
      },
      run: {
        runId: `acp-${session.sessionId}`,
        model: { backendKind: "oma", modelId },
        configRevision: 1,
        systemPrompt: buildSystemPrompt({
          workspacePrompt: cwdPrompt,
          memorySummary: readMemorySummary(session.cwd),
          cwd: session.cwd,
        }),
      },
      workspace: { root: session.cwd, access: "read_write" },
    } as never;
    const segment = await runtime.run(input);
    let outcome: BackendRunOutcome;
    try {
      outcome = await segment.outcome;
    } catch (err) {
      outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (resumedAssistant && outcome.status === "completed") {
      outcome = { ...outcome, messages: [resumedAssistant, ...(outcome.messages ?? [])] };
    }
    if (outcome.status === "completed") {
      await persistSessionTurn({
        sessionId: session.sessionId,
        cwd: session.cwd,
        runtime,
        dir: sessionDir,
        ...(outcome.title ? { title: outcome.title } : {}),
        ...(outcome.summary ? { summary: outcome.summary } : {}),
      }).catch(() => {});
    }
    live = null;
    await runtime.close().catch(() => {});

    if (outcome.status === "aborted") {
      return { stopReason: "cancelled" };
    }
    if (outcome.status !== "completed") {
      throw new Error(`oma run ${outcome.status}: ${outcome.error ?? "no error detail"}`);
    }
    return {
      stopReason: "end_turn",
      ...(outcome.usage ? { usage: toAcpUsage(outcome.usage) } : {}),
    };
  }
}

// ─── Mapping helpers ───────────────────────────────────────────────────────

const STEER_METHOD = "_session/steering";

/** The ACP config option a client sets to pick this session's model. */
const MODEL_CONFIG_ID = "model";

/** The session's model as an ACP config option: the catalog is the source of
 *  truth (the same one `oma --list-models` prints) and values are the
 *  canonical `provider/model` ids. An empty currentValue means the catalog
 *  holds nothing runnable yet (no credentials) - a fact the client can show,
 *  instead of us inventing a model. */
function modelConfigOptions(
  catalog: { models: readonly { providerId: string; modelId: string }[] },
  chosen: string | null,
  fallback: string | null | undefined,
) {
  const options = catalog.models.map((entry) => {
    const id = `${entry.providerId}/${entry.modelId}`;
    return { value: id, name: id };
  });
  const wanted = chosen ?? fallback ?? null;
  const effective = catalog.models.find((m) => `${m.providerId}/${m.modelId}` === wanted);
  const currentValue = effective
    ? `${effective.providerId}/${effective.modelId}`
    : (options[0]?.value ?? "");
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      description: "Select the model for this session",
      category: "model" as const,
      type: "select" as const,
      currentValue,
      options,
    },
  ];
}

const OMA_UPDATE_METHOD = "_oma/update";

/** Drop workspace-configured MCP servers the ACP client declared on this
 *  connection. Both rails can name the same server (a deployment injects the
 *  product-tools SSE URL for every agent kind), and mounting both would put
 *  one server's tools in the table twice — same name, two transports, one of
 *  which is a port that this agent is not supposed to need. */
export function withoutAcpDeclaredServers(
  configs: readonly PluginMcpConfig[],
  declared: ReadonlySet<string>,
): PluginMcpConfig[] {
  if (declared.size === 0) return [...configs];
  return configs
    .map((cfg) => ({
      ...cfg,
      servers: Object.fromEntries(
        Object.entries(cfg.servers).filter(([name]) => !declared.has(name)),
      ),
    }))
    .filter((cfg) => Object.keys(cfg.servers).length > 0);
}

/** The client's `mcpServers` entries of type "acp" (RFCD declaration). */
function readAcpMcpServers(mcpServers: unknown): AcpMcpServerDeclaration[] {
  if (!Array.isArray(mcpServers)) return [];
  const servers: AcpMcpServerDeclaration[] = [];
  for (const entry of mcpServers) {
    const server = entry as { type?: unknown; name?: unknown; serverId?: unknown };
    if (
      server?.type === "acp" &&
      typeof server.name === "string" &&
      typeof server.serverId === "string"
    ) {
      servers.push({ name: server.name, serverId: server.serverId });
    }
  }
  return servers;
}

/** The per-request MCP metadata the RFCD requires on every inner call. */
const ACP_MCP_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "oma", version: "1" },
} as const;

let acpMcpRequestSeq = 0;

/** One `mcp/message` round trip (RFCD envelope: serverId + logical
 *  requestId + flattened method/params). The inner outcome rides the outer
 *  success: `{result: {result|error}}` — an inner error is NOT an ACP
 *  error, so the carrier keeps the provenance. */
async function acpMcpCall(
  client: acp.AgentContext,
  serverId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const requestId = `oma-mcp-${++acpMcpRequestSeq}`;
  const response = (await client.request("mcp/message", {
    serverId,
    requestId,
    method,
    params: { ...params, _meta: ACP_MCP_META },
  } as never)) as { result?: { result?: unknown; error?: { message?: string } } };
  const inner = response.result;
  if (inner?.error) {
    throw new Error(`mcp/${method} failed: ${inner.error.message ?? "unknown error"}`);
  }
  return inner?.result;
}

/** Fetch every declared ACP MCP server's tools, adapted into oma tools. A
 *  server that cannot be listed degrades to "no tools" (logged), never a
 *  failed prompt — the same stance every other mount takes. */
async function fetchAcpMcpTools(
  client: acp.AgentContext,
  session: AcpSession,
  log: (line: string) => void,
): Promise<ReturnType<typeof adaptMcpTool>[]> {
  const tools: ReturnType<typeof adaptMcpTool>[] = [];
  for (const server of session.acpMcpServers) {
    try {
      const listed = (await acpMcpCall(client, server.serverId, "tools/list", {})) as {
        tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
      };
      for (const tool of listed?.tools ?? []) {
        tools.push(
          adaptMcpTool(server.name, tool, {
            callTool: async ({ name, arguments: args }) => ({
              content: await acpMcpCall(client, server.serverId, "tools/call", {
                name,
                arguments: args,
              }),
            }),
          }),
        );
      }
      log(`[acp] mcp-over-acp ${server.name}: ${listed?.tools?.length ?? 0} tools`);
    } catch (err) {
      log(`[acp] mcp-over-acp ${server.name} failed: ${String(err)}`);
    }
  }
  return tools;
}

function parseSteerParams(raw: unknown): { sessionId: string; text: string } {
  const params = raw as { sessionId?: unknown; prompt?: unknown };
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
  const text =
    typeof params?.prompt === "string"
      ? params.prompt
      : Array.isArray(params?.prompt)
        ? promptText(params.prompt as never)
        : "";
  if (!sessionId || !text) {
    throw acp.RequestError.invalidParams(
      undefined,
      "_session/steering requires sessionId and prompt",
    );
  }
  return { sessionId, text };
}

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return (prompt as { type: string; text?: string }[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** The namespaced resume envelope: an optional `adopt` declaration and the
 *  replayed decisions (ADR 0039 extension-vehicle rule 2). */
function readResumeMeta(meta: Record<string, unknown> | null | undefined): {
  adopt?: string;
  decisions: ResumeDecision[] | null;
} | null {
  const raw = meta?.["my-agent-team/resume"] as
    | { adopt?: unknown; decisions?: unknown }
    | undefined;
  if (!raw) return null;
  return {
    ...(typeof raw.adopt === "string" ? { adopt: raw.adopt } : {}),
    decisions: parseDecisions(raw.decisions),
  };
}

function readResumeDecisions(
  meta: Record<string, unknown> | null | undefined,
): ResumeDecision[] | null {
  return readResumeMeta(meta)?.decisions ?? null;
}

function parseDecisions(decisions: unknown): ResumeDecision[] | null {
  if (!Array.isArray(decisions)) return null;
  const parsed: ResumeDecision[] = [];
  for (const decision of decisions) {
    const entry = decision as { callId?: unknown; kind?: unknown; response?: unknown };
    if (
      typeof entry?.callId === "string" &&
      (entry?.kind === "approval" || entry?.kind === "ask") &&
      typeof entry?.response === "object" &&
      entry.response !== null
    ) {
      parsed.push({
        callId: entry.callId,
        kind: entry.kind,
        response: entry.response as Record<string, unknown>,
      });
    }
  }
  return parsed.length > 0 ? parsed : null;
}

function resumeApprovals(resume: readonly ResumeDecision[] | null): Map<string, ApprovalDecision> {
  const map = new Map<string, ApprovalDecision>();
  for (const decision of resume ?? []) {
    if (
      decision.kind === "approval" &&
      (decision.response as { decision?: unknown }).decision === "allow"
    ) {
      map.set(decision.callId, {
        decision: "allow",
        reason: "human decision replayed into the resumed run (ADR 0038)",
      });
    }
  }
  return map;
}

function toolKindFor(toolName: string): string {
  if (toolName === "bash") return "execute";
  if (toolName === "read" || toolName === "glob") return "read";
  if (toolName === "write" || toolName === "edit") return "edit";
  if (toolName === "grep") return "search";
  if (toolName === "browser" || toolName === "web_search") return "fetch";
  return "other";
}

type MappedWireEvent = { update: object } | { oma: unknown };

/** Wire event envelope (id/type/data, the same shape the RPC mode
 *  forwards) → either a standard session/update payload payload or an
 *  oma-private blob for the `_oma/update` custom notification. Field reads
 *  mirror the oma adapter's mapper — one dialect, two directions. */
function mapWireEvent(envelope: RunEventEnvelope): MappedWireEvent[] {
  const data = envelope.data as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text : "";
  switch (envelope.type) {
    case "message_update":
      return [
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      ];
    case "thinking_update":
      return [
        { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } },
      ];
    case "tool_execution_start": {
      const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (!callId) return [];
      const activity = typeof data.activity === "string" ? data.activity : undefined;
      return [
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: callId,
            name: toolName,
            title: activity ?? toolName,
            kind: toolKindFor(toolName),
            status: "pending",
          },
        },
      ];
    }
    case "tool_execution_end": {
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (!callId) return [];
      const result = data.result;
      return [
        {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "completed",
            ...(result !== undefined && result !== null && typeof result === "object"
              ? { rawOutput: result }
              : {}),
          },
        },
      ];
    }
    case "todo_update": {
      const items = Array.isArray(data.items)
        ? (data.items as { text?: unknown; status?: unknown }[])
        : [];
      return [
        {
          update: {
            sessionUpdate: "plan",
            entries: items.map((item) => ({
              content: typeof item.text === "string" ? item.text : "",
              priority: "medium",
              status:
                item.status === "done"
                  ? "completed"
                  : item.status === "in_progress"
                    ? "in_progress"
                    : "pending",
            })),
          },
        },
      ];
    }
    case "tool_output":
      // Display-only stream; v1 has no clean equivalent — dropped rather
      // than faked into a tool_call_update content array.
      return [];
    default:
      // agent/turn lifecycle, retry, compaction, queue, mcp mounts,
      // delegation, stream rules: oma-private → the custom notification.
      return [{ oma: envelope }];
  }
}

function toAcpUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): SdkUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cachedReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
  } as SdkUsage;
}

function processStream(): ReturnType<typeof acp.ndJsonStream> {
  // Server side of the pipe: we WRITE to our stdout and READ our stdin
  // (the parent's spawn view is the mirror image — do not copy it).
  return acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
}

/** The approval gate as an ACP permission request: park the resolver, fail
 *  closed at the deadline, map the client's chosen optionId back to
 *  allow/deny. Cancelled or errored requests deny — never a hang. */
function acpApproval(
  client: acp.AgentContext,
  session: AcpSession,
  req: Parameters<ApprovalHandler>[0],
  pendingApprovals: Map<string, (d: ApprovalDecision) => void>,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    const settle = (d: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      pendingApprovals.delete(req.callId);
      resolve(d);
    };
    pendingApprovals.set(req.callId, settle);
    void client
      .request(acp.methods.client.session.requestPermission, {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: req.callId,
          title: req.reason ?? `${req.toolName} needs approval`,
          kind: toolKindFor(req.toolName),
          status: "pending",
          ...(req.input !== undefined ? { rawInput: req.input } : {}),
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      } as never)
      .then(
        (response: RequestPermissionResponse) => {
          if (response.outcome.outcome !== "selected") {
            settle({ decision: "deny", reason: "client cancelled the request" });
            return;
          }
          const allowed = response.outcome.optionId === "allow-once";
          settle({
            decision: allowed ? "allow" : "deny",
            ...(allowed ? {} : { reason: "denied by the client" }),
          });
        },
        (err: unknown) => {
          settle({ decision: "deny", reason: `permission request failed: ${String(err)}` });
        },
      );
    const timeoutMs =
      req.deadlineAt === undefined ? approvalTimeoutMs() : Math.max(1, req.deadlineAt - Date.now());
    if (timeoutMs > 0) {
      setTimeout(
        () => settle({ decision: "deny", reason: "approval deadline exceeded" }),
        timeoutMs,
      );
    }
  });
}
