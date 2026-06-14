import type { Tool } from "@my-agent-team/core";

/**
 * M15.1: Create a `start_new_conversation` tool for Lark surface runs.
 * The tool calls backend's POST /api/conversations/:id/start-new endpoint
 * to create a fresh conversation and trigger a surface.control rebind.
 */
export function createStartNewConversationTool(input: {
  backendUrl: string;
  backendAuthToken: string | null;
  conversationId: string;
  runId: string;
}): Tool {
  return {
    name: "start_new_conversation",
    description:
      "Start a fresh backend conversation for the current external chat when the user asks to reset context, start a new topic, or open a new conversation.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the user wants a fresh conversation.",
        },
        title: {
          type: "string",
          description: "Optional short title for the new conversation.",
        },
      },
      required: ["reason"],
    },
    async execute(args: unknown) {
      const a = args as { reason: string; title?: string };
      const url = `${input.backendUrl}/api/conversations/${input.conversationId}/start-new`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (input.backendAuthToken) {
        headers["x-auth-token"] = input.backendAuthToken;
      }

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          reason: a.reason,
          title: a.title,
          requestedByRunId: input.runId,
          idempotencyKey: `${input.runId}:start_new_conversation`,
        }),
      });

      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          `start_new_conversation failed: HTTP ${resp.status} - ${
            body.error ?? "unknown"
          }`,
        );
      }
      return await resp.json();
    },
  };
}
