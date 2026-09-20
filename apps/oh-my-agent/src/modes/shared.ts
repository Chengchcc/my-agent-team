import type { BackendRunInput } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { vectorMemoryEnabled } from "../core/memory/vector-memory.js";
import type { PluginMcpConfig } from "../core/plugins/plugin-resolve.js";
import type { CreateOmaRuntimeOptions } from "../core/runtime/create-runtime.js";
import type { Plugin } from "../core/runtime/plugin.js";
import type { ToolFilter } from "../core/runtime/tool-filter.js";

/** The resumed CLI session (resolveSession result): the transcript seeds
 *  the run's store. Messages are wire-loose records by design — the session
 *  file's parse boundary validated them on load. */
export interface StandaloneSession {
  readonly sessionId: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly dir: string;
}

/** Shared runtime-options derivation for the standalone modes (print /
 *  json / tui). The conditional-spread discipline ("an absent option must
 *  not become an explicit undefined key — the runtime would treat it as a
 *  set value") lives HERE, once, instead of being hand-copied per mode —
 *  including the pluginComponents spread. `extras` are merged last and may
 *  override any base field (the TUI's process-stable registry, json's
 *  onEvent, ...). RPC mode is deliberately NOT a consumer: the product
 *  surface keeps its own frozen policy (no gateWorkspaceMcp, no
 *  vectorMemory, no localMemory). */
export function standaloneRuntimeOptions(
  built: BackendRunInput<"oma">,
  opts: {
    modelRuntime: ModelRuntime;
    toolFilter?: ToolFilter;
    session: StandaloneSession;
    /** Assembled plugin components (assemblePluginRuntime result). */
    pluginRt: {
      plugins: readonly Plugin[];
      mcpServers: readonly PluginMcpConfig[];
    };
  },
  extras: Partial<CreateOmaRuntimeOptions> = {},
): CreateOmaRuntimeOptions {
  return {
    runId: built.run.runId,
    modelId: built.run.model.modelId,
    workspaceRoot: built.workspace.root,
    workspaceAccess: built.workspace.access,
    modelRuntime: opts.modelRuntime,
    skillRoots: built.run.skillRoots ?? [],
    gateWorkspaceMcp: true,
    localMemory: true,
    todoScope: opts.session.sessionId,
    ...(built.run.permissionMode ? { permissionMode: built.run.permissionMode } : {}),
    ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
    ...(opts.pluginRt.plugins.length || opts.pluginRt.mcpServers.length
      ? {
          pluginComponents: {
            plugins: opts.pluginRt.plugins,
            mcpServers: opts.pluginRt.mcpServers,
          },
        }
      : {}),
    vectorMemory: vectorMemoryEnabled(built.workspace.root),
    sessionTranscript: seedTranscript(opts.session.messages),
    ...extras,
  };
}

/** The run seed: the session transcript minus a trailing unanswered user run.
 *
 *  A session can end on a user turn that never got a response (typed, then
 *  quit/killed before any assistant persist — the audit found "继续" dangling
 *  at a file tail). Seeding it verbatim replays that instruction into the
 *  next run's context AHEAD of whatever the user types next, so the model
 *  answers a ghost prompt. The FILE keeps the message (the TUI still shows
 *  the bubble the user typed); only the run seed drops the trailing user run.
 *  Exported for the seed test (pure function; the options builder needs a
 *  full BackendRunInput fixture to drive). The new input the user is about
 *  to send takes the dropped turn's place. */
export function seedTranscript(
  messages: readonly Record<string, unknown>[],
): CreateOmaRuntimeOptions["sessionTranscript"] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "user") end--;
  return end === 0
    ? undefined
    : messages.slice(0, end).map((m, i) => ({
        productEntryId: `session:${i}`,
        message: toTranscriptMessage(m),
      }));
}

/** Parse-boundary cast (the .omp/rules/no-unknown-as-cast exception):
 * loadSessionMessages validated these wire-loose session-file records on
 * read; this pins them to Message for the transcript seed. */
function toTranscriptMessage(m: Record<string, unknown>): Message {
  return m as unknown as Message;
}
