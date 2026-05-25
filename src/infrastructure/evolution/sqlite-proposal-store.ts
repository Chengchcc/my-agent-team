import type { Database } from 'bun:sqlite'
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ProposalRecord } from '../../domain/evolution-proposal'

export class SqliteProposalStore implements ProposalStore {
  constructor(private db: Database) {}

  async append(proposal: ProposalRecord): Promise<void> {
    this.db.run(`INSERT INTO proposals (id, type, status, payload_json, created_at) VALUES (?, ?, 'pending', ?, ?)`, [proposal.id, proposal.tier, JSON.stringify(proposal), proposal.createdAt])
  }

  async list(opts?: { limit?: number }): Promise<ProposalRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    const limit = opts?.limit ?? 50
    const rows = this.db.query('SELECT payload_json FROM proposals ORDER BY created_at DESC LIMIT ?').all(String(limit)) as Array<{ payload_json: string }>
    return rows.map(r => JSON.parse(r.payload_json) as ProposalRecord)
  }

  async markAccepted(id: string): Promise<void> {
    this.db.run(`UPDATE proposals SET status = 'accepted', decided_at = ? WHERE id = ?`, [Date.now(), id])
  }

  async markRejected(id: string): Promise<void> {
    this.db.run(`UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?`, [Date.now(), id])
  }
}
