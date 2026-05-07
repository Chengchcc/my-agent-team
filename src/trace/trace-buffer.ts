import { nanoid } from 'nanoid';
import type { TraceRun, TraceTurn, TraceSummary, TraceStore, TraceEntry } from './types';

export interface ModelResponseRecord {
  thinking?: string;
  text: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  usage: Record<string, number>;
}

export interface ToolExecutionRecord {
  toolName: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class TraceBuffer {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentRunId: string | undefined;
  private startTime: number;
  private turns: TraceTurn[] = [];
  private currentTurnIndex = -1;
  private store: TraceStore;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingUserMessage: string | undefined;
  private activatedSkills: string[] = [];

  constructor(sessionId: string, store: TraceStore, parentRunId?: string) {
    this.sessionId = sessionId;
    this.store = store;
    this.parentRunId = parentRunId;
    this.runId = nanoid();
    this.startTime = Date.now();
  }

  setActivatedSkills(skills: string[]): void {
    this.activatedSkills = skills;
  }

  recordUserMessage(message: string): void {
    this.pendingUserMessage = message;
  }

  recordModelResponse(resp: ModelResponseRecord): void {
    this.currentTurnIndex++;
    const userMessage =
      this.currentTurnIndex === 0 ? this.pendingUserMessage : undefined;
    this.pendingUserMessage = undefined;
    const turn: TraceTurn = {
      turnIndex: this.currentTurnIndex,
      ...(userMessage ? { userMessage } : {}),
      modelResponse: {
        ...(resp.thinking !== undefined ? { thinking: resp.thinking } : {}),
        text: resp.text,
        toolCalls: resp.toolCalls,
        usage: resp.usage,
      },
      toolExecutions: [],
    };
    this.turns[this.currentTurnIndex] = turn;

    const { turnIndex: _ti, ...turnWithoutIndex } = turn;
    const entry: TraceEntry = { type: 'turn', turnIndex: this.currentTurnIndex, ...turnWithoutIndex };
    this.enqueueWrite(entry);
  }

  recordToolExecution(exec: ToolExecutionRecord): void {
    const turn = this.turns[this.currentTurnIndex];
    if (turn) {
      turn.toolExecutions.push(exec);
    }

    const entry: TraceEntry = { type: 'tool', ...exec };
    this.enqueueWrite(entry);
  }

  private enqueueWrite(entry: TraceEntry): void {
    this.writeQueue = this.writeQueue.then(() =>
      this.store.appendTurn(this.runId, this.sessionId, entry),
    ).catch(() => {});
  }

  /** Returns a promise that resolves when all pending writes are done. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  finalize(model: string, outcome?: TraceSummary['outcome']): TraceRun {
    const summary = this.computeSummary(outcome);
    return {
      id: this.runId,
      sessionId: this.sessionId,
      parentRunId: this.parentRunId,
      startTime: this.startTime,
      endTime: Date.now(),
      model,
      turns: this.turns,
      summary,
    };
  }

  private computeSummary(overrideOutcome?: TraceSummary['outcome']): TraceSummary {
    let totalToolCalls = 0;
    let totalErrors = 0;
    const totalTokens: Record<string, number> = {};

    for (const turn of this.turns) {
      totalToolCalls += turn.toolExecutions.length;
      for (const exec of turn.toolExecutions) {
        if (!exec.success) totalErrors++;
      }
      if (turn.modelResponse?.usage) {
        for (const [key, value] of Object.entries(turn.modelResponse.usage)) {
          totalTokens[key] = (totalTokens[key] ?? 0) + value;
        }
      }
    }

    const outcome: TraceSummary['outcome'] =
      overrideOutcome ?? (totalErrors > 0 ? 'error' : 'completed');

    return {
      totalTurns: this.turns.filter(t => t.modelResponse).length,
      totalToolCalls,
      totalErrors,
      totalTokens,
      outcome,
      ...(this.activatedSkills.length > 0 ? { activatedSkills: this.activatedSkills } : {}),
    };
  }
}
