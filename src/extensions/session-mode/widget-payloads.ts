export interface PlanProposalPayload {
  readonly callId: string
  readonly planMd: string
  readonly status: 'proposed' | 'approved' | 'rejected' | 'kept' | 'superseded'
  readonly proposedAt: number
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'plan.proposal': PlanProposalPayload
  }
}
