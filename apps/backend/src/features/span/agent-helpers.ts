import { mkdirSync } from "node:fs";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import type { ChatModel, Tool } from "@my-agent-team/core";
import {
  autoSummarize,
  type ContextManager,
  type Plugin,
  pipeContextManagers,
  toolResultTruncator,
} from "@my-agent-team/framework";
import { fsMemoryPlugin } from "@my-agent-team/plugin-fs-memory";
import { identityPlugin } from "@my-agent-team/plugin-identity";
import { progressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import {
  bashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  globTool,
  grepTool,
} from "@my-agent-team/tools-common";
import type { BackendConfig } from "../../config.js";
import {
  createListMembersTool,
  createReadContextTool,
  createReadHistoryTool,
  createSearchTool,
} from "../conversation/conv-tools.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { SettingsService } from "../settings/index.js";
import type { SkillRoots } from "./skill-roots.js";

// ─── Model ────────────────────────────────────────────────

export function createModel(modelName: string, config: BackendConfig): ChatModel {
  return new AnthropicChatModel({
    apiKey: config.anthropicApiKey,
    model: modelName,
    baseUrl: config.anthropicBaseUrl,
  });
}

// ─── Tools ────────────────────────────────────────────────

export function defaultTools(cwd: string): Tool[] {
  mkdirSync(cwd, { recursive: true });
  return [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createEditTool({ cwd }),
    bashTool,
    globTool,
    grepTool,
  ];
}

export function convTools(port: ConversationPort, conversationId: string): Tool[] {
  return [
    createReadHistoryTool({ convPort: port, conversationId }),
    createReadContextTool({ convPort: port, conversationId }),
    createSearchTool({ convPort: port, conversationId }),
    createListMembersTool({ convPort: port, conversationId }),
  ];
}

// ─── Plugins ──────────────────────────────────────────────

export function defaultPlugins(
  cwd: string,
  config: BackendConfig,
  skillRoots?: SkillRoots,
  agentName?: string,
): Plugin[] {
  return [
    identityPlugin({ cwd, agentName }),
    fsMemoryPlugin({ cwd: config.workspaceRoot, root: "./memory/" }),
    progressiveSkillPlugin(
      skillRoots
        ? { ws: skillRoots.ws, roots: skillRoots.roots, posixSkillRoot: skillRoots.posixSkillRoot }
        : { cwd },
    ),
  ];
}

// NOTE: conversationPlugins was removed — conversation-compose inlines the assembly:
//   plugins: [...defaultPlugins(cwd, ws, skillRoots), conversationContextPlugin({ tools: convTools(port, cid) })]

// ─── ContextManager ───────────────────────────────────────

export function defaultContextManager(settings?: SettingsService): ContextManager {
  return pipeContextManagers(
    toolResultTruncator({
      maxCharsPerResult: settings?.get<number>("context.toolResultMaxChars") ?? 50_000,
    }),
    autoSummarize({
      triggerAt: settings?.get<number>("context.summarizeTriggerAt") ?? 100_000,
      keepRecent: settings?.get<number>("context.summarizeKeepRecent") ?? 10,
    }),
  );
}
