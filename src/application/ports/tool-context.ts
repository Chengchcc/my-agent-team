import type { ToolSink } from './tool-sink'

export type ToolCallSource =
  | { kind: 'parent' }
  | {
      kind: 'subagent'
      subAgentType: string
      subAgentCallId: string
      parentSessionId: string
      parentTurnId: string
    }

export interface ToolContext {
  signal: AbortSignal
  environment: { cwd: string }
  sink: ToolSink
  /**
   * Session id of the **direct caller** of this tool.
   * - Parent agent call → parent session id
   * - Sub-agent inner call → sub session id (e.g. 'sub:t1:01XYZ...')
   *
   * If you need to key state by the user-facing top-level session,
   * use `ctx.source.kind === 'subagent'` to detect sub-agent context
   * and consult the source for ancestry. Do NOT assume sessionId is stable
   * across sub-agent boundaries.
   */
  sessionId: string
  turnId: string
  callId: string
  /** Provenance — where did this tool call originate? */
  source?: ToolCallSource
}
