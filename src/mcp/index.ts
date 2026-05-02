export type {
  McpConnectionState,
  McpConnectionStatus,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
  McpPromptArgument,
  McpPromptResult,
  McpCapabilities,
  McpClientEntry,
} from './types';

export { McpManager } from './manager';
export { McpToolAdapter, formatToolName, TOOL_PREFIX } from './tool-adapter';
export { createMcpResourceMiddleware } from './resource-middleware';
export { McpPromptRegistry, formatPromptName } from './prompt-registry';
export { McpListServersTool, McpAddServerTool, McpRemoveServerTool } from './tools';

import type { McpManager } from './manager';

let _managerInstance: McpManager | null = null;

export function setMcpManagerInstance(manager: McpManager | null): void {
  _managerInstance = manager;
}

export function getMcpManagerInstance(): McpManager | null {
  return _managerInstance;
}
