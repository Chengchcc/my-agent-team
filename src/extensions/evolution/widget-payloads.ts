export interface EvolutionProposalsPayload {
  readonly proposals: ReadonlyArray<{
    readonly id: string
    readonly tier: string
    readonly outcome: string
    readonly skillName?: string
    readonly reasoning: string
    readonly createdAt: number
  }>
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'evolution.proposals': EvolutionProposalsPayload
  }
}
