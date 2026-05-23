// SkillDescriptor entity — metadata for a registered skill with evolution provenance.
// Zero IO dependencies. Zero framework imports.

interface SkillDescriptor {
  readonly id: string
  name: string
  description: string
  scope: 'builtin' | 'global' | 'agent'
  parameters?: Record<string, unknown>
  promotedFrom?: string
  version: number
  createdAt: Date
  updatedAt: Date
}

function createSkillDescriptor(opts: {
  id: string
  name: string
  description: string
  scope?: 'builtin' | 'global' | 'agent'
  parameters?: Record<string, unknown>
}): SkillDescriptor {
  if (!opts.name || opts.name.trim().length === 0) {
    throw new Error('Skill name must be non-empty')
  }

  const now = new Date()

  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    scope: opts.scope ?? 'agent',
    parameters: opts.parameters,
    promotedFrom: undefined,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function promoteSkill(
  descriptor: SkillDescriptor,
  sourceReviewId: string,
): SkillDescriptor {
  descriptor.promotedFrom = sourceReviewId
  descriptor.version += 1
  descriptor.updatedAt = new Date()
  return descriptor
}

export { createSkillDescriptor, promoteSkill }
export type { SkillDescriptor }
