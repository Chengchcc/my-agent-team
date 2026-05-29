import type { ToolSink } from './tool-sink'

export type ToolCallSource =
  | { kind: 'parent' }
  | { kind: 'subagent'; subAgentType: string; subAgentCallId: string }

export interface ToolContext {
  signal: AbortSignal
  environment: { cwd: string }
  sink: ToolSink
  sessionId: string
  turnId: string
  callId: string
  /** Provenance — where did this tool call originate? */
  source?: ToolCallSource
}
