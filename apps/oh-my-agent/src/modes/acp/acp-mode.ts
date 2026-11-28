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

import type { Usage as SdkUsage } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import { sanitizeServerName } from "@chengchenccc/adapter-mcp";
import type { ModelRuntime } from "@chengchenccc/ai";
import { type Message, MessageSchema } from "@chengchenccc/message";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import { disabledToolsFromEnv } from "../../core/runtime/agent-loop-runner.js";
import type { ApprovalDecision } from "../../core/runtime/approval.js";
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
import { answeredPrefixLength } from "../shared.js";
import {
  type AcpMcpServerDeclaration,
  acpApproval,
  type DeclaredPermissionMode,
  fetchAcpMcpTools,
  MODEL_CONFIG_ID,
  mapWireEvent,
  modelConfigOptions,
  OMA_UPDATE_METHOD,
  parseSteerParams,
  processStream,
  promptMessageOf,
  type ResumeDecision,
  readAcpMcpServers,
  readPermissionMode,
  readResumeDecisions,
  readResumeMeta,
  readSkillRoots,
  readSystemPrompt,
  resumeApprovals,
  STEER_METHOD,
  toAcpUsage,
} from "./acp-protocol.js";

export { readPermissionMode, readSkillRoots, readSystemPrompt };

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

