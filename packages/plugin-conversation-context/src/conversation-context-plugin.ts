import type { Tool } from "@my-agent-team/core";
import type { Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";

export interface ConversationContextPluginOptions {
  /** Tools to register — created by the caller with conversation closures.
   *  The plugin does not know or care about backend types; it only receives Tool[]. */
  tools: Tool[];
  /** System prompt fragment injected before each model call.
   *  Typically contains conversation metadata (surface, title, trigger context). */
  systemPrompt: string;
}

/**
 * ConversationContextPlugin — injects conversation context into agent runs.
 *
 * Backend creates tools (with convPort closures) and system prompt.
 * The plugin only receives `Tool[]` + `systemPrompt` string — it does NOT import
 * any backend types or know about conversation concepts.
 *
 * Dependency direction: backend → plugin (not plugin → backend).
 */
export function conversationContextPlugin(opts: ConversationContextPluginOptions): Plugin {
  return {
    name: "conversation-context",
    tools: opts.tools,
    hooks: {
      async beforeModel(_ctx, messages: Message[]): Promise<Message[]> {
        const contextMsg: Message = {
          role: "system",
          text: opts.systemPrompt,
        };
        return [contextMsg, ...messages];
      },
    },
  };
}
