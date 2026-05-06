import type { Middleware, AgentMiddleware, AgentContext } from '../types';
import { TraceBuffer } from './trace-buffer';
import type { TraceStore, TraceRedactor, TraceRun } from './types';
import type { NudgeEngine } from './nudge-engine';
import { debugLog } from '../utils/debug';

export class TraceAgentMiddleware implements AgentMiddleware {
  constructor(
    private store: TraceStore,
    private nudgeEngine: NudgeEngine,
    private redactor: TraceRedactor,
    private nudgeEnabled: boolean = true,
  ) {}

  beforeAgentRun: Middleware = async (context, next) => {
    const parentRunId = context.metadata._parentTraceRunId as string | undefined;
    const buffer = new TraceBuffer(this.sessionId(context), this.store, parentRunId);
    context.metadata._traceBuffer = buffer;

    const lastUserMsg = [...context.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      buffer.recordUserMessage(lastUserMsg.content);
    }

    return next();
  };

  beforeAddResponse: Middleware = async (_context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer || !ctx.response) return ctx;

    // Note: thinking is unavailable here -- response.blocks (including thinking)
    // are set AFTER beforeAddResponse completes (agent-loop.ts:384).
    buffer.recordModelResponse({
      text: this.redactor.redactText(ctx.response.content),
      toolCalls: (ctx.response.tool_calls ?? []).map(tc => ({
        name: tc.name,
        arguments: this.redactor.redactToolArguments(tc.name, tc.arguments),
      })),
      usage: ctx.response.usage as Record<string, number>,
    });

    return ctx;
  };

  afterAgentRun: Middleware = async (_context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return ctx;

    const model = ctx.response?.model ?? 'unknown';
    const trace = buffer.finalize(model);

    setImmediate(() => {
      void this.finalizeTrace(trace);
    });

    return ctx;
  };

  private sessionId(context: AgentContext): string {
    return (context.metadata.sessionId as string) || 'unknown';
  }

  private async finalizeTrace(trace: TraceRun): Promise<void> {
    try {
      await this.store.finalize(trace);
      if (this.nudgeEnabled) {
        const nudgeResult = this.nudgeEngine.tick(trace);
        if (nudgeResult) {
          debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
          await this.nudgeEngine.persist();
        }
      }
    } catch (err) {
      debugLog(`[trace] Finalize failed: ${err}`);
    }
  }
}
