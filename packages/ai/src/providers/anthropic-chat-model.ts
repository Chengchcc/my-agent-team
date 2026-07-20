import { Anthropic } from "@anthropic-ai/sdk";
import type { AIMessageChunk, ChatModel, ChatModelOptions } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import { toAnthropicTools } from "./to-anthropic-tools.js";

export interface AnthropicChatModelConfig {
  model?: string;
  thinking?: { type: "adaptive" };
  effort?: "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
}

export class AnthropicChatModel implements ChatModel {
  readonly id: string;
  readonly #client: Anthropic;
  readonly #config: AnthropicChatModelConfig;

  constructor(config: AnthropicChatModelConfig = {}) {
    this.#config = config;
    this.id = config.model ?? "claude-opus-4-7";
    this.#client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL: config.baseUrl,
    });
  }

  async *stream(
    messages: readonly Message[],
    options?: ChatModelOptions,
  ): AsyncIterable<AIMessageChunk> {
    // Merge ALL system messages (not just last)
    const system = mergeSystemMessages(messages);

    // Build API messages: filter empty, merge adjacent same-role, convert to Anthropic params
    const apiMessages = buildApiMessages(messages);

    const tools = options?.tools ? toAnthropicTools(options.tools) : undefined;

    const stream = this.#client.messages.stream(
      {
        model: this.#config.model ?? "claude-opus-4-7",
        max_tokens: this.#config.maxTokens ?? 16000,
        messages: apiMessages,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(this.#config.thinking ? { thinking: this.#config.thinking } : {}),
        ...(this.#config.effort ? { effort: this.#config.effort } : {}),
      },
      { signal: options?.signal },
    );

    const blockIds = new Map<number, string>();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          yield { delta: { type: "text", text: event.content_block.text } };
        } else if (event.content_block.type === "tool_use") {
          blockIds.set(event.index, event.content_block.id);
          yield {
            delta: {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
            },
          };
        } else if (
          event.content_block.type === "thinking" ||
          event.content_block.type === "redacted_thinking"
        ) {
          void 0; // filtered out - thinking is not surfaced to the UI
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { delta: { type: "text", text: event.delta.text } };
        } else if (event.delta.type === "input_json_delta") {
          const id = blockIds.get(event.index) ?? "";
          yield {
            delta: {
              type: "input_json_delta",
              id,
              partial_json: event.delta.partial_json,
            },
          };
        } else if (event.delta.type === "thinking_delta") {
          void 0; // filtered out
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      done: true,
      // Adapter boundary: Anthropic SDK stop_reason -> internal AIMessageChunk.stopReason.
      // SDK: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null
      // Internal: same + "pause_turn" | "refusal" (future Anthropic values, passthrough)
      stopReason: (finalMessage?.stop_reason ?? undefined) as AIMessageChunk["stopReason"],
      usage: finalMessage
        ? {
            input: finalMessage.usage.input_tokens,
            output: finalMessage.usage.output_tokens,
            cacheCreate: finalMessage.usage.cache_creation_input_tokens ?? undefined,
            cacheRead: finalMessage.usage.cache_read_input_tokens ?? undefined,
          }
        : undefined,
    };
  }
}

// -- Helpers --

/** Merge all system messages into a single string. */
function mergeSystemMessages(messages: readonly Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;
  return systemMessages
    .map(extractText)
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

function isEmptyMessage(msg: Message): boolean {
  if (msg.text !== undefined) return msg.text.trim().length === 0;
  if (msg.blocks) return msg.blocks.length === 0;
  return false;
}

/** Filter empty messages, merge adjacent same-role, convert to Anthropic params. */
function buildApiMessages(messages: readonly Message[]): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (isEmptyMessage(msg)) continue;

    const converted = convertMessage(msg);
    const prev = result[result.length - 1];

    if (prev && prev.role === converted.role) {
      // Merge adjacent same-role: concatenate content
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text" as const, text: String(prev.content) }];
      const newContent = Array.isArray(converted.content)
        ? converted.content
        : [{ type: "text" as const, text: String(converted.content) }];
      prev.content = [...prevContent, ...newContent] as Anthropic.Messages.ContentBlockParam[];
    } else {
      result.push(converted);
    }
  }

  return result;
}

function convertMessage(msg: Message): Anthropic.Messages.MessageParam {
  if (msg.text !== undefined) {
    return { role: msg.role as "user" | "assistant", content: msg.text };
  }

  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const block of msg.blocks ?? []) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    } else if (block.type === "tool_result") {
      const tr: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
      };
      if (block.is_error !== undefined) {
        tr.is_error = block.is_error;
      }
      blocks.push(tr);
    }
  }

  return { role: msg.role as "user" | "assistant", content: blocks };
}
