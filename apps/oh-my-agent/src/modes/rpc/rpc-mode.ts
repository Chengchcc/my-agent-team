import { existsSync, statSync } from "node:fs";
import type { BackendRunOutcome, BackendRunSegment } from "@chengchenccc/agent-contract";
import { debugLog } from "@chengchenccc/agent-contract";
import type { ModelRuntime, ModelRuntimeEntry } from "@chengchenccc/ai";
import { type Message, MessageSchema } from "@chengchenccc/message";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  approvalTimeoutMs,
} from "../../core/runtime/approval.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import { buildSystemPrompt, readMemorySummary } from "../../core/runtime/prompts.js";
import { resolveModelEntry } from "../../core/runtime/run-runtime.js";
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
import type {
  AbortCommand,
  ExecuteCommand,
  OmaCommand,
  OmaOutput,
  SteerCommand,
} from "../../protocol/index.js";
import {
  codingAgentCommandSchema,
  eventOutputSchema,
  outcomeOutputSchema,
  responseOutputSchema,
} from "../../protocol/index.js";
import { forWire } from "../../protocol/mapping.js";
import { createJsonlReader } from "./jsonl.js";
/** Minimal RPC mode: stdin JSONL commands, stdout JSONL outputs only, stderr
 *  for logs. One process = at most one execute = one Run = one outcome, then
 *  the process exits. No Session lifecycle, no HTTP, no registry. */

export interface RpcModeOptions {
  modelRuntime: ModelRuntime;
  stdin?: ReadableStream<Uint8Array>;
  /** stdout writer; the RPC mode ONLY writes JSONL lines here. */
  writeLine?: (line: string) => void;
  log?: (line: string) => void;
}

export interface RpcModeController {
  readonly promise: Promise<number>;
  /** Abort the live Run (SIGINT/SIGTERM path): outcome settles aborted. */
  stop(): void;
}

