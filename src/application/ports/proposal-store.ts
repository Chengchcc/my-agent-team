import type { ProposalRecord } from '../../domain/evolution-proposal'

export interface ProposalStore {
  append(proposal: ProposalRecord): Promise<void>
  list(opts?: { limit?: number }): Promise<ProposalRecord[]>
  markAccepted(id: string): Promise<void>
  markRejected(id: string): Promise<void>
}
