import type { AIMessageChunk, ChatModel } from "./chat-model.js";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./message.js";
import type { Tool, ToolExecuteResult } from "./tool.js";

export interface RunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
}

export async function* run(
  model: ChatModel,
  tools: readonly Tool[],
  messages: Message[],
  options: RunOptions = {},
): AsyncIterable<Message> {
  const { signal, maxSteps = 32 } = options;
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return;
    }

    const blocks: ContentBlock[] = [];
    const partialJson = new Map<string, string>();

    for await (const chunk of model.stream(messages, { signal, tools })) {
      if (signal?.aborted) {
        return;
      }

      const changed = mergeChunkIntoBlocks(blocks, partialJson, chunk);
      if (changed) {
        yield { role: "assistant", content: structuredClone(blocks) };
      }

      if (chunk.done) {
        break;
      }
    }

    if (signal?.aborted || blocks.length === 0) {
      return;
    }

    finalizeToolUseInputs(blocks, partialJson);

    const assistantMsg: Message = { role: "assistant", content: blocks };
    messages.push(assistantMsg);

    const toolUses = blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) {
      return;
    }

    const results: ContentBlock[] = [];
    for (const toolUse of toolUses) {
      if (signal?.aborted) {
        return;
      }

      const tool = toolMap.get(toolUse.name);
      if (tool === undefined) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool not found: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      try {
        results.push(toolResult(toolUse.id, await tool.execute(toolUse.input, signal)));
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    }

    if (signal?.aborted) {
      return;
    }

    const userMsg: Message = { role: "user", content: results };
    messages.push(userMsg);
    yield userMsg;
  }
}

function mergeChunkIntoBlocks(
  blocks: ContentBlock[],
  partialJson: Map<string, string>,
  chunk: AIMessageChunk,
): boolean {
  if (!chunk.delta) {
    return false;
  }

  if (chunk.delta.type === "text") {
    const last = blocks.at(-1);
    if (last?.type === "text") {
      last.text += chunk.delta.text;
    } else {
      blocks.push({ type: "text", text: chunk.delta.text });
    }
    return true;
  }

  // Reasoning is ephemeral (UI-only streaming); never persisted as a block.
  if (chunk.delta.type === "reasoning") {
    return false;
  }

  if (chunk.delta.type === "tool_use") {
    blocks.push({ type: "tool_use", id: chunk.delta.id, name: chunk.delta.name, input: "" });
    return true;
  }

  partialJson.set(
    chunk.delta.id,
    `${partialJson.get(chunk.delta.id) ?? ""}${chunk.delta.partial_json}`,
  );
  return false;
}

function finalizeToolUseInputs(blocks: ContentBlock[], partialJson: Map<string, string>): void {
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const rawInput = partialJson.get(block.id) ?? "";
      block.input = parseToolInput(rawInput);
    }
  }
}

function parseToolInput(rawInput: string): unknown {
  try {
    return JSON.parse(rawInput);
  } catch {
    return rawInput;
  }
}

function toolResult(toolUseId: string, output: ToolExecuteResult): ToolResultBlock {
  const result: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: output.content,
  };

  if (output.isError !== undefined) {
    result.is_error = output.isError;
  }

  return result;
}
