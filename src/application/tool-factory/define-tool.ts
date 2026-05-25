import type { Tool } from '../ports/tool';
import type { ToolContext } from '../ports/tool-context';

export function defineTool(config: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>;
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
  readonly?: boolean;
  conflictKey?: (toolCtx: ToolContext, input: unknown) => string | null;
  outputCap?: number;
}): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    parse: config.parse,
    execute: config.execute,
    readonly: config.readonly,
    conflictKey: config.conflictKey,
    outputCap: config.outputCap,
  };
}
