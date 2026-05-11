import type { McpManager } from './manager';
import type { ToolRegistry } from '../agent/tool-registry';
import type { McpPromptRegistry } from './prompt-registry';

let _managerInstance: McpManager | null = null;
let _toolRegistryInstance: ToolRegistry | null = null;
let _promptRegistryInstance: McpPromptRegistry | null = null;

export function setMcpManagerInstance(manager: McpManager | null): void {
  _managerInstance = manager;
}

export function getMcpManagerInstance(): McpManager | null {
  return _managerInstance;
}

export function setMcpToolRegistry(r: ToolRegistry): void {
  _toolRegistryInstance = r;
}

export function getMcpToolRegistry(): ToolRegistry | null {
  return _toolRegistryInstance;
}

export function setMcpPromptRegistry(p: McpPromptRegistry | null): void {
  _promptRegistryInstance = p;
}

export function getMcpPromptRegistry(): McpPromptRegistry | null {
  return _promptRegistryInstance;
}
