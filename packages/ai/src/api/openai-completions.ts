import type { AIMessageChunk, Tool } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import type { ApiImplementation, ApiStreamOptions, Model } from "../types.js";
import { parseSSE } from "./sse-parser.js";

// ─── Message conversion ──────────────────────────────────────

interface OpenAIContent {
  type: string;
  text?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContent[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function convertMessages(messages: readonly Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const msg of messages) {
    if (msg.text !== undefined && msg.text.trim().length > 0) {
      result.push({ role: msg.role, content: msg.text });
      continue;
    }
    if (!msg.blocks || msg.blocks.length === 0) continue;

    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIMessage[] = [];

    for (const b of msg.blocks) {
      if (b.type === "text") {
        textParts.push(b.text);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        });
      } else if (b.type === "tool_result") {
        toolResults.push({
          role: "tool",
          content: b.content,
          tool_call_id: b.tool_use_id,
        });
      }
    }

    const content = textParts.length > 0 ? textParts.join("") : null;
    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      if (content) result.push({ role: msg.role, content });
    }
    result.push(...toolResults);
  }
  return result;
}

function convertTools(tools: readonly Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ─── SSE event mapping ───────────────────────────────────────

function mapStopReason(reason: string | undefined): AIMessageChunk["stopReason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return reason as AIMessageChunk["stopReason"];
  }
}

// ─── API implementation ──────────────────────────────────────

export const openAICompletionsApi: ApiImplementation = {
  async *stream(
    model: Model,
    messages: readonly Message[],
    options?: ApiStreamOptions,
  ): AsyncIterable<AIMessageChunk> {
    const apiMessages = convertMessages(messages);
    const tools = options?.tools?.length ? convertTools(options.tools) : undefined;

    const baseUrl = options?.baseUrl ?? "https://api.openai.com";
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options?.apiKey ?? ""}`,
        "content-type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: model.maxTokens,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools ? { tools } : {}),
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    for await (const chunk of parseSSE(response.body!)) {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;

      if (delta?.content) {
        yield { delta: { type: "text", text: delta.content as string } };
      }

      if (delta?.tool_calls) {
        const tcs = delta.tool_calls as Array<Record<string, unknown>>;
        for (const tc of tcs) {
          const fn = tc.function as Record<string, string> | undefined;
          if (tc.id && fn?.name) {
            yield { delta: { type: "tool_use", id: tc.id as string, name: fn.name } };
          }
          if (fn?.arguments) {
            yield {
              delta: {
                type: "input_json_delta",
                id: (tc.id as string) ?? "",
                partial_json: fn.arguments,
              },
            };
          }
        }
      }

      const finishReason = choices?.[0]?.finish_reason as string | undefined;
      if (finishReason) {
        yield { stopReason: mapStopReason(finishReason) };
      }

      const usage = chunk.usage as Record<string, number> | undefined;
      if (usage) {
        yield {
          usage: {
            input: usage.prompt_tokens ?? 0,
            output: usage.completion_tokens ?? 0,
          },
        };
      }
    }
    yield { done: true };
  },
};
