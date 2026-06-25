import type { LedgerEntry } from "@my-agent-team/conversation";
import type { Tool } from "@my-agent-team/core";
import { deserializeLedgerContent, extractText } from "@my-agent-team/message";
import type { ConversationPort } from "./ports.js";

interface ConvToolDeps {
  convPort: ConversationPort;
  conversationId: string;
}

/** Read recent conversation history from the ledger. */
export function createReadHistoryTool(deps: ConvToolDeps): Tool {
  return {
    name: "read_conversation_history",
    description:
      "Read recent messages from the current conversation. Returns the last N messages in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent messages to return (default: 20)",
        },
      },
    },
    async execute(input: unknown) {
      const rec = input as Record<string, unknown>;
      const limit = (rec.limit as number) ?? 20;
      try {
        const entries = deps.convPort.getLedgerEntries(deps.conversationId);
        const messages = entries.filter((e) => e.kind === "message");
        const recent = messages.slice(-limit);
        const formatted = recent.map((e) => formatLedgerEntry(e)).join("\n");
        return { content: formatted || "(no messages yet)" };
      } catch (err) {
        return {
          content: `Error reading history: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

/** Read context around a specific message. */
export function createReadContextTool(deps: ConvToolDeps): Tool {
  return {
    name: "read_message_context",
    description: "Read messages before and after a specific message for context.",
    inputSchema: {
      type: "object",
      properties: {
        around_seq: {
          type: "number",
          description: "The seq number of the message to center on",
        },
        before: {
          type: "number",
          description: "Number of messages before (default: 5)",
        },
        after: {
          type: "number",
          description: "Number of messages after (default: 5)",
        },
      },
      required: ["around_seq"],
    },
    async execute(input: unknown) {
      const rec = input as Record<string, unknown>;
      const aroundSeq = rec.around_seq as number;
      const before = (rec.before as number) ?? 5;
      const after = (rec.after as number) ?? 5;
      try {
        const entries = deps.convPort.getLedgerEntries(deps.conversationId);
        const messages = entries.filter((e) => e.kind === "message");
        const idx = messages.findIndex((e) => e.seq === aroundSeq);
        if (idx < 0) {
          return {
            content: `No message found at seq=${aroundSeq}`,
            isError: true,
          };
        }
        const start = Math.max(0, idx - before);
        const end = Math.min(messages.length, idx + after + 1);
        const context = messages.slice(start, end);
        const formatted = context.map((e) => formatLedgerEntry(e)).join("\n");
        return { content: formatted || "(no context found)" };
      } catch (err) {
        return {
          content: `Error reading context: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

/** Search conversation messages by keyword. */
export function createSearchTool(deps: ConvToolDeps): Tool {
  return {
    name: "search_conversation",
    description: "Search the conversation history for messages containing a keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword or phrase to search for",
        },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    async execute(input: unknown) {
      const rec = input as Record<string, unknown>;
      const query = String(rec.query ?? "");
      const limit = (rec.limit as number) ?? 10;
      try {
        const entries = deps.convPort.getLedgerEntries(deps.conversationId);
        const messages = entries.filter((e) => e.kind === "message");
        const results = messages
          .filter((e) => e.content.toLowerCase().includes(query.toLowerCase()))
          .slice(-limit);
        const formatted = results.map((e) => formatLedgerEntry(e)).join("\n");
        return { content: formatted || "(no results)" };
      } catch (err) {
        return {
          content: `Error searching: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

/** List conversation members. */
export function createListMembersTool(deps: ConvToolDeps): Tool {
  return {
    name: "list_members",
    description: "List all members in this conversation.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input: unknown) {
      try {
        const members = deps.convPort.getMembers(deps.conversationId);
        const formatted = members
          .map((m) => `- ${m.displayName ?? m.memberId} (${m.kind})`)
          .join("\n");
        return { content: formatted || "(no members)" };
      } catch (err) {
        return {
          content: `Error listing members: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    },
  };
}

function formatLedgerEntry(e: LedgerEntry): string {
  const parsed = deserializeLedgerContent(e.content);
  const text =
    typeof parsed === "object" && parsed !== null && "text" in parsed
      ? String((parsed as { text: unknown }).text ?? "")
      : extractText({ text: undefined, blocks: undefined });
  return `[${e.senderMemberId} seq=${e.seq}]: ${text}`;
}