function redactError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runRpcMode(opts: RpcModeOptions): RpcModeController {
  const stdin = opts.stdin ?? Bun.stdin.stream();
  const write = opts.writeLine ?? ((line: string) => process.stdout.write(line));
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  // Serialized output: whole lines, in order, never interleaved.
  let writeChain: Promise<void> = Promise.resolve();
  const emit = (output: OmaOutput): void => {
    let line: string;
    try {
      line = JSON.stringify(output);
    } catch {
      // A non-serializable envelope (e.g. a BigInt in a tool result) must
      // not take down the writer.
      log("omitted non-serializable output envelope");
      return;
    }
    writeChain = writeChain
      // Both callbacks are errors-as-values: the reader loop `for await`s
      // stdin and drives emit synchronously, so a write failure surfacing
      // as a rejection anywhere in this chain would kill the command loop
      // (steer/abort/resolve_approval stop being read for the rest of the
      // run). A dead peer becomes a logged no-op instead.
      .then(
        () => write(`${line}\n`),
        (err: unknown) => log(`output write skipped: ${redactError(err)}`),
      )
      .then(undefined, (err: unknown) => log(`output write failed: ${redactError(err)}`));
  };
  const emitResponse = (
    id: string,
    command: OmaCommand["type"],
    success: boolean,
    error?: string,
  ): void => {
    let envelope: OmaOutput;
    try {
      envelope = responseOutputSchema.parse({
        id,
        type: "response",
        command,
        success,
        ...(success ? {} : { error: error ?? "command failed" }),
      });
    } catch (caught) {
      // Contract drift guard: a response envelope that fails to validate
      // (schema vs command union) is a bug, but not worth killing the
      // command loop over — the peer times out on its own.
      log(`response envelope invalid (${command}): ${redactError(caught)}`);
      return;
    }
    emit(envelope);
  };

  let runtime: OmaRuntime | null = null;
  let currentRunId: string | null = null;
  let executed = false;
  let finished = false;

  const reader = createJsonlReader(stdin);

  /** runId → (callId → resolver). Late/unknown resolutions fail soft. */
  const pendingApprovalsByRun = new Map<string, Map<string, (d: ApprovalDecision) => void>>();

  const promise = (async (): Promise<number> => {
    try {
      for await (const line of reader.lines) {
        if (finished) {
          // The Run settled: the process exits. One more line is read so a
          // protocol-violating second execute gets an explicit rejection;
          // anything else (or EOF) just ends the process.
          if (line.trim()) {
            try {
              const command = codingAgentCommandSchema.parse(JSON.parse(line));
              if (command.type === "execute") {
                emitResponse(
                  command.id,
                  "execute",
                  false,
                  "a process accepts at most one execute command",
                );
              }
            } catch {
              /* ignored: the process is exiting */
            }
          }
          break;
        }
        if (!line.trim()) continue;
        let command: OmaCommand;
        try {
          command = codingAgentCommandSchema.parse(JSON.parse(line));
        } catch {
          // Malformed JSON: a failure response keeps the protocol clean; the
          // peer settles the Run failed on an uncorrelated response.
          log(`malformed command (${line.length} bytes)`);
          emit(
            responseOutputSchema.parse({
              id: "",
              type: "response",
              command: "execute",
              success: false,
              error: "malformed JSON command",
            }),
          );
          continue;
        }
        switch (command.type) {
          case "execute": {
            if (executed) {
              // Protocol invariant: one process → at most one execute.
              emitResponse(
                command.id,
                "execute",
                false,
                "a process accepts at most one execute command",
              );
              break;
            }
            executed = true; // consumed synchronously: no double-execute race
            // Acceptance is AWAITED so the success response is always the
            // first output; the loop itself runs concurrently below so
            // steer/abort written after acceptance stay routable.
            await acceptExecute(command);
            break;
          }
          case "steer":
            handleSteer(command);
            break;
          case "abort":
            handleAbort(command);
            break;
          case "resolve_approval": {
            const resolve = pendingApprovalsByRun.get(command.runId)?.get(command.callId);
            if (resolve) {
              resolve({ decision: command.decision });
              emitResponse(command.id, "resolve_approval", true);
            } else {
              emitResponse(
                command.id,
                "resolve_approval",
                false,
                `no pending approval ${command.callId}`,
              );
            }
            break;
          }
        }
      }
      if (!finished) {
        log(`stdin closed before an outcome was produced (executed=${executed})`);
        return 1;
      }
      return await writeChain.then(() => 0);
    } catch (err) {
      log(`rpc mode failed: ${redactError(err)}`);
      return 1;
    }
  })();

  /** Validate + assemble the Runtime, START the loop, and emit the execute
   *  response ONLY once the loop is live (agent_start). Awaited by the
   *  reader so the acceptance response is always the first output AND
   *  implies steer/abort are routable; the outcome runs CONCURRENTLY via
   *  driveOutcome, keeping steer/abort routable for the whole run. */
  async function acceptExecute(command: ExecuteCommand): Promise<void> {
    const input = command.input;
    debugLog("oma", `execute_received runId=${input.run.runId}`);
    const err = await validateExecute(input, opts.modelRuntime);
    if (err) {
      emitResponse(command.id, "execute", false, err);
      return;
    }
    const runId = input.run.runId;
    // Session (ADR 0003 decision 6): the child owns its session file; the
    // product forwards the branch's opaque reference. Resume loads the
    // transcript as the loop's seed history (validated at the file
    // boundary); a ref whose file is missing/empty degrades to a fresh
    const resumeId = input.run.cliSessionRef;
    // The session dir is a RUN fact, not a process fact: derived from the
    // run's workspace root (the child's cwd in production), with the flat
    // OMA_SESSION_DIR override still winning for dev/tests.
    const sessionDir = process.env.OMA_SESSION_DIR ?? sessionDirFor(input.workspace.root);
    let sessionId = resumeId ?? newSessionId();
    // ADR 0038: a run killed mid-flight never settles, so the branch has
    // no cliSessionRef to forward — the resume child must find its own
    // predecessor. The workspace lock serializes runs per root, so the
    // newest INTERRUPTED parked_turn marker in the workspace's session dir
    // is unambiguously the session to adopt (continuation appends to it).
    if (input.resume && !resumeId) {
      // The SAME directory this dispatch reads and writes: deriving it here
      // would ignore the OMA_SESSION_DIR override.
      const adopted = findInterruptedSession(sessionDir);
      if (adopted) {
        sessionId = adopted;
        debugLog("oma", `resume_adopted_session runId=${runId} session=${adopted}`);
      }
    }
    const loaded = withoutOrphanToolResults(loadSessionMessages(sessionId, sessionDir));
    const resume = input.resume;
    // A corrupt line must degrade that entry (log + skip), never brick the
    // whole resume: MessageSchema.parse throws on the first bad shape.
    const parsedTranscript: { productEntryId: string; message: Message }[] = [];
    for (const [i, message] of loaded.entries()) {
      try {
        parsedTranscript.push({
          productEntryId: `session:${i}`,
          message: MessageSchema.parse(message) as Message,
        });
      } catch {
        console.warn(`[rpc] skipping malformed session line ${i} for ${resumeId}`);
      }
    }
    // ADR 0038 resume: this dispatch re-runs a turn that died parked on
    // HITL. The parked-turn marker carries the interrupted assistant
    // (tool_use) message; its calls complete from the wire's decisions
    // instead of re-running the turn.
    const parkedTurn = resume ? loadLastParkedTurn(sessionId, sessionDir) : null;
    /** The interrupted assistant this dispatch completes. It is a marker, not
     *  a logged message, so nothing else will ever write it: unless THIS run
     *  persists and commits it, the log and the ledger keep a tool_result
     *  whose assistant(tool_use) is missing and the provider refuses the next
     *  turn ("Messages with role 'tool' must be a response to a preceding
     *  message with 'tool_calls'", live 2026-09-28). Written here, before the
     *  tools run, so the log order stays assistant -> tool_result. */
    let resumedAssistant: Message | null = null;
    if (resume && parkedTurn?.interrupted) {
      try {
        const parkedMessage = MessageSchema.parse(parkedTurn.message) as Message;
        parsedTranscript.push({
          productEntryId: `session:${parsedTranscript.length}`,
          message: parkedMessage,
        });
        const alreadyLogged = loaded.some((m) => m.id === parkedMessage.id);
        if (!alreadyLogged) {
          appendSessionMessages(sessionId, process.cwd(), [parkedMessage], sessionDir);
          resumedAssistant = parkedMessage;
        }
      } catch {
        console.warn(`[rpc] malformed parked-turn marker for ${sessionId}: ignoring`);
      }
    }
    // File-level message-id seen set: the real-time persistence hook must
    // never write a message the file already has (the resume prompt is the
    // SAME canonical message as the seed's copy — the store dedups it by
    // productEntryId, this guards the file side).
    const persistedIds = new Set(
      parsedTranscript.map((t) => t.message.id).filter((id): id is string => id != null),
    );
    const inputCopyIndex = parsedTranscript.findIndex(
      (t) =>
        t.message.id != null &&
        input.input.message.id != null &&
        t.message.id === input.input.message.id,
    );
    const sessionTranscript = parsedTranscript.length > 0 ? parsedTranscript : undefined;
    let effectiveInput: typeof input;

    let segment: BackendRunSegment<"oma">;
    try {
      // cwd-based meta (ADR 0003 decision 6): skills and the system prompt
      // live in workspace files (.oma/skills + AGENTS.md/SOUL.md/USER.md).
      // Explicit run-input values (Loop scopes) win over the cwd fallback.
      const cwdSkills = scanWorkspaceSkillRoots(input.workspace.root);
      const cwdPrompt = readWorkspaceSystemPrompt(input.workspace.root);
      const bridged = input.run.systemPrompt
        ? input
        : {
            ...input,
            run: {
              ...input.run,
              systemPrompt: buildSystemPrompt({
                workspacePrompt: cwdPrompt,
                memorySummary: readMemorySummary(input.workspace.root),
                cwd: input.workspace.root,
              }),
            },
          };
      // Resume dedup (ADR 0038): the seed already carries this input as
      // `session:<k>`; sharing that productEntryId makes the store's dedup
      // drop the second prompt append.
      effectiveInput =
        inputCopyIndex >= 0
          ? {
              ...bridged,
              input: { ...bridged.input, productEntryId: `session:${inputCopyIndex}` },
            }
          : bridged;
      // ADR 0038: decisions for the resumed turn's approvals, pre-supplied
      // so re-executing an allowed tool never re-asks the human (same
      // callId — the parked tool_use id).
      const resumeApprovals = new Map<string, ApprovalDecision>();
      for (const d of resume?.decisions ?? []) {
        if (d.kind === "approval" && (d.response as { decision?: unknown }).decision === "allow") {
          resumeApprovals.set(d.callId, {
            decision: "allow",
            reason: "human decision replayed into the resumed run (ADR 0038)",
          });
        }
      }
      // Plugin components (spec): policy resolved in the mode layer — RPC
      // NEVER loads project-scope code; user-scope needs enablement only.
      const pluginRt = await assemblePluginRuntime(input.workspace.root, "rpc");
      for (const w of pluginRt.warnings) debugLog("oma", `plugin: ${w}`);
      // HITL approval pipe (spec): emit approval_request on stdout, park the
      // resolver, resolve on the resolve_approval command; deadline = deny.
      // The resolver settles EXACTLY once and leaves the map the moment it
      // fires (human or deadline): a late second click then gets the
      // explicit "no pending approval" failure instead of a false success
      // over a race that already ended.
      const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
      pendingApprovalsByRun.set(runId, pendingApprovals);
      let approvalSeq = 10_000;
      const rpcApproval: ApprovalHandler = (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          let settled = false;
          const settle = (d: ApprovalDecision): void => {
            if (settled) return;
            settled = true;
            pendingApprovals.delete(req.callId);
            resolve(d);
          };
          pendingApprovals.set(req.callId, settle);
          emit(
            eventOutputSchema.parse({
              type: "event",
              runId,
              // Own id space (10k+): the runtime's envelope seq is internal;
              // consumers key on type + data.callId, not global id order.
              event: {
                id: approvalSeq++,
                type: "approval_request",
                data: {
                  callId: req.callId,
                  toolName: req.toolName,
                  reason: req.reason ?? `${req.toolName} requested approval (${req.source})`,
                  input: req.input,
                  // BashSandbox design P4: distinguish unsandboxed fallback
                  // from OS-sandboxed execution on the approval card.
                  ...(req.sandboxed === undefined ? {} : { sandboxed: req.sandboxed }),
                  // The runtime's stamped deadline: the card shows it, so the
                  // local fail-closed must use the SAME number (two sources
                  // would let the card promise a moment that never arrives).
                  ...(req.deadlineAt === undefined ? {} : { deadlineAt: req.deadlineAt }),
                },
              },
            }),
          );
          const timeoutMs =
            req.deadlineAt === undefined
              ? approvalTimeoutMs()
              : Math.max(1, req.deadlineAt - Date.now());
          if (timeoutMs > 0) {
            setTimeout(
              () => settle({ decision: "deny", reason: "approval deadline exceeded" }),
              timeoutMs,
            );
          }
        });
      runtime = await createOmaRuntime({
        runId,
        // ADR 0038: a resumed turn's allowed approvals answer from the
        // pre-supplied map (same callId) — the human is never re-asked.
        approvalHandler: (req) =>
          resumeApprovals.has(req.callId)
            ? Promise.resolve(resumeApprovals.get(req.callId)!)
            : rpcApproval(req),
        modelId: input.run.model.modelId,
        workspaceRoot: input.workspace.root,
        workspaceAccess: input.workspace.access,
        modelRuntime: opts.modelRuntime,
        skillRoots: input.run.skillRoots?.length ? input.run.skillRoots : cwdSkills,
        // The RPC child has a session id too (resumed from the branch's
        // cliSessionRef, or minted per run). Passing it as the todo scope is
        // what standalone modes already do; without it the native todo store
        // fell back to the workspace-global `.oma/todo.json`, so a task list
        // written by ANY conversation in this workspace was injected into
        // every other one — the item that derailed a Lark run came from an
        // unrelated earlier session.
        todoScope: sessionId,
        ...(pluginRt.plugins.length || pluginRt.mcpServers.length
          ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
          : {}),
        ...(input.run.permissionMode ? { permissionMode: input.run.permissionMode } : {}),
        sessionTranscript,
        // Real-time session persistence (pi appendMessage, ADR 0038): every
        // conversational message lands in the file as it happens, so a
        // killed process leaves its trail. The seen-id set keeps the resume
        // prompt's store-level dedup from double-writing the file.
        onPersistMessages: (messages) => {
          const fresh = messages.filter((m) => !m.id || !persistedIds.has(m.id));
          for (const m of fresh) if (m.id) persistedIds.add(m.id);
          if (fresh.length > 0) {
            appendSessionMessages(sessionId, process.cwd(), fresh, sessionDir);
          }
        },
        // Parked-turn marker (ADR 0038): the assistant(tool_use) of a turn
        // whose tools are about to run — the durable trace an interrupted
        // turn resumes from.
        onParkedTurn: (message) => appendParkedTurnMarker(sessionId, message, sessionDir),
        onEvent: (event) => {
          // forWire drops oma-internal fields (raw tool input) before the
          // frame leaves the process — the mapper's later omission of `input`
          // cannot protect stdout/logs/backend, which see the frame first.
          if (!finished)
            emit(eventOutputSchema.parse({ type: "event", runId, event: forWire(event) }));
        },
      });
      // run() resolves when the loop is live: acceptance ⟹ routable.
      segment = await runtime.run(effectiveInput as never);
      debugLog(
        "oma",
        `runtime_assembled runId=${runId} skills=${(input.run.skillRoots?.length ? input.run.skillRoots : cwdSkills).length} access=${input.workspace.access}`,
      );
    } catch (caught) {
      emitResponse(command.id, "execute", false, `runtime assembly failed: ${redactError(caught)}`);
      return;
    }

    // Acceptance: the runtime is assembled, event forwarding is registered,
    // the loop is live, and steer/abort route to it.
    currentRunId = runId;
    debugLog("oma", `loop_live runId=${runId}`);
    emitResponse(command.id, "execute", true, undefined);

    void driveOutcome(runtime, segment, runId, sessionId, sessionDir, resumedAssistant);
  }
  /** Await the outcome, emit the outcome envelope, flush, close the runtime,
   *  then END the reader so the process exits on its own (one Run → one
   *  outcome → exit) - no dependency on the parent closing stdin. */
  async function driveOutcome(
    runtime: OmaRuntime,
    segment: BackendRunSegment<"oma">,
    runId: string,
    sessionId: string,
    sessionDir: string,
    resumedAssistant: Message | null,
  ): Promise<void> {
    let outcome: BackendRunOutcome;
    try {
      outcome = await segment.outcome;
    } catch (caught) {
      outcome = { status: "failed", error: redactError(caught) };
    }
    // The resumed turn's own first message: the assistant(tool_use) whose
    // calls this run executed. The product commits outcome.messages verbatim,
    // so omitting it leaves the ledger's canonical sequence invalid.
    if (resumedAssistant && outcome.status === "completed") {
      outcome = {
        ...outcome,
        messages: [resumedAssistant, ...(outcome.messages ?? [])],
      };
    }
    // Finalize the turn in the session file (ADR 0003 + ADR 0038):
    // conversational messages were already written in REAL TIME by
    // onPersistMessages; what remains is compaction summaries and the auto
    // title/summary.
    if (outcome.status === "completed") {
      await persistSessionTurn({
        sessionId,
        cwd: process.cwd(),
        runtime,
        dir: sessionDir,
        ...(outcome.title ? { title: outcome.title } : {}),
        ...(outcome.summary ? { summary: outcome.summary } : {}),
      });
    }
    const outcomeWithRef: BackendRunOutcome = {
      ...outcome,
      cliSessionRef: sessionId,
    };
    finished = true;
    await runtime.close().catch(() => {});
    debugLog("oma", `runtime_closed runId=${runId}`);
    emit(outcomeOutputSchema.parse({ type: "outcome", runId, outcome: outcomeWithRef }));
    debugLog("oma", `outcome runId=${runId} status=${outcome.status}`);
    await writeChain;
    // Unblock the reader: the pending stdin read resolves done and the main
    // promise returns; main() exits with the code. Never a hard process.exit
    // before the outcome is written and the runtime closed.
    await reader.cancel();
    debugLog("oma", `rpc_exit runId=${runId}`);
  }

  function handleSteer(command: SteerCommand): void {
    debugLog("oma", `steer_received runId=${command.runId}`);
    if (!executed || command.runId !== currentRunId || !runtime) {
      emitResponse(
        command.id,
        "steer",
        false,
        `no live run for runId: ${command.runId} (current: ${currentRunId ?? "none"})`,
      );
      return;
    }
    try {
      void runtime.steer(command.input as never).then(
        () => emitResponse(command.id, "steer", true),
        (err: unknown) => emitResponse(command.id, "steer", false, redactError(err)),
      );
    } catch (caught) {
      emitResponse(command.id, "steer", false, redactError(caught));
    }
  }

  /** Deny a run's parked approvals so an abort can unwind. A tool call
   *  blocked on the human (default wait: 24h) never returns otherwise, the
   *  loop cannot stop, and the parent waits out its abort grace and SIGKILLs
   *  the child - "oma process did not stop within the abort grace period",
   *  which reads as a crash instead of "you stopped it" (live 2026-09-28). */
  function releaseParkedApprovals(runId: string): void {
    const pending = pendingApprovalsByRun.get(runId);
    if (!pending || pending.size === 0) return;
    // Snapshot the resolvers: settling deletes from the map.
    for (const settle of [...pending.values()]) {
      settle({ decision: "deny", reason: "run stopped by the user" });
    }
  }

  function handleAbort(command: AbortCommand): void {
    debugLog("oma", `abort_received runId=${command.runId}`);
    if (!executed || command.runId !== currentRunId || !runtime) {
      emitResponse(
        command.id,
        "abort",
        false,
        `no live run for runId: ${command.runId} (current: ${currentRunId ?? "none"})`,
      );
      return;
    }
    releaseParkedApprovals(command.runId);
    void runtime.stop().then(
      () => emitResponse(command.id, "abort", true),
      (err: unknown) => emitResponse(command.id, "abort", false, redactError(err)),
    );
  }

  return {
    promise,
    stop() {
      if (runtime) void runtime.stop().catch(() => {});
    },
  };
}

/** Execute acceptance preflight: payload schema valid (already parsed),
 *  model valid/available in the runtime catalog, workspace valid. */
async function validateExecute(
  input: ExecuteCommand["input"],
  modelRuntime: ModelRuntime,
): Promise<string | null> {
  if (input.run.model.backendKind !== "oma") {
    return `unsupported backend kind: ${input.run.model.backendKind}`;
  }
  if (!existsSync(input.workspace.root) || !statSync(input.workspace.root).isDirectory()) {
    return `workspace root is not a directory: ${input.workspace.root}`;
  }
  // Same resolution the Run assembly uses (alias table included): acceptance
  // must never reject an id the runtime itself would happily run.
  let model: ModelRuntimeEntry;
  try {
    model = await resolveModelEntry(modelRuntime, input.run.model.modelId);
  } catch (err) {
    return redactError(err);
  }
  if (model.available === false) return `model unavailable: ${input.run.model.modelId}`;
  return null;
}
