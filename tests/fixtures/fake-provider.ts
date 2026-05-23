import type { AgentContext } from '../../src/domain/agent'
import type { ToolCall } from '../../src/application/ports/provider-adapter';

export interface FakeProviderOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * A single preset turn's worth of stream output.
 * Maps to what the agent loop consumes from LLMResponseChunk:
 * - thinkingDeltas → chunk.thinking (yielded individually, then chunk.thinkingSignature for the last)
 * - textDeltas → chunk.content (yielded individually)
 * - toolCalls → chunk.tool_calls
 * - usage → chunk.usage (yielded on stream completion)
 * - errorAfter → throw after N deltas to simulate stream failure
 */
export type PresetTurn = {
  textDeltas?: string[];
  thinkingDeltas?: string[];
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  errorAfter?: number; // throw after N deltas to simulate stream failure
};

export class FakeProvider {
  model: string;
  maxTokens: number;
  private turns: PresetTurn[] = [];

  constructor(opts: FakeProviderOptions = {}) {
    this.model = opts.model ?? 'fake-model';
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  setTurns(turns: PresetTurn[]): void {
    this.turns = turns;
  }

  // eslint-disable-next-line require-await
  async invoke(_context: AgentContext, _options?: { tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }): Promise<{
    content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model: string; tool_calls?: ToolCall[]; blocks?: Array<{ type: string; thinking?: string; text?: string }>
  }> {
    // For non-streaming, aggregate all preset turns into a single response
    let fullContent = '';
    let fullThinking = '';
    const allToolCalls: ToolCall[] = [];
    let lastUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    for (const turn of this.turns) {
      if (turn.textDeltas) fullContent += turn.textDeltas.join('');
      if (turn.thinkingDeltas) fullThinking += turn.thinkingDeltas.join('');
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          allToolCalls.push({
            id: `fake-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      }
      if (turn.usage) lastUsage = turn.usage;
    }

    const response: LLMResponse = {
      content: fullContent,
      usage: lastUsage,
      model: this.model,
    };
    if (allToolCalls.length > 0) response.tool_calls = allToolCalls;
    if (fullThinking) {
      response.blocks = [{ type: 'thinking', thinking: fullThinking }];
      if (fullContent) response.blocks.push({ type: 'text', text: fullContent });
    }
    return response;
  }

  // eslint-disable-next-line require-await
  async *stream(
    _context: AgentContext,
    _options?: { signal?: AbortSignal; tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }> },
  ): AsyncIterable<{
    content: string; thinking?: string; thinkingSignature?: string; done: boolean; tool_calls?: ToolCall[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }> {
    for (const turn of this.turns) {
      let deltaCount = 0;

      const checkError = () => {
        if (turn.errorAfter !== undefined && deltaCount >= turn.errorAfter) {
          throw new Error('FakeProvider: simulated stream error');
        }
      };

      // Yield thinking deltas first
      if (turn.thinkingDeltas) {
        const lastIdx = turn.thinkingDeltas.length - 1;
        let thinkIdx = 0;
        for (const delta of turn.thinkingDeltas) {
          checkError();
          if (thinkIdx === lastIdx) {
            // Last thinking delta carries the signature
            yield {
              content: '',
              thinking: delta,
              thinkingSignature: 'fake-sig',
              done: false,
            };
          } else {
            yield {
              content: '',
              thinking: delta,
              done: false,
            };
          }
          thinkIdx++;
          deltaCount++;
        }
      }

      // Yield text deltas
      for (const delta of turn.textDeltas ?? ['']) {
        checkError();
        yield { content: delta, done: false };
        deltaCount++;
      }

      // Yield tool calls as completed chunks
      if (turn.toolCalls) {
        const completedCalls: ToolCall[] = [];
        for (const tc of turn.toolCalls) {
          const toolCall: ToolCall = {
            id: `fake-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: tc.name,
            arguments: tc.arguments,
          };
          completedCalls.push(toolCall);
        }
        yield {
          content: '',
          done: false,
          tool_calls: completedCalls,
        };
      }

      // Yield usage on completion
      if (turn.usage) {
        yield {
          content: '',
          done: true,
          usage: turn.usage,
        };
      } else {
        yield {
          content: '',
          done: true,
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };
      }
    }
  }

  getModelName(): string {
    return this.model;
  }
}
