import type { BackendRunInput } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import { vectorMemoryEnabled } from "../core/memory/vector-memory.js";
import type { CreateOmaRuntimeOptions } from "../core/runtime/create-runtime.js";
import type { ToolFilter } from "../core/runtime/tool-filter.js";

/** Shared runtime-options derivation for the standalone modes (print /
 *  json / tui). The conditional-spread discipline ("an absent option must
 *  not become an explicit undefined key — the runtime would treat it as a
 *  set value") lives HERE, once, instead of being hand-copied per mode.
 *  `extras` are merged last and may override any base field (the TUI's
 *  process-stable registry, the one-shot modes' denyAllApprovals, ...).
 *  RPC mode is deliberately NOT a consumer: the product surface keeps its
 *  own frozen policy (no gateWorkspaceMcp, no vectorMemory). */
export function standaloneRuntimeOptions(
  built: BackendRunInput<"oma">,
  opts: {
    modelRuntime: ModelRuntime;
    toolFilter?: ToolFilter;
    /** Resumed CLI session (resolveSession result): the transcript seeds
     *  the run's store. */
    session: { messages: readonly unknown[] };
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
    ...(built.run.permissionMode ? { permissionMode: built.run.permissionMode } : {}),
    ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
    vectorMemory: vectorMemoryEnabled(built.workspace.root),
    sessionTranscript: opts.session.messages.length
      ? opts.session.messages.map((m, i) => ({
          productEntryId: `session:${i}`,
          message: m as never,
        }))
      : undefined,
    ...extras,
  };
}
