import type { ToolMiddleware } from '../agent/tool-dispatch/middleware';
import type { ToolCall } from '../types';
import type { ToolContext } from '../agent/tool-dispatch/types';
import type { TraceBuffer } from './trace-buffer';

export class TraceToolMiddleware implements ToolMiddleware {
  name = 'trace';

  async handle(
    toolCall: ToolCall,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const buffer = ctx.agentContext.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return next();

    const start = Date.now();
    try {
      const result = await next();
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: false,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
