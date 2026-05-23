/**
 * Spawns a short-lived worker for LLM-heavy, one-shot tasks
 * (evolution review, memory extract). TJob and TResult must be
 * JSON-safe — no Date, no Map, no circular references.
 */
export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string         // require.resolve(...) absolute path
    job: TJob
    timeoutMs?: number
  }): Promise<TResult>
}
