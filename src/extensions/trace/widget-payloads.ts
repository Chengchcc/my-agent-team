export interface TraceShowPayload {
  readonly run: {
    readonly id: string
    readonly sessionId: string
    readonly events: ReadonlyArray<{
      readonly type: string
      readonly turnIndex: number
      readonly toolName?: string
      readonly timestamp: string
    }>
  }
}

export interface TraceListPayload {
  readonly runs: ReadonlyArray<{
    readonly id: string
    readonly sessionId: string
    readonly totalTurns: number
    readonly outcome: string
  }>
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'trace.show': TraceShowPayload
    'trace.list': TraceListPayload
  }
}
