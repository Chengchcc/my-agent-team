import type { Anthropic } from "@anthropic-ai/sdk";
import type { Tool } from "@my-agent-team/core";

export function toAnthropicTools(tools: readonly Tool[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
}
