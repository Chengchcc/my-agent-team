import type { ToolExecutor } from '../../application/ports/tool-executor';
import type { Tool } from '../../application/ports/tool';
import type { ToolContext } from '../../application/ports/tool-context';

export class InProcessExecutor implements ToolExecutor {
  async execute(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    return tool.execute(ctx, input);
  }
}
