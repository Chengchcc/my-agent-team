import type { Tool } from '../../application/ports/tool';
import type { ToolContext } from '../../application/ports/tool-context';
import type { McpManager } from './manager';
import type { McpPromptDef } from './types';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import { formatToolName } from './tool-adapter';

function createPromptTool(manager: McpManager, serverName: string, promptDef: McpPromptDef): Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of promptDef.arguments || []) {
    properties[arg.name] = { type: 'string', description: arg.description || arg.name };
    if (arg.required) required.push(arg.name);
  }
  return {
    name: formatToolName(serverName, `prompt__${promptDef.name}`),
    description: promptDef.description ?? `MCP prompt '${promptDef.name}' from server '${serverName}'`,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    execute: async (_ctx: ToolContext, params: Record<string, unknown>) => {
      const stringArgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) stringArgs[key] = String(value);
      const result = await manager.getPrompt(serverName, promptDef.name, stringArgs);
      return result.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    },
  };
}

export class McpPromptRegistry {
  constructor(private manager: McpManager) {}

  getAll(): Array<{ serverName: string; prompt: McpPromptDef }> {
    return this.manager.getAllPrompts();
  }

  registerAsTool(serverName: string, promptDef: McpPromptDef, catalog: ToolCatalog): void {
    catalog.register(createPromptTool(this.manager, serverName, promptDef));
  }
}
