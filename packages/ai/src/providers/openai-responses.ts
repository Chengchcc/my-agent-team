import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { registerApi } from "../api-registry.js";
import { resolveEffort, resolveOpenAICompat, sanitizeSurrogates } from "../compat.js";
import type { Model, ProviderStreamOptions } from "../types.js";

// ── Request assembly ──────────────────────────────────────────────

/** Concatenate text blocks; fall back to the legacy `text` field. */
function textOf(m: Message): string {
  const fromBlocks =
    m.blocks
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "";
  return sanitizeSurrogates(fromBlocks || m.text || "");
}

/** Canonical messages → OpenAI Responses API `input` items.
 *  system/developer → message(input_text); user → message(input_text);
 *  assistant → message(output_text) + function_call*; tool → function_call_output.
 *  Tool round-trip closes on `call_id`: tool_use emits call_id, tool_result
 *  echoes it back as function_call_output.call_id. */
function convertInput(messages: readonly Message[], systemRole: string): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = textOf(m);
      if (text)
        input.push({ type: "message", role: systemRole, content: [{ type: "input_text", text }] });
    } else if (m.role === "user") {
      const text = textOf(m);
      const images =
        m.blocks?.filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image") ??
        [];
      if (text || images.length > 0)
        input.push({
          type: "message",
          role: "user",
          content: [
            ...(text ? [{ type: "input_text", text }] : []),
            ...images.map((img) => ({
              type: "input_image",
              image_url: `data:${img.mediaType};base64,${img.base64}`,
            })),
          ],
        });
    } else if (m.role === "assistant") {
      if (m.blocks?.length) {
        const text = sanitizeSurrogates(
          m.blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("") ||
            (m.text ?? ""),
        );
        if (text)
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
            status: "completed",
          });
        for (const b of m.blocks)
          if (b.type === "tool_use")
            input.push({
              type: "function_call",
              call_id: b.id,
              name: b.name,
              arguments: JSON.stringify(b.input ?? {}),
            });
      } else if (m.text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: sanitizeSurrogates(m.text) }],
          status: "completed",
        });
      }
    } else if (m.role === "tool") {
      const results =
        m.blocks?.filter(
          (b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result",
        ) ?? [];
      for (const result of results) {
        const images = result.images ?? [];
        const cleanContent = sanitizeSurrogates(result.content ?? m.text ?? "");
        const output =
          images.length > 0
            ? [
                ...(cleanContent ? [{ type: "input_text", text: cleanContent }] : []),
                ...images.map((img) => ({
                  type: "input_image",
                  image_url: `data:${img.mediaType};base64,${img.base64}`,
                })),
              ]
            : cleanContent;
        input.push({
          type: "function_call_output",
          call_id: result.tool_use_id ?? "",
          output,
        });
      }
      // ponytail: keep the legacy single-output fallback for bare-text tool turns.
      if (!results.length && m.text)
        input.push({
          type: "function_call_output",
          call_id: "",
          output: sanitizeSurrogates(m.text),
        });
    }
  }
  return input;
}

const EFFORT_CLAMP: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  // ponytail: Responses API effort ∈ {minimal,low,medium,high}; xhigh/max clamp to high.
  xhigh: "high",
  max: "high",
};

/** Provider/gateway output-token cap (zai/llmbox rejects >131072). */
const MAX_OUTPUT_TOKENS = 131_072;

function buildRequest(
  model: Model,
  messages: readonly Message[],
  opts?: ProviderStreamOptions,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  // o-series models prefer the "developer" role over the deprecated "system".
  const systemRole = resolveOpenAICompat(model).supportsDeveloperRole ? "developer" : "system";

  const effectiveMaxTokens = Math.min(
    opts?.maxTokens !== undefined ? Math.max(1, Math.floor(opts.maxTokens)) : model.maxTokens,
    model.maxTokens,
    MAX_OUTPUT_TOKENS,
  );
  const body: Record<string, unknown> = {
    model: model.id,
    input: convertInput(messages, systemRole),
    stream: true,
    store: false, // do not persist conversations server-side
    max_output_tokens: effectiveMaxTokens,
  };

  if (model.reasoning && opts?.effort) {
    const resolved = resolveEffort(model, opts.effort, EFFORT_CLAMP);
    if (resolved) body.reasoning = { effort: resolved, summary: "auto" };
  }

  if (opts?.tools?.length)
    body.tools = opts.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? {},
      strict: false,
    }));

  // F5 structured output: Responses API text.format JSON Schema mode.
  if (opts?.responseFormat) {
    body.text = {
      format: {
        type: "json_schema",
        name: opts.responseFormat.name,
        schema: opts.responseFormat.schema,
        strict: opts.responseFormat.strict ?? true,
      },
    };
  }

  return {
    url: "/responses",
    headers: { "Content-Type": "application/json", Authorization: "Bearer {apiKey}" },
    body,
  };
}

