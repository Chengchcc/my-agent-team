import { TraceAgentMiddleware } from './agent-middleware';
import { TraceToolMiddleware } from './tool-middleware';
import { TraceStore } from './store';
import { NudgeEngine } from './nudge-engine';
import { DefaultRedactor } from './redactor';
import type { TraceRedactor, NudgeResult, NudgeState, TraceRun, TraceTurn, TraceSummary, TraceEntry } from './types';
import { TraceBuffer } from './trace-buffer';
import type { ModelResponseRecord, ToolExecutionRecord } from './trace-buffer';
import os from 'os';
import path from 'path';

const DEFAULT_TRACE_DIR = path.join(os.homedir(), '.my-agent', 'traces');
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.my-agent', 'trace-state.json');

export interface TraceMiddlewareSet {
  agentMiddleware: TraceAgentMiddleware;
  toolMiddleware: TraceToolMiddleware;
  store: TraceStore;
  nudgeEngine: NudgeEngine;
  redactor: TraceRedactor;
}

export function createTraceMiddleware(options: {
  store?: TraceStore;
  redactor?: TraceRedactor;
  reviewInterval?: number | undefined;
  baseDir?: string;
  maxRunsPerSession?: number | undefined;
  redactionMode?: 'default' | 'none' | undefined;
  nudgeEnabled?: boolean | undefined;
} = {}): TraceMiddlewareSet {
  const baseDir = options.baseDir ?? DEFAULT_TRACE_DIR;
  const store = options.store ?? new TraceStore(baseDir, options.maxRunsPerSession);
  const redactor = options.redactor ?? new DefaultRedactor(options.redactionMode ?? 'default');
  const statePath = options.baseDir
    ? path.join(options.baseDir, '..', 'trace-state.json')
    : DEFAULT_STATE_PATH;
  const nudgeEngine = new NudgeEngine(statePath, options.reviewInterval);
  const agentMiddleware = new TraceAgentMiddleware(
    store,
    nudgeEngine,
    redactor,
    options.nudgeEnabled ?? true,
  );
  const toolMiddleware = new TraceToolMiddleware();

  return { agentMiddleware, toolMiddleware, store, nudgeEngine, redactor };
}

// Re-export types for external consumers
export type {
  TraceRun, TraceTurn, TraceSummary, TraceEntry,
  TraceRedactor, NudgeResult, NudgeState,
  ModelResponseRecord, ToolExecutionRecord,
};

export { TraceBuffer, TraceStore, NudgeEngine, DefaultRedactor, TraceAgentMiddleware, TraceToolMiddleware };
