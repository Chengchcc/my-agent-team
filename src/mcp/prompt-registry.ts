import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { McpPromptDef } from './types';
import type { ToolRegistry } from '../agent/tool-registry';
import { formatToolName } from './tool-adapter';

export function formatPromptName(serverName: string, promptName: string): string {
  return formatToolName(serverName, `prompt__${promptName}`);
}

class McpPromptTool implements ToolImplementation {
  constructor(
    private manager: McpManager,
    private serverName: string,
    private promptDef: McpPromptDef,
  ) {}

  getDefinition(): Tool {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const arg of this.promptDef.arguments || []) {
      properties[arg.name] = { type: 'string', description: arg.description || arg.name };
      if (arg.required) required.push(arg.name);
    }

    return {
      name: formatPromptName(this.serverName, this.promptDef.name),
      description: this.promptDef.description ??
        `MCP prompt '${this.promptDef.name}' from server '${this.serverName}'`,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const stringArgs: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      stringArgs[key] = String(value);
    }

    const result = await this.manager.getPrompt(
      this.serverName,
      this.promptDef.name,
      stringArgs,
    );

    return result.messages
      .map(m => `[${m.role}]\n${m.content}`)
      .join('\n\n');
  }
}

export class McpPromptRegistry {
  constructor(private manager: McpManager) {}

  getAll(): Array<{ serverName: string; prompt: McpPromptDef }> {
    return this.manager.getAllPrompts();
  }

  registerAsTool(
    serverName: string,
    promptDef: McpPromptDef,
    toolRegistry: ToolRegistry,
  ): void {
    const tool = new McpPromptTool(this.manager, serverName, promptDef);
    toolRegistry.register(tool);
  }
}
