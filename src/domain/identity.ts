// Identity entity — versioned key-value identity data with diff tracking and rollback.
// Zero IO dependencies. Zero framework imports.

interface Identity {
  readonly agentId: string
  version: number
  content: Record<string, unknown>
  updatedAt: Date
  previousVersion?: number
}

interface IdentityDiff {
  agentId: string
  fromVersion: number
  toVersion: number
  changes: Record<string, { from: unknown; to: unknown }>
  createdAt: Date
}

function createIdentity(
  agentId: string,
  content?: Record<string, unknown>,
): Identity {
  return {
    agentId,
    version: 1,
    content: content ?? {},
    updatedAt: new Date(),
    previousVersion: undefined,
  }
}

function applyDiff(
  identity: Identity,
  changes: Record<string, unknown>,
): IdentityDiff {
  const fromVersion = identity.version
  const diffChanges: Record<string, { from: unknown; to: unknown }> = {}

  for (const key of Object.keys(changes)) {
    diffChanges[key] = { from: identity.content[key], to: changes[key] }
    identity.content[key] = changes[key]
  }

  identity.previousVersion = identity.version
  identity.version += 1
  identity.updatedAt = new Date()

  return {
    agentId: identity.agentId,
    fromVersion,
    toVersion: identity.version,
    changes: diffChanges,
    createdAt: new Date(),
  }
}

function rollback(identity: Identity, targetVersion: number): Identity {
  if (targetVersion >= identity.version) {
    throw new Error(
      `Rollback target version (${targetVersion}) must be less than current version (${identity.version})`,
    )
  }
  identity.previousVersion = identity.version
  identity.version = targetVersion
  identity.updatedAt = new Date()
  return identity
}

export { createIdentity, applyDiff, rollback }
export type { Identity, IdentityDiff }
