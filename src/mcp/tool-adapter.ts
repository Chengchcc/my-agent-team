import type { Tool, ToolImplementation } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { McpManager } from './manager';
import type { McpToolDef } from './types';

const TOOL_PREFIX = 'mcp__';

const READONLY_PREFIXES = ['list_', 'read_', 'search_', 'get_', 'find_'];

function isReadonly(toolDef: McpToolDef): boolean {
  return READONLY_PREFIXES.some(prefix => toolDef.name.startsWith(prefix));
}

export function formatToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverName}__${toolName}`;
}

export class McpToolAdapter implements ToolImplementation {
  readonly readonly: boolean = false;
  readonly conflictKey?: (input: unknown) => string | null;

  constructor(
    private manager: McpManager,
    private serverName: string,
    private toolDef: McpToolDef,
  ) {
    if (isReadonly(toolDef)) {
      this.readonly = true;
      this.conflictKey = () => null;
    } else {
      this.conflictKey = () => `mcp:${this.serverName}`;
    }
  }

  getDefinition(): Tool {
    return {
      name: formatToolName(this.serverName, this.toolDef.name),
      description: this.toolDef.description ??
        `MCP tool '${this.toolDef.name}' from server '${this.serverName}'`,
      parameters: this.toolDef.parameters,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const result = await this.manager.executeTool(
      this.serverName,
      this.toolDef.name,
      params,
      ctx.signal,
    );
    return this._unwrapContent(result);
  }

  private _unwrapContent(result: unknown): string {
    const callResult = result as {
      content?: Array<{ type: string; text?: string; mimeType?: string; resource?: unknown }>;
      isError?: boolean;
    };

    if (!callResult.content || callResult.content.length === 0) {
      return callResult.isError ? '[MCP tool error]' : '';
    }

    const texts: string[] = [];
    for (const block of callResult.content) {
      if (block.type === 'text' && block.text !== undefined) {
        texts.push(block.text);
      } else if (block.type === 'image') {
        const data = (block as { data?: string }).data;
        const len = typeof data === 'string' ? data.length : 0;
        texts.push(`[image: ${block.mimeType || 'unknown'}${len ? `, ${len} bytes base64` : ''}]`);
      } else if (block.type === 'resource') {
        texts.push(JSON.stringify(block.resource));
      }
    }

    const output = texts.join('\n');
    return callResult.isError ? `[MCP tool error]\n${output}` : output;
  }
}
