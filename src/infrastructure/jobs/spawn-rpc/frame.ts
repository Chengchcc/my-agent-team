// NDJSON frame codec for the spawn LLM bridge protocol.
// Each frame is one JSON line terminated by '\n'.

export type FrameKind =
  | 'init'          // parent -> worker: initialisation payload
  | 'invoke-req'    // worker -> parent: LLM call request (tool-free)
  | 'invoke-resp'   // parent -> worker: LLM call response
  | 'result'        // worker -> parent: job result (last frame)
  | 'log'           // worker -> parent: log relay
  | 'shutdown'      // parent -> worker: request graceful exit
  | 'error'         // bidirectional: error
  | 'chat-req'      // worker -> parent: LLM chat call (tool-capable)
  | 'chat-resp'     // parent -> worker: LLM chat response
  | 'chat-error'    // parent -> worker: LLM chat failed
  | 'tool-call-req' // worker -> parent: call parent's tool catalog
  | 'tool-call-resp'// parent -> worker: tool execution result
  | 'progress'      // worker -> parent: intermediate status (optional)

export interface Frame {
  v: 1
  /** UUID v4 — used to match requests with responses. */
  id: string
  kind: FrameKind
  /** Sender timestamp in ms. */
  ts: number
  payload: unknown
}

// ── Payload types (documentation + type guards) ──

/** @internal */
export interface ChatRequestPayload {
  purpose: string
  messages: Array<{ role: string; content: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
}

/** @internal */
export interface ChatResponsePayload {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage: { input: number; output: number }
}

/** @internal */
export interface ChatErrorPayload {
  code: 'PURPOSE_NOT_ALLOWED' | 'PROVIDER_FAIL' | 'RATE_LIMITED' | 'TIMEOUT'
  message: string
}

/** @internal */
export interface ToolCallRequestPayload {
  name: string
  arguments: Record<string, unknown>
  callId: string
}

/** @internal */
export interface ToolCallResponsePayload {
  success: boolean
  result?: unknown
  error?: { code: 'TOOL_NOT_ALLOWED' | 'TOOL_NOT_FOUND' | 'TOOL_EXEC_FAIL'; message: string }
}

/** @internal */
export interface ProgressPayload {
  kind: 'round-started' | 'round-completed' | 'tool-starting' | 'text-delta'
  data: Record<string, unknown>
}

/** Encode a Frame to its NDJSON wire representation. */
export function encodeFrame(f: Frame): string {
  return JSON.stringify(f) + '\n'
}

/**
 * Stateful decoder that buffers incomplete lines across read() chunks.
 * Invalid JSON lines are silently dropped.
 */
export class FrameDecoder {
  private buf = ''

  /**
   * Feed a chunk of data into the decoder. Returns zero or more parsed Frames.
   * Partial (non-terminated) lines are held in the internal buffer.
   * Lines that fail JSON parse or lack `v === 1` are silently discarded.
   */
  push(chunk: string | Buffer | Uint8Array): Frame[] {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    this.buf += text
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    const frames: Frame[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj !== null && typeof obj === 'object' && 'v' in obj && (obj as Record<string, unknown>).v === 1) {
        frames.push(obj as Frame)
      }
    }
    return frames
  }

  /** Discard the internal buffer. */
  reset(): void {
    this.buf = ''
  }
}
