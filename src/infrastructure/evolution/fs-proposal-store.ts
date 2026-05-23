import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ProposalRecord } from '../../domain/evolution-proposal'
import { join } from 'path'
import { mkdir, appendFile, readFile, writeFile } from 'fs/promises'

interface ProposalMeta { accepted: string[]; rejected: string[] }

export class FsProposalStore implements ProposalStore {
  private filePath: string
  private metaPath: string

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'proposals.jsonl')
    this.metaPath = join(baseDir, 'proposals-meta.json')
  }

  async append(proposal: ProposalRecord): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await appendFile(this.filePath, JSON.stringify(proposal) + '\n', 'utf-8')
  }

  async list(opts: { limit?: number } = {}): Promise<ProposalRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const limit = opts.limit ?? lines.length
      return lines.slice(-limit).map(l => JSON.parse(l) as ProposalRecord)
    } catch { return [] }
  }

  private async loadMeta(): Promise<ProposalMeta> {
    try {
      const raw = await readFile(this.metaPath, 'utf-8')
      return JSON.parse(raw) as ProposalMeta
    } catch { return { accepted: [], rejected: [] } }
  }

  private async saveMeta(meta: ProposalMeta): Promise<void> {
    await writeFile(this.metaPath, JSON.stringify(meta), 'utf-8')
  }

  async markAccepted(id: string): Promise<void> {
    const meta = await this.loadMeta()
    meta.accepted.push(id)
    meta.rejected = meta.rejected.filter(x => x !== id)
    // deduplicate
    meta.accepted = [...new Set(meta.accepted)]
    await this.saveMeta(meta)
  }

  async markRejected(id: string): Promise<void> {
    const meta = await this.loadMeta()
    meta.rejected.push(id)
    meta.accepted = meta.accepted.filter(x => x !== id)
    meta.rejected = [...new Set(meta.rejected)]
    await this.saveMeta(meta)
  }
}
