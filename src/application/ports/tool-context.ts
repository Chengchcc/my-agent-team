import type { ToolSink } from './tool-sink'

export interface ToolContext {
  signal: AbortSignal
  environment: { cwd: string }
  sink: ToolSink
  sessionId: string
}
