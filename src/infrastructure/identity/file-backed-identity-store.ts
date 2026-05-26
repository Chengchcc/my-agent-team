import { renderIdentityMd } from '../../domain/identity-doc'
import { atomicWrite } from '../../shared/atomic-write'
import type { Identity, IdentityDiff } from '../../domain/identity'
import { createIdentity, applyDiff } from '../../domain/identity'

export interface IdentitySnapshot {
  agentId: string
  fields: Readonly<Record<string, string>>
  body: string
  version: number
  updatedAt: number
}

export interface IdentityPatch {
  fields?: Record<string, string>
  body?: string
}

export class FileBackedIdentityStore {
  private identity: Identity
  private diffHistory: IdentityDiff[] = []
  private hydrationResolve!: () => void
  private _hydrationDone = new Promise<void>(resolve => { this.hydrationResolve = resolve })
  constructor(
    private agentId: string,
    private filePath: string,
  ) {
    this.identity = createIdentity(agentId, {})
  }

  get hydrationDone(): Promise<void> {
    return this._hydrationDone
  }

  /** Returns the resolved file path for writing draft identity documents. */
  getDraftPath(): string {
    return this.filePath
  }

  hydrate(fields: Record<string, string>, body: string, _source: 'file' | 'bootstrap'): void {
    this.identity = createIdentity(this.agentId, { ...fields, __body: body })
    this.diffHistory = []
    this.hydrationResolve()
  }

  current(): IdentitySnapshot {
    const content = this.identity.content
    const body = (content.__body as string) ?? ''
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(content)) {
      if (k !== '__body' && typeof v === 'string') {
        fields[k] = v
      }
    }
    return {
      agentId: this.identity.agentId,
      fields: fields as Readonly<Record<string, string>>,
      body,
      version: this.identity.version,
      updatedAt: this.identity.updatedAt.getTime(),
    }
  }

  async update(patch: IdentityPatch, _opts: { source: 'rpc' | 'bootstrap' | 'cli' }): Promise<IdentityDiff> {
    const changes: Record<string, unknown> = {}
    if (patch.fields) Object.assign(changes, patch.fields)
    if (patch.body !== undefined) changes.__body = patch.body
    const diff = applyDiff(this.identity, changes)
    this.diffHistory.push(diff)
    await this.persist()
    return diff
  }

  getHistory(): IdentityDiff[] {
    return [...this.diffHistory]
  }

  getVersion(): number {
    return this.identity.version
  }

  async rollback(targetVersion: number, _opts: { source: 'rpc' | 'cli' }): Promise<IdentityDiff> {
    if (targetVersion >= this.identity.version) {
      throw new Error(`Cannot rollback: target version ${targetVersion} must be less than current version ${this.identity.version}`)
    }
    if (targetVersion < 1) {
      throw new Error(`Cannot rollback: target version ${targetVersion} must be at least 1`)
    }

    const previousVersion = this.identity.version
    const diffsToRevert = [...this.diffHistory]
      .filter(d => d.toVersion > targetVersion)
      .reverse()

    for (const diff of diffsToRevert) {
      for (const [key, change] of Object.entries(diff.changes)) {
        if (change.from === undefined) {
          delete this.identity.content[key]
        } else {
          this.identity.content[key] = change.from
        }
      }
    }

    this.diffHistory = this.diffHistory.filter(d => d.toVersion <= targetVersion)
    this.identity.previousVersion = previousVersion
    this.identity.version = targetVersion
    this.identity.updatedAt = new Date()

    await this.persist()
    return {
      agentId: this.identity.agentId,
      fromVersion: previousVersion,
      toVersion: targetVersion,
      changes: {},
      createdAt: new Date(),
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.current()
    const md = renderIdentityMd(snapshot.fields, snapshot.body)
    await atomicWrite(this.filePath, md)
  }

  dispose(): void {
    this.diffHistory = []
  }
}
