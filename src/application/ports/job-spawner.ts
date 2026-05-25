export interface InvokeFn {
  (req: {
    purpose: string
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<{ content: string; usage: { input: number; output: number } }>
}

export interface JobContext {
  invoke: InvokeFn
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * Spawns a short-lived worker for LLM-heavy, one-shot tasks
 * (evolution review, memory extract). TJob and TResult must be
 * JSON-safe — no Date, no Map, no circular references.
 */
export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string         // require.resolve(...) absolute path
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult>
}