interface AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly permissionMode: DeclaredPermissionMode;
  readonly acpMcpServers: readonly AcpMcpServerDeclaration[];
  /** Authoritative host/product system prompt passed over `_meta` (ADR 0039 rule 2). */
  readonly systemPrompt: string | null;
  /** Product-assigned skill pack roots passed over `_meta`. */
  readonly skillRoots: readonly string[];
  /** Decisions read off a session/load's `_meta` (ADR 0039
   *  extension-vehicle rule 2): the NEXT prompt completes the parked turn
   *  with them pre-supplied — the ACP shape of ADR 0038's resume. */
  resumeDecisions: readonly ResumeDecision[] | null;
  /** The model this session runs, chosen by the client through the
   *  `model` config option. null = the mode's own resolution (explicit
   *  --model, else the first available catalog entry). */
  model: string | null;
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
  let promptInFlightSessionId: string | null = null;
  let cancelledInFlight = false;
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
        systemPrompt: readSystemPrompt(meta),
        skillRoots: readSkillRoots(meta),
        resumeDecisions: resumeMeta?.decisions ?? null,
        permissionMode: readPermissionMode(meta),
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
        systemPrompt: readSystemPrompt(meta),
        skillRoots: readSkillRoots(meta),
        resumeDecisions: readResumeDecisions(meta),
        permissionMode: readPermissionMode(meta),
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
      // Single-flight guard set BEFORE any await so concurrent session/prompt
      // requests cannot race through assemblePluginRuntime / createOmaRuntime.
      if (promptInFlightSessionId !== null || live) {
        throw acp.RequestError.invalidParams(undefined, "a prompt is already running");
      }
      promptInFlightSessionId = session.sessionId;
      cancelledInFlight = false;
      try {
        return await runPrompt(session, promptMessageOf(ctx.params.prompt), ctx.client);
      } finally {
        promptInFlightSessionId = null;
        cancelledInFlight = false;
      }
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
      if (promptInFlightSessionId === ctx.params.sessionId) {
        cancelledInFlight = true;
      }
      if (!live || live.sessionId !== ctx.params.sessionId) return;
      releaseParkedApprovals();
      void live.runtime.stop().catch(() => {});
    });

  const finishOnDisconnect = () => {
    cancelledInFlight = true;
    releaseParkedApprovals();
    if (live) void live.runtime.stop().catch(() => {});
    resolveExit?.(0);
  };
  const connection = app.connect(opts.stream ?? processStream());
  void connection.closed.then(finishOnDisconnect, finishOnDisconnect);

  return {
    promise,
    stop() {
      finishOnDisconnect();
      connection.close();
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
    prompt: Message,
    client: acp.AgentContext,
  ): Promise<{ stopReason: "end_turn" | "cancelled"; usage?: SdkUsage }> {
    const sessionDir = process.env.OMA_SESSION_DIR ?? sessionDirFor(session.cwd);
    const resume = session.resumeDecisions;
    session.resumeDecisions = null;
    const loaded = withoutOrphanToolResults(loadSessionMessages(session.sessionId, sessionDir));
    // ADR 0038 parked-turn completion: when resuming a run that died parked on
    // HITL, the trailing user message in `loaded` IS the prompt that the parked
    // assistant(tool_use) answered. Keep it in place so the branch order stays
    // strictly [..., user(P1), assistant(tool_use), tool(tool_result), meta]
    // instead of stripping P1 and re-appending it between tool_use and tool_result.
    const parkedTurn = resume ? loadLastParkedTurn(session.sessionId, sessionDir) : null;
    const resumingParked = Boolean(resume && parkedTurn?.interrupted);
    const seeded = resumingParked ? loaded : loaded.slice(0, answeredPrefixLength(loaded));
    const transcript: { productEntryId: string; message: Message }[] = [];
    for (const [i, message] of seeded.entries()) {
      try {
        transcript.push({
          productEntryId: `session:${i}`,
          message: MessageSchema.parse(message) as Message,
        });
      } catch {
        log(`[acp] skipping malformed session line ${i}`);
      }
    }
    let resumedAssistant: Message | null = null;
    if (resumingParked && parkedTurn) {
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
    const promptMessage: Message = prompt;

    const cwdSkills = scanWorkspaceSkillRoots(session.cwd);
    const mergedSkillRoots = [...new Set([...session.skillRoots, ...cwdSkills])];
    // When the product backend provides an authoritative systemPrompt (already
    // carrying filtered SOUL/USER + front-desk discipline + recall), skip raw
    // SOUL.md/USER.md re-reads from cwd so placeholders never leak and identity
    // is never duplicated — while still loading repo AGENTS.md rules from cwd.
    const cwdPrompt = readWorkspaceSystemPrompt(session.cwd, {
      includeIdentity: session.systemPrompt === null,
    });
    const pluginRt = await assemblePluginRuntime(session.cwd, "acp", {
      permissionMode: session.permissionMode,
    });
    for (const warning of pluginRt.warnings) log(`[acp] plugin: ${warning}`);
    // MCP-over-ACP servers ride the plugin seam: tools fetched over
    // mcp/message, executed over mcp/message, adapted with the same
    // mcp__<server>__<tool> naming every other mount uses.
    const acpMcpTools = await fetchAcpMcpTools(client, session, log);
    // Servers the product declared over this connection ride MCP-over-ACP
    // (the identity-carrying rail). The runtime's exclusion covers BOTH the
    // plugin configs and the workspace .mcp.json it mounts itself — a
    // file-based duplicate won the tool table and silently dropped the call
    // identity (#26, traced live).
    // Canonical keys on BOTH sides: the mount loop compares sanitized names,
    // so the exclusion set must use the same normalization or a workspace key
    // with different case/spacing bypasses it and the duplicate wins by
    // mount order, silently dropping the call identity (#49).
    const acpDeclared = new Set(
      session.acpMcpServers.map((server) => sanitizeServerName(server.name)),
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
    // ADR 0072: the backend freezes a role's denied tools into this process's
    // env (OMA_DISABLED_TOOLS). The RPC loop honored it; THIS path did not, so
    // a front desk on ACP could still fetch the web and spawn subagents after
    // its file tools were gone (live 2026-11-21). Same env, same parser, and
    // the filter reaches native tools, plugin tools and the delegation tool.
    const disabledTools = disabledToolsFromEnv();
    const runtime = await createOmaRuntime({
      runId: `acp-${session.sessionId}`,
      ...(disabledTools.size > 0 ? { toolFilter: { deny: disabledTools } } : {}),
      modelId,
      approvalHandler: (req) =>
        preSupplied.has(req.callId)
          ? Promise.resolve(preSupplied.get(req.callId)!)
          : acpApproval(client, session, req, pendingApprovals),
      workspaceRoot: session.cwd,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: mergedSkillRoots,
      // The client-declared policy (see readPermissionMode): a client that
      // declared "auto" runs its own classifier; one that declared nothing is
      // asked, because it IS the human surface.
      // Product ACP runs delegate long-term memory ownership to the backend:
      // disable oma's built-in post-run autonomous memory extraction so child
      // processes never concurrently overwrite MEMORY.md / memory_summary.md.
      autonomousMemory: false,
      permissionMode: session.permissionMode,
      todoScope: session.sessionId,
      excludeMcpServerNames: acpDeclared,
      ...(pluginRt.plugins.length || pluginRt.mcpServers.length || acpMcpTools.length
        ? {
            pluginComponents: {
              plugins: [
                ...pluginRt.plugins,
                ...(acpMcpTools.length > 0
                  ? [{ name: "acp-mcp", tools: acpMcpTools } as unknown as Plugin]
                  : []),
              ],
              mcpServers: pluginRt.mcpServers,
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

    let outcome: BackendRunOutcome;
    try {
      // Honor a session/cancel notification that arrived during pre-run setup
      // (plugin assembly / MCP list / runtime creation) before `live` was set.
      if (cancelledInFlight) {
        return { stopReason: "cancelled" };
      }

      const hasCodingTools =
        !disabledTools.has("write") && !disabledTools.has("edit") && !disabledTools.has("bash");
      const input = {
        input: {
          inputId: `acp-in-${session.sessionId}-${Date.now()}`,
          message: promptMessage,
        },
        run: {
          runId: `acp-${session.sessionId}`,
          model: { backendKind: "oma", modelId },
          configRevision: 1,
          systemPrompt: buildSystemPrompt({
            hostPrompt: session.systemPrompt ?? undefined,
            workspacePrompt: cwdPrompt,
            // External ACP clients (no backend hostPrompt) still get local
            // workspace memory summaries; product ACP runs delegate recall &
            // memory ownership to the backend (autonomousMemory: false).
            memorySummary: session.systemPrompt ? undefined : readMemorySummary(session.cwd),
            cwd: session.cwd,
            includeBase: hasCodingTools,
            includeLocalMemory: false,
          }),
        },
        workspace: { root: session.cwd, access: "read_write" },
        // ADR 0038: without this the runtime never enters its resume branch, so
        // the parked tool calls stay unpaired and the already-submitted HITL
        // decisions silently never apply.
        ...(resume ? { resume: { decisions: resume } } : {}),
      } as never;
      const segment = await runtime.run(input);
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
    } finally {
      releaseParkedApprovals();
      live = null;
      await runtime.close().catch(() => {});
    }

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
