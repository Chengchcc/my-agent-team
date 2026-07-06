import type { Tool } from "@my-agent-team/core";
import { definePlugin, type Plugin } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";

export interface ConversationContextPluginOptions {
  /** Tools to register — created by the caller with conversation closures. */
  tools: Tool[];
}

/** Per-run conversation metadata. Set via AgentSession.setContext(CONVERSATION_KEY, data). */
export interface ConversationContext {
  id: string;
  surface: string;
  senderName: string;
  input: string;
}

/** Context key for per-run conversation metadata. Use with AgentSession.setContext() / ctx.get(). */

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ConversationContextPlugin — injects conversation context into agent runs.
 *
 * Reads per-run conversation metadata from ctx via the CONVERSATION_KEY.
 * The caller writes via AgentSession.setContext(CONVERSATION_KEY, data)
 * before calling prompt(). The framework forwards to ctx at run start.
 *
 * This fixes the old bug where per-run trigger data was baked into a
 * per-session systemPrompt.
 */
export function conversationContextPlugin(opts: ConversationContextPluginOptions): Plugin {
  return definePlugin({
    name: "conversation-context",
    tools: opts.tools,
    hooks: {
      async beforeModel(ctx, messages: Message[]): Promise<Message[]> {
        const raw = ctx.data;
        if (!raw || typeof raw !== "object") return messages;
        const conv = raw as unknown as ConversationContext;
        if (!conv.id) return messages;
        const contextMsg: Message = {
          role: "system",
          text: `<conversation>
  <id>${escapeXml(conv.id)}</id>
  <surface>${escapeXml(conv.surface)}</surface>
  <trigger>
    <from>${escapeXml(conv.senderName)}</from>
    <message>${escapeXml(conv.input)}</message>
  </trigger>
</conversation>
如需更多上下文，使用 read_conversation_history 等工具。`,
        };
        return [contextMsg, ...messages];
      },
    },
  });
}
