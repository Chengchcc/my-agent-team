// NDJSON frame codec for the spawn LLM bridge protocol.
// Each frame is one JSON line terminated by '\n'.

export type FrameKind =
  | 'init'        // parent -> worker: initialisation payload
  | 'invoke-req'  // worker -> parent: LLM call request
  | 'invoke-resp' // parent -> worker: LLM call response
  | 'result'      // worker -> parent: job result (last frame)
  | 'log'         // worker -> parent: log relay
  | 'shutdown'    // parent -> worker: request graceful exit
  | 'error'       // bidirectional: error

export interface Frame {
  v: 1
  /** UUID v4 — used to match requests with responses. */
  id: string
  kind: FrameKind
  /** Sender timestamp in ms. */
  ts: number
  payload: unknown
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
  push(chunk: string | Buffer): Frame[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
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
