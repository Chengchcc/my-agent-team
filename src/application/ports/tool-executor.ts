import type { Tool } from './tool';
import type { ToolContext } from './tool-context';

export interface ToolExecutor {
  execute(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
