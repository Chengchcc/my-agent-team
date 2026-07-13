import type { Tool } from "@my-agent-team/core";
import type { AgentEvent } from "@my-agent-team/framework";
import type { SessionConfig } from "../agent-session.js";
import type { SessionManager } from "../session-manager.js";

export interface SubtaskToolConfig {
  sessionManager: SessionManager;
  /** Factory to build SessionConfig for sub-sessions */
  buildConfig: (params: { modelName: string; cwd: string }) => SessionConfig;
}

export function createSubtaskTool(config: SubtaskToolConfig): Tool {
  return {
    name: "spawn_subtask",
    description:
      "Spawn a parallel sub-agent for an isolated task. The sub-agent runs in its own session with a fresh context window. Returns the result as text.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task prompt for the sub-agent" },
        model: {
          type: "string",
          description: "Model name (default: same as parent)",
          default: "claude-sonnet-4",
        },
      },
      required: ["prompt"],
    },
    executionMode: "concurrent",
    execute: async (input: { prompt: string; model?: string }) => {
      const subConfig = config.buildConfig({
        modelName: input.model ?? "claude-sonnet-4",
        cwd: process.cwd(), // ponytail: inherit parent cwd
      });
      const session = config.sessionManager.create(subConfig);
      let lastAssistantText = "";
      const unsub = session.subscribe((event: AgentEvent) => {
        if (event.type === "message" && event.payload.role === "assistant" && event.payload.text) {
          lastAssistantText = event.payload.text;
        }
      });
      try {
        await session.prompt(input.prompt);
        const usage = await session.getUsage();
        const resultText = lastAssistantText || `Subtask completed. Token usage: ${usage}`;
        return { content: resultText };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      } finally {
        unsub();
        config.sessionManager.dispose(session.sessionId ?? "");
      }
    },
  };
}
