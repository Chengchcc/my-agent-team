export interface ReflectMeta {
  isGenesis: boolean;
  agentId: string;
  agentMemberId: string;
}

export interface ReflectOrchestratorDeps {
  runMeta: Map<string, ReflectMeta>;
  /** ID generator — ulid in production, deterministic stub in tests. */
  genId: () => string;
  /** Build a spec JSON for a reflect run. Must include mode:"reflect" in the output. */
  buildSpecJson: (
    threadId: string,
    input: string,
    opts: { mode: "reflect"; runId: string; conversationId: string; senderMemberId: string },
  ) => Promise<string>;
  /** Fork a new runner subprocess. signature: supervisor.fork(runId, threadId, specJson). */
  fork: (runId: string, threadId: string, specJson: string) => void;
  /** Best-effort error hook — called when the reflect fork fails. */
  onError?: (runId: string, err: unknown) => void;
}

/**
 * Trigger a post-run reflection as an independent run (fire-and-forget).
 *
 * Called after `completeRun` has already released the conversation lock.
 * Returns `true` if a reflect run was started, `false` if skipped (genesis,
 * resume, or the completed run was itself a reflect run).
 *
 * Contract:
 * 1. Caller MUST call this AFTER completeRun — lock release is the caller's
 *    responsibility; this function never touches conversation locks.
 * 2. The reflect run uses `reflect:<main-threadId>` as its supervisor threadId
 *    so the run table and onRunComplete guard correctly isolate it.
 * 3. Best-effort: errors are logged via `onError` and swallowed — they never
 *    propagate to the caller or affect the main turn's settled results.
 */
export async function orchestrateReflection(
  threadId: string,
  runId: string,
  conversationId: string,
  deps: ReflectOrchestratorDeps,
): Promise<boolean> {
  // Gate 1: reflect run itself — never recurse
  if (threadId.startsWith("reflect:")) return false;

  const meta = deps.runMeta.get(runId);
  try {
    // Gate 2: resume runs have no meta (forkRun not called), genesis skips reflection
    if (!meta || meta.isGenesis) return false;

    const reflectRunId = deps.genId();
    const specJson = await deps.buildSpecJson(threadId, "", {
      mode: "reflect",
      runId: reflectRunId,
      conversationId,
      senderMemberId: meta.agentMemberId,
    });
    deps.fork(reflectRunId, `reflect:${threadId}`, specJson);
    return true;
  } catch (err) {
    deps.onError?.(runId, err);
    return false;
  } finally {
    deps.runMeta.delete(runId);
  }
}
