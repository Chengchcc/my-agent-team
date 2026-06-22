import type { RunSupervisor } from "./supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { RunOriginKind, RunOriginRow } from "../runtime-ops/types.js";

/** Fields that must be provided per dispatch call — originKind, createdAt,
 *  and runId are filled by the dispatcher itself. */
export type RunOriginInput = Omit<RunOriginRow, "originKind" | "createdAt" | "runId">;

export type DispatchCause = {
  kind: RunOriginKind;
  runId: string;
  threadId: string;
  spec: Record<string, unknown>;
  opts?: Record<string, unknown>;
  origin: RunOriginInput;
};

export function createRunDispatcher(deps: {
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  now?: () => number;
}) {
  return {
    async dispatch(
      cause: DispatchCause,
    ): Promise<{ runId: string; attemptId: string }> {
      const { attemptId } = await deps.supervisor.startMainRun(
        cause.runId,
        cause.threadId,
        cause.spec,
        cause.opts as Parameters<RunSupervisor["startMainRun"]>[3] | undefined,
      );
      deps.opsStore.insertRunOrigin({
        ...cause.origin,
        runId: cause.runId,
        originKind: cause.kind,
        createdAt: (deps.now ?? Date.now)(),
      });
      return { runId: cause.runId, attemptId };
    },
  };
}

export type RunDispatcher = ReturnType<typeof createRunDispatcher>;
