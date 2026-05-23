/**
 * Message conversion utilities — single source of truth for
 * transforming between Kernel-internal message format and LLM API format.
 *
 * Internal format: { role, content?, blocks?: ContentBlock[], id?, ... }
 * LLM API format:  { role, content }
 */

export interface InternalMessage {
  role: string
  content?: string
  blocks?: Array<{ type: string; text?: string }>
  id?: string
}

export interface LlmMessage {
  role: string
  content: string
}

/** Extract plain text content from an internal message */
export function extractContent(msg: InternalMessage | LlmMessage): string {
  if ((msg as LlmMessage).content !== undefined) return (msg as LlmMessage).content
  const blocks = (msg as InternalMessage).blocks
  if (blocks && blocks.length > 0) {
    const textBlock = blocks.find(b => b.type === 'text')
    if (textBlock?.text) return textBlock.text
  }
  return ''
}

/** Convert internal message array to LLM API message array */
export function toLlmMessages(messages: Array<InternalMessage | LlmMessage>): LlmMessage[] {
  return messages
    .filter(m => m.role !== 'system') // system handled separately
    .map(m => {
      // Tool messages: extract content, present as user message for LLM understanding
      if (m.role === 'tool') {
        return { role: 'user' as const, content: extractContent(m) }
      }
      return { role: m.role as LlmMessage['role'], content: extractContent(m) }
    })
}
