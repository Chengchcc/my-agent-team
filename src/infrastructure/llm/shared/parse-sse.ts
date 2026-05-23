const SSE_EVENT_PREFIX_LEN = 7
const SSE_DATA_PREFIX_LEN = 6

/** Parsed SSE event from a byte stream. */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * Parse a ReadableStream<Uint8Array> into individual SSE events.
 * Only handles byte-stream → { event?, data } parsing.
 * Event-type routing is the adapter's responsibility.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      let event: string | undefined
      let dataLines: string[] = []

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          event = line.slice(SSE_EVENT_PREFIX_LEN).trim()
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(SSE_DATA_PREFIX_LEN))
        } else if (line === '') {
          if (dataLines.length > 0) {
            const data = dataLines.join('\n')
            if (data !== '[DONE]') {
              yield { event, data }
            }
            dataLines = []
            event = undefined
          }
        }
      }
    }

    buffer += decoder.decode()
    const remaining = buffer.trim()
    if (remaining) {
      const dataMatch = remaining.match(/^data: (.+)$/m)
      if (dataMatch && dataMatch[1] !== '[DONE]') {
        yield { data: dataMatch[1]! }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
