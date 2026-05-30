export interface InvokeFn {
  (req: {
    purpose: string
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<{ content: string; usage: { input: number; output: number } }>
}

export interface ChatCompleteRequest {
  purpose: string
  messages: Array<{ role: string; content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; tool_call_id?: string; name?: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
  signal?: AbortSignal
  model?: string
}

export interface ChatCompleteResponse {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage: { input: number; output: number }
}

export interface JobContext {
  invoke: InvokeFn
  chatComplete?: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  dispatchTool?: (call: { name: string; arguments: Record<string, unknown>; callId: string }) => Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }>
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  onProgress?: (payload: Record<string, unknown>) => void
}

/**
 * Spawns a short-lived worker for LLM-heavy, one-shot tasks
 * (evolution review, memory extract, sub-agent run). TJob and TResult must be
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
