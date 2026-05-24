import type { Tool } from '../../application/ports/tool';
import type { ToolContext } from '../../application/ports/tool-context';
import type { McpManager } from './manager';
import type { McpToolDef } from './types';

const TOOL_PREFIX = 'mcp__';
const READONLY_PREFIXES = ['list_', 'read_', 'search_', 'get_', 'find_'];

function isReadonly(toolDef: McpToolDef): boolean {
  return READONLY_PREFIXES.some((prefix) => toolDef.name.startsWith(prefix));
}

export function formatToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverName}__${toolName}`;
}

export class McpToolAdapter {
  constructor(
    private manager: McpManager,
    private serverName: string,
    private toolDef: McpToolDef,
  ) {}

  toTool(): Tool {
    return {
      name: formatToolName(this.serverName, this.toolDef.name),
      description: this.toolDef.description ?? `MCP tool '${this.toolDef.name}' from server '${this.serverName}'`,
      parameters: this.toolDef.parameters,
      execute: async (ctx: ToolContext, params: Record<string, unknown>) => {
        const result = await this.manager.executeTool(this.serverName, this.toolDef.name, params, ctx.signal);
        return this.unwrapContent(result);
      },
      readonly: isReadonly(this.toolDef),
      conflictKey: isReadonly(this.toolDef) ? () => null : () => `mcp:${this.serverName}:${this.toolDef.name}`,
    };
  }

  private unwrapContent(result: unknown): string {
    const cr = result as { content?: Array<{ type: string; text?: string; mimeType?: string; resource?: unknown }>; isError?: boolean };
    if (!cr.content || cr.content.length === 0) return cr.isError ? '[MCP tool error]' : '';
    const texts: string[] = [];
    for (const block of cr.content) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text);
      else if (block.type === 'image') {
        const data = (block as { data?: string }).data;
        texts.push(`[image: ${block.mimeType || 'unknown'}${typeof data === 'string' ? `, ${data.length} bytes base64` : ''}]`);
      } else if (block.type === 'resource') texts.push(JSON.stringify(block.resource));
    }
    const output = texts.join('\n');
    return cr.isError ? `[MCP tool error]\n${output}` : output;
  }
}
