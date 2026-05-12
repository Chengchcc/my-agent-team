import type Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../types';

/**
 * Convert unified message format to Claude API message format.
 * - Removes system messages (Claude expects system as separate parameter)
 * - Converts tool messages to user messages with tool_result content blocks
 * - Converts assistant messages with blocks (thinking/text/tool_use) preserving order:
 *   thinking → redacted_thinking → text → tool_use (Anthropic requirement)
 * - Merges consecutive user messages so multiple tool_results land in one turn
 *   (some providers, e.g. Volcengine Ark, return null instead of a stream when
 *   they see consecutive user messages).
 */
export function convertToClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  const converted = messages
    .filter(m => m.role !== 'system')
    .map(m => convertOne(m));

  return mergeConsecutiveUserMessages(converted);
}

function mergeConsecutiveUserMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (msg.role === 'user' && prev?.role === 'user') {
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }];
      const currContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: msg.content }];
      out[out.length - 1] = {
        role: 'user',
        content: [...prevContent, ...currContent],
      };
    } else {
      out.push(msg);
    }
  }
  return out;
}

function convertOne(m: Message): Anthropic.MessageParam {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: m.tool_call_id!,
          content: m.content,
        },
      ],
    };
  }

  if (m.role === 'assistant') {
    if (m.blocks && m.blocks.length > 0) {
      const content: Anthropic.ContentBlockParam[] = [];
      const BLOCK_ORDER_FALLBACK = 5;
      // Filter unreplayable blocks: thinking blocks without signature cannot be sent back
      // to the API. Some providers (e.g. Volcengine Ark) emit thinking blocks without
      // signature_delta events even when thinking is not enabled — those are display-only.
      const replayable = m.blocks.filter(b => b.type !== 'thinking' || (b.signature && b.signature.length > 0));
      const ordered = [...replayable].sort((a, b) => {
        const order: Record<string, number> = { thinking: 0, redacted_thinking: 1, text: 2, tool_use: 3, tool_result: 4 };
        return (order[a.type] ?? BLOCK_ORDER_FALLBACK) - (order[b.type] ?? BLOCK_ORDER_FALLBACK);
      });
      for (const block of ordered) {
        switch (block.type) {
          case 'thinking':
            content.push({
              type: 'thinking' as Anthropic.ContentBlockParam['type'],
              thinking: block.thinking,
              ...(block.signature ? { signature: block.signature } : {}),
            } as Anthropic.ContentBlockParam);
            break;
          case 'redacted_thinking':
            content.push({
              type: 'redacted_thinking' as Anthropic.ContentBlockParam['type'],
              data: block.data,
            } as Anthropic.ContentBlockParam);
            break;
          case 'text':
            content.push({ type: 'text', text: block.text });
            break;
          case 'tool_use':
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
            break;
          case 'tool_result':
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
            });
            break;
        }
      }
      return { role: 'assistant', content };
    }

    if (m.tool_calls && m.tool_calls.length > 0) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      return { role: 'assistant', content };
    }

    return { role: 'assistant', content: m.content };
  }

  return {
    role: 'user',
    content: m.content,
  };
}

/**
 * Extract system prompt from messages array for Claude API.
 */
export function extractSystemPrompt(messages: Message[]): string {
  return messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
}
