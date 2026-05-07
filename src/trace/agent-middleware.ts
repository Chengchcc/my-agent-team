import type { Middleware, AgentMiddleware, AgentContext } from '../types';
import { TraceBuffer } from './trace-buffer';
import type { TraceStore, TraceRedactor, TraceRun } from './types';
import type { NudgeEngine } from './nudge-engine';
import type { EvolutionCallback } from '../evolution/types';
import type { SkillLoader } from '../skills/loader';
import { debugLog } from '../utils/debug';
import { useTuiStore } from '../cli/tui/state/store';

export class TraceAgentMiddleware implements AgentMiddleware {
  constructor(
    private store: TraceStore,
    private nudgeEngine: NudgeEngine,
    private redactor: TraceRedactor,
    private nudgeEnabled: boolean = true,
    private evolution?: EvolutionCallback | null,
    private skillLoader?: SkillLoader | null,
  ) {}

  beforeAgentRun: Middleware = async (context, next) => {
    this.skillLoader?.checkAutoSkills();
    void this.evolution?.autoAcceptStaleSkills?.();
    const parentRunId = context.metadata._parentTraceRunId as string | undefined;
    const buffer = new TraceBuffer(this.sessionId(context), this.store, parentRunId);
    context.metadata._traceBuffer = buffer;

    const lastUserMsg = [...context.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      buffer.recordUserMessage(lastUserMsg.content);
    }

    const activatedSkills = this.skillLoader?.getAutoSkillNames() ?? [];
    if (activatedSkills.length > 0) {
      buffer.setActivatedSkills(activatedSkills);
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
          if (this.evolution?.review) {
            this.evolution.review(nudgeResult, trace);
          }
        }
      }
      // Tier 2 effectiveness tracking
      if (this.evolution?.trackStats) {
        try {
          const results = await this.evolution.trackStats(trace.summary, trace.id);
          for (const { skillName, triggerReview } of results) {
            if (triggerReview) {
              debugLog(`[trace] Low-score warning for ${skillName} — Tier 2 review recommended`);
              useTuiStore.getState().addReviewNotification(
                skillName,
                'Low success rate — Tier 2 analysis triggered',
                '',
              );
              this.evolution.runTier2Analysis?.(skillName, `Auto skill: ${skillName}`);
            }
          }
        } catch (err) {
          debugLog(`[trace] Track stats failed: ${err}`);
        }
      }
    } catch (err) {
      debugLog(`[trace] Finalize failed: ${err}`);
    }
  }
}