// ── SSE decoding ──────────────────────────────────────────────────

/** Map Responses API response.status → canonical stop reason. A completed
 *  response that emitted tool calls is a tool_use turn, not an end_turn. */
function mapStopReason(
  status: string,
  sawToolUse: boolean,
  incompleteReason?: string,
): AIMessageChunk["stopReason"] {
  if (status === "incomplete") {
    return incompleteReason === "content_filter" ? "refusal" : "max_tokens";
  }
  return sawToolUse ? "tool_use" : "end_turn";
}

/** Streaming converter for OpenAI Responses API SSE. Tool calls arrive
 *  indexed: `output_item.added` announces call_id at an output_index, then
 *  `function_call_arguments.delta` streams JSON fragments keyed by that index.
 *  We track output_index → call_id so every fragment emits as
 *  input_json_delta paired to the announced tool. */
function createChunkConverter(): (raw: Record<string, unknown>) => Generator<AIMessageChunk> {
  const callIdByIndex = new Map<number, string>();
  const streamed = new Map<string, number>(); // call_id → bytes already emitted
  let sawToolUse = false;

  return function* convertChunk(raw: Record<string, unknown>): Generator<AIMessageChunk> {
    const type = raw.type as string | undefined;
    if (!type) return;

    if (type === "response.output_item.added") {
      const item = raw.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const callId = (item.call_id as string) ?? (item.id as string) ?? "";
        callIdByIndex.set((raw.output_index as number) ?? 0, callId);
        sawToolUse = true;
        yield { delta: { type: "tool_use", id: callId, name: (item.name as string) ?? "" } };
      }
      // message / reasoning items are started by their own delta events.
      return;
    }

    if (type === "response.output_text.delta") {
      const delta = raw.delta as string | undefined;
      if (delta) yield { delta: { type: "text", text: sanitizeSurrogates(delta) } };
      return;
    }

    // Summary text (o-series) and raw reasoning text both surface as reasoning.
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      const delta = raw.delta as string | undefined;
      if (delta) yield { delta: { type: "reasoning", text: sanitizeSurrogates(delta) } };
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = raw.delta as string | undefined;
      if (!delta) return;
      const callId = callIdByIndex.get((raw.output_index as number) ?? 0);
      if (!callId) return;
      streamed.set(callId, (streamed.get(callId) ?? 0) + delta.length);
      yield { delta: { type: "input_json_delta", id: callId, partial_json: delta } };
      return;
    }

    if (type === "response.output_item.done") {
      // Non-streaming tool calls arrive fully formed here — flush arguments we
      // never saw deltas for so the tool input still resolves.
      const item = raw.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const callId = (item.call_id as string) ?? (item.id as string) ?? "";
        const args = (item.arguments as string) ?? "";
        if (callId && args && !(streamed.get(callId) ?? 0))
          yield { delta: { type: "input_json_delta", id: callId, partial_json: args } };
      }
      return;
    }

    if (type === "response.failed" || type === "response.cancelled" || type === "error") {
      const resp = raw.response as Record<string, unknown> | undefined;
      const err = (raw.error ?? resp?.error) as Record<string, unknown> | undefined;
      throw new Error(`OpenAI Responses error: ${(err?.message as string) ?? type}`);
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const response = raw.response as Record<string, unknown> | undefined;
      const chunk: AIMessageChunk = { done: true };
      const usage = response?.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens = (usage.input_tokens as number) ?? 0;
        const outputTokens = (usage.output_tokens as number) ?? 0;
        const details = usage.input_tokens_details as Record<string, number> | undefined;
        const cached = details?.cached_tokens ?? 0;
        // OpenAI folds cached tokens into input_tokens; report them separately.
        chunk.usage = { input: Math.max(0, inputTokens - cached), output: outputTokens };
        if (cached) chunk.usage.cacheRead = cached;
      }
      const incompleteReason = (response?.incomplete_details as { reason?: string } | undefined)
        ?.reason;
      chunk.stopReason = mapStopReason(
        (response?.status as string) ??
          (type === "response.incomplete" ? "incomplete" : "completed"),
        sawToolUse,
        incompleteReason,
      );
      yield chunk;
    }
  };
}

registerApi("openai-responses", { buildRequest, createChunkConverter });
