import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, CompressionStrategy, Message } from '../types';

export function countTotalTokens(messages: Message[], systemPrompt?: string): number {
  let total = systemPrompt ? countTokens(systemPrompt) : 0;
  for (const msg of messages) {
    total += countSingleMessageTokens(msg);
  }
  return total;
}

function countSingleMessageTokens(msg: Message): number {
  let tokens = 4; // overhead per message for role/metadata
  if (msg.content) {
    tokens += countTokens(msg.content);
  }
  if (msg.tool_calls) {
    tokens += countTokens(JSON.stringify(msg.tool_calls));
  }
  return tokens;
}

/**
 * Default compression strategy - trim oldest messages when over limit.
 * Keeps system prompt if present.
 */
export class TrimOldestStrategy implements CompressionStrategy {
  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    let messages = [...context.messages];

    // Keep all system messages separate
    const systemMessages = messages.filter(m => m.role === 'system');
    if (systemMessages.length > 0) {
      messages = messages.filter(m => m.role !== 'system');
    }

    // Count total tokens including system prompt
    const systemTokenCount = context.systemPrompt ? countTokens(context.systemPrompt) : 0;
    let currentTotalTokens = systemTokenCount + countTotalTokens(messages);

    // Remove oldest messages until we're under the limit or empty
    while (currentTotalTokens > tokenLimit && messages.length > 0) {
      // Never remove the last two messages - keep the current turn
      if (messages.length <= 2) break;

      // Check if the first message is an assistant with tool_calls. If so, remove it plus all matching tool results.
      const first = messages[0];
      if (!first) break;
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
        let removeCount = 1; // Start with assistant message itself
        // Remove consecutive tool result messages that match any of the tool_call_ids from this assistant
        for (let i = 1; i < messages.length && removeCount <= 1 + first.tool_calls.length; i++) {
          const msg = messages[i];
          if (!msg) break;
          if (msg.role === 'tool' && msg.tool_call_id && first.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
            removeCount++;
          } else {
            break; // Stop at first non-matching message
          }
        }
        messages = messages.slice(removeCount);
      } else {
        // Just remove the single message
        messages = messages.slice(1);
      }
      // Recalculate total tokens after removal
      currentTotalTokens = systemTokenCount + countTotalTokens(messages);
    }

    // Remove orphaned tool results — tool messages whose tool_call_id doesn't match
    // any remaining assistant message's tool_calls. The Anthropic API rejects these.
    const activeToolIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) activeToolIds.add(tc.id);
      }
    }
    messages = messages.filter(msg =>
      msg.role !== 'tool' || !msg.tool_call_id || activeToolIds.has(msg.tool_call_id),
    );

    // Put all system messages back at the beginning
    messages.unshift(...systemMessages);

    return messages;
  }
}
