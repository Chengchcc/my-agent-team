export interface MemoryListPayload {
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly text: string
    readonly weight: number
  }>
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'memory.list': MemoryListPayload
  }
}
