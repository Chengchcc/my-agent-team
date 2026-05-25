import { rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import { createEvent } from '../../application/contracts'
import type { SkillMetaRepo } from '../../application/ports/skill-meta-repo'
import type { Logger } from '../../application/ports/logger'
import type { AgentPaths } from '../../infrastructure/paths/agent-paths'

/**
 * Handles archiving a skill from the agent skills directory to an
 * `_archived` subdirectory. Emits `skill.archived` and `skills.reload-requested`
 * so the skills extension reloads its registry.
 *
 * Idempotent: if the skill is already marked as archived in skill_meta,
 * this is a no-op.
 */
export class AutoRetirer {
  constructor(
    private paths: AgentPaths,
    private bus: ContractBus,
    private meta: SkillMetaRepo,
    private logger: Logger,
  ) {}

  async retire(skillName: string, reason: string): Promise<void> {
    // Idempotency guard
    const existing = await this.meta.get(skillName)
    if (existing?.archivedAt != null) {
      this.logger.debug('auto-retirer', `skill ${skillName} already archived, skipping`)
      return
    }

    const src = join(this.paths.skills.agent, skillName)
    const dstName = `${skillName}-${Date.now()}`
    const dst = join(this.paths.skills.agent, '_archived', dstName)

    await mkdir(dirname(dst), { recursive: true })

    try {
      await rename(src, dst)
    } catch {
      // If the source doesn't exist (e.g. already moved manually), just mark archived
      this.logger.warn('auto-retirer', `failed to rename ${src} → ${dst}, marking as archived anyway`)
    }

    await this.meta.markArchived(skillName, Date.now())

    this.bus.emit(createEvent('skill.archived', { skillName, archivedTo: dst, reason }))
    this.bus.emit(createEvent('skills.reload-requested', {
      reason: 'auto-retire',
      source: skillName,
    }))
    this.logger.info('auto-retirer', `skill auto-retired: ${skillName} → ${dst} (${reason})`)
  }
}
