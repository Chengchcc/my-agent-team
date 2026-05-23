import type { ToolContext } from './tool-context';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>;
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
  readonly?: boolean;
  conflictKey?: (input: unknown) => string | null;
}
