import type { AIMessageChunk, Tool } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import type { ApiImplementation, ApiStreamOptions, Model } from "../types.js";
import { parseSSE } from "./sse-parser.js";

// ─── Message conversion ──────────────────────────────────────

function mergeSystem(messages: readonly Message[]): string | undefined {
  const sys = messages.filter((m) => m.role === "system");
  if (sys.length === 0) return undefined;
  return sys
    .map(extractText)
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

function isEmpty(msg: Message): boolean {
  if (msg.text !== undefined) return msg.text.trim().length === 0;
  if (msg.blocks) return msg.blocks.length === 0;
  return true;
}

interface AnthropicContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

function convertMessage(msg: Message): { role: string; content: string | AnthropicContent[] } {
  if (msg.text !== undefined) {
    return { role: msg.role, content: msg.text };
  }
  const blocks: AnthropicContent[] = [];
  for (const b of msg.blocks ?? []) {
    if (b.type === "text") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    } else if (b.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error ? { is_error: true } : {}),
      });
    }
  }
  return { role: msg.role, content: blocks };
}

function buildMessages(
  messages: readonly Message[],
): Array<{ role: string; content: string | AnthropicContent[] }> {
  const result: Array<{ role: string; content: string | AnthropicContent[] }> = [];
  for (const msg of messages) {
    if (msg.role === "system" || isEmpty(msg)) continue;
    const converted = convertMessage(msg);
    const prev = result[result.length - 1];
    if (prev && prev.role === converted.role) {
      const prevContent =
        typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
      const newContent =
        typeof converted.content === "string"
          ? [{ type: "text", text: converted.content }]
          : converted.content;
      prev.content = [...prevContent, ...newContent];
    } else {
      result.push(converted);
    }
  }
  return result;
}

function convertTools(tools: readonly Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ─── SSE event mapping ───────────────────────────────────────

function mapStopReason(reason: string | undefined): AIMessageChunk["stopReason"] {
  if (!reason) return undefined;
  return reason as AIMessageChunk["stopReason"];
}

// ─── API implementation ──────────────────────────────────────

export const anthropicMessagesApi: ApiImplementation = {
  async *stream(
    model: Model,
    messages: readonly Message[],
    options?: ApiStreamOptions,
  ): AsyncIterable<AIMessageChunk> {
    const system = mergeSystem(messages);
    const apiMessages = buildMessages(messages);
    const tools = options?.tools?.length ? convertTools(options.tools) : undefined;

    const baseUrl = options?.baseUrl ?? "https://api.anthropic.com";
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": options?.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: model.maxTokens,
        messages: apiMessages,
        stream: true,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const blockIds = new Map<number, string>();

    for await (const event of parseSSE(response.body!)) {
      const type = event.type as string;

      if (type === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        const index = event.index as number;
        if (block?.type === "tool_use") {
          const id = block.id as string;
          blockIds.set(index, id);
          yield { delta: { type: "tool_use", id, name: block.name as string } };
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        const index = event.index as number;
        if (delta?.type === "text_delta") {
          yield { delta: { type: "text", text: delta.text as string } };
        } else if (delta?.type === "input_json_delta") {
          yield {
            delta: {
              type: "input_json_delta",
              id: blockIds.get(index) ?? "",
              partial_json: delta.partial_json as string,
            },
          };
        } else if (delta?.type === "thinking_delta") {
          yield { delta: { type: "reasoning", text: delta.thinking as string } };
        }
      } else if (type === "message_start") {
        const msg = event.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, number> | undefined;
        if (usage) {
          yield {
            usage: {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheCreate: usage.cache_creation_input_tokens,
              cacheRead: usage.cache_read_input_tokens,
            },
          };
        }
      } else if (type === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          yield { stopReason: mapStopReason(delta.stop_reason as string) };
        }
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          yield {
            usage: {
              input: 0,
              output: usage.output_tokens ?? 0,
            },
          };
        }
      } else if (type === "message_stop") {
        yield { done: true };
      }
    }
  },
};
